export const meta = {
  name: 'ug-coding-loop',
  description: 'Tiered multi-model build→verify→bless loop: Fable plans, parallel Sonnet builds, two independent Opus reviewers gate, Fable blesses. Loops on failure (Sonnet→Opus, no Fable) up to a cycle cap. Spends the top model only at the two bookends to minimize its token cost.',
  phases: [
    { title: 'Plan', detail: 'Fable audits the task, sets acceptance criteria, decomposes into file-disjoint work items', model: 'fable' },
    { title: 'Build', detail: 'One parallel Sonnet coder per work item' },
    { title: 'Smoke', detail: 'Haiku runs the objective check; red skips Opus and loops straight back to Sonnet', model: 'haiku' },
    { title: 'Verify', detail: 'Two independent Opus reviewers; both must pass' },
    { title: 'Bless', detail: 'Single Fable final review over everything', model: 'fable' },
  ],
}

// ---------------------------------------------------------------------------
// Model routing. Edit these three values if your environment uses full model
// IDs instead of the short aliases. Everything downstream reads from here so
// you only change names in one place.
//   top     = smartest + most expensive. Used ONLY to plan and to bless. Rare.
//   coder   = cheap workhorse. Does all the actual building, in parallel.
//   reviewer= mid-tier. Two independent instances gate every cycle.
// The whole point: the expensive model appears at exactly two moments, never
// inside the retry churn — that is what keeps its token spend minimal.
// ---------------------------------------------------------------------------
const MODELS = { top: 'fable', coder: 'sonnet', reviewer: 'opus', smoke: 'haiku' }

// args may be a plain string (the task) or an object:
//   { task, context?, maxCycles?, minBudgetFloor?, mode?, plan? }
//
// The PLAN GATE: on a task's first run, invoke with mode:'plan-only' — the
// script spends ONE Fable call, returns the plan (plain-English summary +
// technical work items + acceptance criteria) and stops before any build agent
// runs. The main thread shows it to the user for a single approval, then
// re-invokes with the approved plan passed as `plan` — the Plan phase is
// skipped and the loop runs fully autonomously. One approval per task, never
// per cycle or per agent.
// Harden against stringified args: some callers (and the resume path) deliver
// args as a JSON-encoded string. Without this parse, options like mode:
// 'plan-only' would be SILENTLY ignored and the full loop would run — a real
// failure observed in validation. Parse defensively.
let _args = args
if (typeof _args === 'string') {
  const t = _args.trim()
  if (t.startsWith('{') || t.startsWith('[')) { try { _args = JSON.parse(t) } catch { /* keep as plain task string */ } }
}
const A = (typeof _args === 'object' && _args) ? _args : {}
const TASK = typeof _args === 'string' ? _args : (A.task ?? JSON.stringify(_args))
const CONTEXT = A.context ?? ''
const MODE = A.mode === 'plan-only' ? 'plan-only' : 'full'
const PROVIDED_PLAN = (A.plan && typeof A.plan === 'object') ? A.plan : null
const MAX_CYCLES = Number.isFinite(A.maxCycles) ? A.maxCycles : 6
// Stop early if we would dip below this many output tokens of headroom (only
// active when the turn set a budget target). Prevents a half-finished loop from
// starving the rest of the turn.
const BUDGET_FLOOR = Number.isFinite(A.minBudgetFloor) ? A.minBudgetFloor : 40000

const j = (x) => JSON.stringify(x, null, 2)

// Token accounting. budget.spent() counts output tokens for the WHOLE turn
// (main loop + all workflows), so we snapshot at start and report the delta —
// an accurate measure of this run unless other heavy work runs concurrently
// in the same turn. Wall-clock time cannot be measured in here (Date.now is
// unavailable in workflow scripts); the harness reports duration_ms per run
// and per agent, which the main thread folds into the final report.
const SPENT0 = budget.spent()
const spentSoFar = () => Math.max(0, budget.spent() - SPENT0)
const fmtK = (n) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const collectIssues = (verdicts) =>
  verdicts.filter(Boolean).flatMap(v => (v.blocking_issues || []).map(i =>
    typeof i === 'string' ? { problem: i } : i))

// -------------------------------- schemas ---------------------------------
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'plain_english', 'acceptance_criteria', 'work_items'],
  properties: {
    summary: { type: 'string', description: 'What the task is and the intended end state.' },
    plain_english: { type: 'string', description: 'A short, jargon-free explanation for the human who approves this plan: what will be built, how the work is split, and how we will know it is done. A non-technical reader should follow it.' },
    acceptance_criteria: {
      type: 'array', minItems: 1,
      items: { type: 'string' },
      description: 'Objectively checkable statements that define "green". Reviewers grade against exactly these.',
    },
    smoke_command: { type: 'string', description: "Optional. ONE shell command that objectively exercises the acceptance criteria (e.g. 'cd /path/to/repo && python3 -m pytest'). Include the working directory in the command itself. Omit entirely when no runnable objective check exists (e.g. a prose deliverable)." },
    work_items: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'title', 'instructions'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          instructions: { type: 'string', description: 'Enough for one coder to do this item end-to-end.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files this item OWNS. Must be disjoint from every other item so parallel coders never touch the same file.' },
        },
      },
    },
  },
}
const SMOKE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['green', 'evidence'],
  properties: {
    green: { type: 'boolean', description: 'true ONLY if the command exited with status 0.' },
    evidence: { type: 'string', description: 'The command run, its exit code, and the tail (~50 lines) of its raw output.' },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pass', 'blocking_issues', 'summary'],
  properties: {
    pass: { type: 'boolean', description: 'true ONLY if every acceptance criterion is met and (for code) tests you could run/inspect pass.' },
    blocking_issues: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['problem', 'fix'],
        properties: {
          criterion: { type: 'string' },
          problem: { type: 'string' },
          where: { type: 'string', description: 'file:line or component' },
          fix: { type: 'string', description: 'Concrete change a coder can act on.' },
        },
      },
    },
    summary: { type: 'string' },
  },
}
const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['item_id', 'changed_files', 'summary'],
  properties: {
    item_id: { type: 'string' },
    changed_files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', description: 'What you changed and why, in a few sentences.' },
    tests_run: { type: 'string', description: 'Commands you ran and their result, or why none applied.' },
  },
}

// -------------------------------- prompts ---------------------------------
const planPrompt = () => `You are the lead architect. Use the TOP-tier model's full judgement — this is one of only two moments an expensive model is spent on this task, so make it count.

TASK:
${TASK}
${CONTEXT ? `\nCONTEXT:\n${CONTEXT}\n` : ''}
Do a real audit first: read the relevant files/state so your plan reflects reality, not assumption. The audit is STRICTLY READ-ONLY — you may read files and run non-mutating checks (e.g. the test suite), but do not edit, create, or fix anything. Your plan may be shown to a human for approval before any build agent runs; a file you already changed makes that approval meaningless. Then produce:
1. A short summary of the task and the intended end state, plus plain_english — a jargon-free version a non-technical human will read to approve this plan before any agents run. Make the plain_english genuinely plain: what gets built, how the work splits, how we know it's done.
2. acceptance_criteria — the objectively checkable conditions that mean "done". Independent reviewers will grade ONLY against these, so make them specific and testable (e.g. "npm test passes", "endpoint returns 400 on missing field", not "code is clean").
2b. smoke_command — if ONE shell command can objectively exercise the criteria (a test suite, a build, a linter chain), provide it with its working directory baked in. A minimal-cost agent will run it after each build round and, when it fails, the expensive reviewers are skipped for that round — this is a major token saver, so provide it whenever a runnable check exists. Omit it when nothing runnable applies.
3. work_items — a decomposition into pieces that can be built IN PARALLEL. Critical constraint: each work item must OWN a disjoint set of files. Two items must never edit the same file, because coders run concurrently in a shared workspace and would clobber each other. If the task cannot be cleanly split, return a single work item — that is correct and expected for small tasks.

Method: follow superpowers:writing-plans — invoke that skill if you can reach the Skill tool, and either way apply its core: write each work item as a bite-sized task for a coder who knows the domain but nothing about this codebase; fold TDD in so each item's acceptance is a failing test made to pass; DRY, YAGNI. Write the acceptance_criteria in FULL, precise, testable language — do NOT abbreviate or caveman-compress them; vague criteria make "green" unverifiable and defeat the whole loop.

Plan lazily (ponytail): the cheapest work item is the one that doesn't exist. Before including any item ask, in order — does this need to be built at all? does existing code in the repo, the standard library, a native platform feature, or an already-installed dependency cover it? does it collapse to a trivial change? Prefer the smallest plan that genuinely meets the acceptance criteria; do not plan abstractions, refactors, or "while we're here" work nobody asked for. Never trim at the expense of: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything explicitly requested.`

const buildPrompt = (item, fixList) => `You are a coder implementing ONE work item. Work only within the files this item owns; do not touch files owned by other items.

OVERALL TASK:
${TASK}

ACCEPTANCE CRITERIA (the whole task is graded on these):
${j(PLAN.acceptance_criteria)}

YOUR WORK ITEM:
${j(item)}
${fixList ? `\nThis is a RE-WORK pass. Independent reviewers rejected the previous attempt. Fix these issues that fall within your files — ignore ones outside your ownership:\n${j(fixList)}\n` : ''}
Work test-first: invoke superpowers:test-driven-development if the Skill tool is available and follow it — write the failing test, watch it fail, then the minimal code to pass. That is how you know the test tests the right thing. ${fixList ? 'Since this is rework triggered by a reviewer failure, invoke superpowers:systematic-debugging (or apply it) and find the ROOT CAUSE before changing anything — a symptom patch that hides the real bug is a failure.' : ''}

Code lazily (ponytail — "the best code is the code you never wrote"). Before writing anything, walk this ladder in order: (1) does this need to exist at all? (2) does code already in this repo do it — reuse, don't rewrite; (3) does the standard library do it? (4) does a native platform feature cover it? (5) does an already-installed dependency solve it? (6) can it be one line? Only after all six: write minimum working code. No new abstractions, no unasked-for boilerplate, no extra dependencies; prefer deletion over addition. Be lazy about the solution, NEVER about reading — understand the problem fully first. When two equally small options exist, pick the edge-case-correct one. Mark intentional simplifications with a 'ponytail:' comment noting the ceiling and upgrade path. These are never negotiable and never trimmed: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, and anything the task explicitly asks for.

Actually make the edits in the workspace (Read/Edit/Write). Run the real tests/checks yourself and record the exact commands and their output in tests_run — do not claim a piece works without having run it. Then report what you changed.`

const smokePrompt = () => `You are a smoke-check runner. Run EXACTLY this command and report the result. Do not fix anything, do not edit any file, do not run any other command.

COMMAND:
${PLAN.smoke_command}

TASK (context only, for orientation — you are not implementing it):
${TASK}

Report green=true ONLY if the command exited with status 0 (append '; echo EXIT:$?' if needed to capture it). Include the exit code and the tail of the raw output as evidence — the raw output is what the coders will act on if red, so do not summarize it away.`

const verifyPrompt = (builds, lane) => `You are independent reviewer ${lane}. You are one of two reviewers grading this work SEPARATELY — you cannot see the other reviewer, and you should assume they may miss things, so do your own thorough pass. Be skeptical: your job is to catch problems before an expensive top-tier review is spent.

OVERALL TASK:
${TASK}

ACCEPTANCE CRITERIA — grade against EXACTLY these:
${j(PLAN.acceptance_criteria)}

WHAT THE CODERS REPORT THEY DID:
${j(builds)}

Apply superpowers:verification-before-completion (invoke it if available): the iron law is NO pass without fresh verification evidence gathered in THIS review. You may not mark a criterion met unless you ran or inspected the actual test/command yourself and saw it pass — cite that evidence. Do not trust the coders' self-reports; open the real files and run the checks.

Pass ONLY if every acceptance criterion is genuinely met; default to pass=false when uncertain — a false green wastes the top model's time. Write each blocking issue in FULL precise detail: file:line, expected-vs-actual, and a concrete fix the next coder can act on directly. Do NOT compress or caveman these issue reports — the next cycle acts on exactly what you write, so specificity is the point.

The coders work under a minimal-code mandate (ponytail): an implementation that meets every criterion with the least code is CORRECT, not lazy. Do not raise issues demanding abstractions, patterns, configurability, or features beyond the acceptance criteria — that churns the loop on ideology instead of defects. The exceptions that ARE always blocking regardless of criteria: missing input validation at trust boundaries, error handling gaps that risk data loss, security holes, and accessibility failures.`

const blessPrompt = (builds, verdicts) => `You are the final authority, on the TOP-tier model. Two independent reviewers already passed this work; you are the last gate before it ships. This is the second and final moment an expensive model is spent here, so be comprehensive — look for whole-picture problems the per-item reviewers could miss: integration gaps, missed edge cases, whether the work truly satisfies the ORIGINAL intent (not just the letter of the criteria), regressions, and anything unsafe.

ORIGINAL TASK:
${TASK}

ACCEPTANCE CRITERIA:
${j(PLAN.acceptance_criteria)}

CODER REPORTS:
${j(builds)}

INDEPENDENT REVIEWER VERDICTS:
${j(verdicts)}

Apply superpowers:verification-before-completion at the highest bar (invoke it if available): sign off only on evidence you gathered yourself in this pass — run the verification, don't inherit the reviewers' word for it. State what you ran. Inspect the real workspace state, not just the reports. The coders work under a minimal-code mandate (ponytail): judge whether the work meets the intent with the least code, not whether it's architecturally elaborate — but security, data-loss, trust-boundary, and accessibility gaps are always blocking. Pass ONLY if you would personally sign off on shipping this. If you reject, give concrete, fully-detailed fixes — the cheaper models will do the rework and you will review again.`

// --------------------------------- run ------------------------------------
const belowBudget = () => budget.total && budget.remaining() < BUDGET_FLOOR

let PLAN = PROVIDED_PLAN
if (!PLAN) {
  phase('Plan')
  PLAN = await agent(planPrompt(), { label: 'plan:fable', phase: 'Plan', model: MODELS.top, schema: PLAN_SCHEMA })
  if (!PLAN) return { status: 'error', error: 'planning failed', cycles: 0 }
} else {
  log('Approved plan provided. Skip Fable plan phase — no top-model tokens spent.')
}
log(`Plan ready. ${PLAN.work_items.length} work item(s), ${PLAN.acceptance_criteria.length} criteria. [${fmtK(spentSoFar())} tok]`)

if (MODE === 'plan-only') {
  log('Plan-only run: stopping before any build agent. Present plan to user for the one-time approval.')
  return { status: 'planned', cycles: 0, plan: PLAN, final_builds: null, outstanding_issues: [], history: [], tokens_spent: spentSoFar() }
}

const history = []
let fixList = null
let lastBuilds = null
let status = 'exhausted'
let cycle = 0

while (cycle < MAX_CYCLES) {
  if (belowBudget()) { status = 'budget-stopped'; log(`Stop. Token floor hit before cycle ${cycle + 1}.`); break }
  cycle++

  // BUILD — parallel Sonnet, one per work item.
  phase('Build')
  const items = PLAN.work_items
  const built = await parallel(items.map((it, i) => () =>
    agent(buildPrompt(it, fixList), { label: `build:${it.id || i}`, phase: 'Build', model: MODELS.coder, schema: BUILD_SCHEMA })))
  lastBuilds = built.filter(Boolean)
  log(`cycle ${cycle}: ${lastBuilds.length}/${items.length} coder(s) done. [${fmtK(spentSoFar())} tok]`)

  // SMOKE — optional Haiku tripwire between Build and Verify. If the plan
  // defined an objective check and it fails, both Opus reviewers are skipped
  // this cycle: paying mid-tier review tokens to confirm what a failing
  // command already proves is waste. Haiku only runs the command and reports
  // the raw result — no judgement, no fixes — so the cheapest model gets the
  // most mechanical job. A green smoke still goes through full Opus review,
  // so this adds no false-green risk.
  if (PLAN.smoke_command) {
    phase('Smoke')
    const smoke = await agent(smokePrompt(), { label: 'smoke:haiku', phase: 'Smoke', model: MODELS.smoke, schema: SMOKE_SCHEMA })
    if (smoke && !smoke.green) {
      fixList = [{
        problem: `Objective check failed: ${PLAN.smoke_command}`,
        where: 'smoke gate (pre-review)',
        fix: 'Make this command pass. Its raw failing output follows — work from it.',
        output: (smoke.evidence || '').slice(0, 4000),
      }]
      history.push({ cycle, gate: 'smoke', pass: false })
      log(`cycle ${cycle}: smoke RED. Skip Opus, back to Sonnet. [${fmtK(spentSoFar())} tok]`)
      continue
    }
    history.push({ cycle, gate: 'smoke', pass: true })
    log(`cycle ${cycle}: smoke green. [${fmtK(spentSoFar())} tok]`)
  }

  // VERIFY — two independent Opus reviewers; both must pass.
  phase('Verify')
  const [vA, vB] = await parallel([
    () => agent(verifyPrompt(lastBuilds, 'A'), { label: 'verify:opus-A', phase: 'Verify', model: MODELS.reviewer, schema: VERDICT_SCHEMA }),
    () => agent(verifyPrompt(lastBuilds, 'B'), { label: 'verify:opus-B', phase: 'Verify', model: MODELS.reviewer, schema: VERDICT_SCHEMA }),
  ])
  const opusGreen = vA && vB && vA.pass && vB.pass
  if (!opusGreen) {
    fixList = collectIssues([vA, vB])
    history.push({ cycle, gate: 'verify', pass: false, issue_count: fixList.length })
    log(`cycle ${cycle}: Opus gate FAIL. ${fixList.length} issue(s). Back to Sonnet, no Fable. [${fmtK(spentSoFar())} tok]`)
    continue
  }
  history.push({ cycle, gate: 'verify', pass: true })

  // BLESS — single Fable review. Only reached when both reviewers already agree.
  if (belowBudget()) { status = 'green-unblessed'; log(`cycle ${cycle}: Opus green but token floor hit. Skip Fable bless.`); break }
  phase('Bless')
  const bless = await agent(blessPrompt(lastBuilds, [vA, vB]), { label: 'bless:fable', phase: 'Bless', model: MODELS.top, schema: VERDICT_SCHEMA })
  if (bless && bless.pass) {
    status = 'green'
    history.push({ cycle, gate: 'bless', pass: true })
    log(`cycle ${cycle}: GREEN. Fable bless done. [${fmtK(spentSoFar())} tok total]`)
    break
  }
  fixList = collectIssues([bless])
  history.push({ cycle, gate: 'bless', pass: false, issue_count: fixList.length })
  log(`cycle ${cycle}: Fable reject. ${fixList.length} issue(s). Back to Sonnet. [${fmtK(spentSoFar())} tok]`)
}

return {
  status,                    // planned | green | green-unblessed | budget-stopped | exhausted | error
  cycles: cycle,
  plan: PLAN,
  final_builds: lastBuilds,
  outstanding_issues: status === 'green' ? [] : (fixList || []),
  history,
  tokens_spent: spentSoFar(),   // output tokens this run (turn-delta; see SPENT0 note)
}
