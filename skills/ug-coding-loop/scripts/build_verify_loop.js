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
// Model routing. Edit these values if your environment uses full model
// IDs instead of the short aliases. Everything downstream reads from here so
// you only change names in one place.
//   top     = smartest + most expensive. Used ONLY to plan and to bless. Rare.
//   coder   = cheap workhorse. Does all the actual building, in parallel.
//   reviewer= mid-tier. Two independent instances gate every cycle.
// The whole point: the expensive model appears at exactly two moments, never
// inside the retry churn — that is what keeps its token spend minimal.
//
// Aliases (fable/opus/sonnet/haiku) resolve in the harness to the NEWEST
// available version of each tier — never pin a dated model ID here, or the
// loop silently falls behind when a new version ships. topFallback is used
// automatically when the top model is unavailable (its agent returns null):
// plan and bless retry once on the next-best tier instead of failing the run.
// ---------------------------------------------------------------------------
const MODELS = { top: 'fable', topFallback: 'opus', coder: 'sonnet', reviewer: 'opus', smoke: 'haiku' }

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
// Validate a caller-provided plan before trusting it: the plan-gate flow hands
// the approved plan back (possibly hand-edited), so nothing guarantees shape.
// Missing work_items would crash the run. (Missing/duplicate item ids are fixed
// centrally after the plan resolves — see the uniquify block below.)
let PROVIDED_PLAN = null
if (A.plan && typeof A.plan === 'object') {
  const p = A.plan
  if (Array.isArray(p.work_items) && p.work_items.length &&
      Array.isArray(p.acceptance_criteria) && p.acceptance_criteria.length) {
    PROVIDED_PLAN = p
  }
}
// Coerce numeric knobs: callers that stringify args deliver "5", which
// Number.isFinite rejects — silently ignoring an explicit user setting.
const _num = (v) => v == null ? NaN : Number(v)
const MAX_CYCLES = Math.max(1, Number.isFinite(_num(A.maxCycles)) ? _num(A.maxCycles) : 10)
// Stop early if we would dip below this many output tokens of headroom (only
// active when the turn set a budget target). Prevents a half-finished loop from
// starving the rest of the turn.
const BUDGET_FLOOR = Number.isFinite(_num(A.minBudgetFloor)) ? _num(A.minBudgetFloor) : 40000

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

// Normalized prose for fingerprinting/dedupe: lowercase, punctuation squashed.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40)

// Collect blocking issues across verdicts, deduping cross-lane duplicates: two
// parallel reviewers reporting the same defect (same implicated file + same
// acceptance criterion, prose reworded) collapse to one issue, so rework
// prompts don't bloat and the stall tracker isn't skewed by lane count.
const collectIssues = (verdicts) => {
  const seen = new Set()
  return verdicts.filter(Boolean).flatMap(v => (v.blocking_issues || []).map(i =>
    typeof i === 'string' ? { problem: i } : i))
    .filter(i => {
      const key = (issueFile(i) || norm(i.where)) + '|' + norm(i.criterion)
      if (key === '|') return true            // nothing stable to dedupe on
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

// --- Targeted re-run: attribute each rework issue to the work item that owns
// the file it names, so a cycle re-runs only the implicated coders and carries
// every other item's prior build forward. Safe because work items own DISJOINT
// files, so an item whose files appear in no issue does not need rework. When an
// issue can't be pinned to a file (a smoke failure, a component-name issue, or an
// item that declared no files) we conservatively re-run ALL coders — never skip a
// needed fix.
const itemFiles = (it) => (it.files || []).map(f => f.replace(/^\.\//, ''))
// Best-effort file path out of an issue's `where`/`file` field. Returns '' when
// it names no path (e.g. a component name or the smoke gate).
const issueFile = (iss) => {
  const w = String(iss.where || iss.file || '').trim()
  const tok = w.split(/[\s(]/)[0]      // drop " or component", "(...)" tails
  const path = tok.split(':')[0]       // drop :line[:col]
  return /[./]/.test(path) ? path.replace(/^\.\//, '') : ''
}
// Path-looking tokens out of raw command output (stack traces, compiler errors,
// test headers). Deterministic backstop for the smoke gate: it does not depend on
// the smoke agent choosing to fill implicated_files. Strips :line[:col], dedupes.
const SMOKE_PATH_RE = /[\p{L}\p{N}_@./-]+\.[A-Za-z]{1,4}(?::\d+)?/gu
const extractPaths = (text) => [...new Set((String(text || '').match(SMOKE_PATH_RE) || [])
  .map(t => t.split(':')[0].replace(/^\.\//, ''))
  .filter(Boolean))]
// Disjoint ownership => a FULL path maps to at most one item. A bare name
// ("test.py") can suffix-match several items owning same-named files in
// different dirs — all matches re-run, which is safe (mild waste, never a
// skipped fix). Suffix-match on a '/' boundary so "app.py" resolves against an
// owned "src/app.py" (and vice versa) but never against "webapp.py".
const ownersOf = (file, items) => !file ? [] :
  items.filter(it => itemFiles(it).some(of =>
    of === file || of.endsWith('/' + file) || file.endsWith('/' + of)))
// Decide which coders run this cycle and each one's scoped issue slice.
//   fixList == null  -> first build: every item runs fresh (issues: null).
//   all issues attributable -> only implicated items run, each gets its own issues.
//   any unattributable (incl. empty fixList, missing files) -> re-run ALL,
//     unattributed issues handed to every coder.
const planRework = (items, fixList, forceAll) => {
  if (!fixList) return items.map((it) => ({ item: it, issues: null }))
  const attributed = fixList.map(iss => ({ iss, owners: ownersOf(issueFile(iss), items).map(it => it.id) }))
  // An issue naming no owned file could belong to anyone: full re-run. An item
  // that declared no files could have caused any issue, so it always re-runs and
  // sees every issue — but it no longer drags well-attributed issues into a
  // global re-run of the file-owning items. forceAll is the stall-escalation
  // override: targeted rework didn't converge, so everyone re-runs.
  const fileless = new Set(items.filter(it => itemFiles(it).length === 0).map(it => it.id))
  const fallbackAll = forceAll || attributed.length === 0 || attributed.some(a => a.owners.length === 0)
  const pool = fallbackAll ? items : items.filter(it =>
    fileless.has(it.id) || attributed.some(a => a.owners.includes(it.id)))
  return pool.map(it => ({
    item: it,
    // Under forceAll the attribution itself is suspect, so every coder sees
    // every issue rather than a possibly-wrong slice.
    issues: attributed
      .filter(a => forceAll || a.owners.includes(it.id) || fileless.has(it.id) || (fallbackAll && a.owners.length === 0))
      .map(a => a.iss),
  }))
}

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
        required: ['id', 'title', 'instructions', 'files'],
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
    implicated_files: {
      type: 'array', items: { type: 'string' },
      description: 'Every file path that appears in the failure output, repo-relative when possible. Empty list if none appear.',
    },
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

// Identical raw-output blobs (per-file smoke issues share one evidence tail)
// collapse to a single copy in a coder's prompt instead of repeating 4KB each.
const dedupeOutputs = (list) => {
  const seen = new Set()
  return list.map(iss => {
    if (!iss.output) return iss
    if (seen.has(iss.output)) return { ...iss, output: '(same failing output as the issue above)' }
    seen.add(iss.output)
    return iss
  })
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
3. work_items — a decomposition into pieces that can be built IN PARALLEL. Critical constraint: each work item must OWN a disjoint set of files. Two items must never edit the same file, because coders run concurrently in a shared workspace and would clobber each other. ALWAYS fill each item's files array — list every file the item will create or edit (an empty array only for a genuinely non-file deliverable); targeted rework depends on this ownership map, and an item without files degrades rework to full re-runs. If the task cannot be cleanly split, return a single work item — that is correct and expected for small tasks.

Method: follow superpowers:writing-plans — invoke that skill if you can reach the Skill tool, and either way apply its core: write each work item as a bite-sized task for a coder who knows the domain but nothing about this codebase; fold TDD in so each item's acceptance is a failing test made to pass; DRY, YAGNI. Write the acceptance_criteria in FULL, precise, testable language — do NOT abbreviate or caveman-compress them; vague criteria make "green" unverifiable and defeat the whole loop.

Plan lazily (ponytail): the cheapest work item is the one that doesn't exist. Before including any item ask, in order — does this need to be built at all? does existing code in the repo, the standard library, a native platform feature, or an already-installed dependency cover it? does it collapse to a trivial change? Prefer the smallest plan that genuinely meets the acceptance criteria; do not plan abstractions, refactors, or "while we're here" work nobody asked for. Never trim at the expense of: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything explicitly requested.`

const buildPrompt = (item, fixList) => `You are a coder implementing ONE work item. Work only within the files this item owns; do not touch files owned by other items.

OVERALL TASK:
${TASK}

ACCEPTANCE CRITERIA (the whole task is graded on these):
${j(PLAN.acceptance_criteria)}

YOUR WORK ITEM:
${j(item)}
${fixList ? `\nThis is a RE-WORK pass. Independent reviewers rejected the previous attempt. These issues are already scoped to your files — fix each one:\n${j(dedupeOutputs(fixList))}\n` : ''}
Work test-first: invoke superpowers:test-driven-development if the Skill tool is available and follow it — write the failing test, watch it fail, then the minimal code to pass. That is how you know the test tests the right thing. ${fixList ? 'Since this is rework triggered by a reviewer failure, invoke superpowers:systematic-debugging (or apply it) and find the ROOT CAUSE before changing anything — a symptom patch that hides the real bug is a failure.' : ''}

Code lazily (ponytail — "the best code is the code you never wrote"). Before writing anything, walk this ladder in order: (1) does this need to exist at all? (2) does code already in this repo do it — reuse, don't rewrite; (3) does the standard library do it? (4) does a native platform feature cover it? (5) does an already-installed dependency solve it? (6) can it be one line? Only after all six: write minimum working code. No new abstractions, no unasked-for boilerplate, no extra dependencies; prefer deletion over addition. Be lazy about the solution, NEVER about reading — understand the problem fully first. When two equally small options exist, pick the edge-case-correct one. Mark intentional simplifications with a 'ponytail:' comment noting the ceiling and upgrade path. These are never negotiable and never trimmed: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, and anything the task explicitly asks for.

Actually make the edits in the workspace (Read/Edit/Write). Run the real tests/checks yourself and record the exact commands and their output in tests_run — do not claim a piece works without having run it. Then report what you changed.`

const smokePrompt = () => `You are a smoke-check runner. Run EXACTLY this command and report the result. Do not fix anything, do not edit any file, do not run any other command.

COMMAND:
${PLAN.smoke_command}

TASK (context only, for orientation — you are not implementing it):
${TASK}

Report green=true ONLY if the command exited with status 0 (append '; echo EXIT:$?' if needed to capture it). Include the exit code and the tail of the raw output as evidence — the raw output is what the coders will act on if red, so do not summarize it away.

Also fill implicated_files: list every file path that appears in the failure output (repo-relative when possible); empty list if none appear. Copy them from the output, do not infer paths that are not printed there.`

const verifyPrompt = (builds, lane, smokeEvidence, reworkNote) => `You are independent reviewer ${lane}. You are one of two reviewers grading this work SEPARATELY — you cannot see the other reviewer, and you should assume they may miss things, so do your own thorough pass. Be skeptical: your job is to catch problems before an expensive top-tier review is spent.

OVERALL TASK:
${TASK}

ACCEPTANCE CRITERIA — grade against EXACTLY these:
${j(PLAN.acceptance_criteria)}

WHAT THE CODERS REPORT THEY DID:
${j(builds)}
${smokeEvidence ? `\nOBJECTIVE CHECK ALREADY GREEN THIS CYCLE: '${PLAN.smoke_command}' exited 0, run by the smoke gate just before this review. Its evidence:\n${smokeEvidence}\nDo not re-run that same command just to re-prove exit 0 — spend your review inspecting the actual code and verifying the criteria that command does not cover. Criteria needing OTHER commands still require you to run them yourself.\n` : ''}${reworkNote ? `\nREWORK CYCLE. The previous round was rejected for these issues (raw failure output omitted). Verify EACH is now genuinely resolved, in addition to your own full pass over the criteria:\n${j(reworkNote.issues)}\nItems rebuilt this cycle: ${reworkNote.rebuilt.join(', ')}. All other items are unchanged since the previous round — focus fresh scrutiny on the rebuilt ones.\n` : ''}
Apply superpowers:verification-before-completion (invoke it if available): the iron law is NO pass without fresh verification evidence gathered in THIS review. You may not mark a criterion met unless you ran or inspected the actual test/command yourself and saw it pass — cite that evidence. Do not trust the coders' self-reports; open the real files and run the checks.

Pass ONLY if every acceptance criterion is genuinely met; default to pass=false when uncertain — a false green wastes the top model's time. Write each blocking issue in FULL precise detail: file:line, expected-vs-actual, and a concrete fix the next coder can act on directly. Do NOT compress or caveman these issue reports — the next cycle acts on exactly what you write, so specificity is the point.

The coders work under a minimal-code mandate (ponytail): an implementation that meets every criterion with the least code is CORRECT, not lazy. Do not raise issues demanding abstractions, patterns, configurability, or features beyond the acceptance criteria — that churns the loop on ideology instead of defects. The exceptions that ARE always blocking regardless of criteria: missing input validation at trust boundaries, error handling gaps that risk data loss, security holes, and accessibility failures.`

const blessPrompt = (builds, verdicts, reworkNote) => `You are the final authority, on the TOP-tier model. Two independent reviewers already passed this work; you are the last gate before it ships. This is the second and final moment an expensive model is spent here, so be comprehensive — look for whole-picture problems the per-item reviewers could miss: integration gaps, missed edge cases, whether the work truly satisfies the ORIGINAL intent (not just the letter of the criteria), regressions, and anything unsafe.

ORIGINAL TASK:
${TASK}

ACCEPTANCE CRITERIA:
${j(PLAN.acceptance_criteria)}

CODER REPORTS:
${j(builds)}

INDEPENDENT REVIEWER VERDICTS:
${j(verdicts)}
${reworkNote ? `\nTHIS IS A RE-REVIEW after a rework cycle. The issues that triggered the rework (verify EACH is genuinely resolved before anything else):\n${j(reworkNote.issues)}\nItems rebuilt: ${reworkNote.rebuilt.join(', ')}.\n` : ''}
Apply superpowers:verification-before-completion at the highest bar (invoke it if available): sign off only on evidence you gathered yourself in this pass — run the verification, don't inherit the reviewers' word for it. State what you ran. Inspect the real workspace state, not just the reports. The coders work under a minimal-code mandate (ponytail): judge whether the work meets the intent with the least code, not whether it's architecturally elaborate — but security, data-loss, trust-boundary, and accessibility gaps are always blocking. Pass ONLY if you would personally sign off on shipping this. If you reject, give concrete, fully-detailed fixes — the cheaper models will do the rework and you will review again.`

// --------------------------------- run ------------------------------------
const belowBudget = () => budget.total && budget.remaining() < BUDGET_FLOOR

let PLAN = PROVIDED_PLAN
if (A.plan && !PLAN) log('Provided plan invalid (missing/empty work_items or acceptance_criteria) — replanning from scratch.')
if (!PLAN) {
  phase('Plan')
  PLAN = await agent(planPrompt(), { label: `plan:${MODELS.top}`, phase: 'Plan', model: MODELS.top, schema: PLAN_SCHEMA })
  if (!PLAN) {
    log(`top model unavailable — retrying plan on ${MODELS.topFallback}.`)
    PLAN = await agent(planPrompt(), { label: `plan:${MODELS.topFallback}`, phase: 'Plan', model: MODELS.topFallback, schema: PLAN_SCHEMA })
  }
  if (!PLAN) return { status: 'error', error: 'planning failed', cycles: 0 }
} else {
  log('Approved plan provided. Skip Fable plan phase — no top-model tokens spent.')
}
// Uniquify item ids (missing OR duplicated — the schema requires id but not
// uniqueness, and a synthesized id could collide with a hand-written one).
// Duplicates would collapse buildsById entries, silently dropping a coder's
// report from what the reviewers see, and cross-wire issue targeting.
{
  const seen = new Set()
  PLAN.work_items.forEach((it, i) => {
    let id = String(it.id || '') || `item-${i + 1}`
    while (seen.has(id)) id = `${id}-dup`
    seen.add(id)
    it.id = id
  })
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
let errMsg = null
let cycle = 0
// Latest build result per work item, persisted across cycles so a targeted
// rework carries untouched items forward instead of rebuilding them.
const buildsById = new Map()
// Items that already completed the CURRENT round's build. Non-empty only after
// a dead-coder retry cycle: the next cycle rebuilds just the missing items
// instead of re-spawning every coder over work already in the workspace.
const doneThisRound = new Set()
// Smoke-attribution state machine: 'fresh' (may target), 'targeted' (last red
// was handled by targeted attribution — another red means the attribution was
// wrong, escalate), 'escalated' (STAY on full re-runs; no targeted/full
// ping-pong). Only a smoke pass resets to 'fresh'.
let smokeMode = 'fresh'
// Consecutive red smoke checks. Three in a row (one targeted attempt + two
// full re-runs) means the command itself may be unfixable by any coder (bad
// cwd, missing dep nobody owns) — stop as 'stalled' instead of burning the
// remaining cycles on full-team rebuilds. Reset on green; a dead smoke agent
// changes nothing (no new information).
let smokeReds = 0
// Green smoke evidence from THIS cycle, handed to the reviewers so they don't
// burn tokens re-running a command a cheaper agent already proved exits 0.
let smokeEvidence = null
// Verify/bless stall detection. "Stall" = consecutive rejections implicate the
// same PLACES with no drop in issue count: one repeat escalates to a full
// re-run (every coder, every issue); a second repeat after that stops as
// 'stalled'. A shrinking issue count is progress and resets the counter, so a
// single-work-item task grinding 5 -> 2 -> 1 issues in the same file is never
// mistaken for a stall. The tracker resets whenever a gate PASSES — otherwise
// bless's first-ever rejection could inherit verify's repeat count and be
// swallowed as a stall without any coder ever seeing it (a skipped fix).
let lastSig = null
let lastCount = Infinity
let sigRepeats = 0
let forceFullRework = false
const resetStall = () => { lastSig = null; lastCount = Infinity; sigRepeats = 0; forceFullRework = false }
// Fingerprint on the STABLE parts of an issue: the implicated file, else the
// acceptance criterion (a fixed list, so its prose is stable across cycles),
// else normalized `where`. Fresh reviewer agents reword free prose every
// cycle, so raw problem text never matches.
const issueSig = (list) => JSON.stringify([...new Set(list.map(i =>
  issueFile(i) || norm(i.criterion) || norm(i.where)))].sort())
// Returns true when the loop should stop.
const trackStall = (list, cycle) => {
  const sig = issueSig(list)
  if (sig === lastSig && list.length >= lastCount) sigRepeats++
  else sigRepeats = 0
  lastSig = sig
  lastCount = list.length
  if (sigRepeats >= 2) return true
  forceFullRework = sigRepeats === 1
  if (forceFullRework) log(`cycle ${cycle}: same places failing with no progress — escalating to full re-run, all issues to all coders.`)
  return false
}

while (cycle < MAX_CYCLES) {
  if (belowBudget()) { status = 'budget-stopped'; log(`Stop. Token floor hit before cycle ${cycle + 1}.`); break }
  cycle++

  // BUILD — parallel Sonnet. First cycle builds every work item; rework cycles
  // re-run only the coders whose files the reviewers' issues implicate, each fed
  // just its own issues, and carry every other item's prior build forward.
  phase('Build')
  const items = PLAN.work_items
  let jobs = planRework(items, fixList, forceFullRework)
  // Resuming after a dead-coder cycle: only the items that didn't finish that
  // round rebuild; the ones that did keep their fresh builds.
  if (doneThisRound.size) jobs = jobs.filter(jb => !doneThisRound.has(jb.item.id))
  // What this round reworked (both halves, when split by a retry), handed to
  // the reviewers so they verify the fixes specifically instead of
  // cold-reviewing everything from scratch. Output blobs stripped — reviewers
  // gather their own evidence.
  const reworkNote = fixList ? {
    rebuilt: [...new Set([...doneThisRound, ...jobs.map(jb => jb.item.id)])],
    issues: fixList.map(({ output, ...rest }) => rest),
  } : null
  if (fixList) log(`cycle ${cycle}: rework ${jobs.length}/${items.length} item(s); ${items.length - jobs.length} carried forward. [${fmtK(spentSoFar())} tok]`)
  const ran = await parallel(jobs.map(({ item, issues }, i) => () =>
    agent(buildPrompt(item, issues), { label: `build:${item.id || i}`, phase: 'Build', model: MODELS.coder, schema: BUILD_SCHEMA })))
  // Retry dead coders once, in parallel.
  const deadIdx = ran.map((b, k) => b ? -1 : k).filter(k => k >= 0)
  if (deadIdx.length) {
    const retried = await parallel(deadIdx.map(k => () =>
      agent(buildPrompt(jobs[k].item, jobs[k].issues), { label: `build:${jobs[k].item.id || k}:retry`, phase: 'Build', model: MODELS.coder, schema: BUILD_SCHEMA })))
    retried.forEach((b, i) => { if (b) ran[deadIdx[i]] = b })
  }
  ran.forEach((b, k) => {
    if (!b) return
    const it = jobs[k].item
    buildsById.set(it.id || it.title || k, b)
    // Fold what the coder actually touched into its ownership: newly created
    // files (its tests, helpers) become attributable to their author instead of
    // forcing a full re-run when a later issue names them. This also gives an
    // initially file-less item real ownership after its first build. A changed
    // file already owned by ANOTHER item is a disjointness violation — warn,
    // don't adopt it.
    for (const raw of (b.changed_files || [])) {
      const f = String(raw).replace(/^\.\//, '')
      if (!f || itemFiles(it).includes(f)) continue
      const other = ownersOf(f, items).filter(o => o !== it)
      if (other.length) log(`warning: ${it.id} changed ${f}, owned by ${other[0].id} — disjoint-files invariant violated.`)
      else (it.files = it.files || []).push(f)
    }
  })
  lastBuilds = [...buildsById.values()]
  log(`cycle ${cycle}: ${ran.filter(Boolean).length}/${jobs.length} coder(s) done, ${lastBuilds.length}/${items.length} item(s) built. [${fmtK(spentSoFar())} tok]`)
  // A coder still dead after its retry means this build is knowingly incomplete —
  // grading it wastes smoke/review spend. Re-run the cycle: fixList and
  // forceFullRework are left untouched so the next cycle re-plans the same
  // round, and doneThisRound narrows it to just the missing items; MAX_CYCLES
  // bounds the retries.
  if (ran.some(b => !b)) {
    ran.forEach((b, k) => { if (b) doneThisRound.add(jobs[k].item.id) })
    history.push({ cycle, gate: 'build', pass: false })
    log(`cycle ${cycle}: ${ran.filter(b => !b).length} coder(s) unresponsive after retry — skip grading, retrying just those. [${fmtK(spentSoFar())} tok]`)
    continue
  }
  doneThisRound.clear()
  forceFullRework = false

  // SMOKE — optional Haiku tripwire between Build and Verify. If the plan
  // defined an objective check and it fails, both Opus reviewers are skipped
  // this cycle: paying mid-tier review tokens to confirm what a failing
  // command already proves is waste. Haiku only runs the command and reports
  // the raw result — no judgement, no fixes — so the cheapest model gets the
  // most mechanical job. A green smoke still goes through full Opus review,
  // so this adds no false-green risk.
  smokeEvidence = null
  if (PLAN.smoke_command) {
    phase('Smoke')
    let smoke = await agent(smokePrompt(), { label: 'smoke:haiku', phase: 'Smoke', model: MODELS.smoke, schema: SMOKE_SCHEMA })
    if (!smoke) smoke = await agent(smokePrompt(), { label: 'smoke:haiku:retry', phase: 'Smoke', model: MODELS.smoke, schema: SMOKE_SCHEMA })
    if (!smoke) {
      // Smoke agent died twice. The check never ran — do NOT record a pass. Fall
      // through to Opus, which verifies the criteria itself anyway; smokeMode is
      // left untouched since no new smoke information exists.
      history.push({ cycle, gate: 'smoke', pass: null })
      log(`cycle ${cycle}: smoke agent unavailable — gate skipped, Opus verifies. [${fmtK(spentSoFar())} tok]`)
    } else if (!smoke.green) {
      // TARGETED_SMOKE_REWORK_V2 — a red smoke check names files in its output;
      // map those to the work items that own them and re-run only those coders,
      // instead of re-running every coder over a nameless issue. The agent's
      // implicated_files lists only failure paths; the regex sweep of the raw
      // evidence also catches passing-test noise (a runner summary lists every
      // file it ran), so the sweep is a deterministic BACKSTOP used only when the
      // agent's list maps to nothing — not unioned in every time. If no named
      // path maps to an item, or the state machine says a targeted attempt
      // already failed, fall back to the nameless issue, which planRework()
      // turns into a full re-run.
      const evidence = (smoke.evidence || '').slice(0, 4000)
      const keepOwned = (paths) => [...new Set(paths.map(f => String(f).replace(/^\.\//, '')).filter(Boolean))]
        .filter(p => ownersOf(p, PLAN.work_items).length > 0)
      let owned = smokeMode === 'fresh' ? keepOwned(smoke.implicated_files || []) : []
      if (smokeMode === 'fresh' && !owned.length) owned = keepOwned(extractPaths(smoke.evidence))
      fixList = owned.length ? owned.map(f => ({
        problem: `Objective check failed: ${PLAN.smoke_command} — failure implicates this file`,
        where: f,
        fix: 'Make this command pass. Its raw failing output follows — work from it.',
        output: evidence,
      })) : [{
        problem: `Objective check failed: ${PLAN.smoke_command}`,
        where: 'smoke gate (pre-review)',
        fix: 'Make this command pass. Its raw failing output follows — work from it.',
        output: evidence,
      }]
      smokeMode = smokeMode !== 'fresh' ? 'escalated' : (owned.length ? 'targeted' : 'fresh')
      smokeReds++
      history.push({ cycle, gate: 'smoke', pass: false, targeted: owned })
      if (smokeReds >= 3) {
        status = 'stalled'
        log(`cycle ${cycle}: smoke red ${smokeReds} cycles running — the check may be unfixable by the coders, stopping. [${fmtK(spentSoFar())} tok]`)
        break
      }
      log(`cycle ${cycle}: smoke RED${owned.length ? ` — implicates ${owned.join(', ')}` : ' — no targeted attribution, full re-run'}. Skip Opus, back to Sonnet. [${fmtK(spentSoFar())} tok]`)
      continue
    } else {
      smokeMode = 'fresh'
      smokeReds = 0
      smokeEvidence = (smoke.evidence || '').slice(0, 2000)
      history.push({ cycle, gate: 'smoke', pass: true })
      log(`cycle ${cycle}: smoke green. [${fmtK(spentSoFar())} tok]`)
    }
  }

  // VERIFY — two independent Opus reviewers; both must pass.
  if (belowBudget()) { status = 'budget-stopped'; log(`cycle ${cycle}: token floor hit before review.`); break }
  phase('Verify')
  const reviewOnce = (lane, tag) => agent(verifyPrompt(lastBuilds, lane, smokeEvidence, reworkNote),
    { label: `verify:opus-${lane}${tag || ''}`, phase: 'Verify', model: MODELS.reviewer, schema: VERDICT_SCHEMA })
  // A dead reviewer, or a fail that names zero actionable issues, would send the
  // loop into a rework cycle with an empty fix list — retry that lane once.
  const review = async (lane) => {
    let [v] = await parallel([() => reviewOnce(lane)])
    if (!v || (!v.pass && collectIssues([v]).length === 0)) [v] = await parallel([() => reviewOnce(lane, ':retry')])
    return v
  }
  // First build reviews in parallel. Rework cycles run the lanes sequentially:
  // green needs BOTH, so when A fails, B's tokens are pure waste — fail-fast
  // halves reviewer spend on red cycles at some wall-clock cost.
  let vA, vB
  if (fixList) {
    vA = await review('A')
    vB = (vA && vA.pass) ? await review('B') : null
  } else {
    ;[vA, vB] = await parallel([() => review('A'), () => review('B')])
  }
  const opusGreen = vA && vB && vA.pass && vB.pass
  if (!opusGreen) {
    fixList = collectIssues([vA, vB])
    if (fixList.length === 0) {
      // Red gate with nothing to act on: reviewers died or refused to name
      // issues, twice each. Rework can't proceed — stop honestly.
      status = 'error'
      errMsg = 'reviewer gate unavailable: reviewers died or named no actionable issues, twice each'
      log(`cycle ${cycle}: reviewer gate unavailable (agent failures, no actionable issues). Stopping.`)
      break
    }
    if (trackStall(fixList, cycle)) {
      status = 'stalled'
      history.push({ cycle, gate: 'verify', pass: false, issue_count: fixList.length })
      log(`cycle ${cycle}: same issues three cycles running — loop cannot converge, stopping. [${fmtK(spentSoFar())} tok]`)
      break
    }
    history.push({ cycle, gate: 'verify', pass: false, issue_count: fixList.length })
    log(`cycle ${cycle}: Opus gate FAIL. ${fixList.length} issue(s). Back to Sonnet, no Fable. [${fmtK(spentSoFar())} tok]`)
    continue
  }
  history.push({ cycle, gate: 'verify', pass: true })
  // Gate passed: the old fix list is confirmed resolved — clear it so a later
  // green-unblessed stop doesn't report fixed issues as outstanding, and reset
  // the stall tracker so a first bless rejection starts from a clean slate
  // instead of inheriting verify's repeat count.
  fixList = null
  resetStall()

  // BLESS — single Fable review. Only reached when both reviewers already agree.
  if (belowBudget()) { status = 'green-unblessed'; log(`cycle ${cycle}: Opus green but token floor hit. Skip Fable bless.`); break }
  phase('Bless')
  let bless = await agent(blessPrompt(lastBuilds, [vA, vB], reworkNote), { label: `bless:${MODELS.top}`, phase: 'Bless', model: MODELS.top, schema: VERDICT_SCHEMA })
  if (!bless) {
    log(`top model unavailable — retrying bless on ${MODELS.topFallback}.`)
    bless = await agent(blessPrompt(lastBuilds, [vA, vB], reworkNote), { label: `bless:${MODELS.topFallback}`, phase: 'Bless', model: MODELS.topFallback, schema: VERDICT_SCHEMA })
  }
  if (!bless) {
    // Both reviewers already passed; a dead bless agent should not trigger an
    // empty-fix-list rework. Report the honest state and stop.
    status = 'green-unblessed'
    log(`cycle ${cycle}: bless agent unavailable after fallback — Opus-green, unblessed.`)
    break
  }
  if (bless.pass) {
    status = 'green'
    history.push({ cycle, gate: 'bless', pass: true })
    log(`cycle ${cycle}: GREEN. Bless done. [${fmtK(spentSoFar())} tok total]`)
    break
  }
  fixList = collectIssues([bless])
  if (fixList.length === 0) {
    // Rejected but named nothing actionable — rework can't act on that.
    status = 'green-unblessed'
    log(`cycle ${cycle}: bless rejected without actionable issues — Opus-green, unblessed. Review its summary manually.`)
    break
  }
  if (trackStall(fixList, cycle)) {
    status = 'stalled'
    history.push({ cycle, gate: 'bless', pass: false, issue_count: fixList.length })
    log(`cycle ${cycle}: same issues three cycles running — loop cannot converge, stopping. [${fmtK(spentSoFar())} tok]`)
    break
  }
  history.push({ cycle, gate: 'bless', pass: false, issue_count: fixList.length })
  log(`cycle ${cycle}: bless reject. ${fixList.length} issue(s). Back to Sonnet. [${fmtK(spentSoFar())} tok]`)
}

return {
  status,                    // planned | green | green-unblessed | budget-stopped | stalled | exhausted | error
  error: errMsg ?? undefined,
  cycles: cycle,
  plan: PLAN,
  final_builds: lastBuilds,
  outstanding_issues: status === 'green' ? [] : (fixList || []),
  history,
  tokens_spent: spentSoFar(),   // output tokens this run (turn-delta; see SPENT0 note)
}
