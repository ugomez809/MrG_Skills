---
name: ug-coding-loop
description: >-
  Runs a tiered, multi-model build-and-verify loop that spends expensive models
  sparingly. The top model (Fable) plans and gives the final sign-off; cheap
  parallel Sonnet agents do the actual building; two independent Opus reviewers
  gate every cycle; on failure it loops Sonnet→Opus (never re-spending the top
  model) up to a cycle cap. Use this WHENEVER the user wants a task built and
  verified by multiple models, mentions a "loop", "model ladder", "tiered
  agents", "cheap models to build and expensive to review", "audit then code
  then verify", "parallel coders", "independent reviewers", or asks to
  orchestrate several models to maximize quality while minimizing spend on the
  strongest model. Default to this skill for any "build it, then have other
  models check it" request even if the user doesn't name the models — especially
  for coding tasks, but it works for any deliverable that can be graded against
  acceptance criteria.
compatibility: >-
  Needs the Workflow tool (deterministic multi-agent orchestration) with
  per-agent model routing. Falls back to the Agent tool if Workflow is
  unavailable. Model aliases fable/opus/sonnet/haiku must resolve in the
  environment (haiku powers the smoke gate).
---

# Model Ladder Loop

## What this is for

The user wants a task done by a *ladder* of models rather than one: the smartest,
most expensive model is reserved for the two moments where its judgement matters
most — planning and final sign-off — while cheaper models do the high-volume
work of building and reviewing. The explicit goal is quality **and** minimizing
how many tokens the top model burns. Everything here is built around that
tradeoff.

The ladder, cheapest-used-most to most-expensive-used-least:

- **Haiku** — the tripwire. Runs the plan's objective check command after each
  build round and reports the raw result. Red skips the expensive reviewers for
  that round. No judgement, no fixes — the cheapest model gets the most
  mechanical job. Only active when the plan defines a runnable check.
- **Sonnet** — the workhorse. Writes the code / builds the deliverable, in
  parallel across independent pieces. Runs every cycle.
- **Opus** — the gate. Two independent reviewers grade each cycle against the
  acceptance criteria. Both must pass.
- **Fable** — the authority. Plans the work up front and gives one final blessing
  at the end. Appears at exactly two points and *never inside the retry loop*.

## The loop, precisely

```
Fable: audit + plan + acceptance criteria + file-disjoint work items   (once)
  │
  ▼
┌─ cycle (max 10, stall-guarded) ───────────────────────────────┐
│ Sonnet ×N (parallel): build/rework the work items             │
│ Haiku (if plan has smoke_command): run the objective check     │
│   • check fails → raw output → next cycle                      │
│     (back to Sonnet; NO Opus, NO Fable spent)                  │
│ Opus ×2 (independent): grade against acceptance criteria       │
│   • either reviewer fails → collect issues → next cycle        │
│     (back to Sonnet; NO Fable spent)                           │
│   • both pass → Fable final review                             │
│       • Fable passes → GREEN, done                             │
│       • Fable rejects → collect issues → next cycle            │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
Report: status, cycles used, what shipped, any outstanding issues
```

**Targeted rework — only the implicated coders re-run.** A rework cycle does not
re-spawn every coder. Each reviewer issue names a file; the loop maps that file
to the work item that owns it (work items own disjoint files, so a full path
maps to one item; an ambiguous bare name may match several, all of which
re-run — safe, mildly wasteful) and re-runs only those coders, each handed just
its own issues. Every
untouched item carries its previous build forward — reviewers still grade the
merged whole.

Smoke failures attribute the same way. A red command prints file paths — stack
frames, compiler errors, failing-test headers — so the loop takes the paths
Haiku reports in `implicated_files` (failure paths only), falls back to a
deterministic regex sweep of the raw output when that list maps to nothing,
keeps the ones that map to a work item, and files one issue per file. Only the
owning coders re-run.

Two escape hatches keep the "never skip a needed fix" guarantee:

- **No path maps to a work item** (a segfault with no trace, a failure naming
  only vendored files, a plan whose items declared no files, or a reviewer issue
  that names a component instead of a file) → the loop files one nameless issue
  and re-runs all coders.
- **The same smoke check fails twice in a row** → the file showing the symptom
  wasn't the file causing it, so the second failure escalates to a full re-run
  regardless of what the output names — and *stays* escalated (no targeted/full
  ping-pong) until a smoke pass resets the tracker. A **third** consecutive red
  stops the run as `stalled`: the command itself may be unfixable by any coder
  (a typo'd working directory, a missing dependency nobody owns), and burning
  the remaining cycles on full-team rebuilds won't change that.

This is the disjoint-files invariant paying off twice: it makes parallel building
safe AND makes targeted rework safe, and it's the biggest per-cycle token saver
after the first build.

More design choices worth understanding, because they are what make this cheap:

1. **Fable is bookended, not looped.** The expensive model runs once to plan and
   once (per green) to bless. Rework cycles are Sonnet→Opus only. If Opus is a
   strict gate, Fable is reached rarely and rejects even more rarely — so the top
   model's token cost stays near its floor of two calls.

2. **Opus is unanimous.** Green requires *both* independent reviewers to pass. A
   false green is expensive here — it wastes a Fable call — so the gate is
   deliberately conservative. Two reviewers who cannot see each other catch
   correlated mistakes a single reviewer would wave through. On rework cycles
   the two lanes run sequentially — the second reviewer only spawns if the
   first passes, since one fail already sends the cycle back to Sonnet. That
   halves reviewer spend on red cycles; first builds still review in parallel.
   When the smoke gate is green, reviewers receive its evidence so they don't
   re-run the same command just to re-prove exit 0.

3. **Haiku guards Opus the way Opus guards Fable.** Each Opus review round costs
   roughly 15–20× a Haiku smoke run. When a build is objectively broken (the
   test command exits red), the smoke gate catches it for a few thousand tokens
   and loops straight back to Sonnet with the raw failure output. Haiku is
   trusted with exactly one judgement — "did the command exit 0" — and nothing
   else: it never codes, never reviews, never fixes. That's why it's safe at the
   bottom of the ladder. A green smoke still gets full Opus review, so it can
   save tokens but never leak a false green.

4. **Rework reviews are focused, and stalls are detected.** On rework cycles the
   reviewers receive the rejected issues and which items were rebuilt, so they
   verify the fixes specifically instead of cold-reviewing from scratch. And the
   loop watches for non-convergence: when consecutive rejections implicate the
   same places with *no drop in issue count* (issue prose varies between fresh
   reviewer agents, so the stable fingerprint is the implicated files — or the
   acceptance criterion for pathless issues — plus whether the count shrank),
   it escalates once to a full re-run (every issue to every coder); a repeat
   after that stops the run as `stalled`. A shrinking issue count always
   counts as progress and resets the tracker, and so does any gate passing —
   cycles are only spent while they're actually buying progress toward green. Ownership also *grows* as coders work: files a coder
   creates (its tests, helpers) are folded into its item, so later issues
   naming them stay attributable, and a coder touching another item's file
   logs a disjointness warning.

## How to run it

The loop is implemented as a bundled Workflow script so the looping, retry state,
and model routing are **deterministic** — prose instructions to "loop back on
failure" get executed unreliably, and a silent non-looping loop is the worst
outcome here. Run the script rather than hand-orchestrating.

1. Gather the task and any context the planner needs (repo path, the feature
   spec, the file the user pointed at, etc.). The richer the input, the better
   Fable's plan and acceptance criteria.

2. Create the **task checklist** before launching, so the user gets a durable,
   ticking summary alongside the live workflow tree (see "Progress display"
   below). Create these items with `TaskCreate` (six, or five when the plan has
   no smoke_command), mirroring the phase names so the two boxes read
   consistently:

   - `Plan & acceptance criteria (Fable)`
   - `Build in parallel (Sonnet)`
   - `Smoke check (Haiku)` — include only when the plan defines a smoke_command
   - `Independent verification (2× Opus)`
   - `Final sign-off (Fable)`
   - `Report outcome, run time & tokens`

   Mark the first item `in_progress` right before you launch the workflow.

3. **The plan gate — one approval per task, never per agent.** On a task's
   first run, invoke the script in plan-only mode so the user reads the plan
   before any build agent spends a token:

   ```
   Workflow({
     scriptPath: "<this-skill-dir>/scripts/build_verify_loop.js",
     args: {
       task: "<the full task description>",
       context: "<optional: repo path, constraints, links, prior decisions>",
       mode: "plan-only"
     }
   })
   ```

   This spends exactly one Fable call and returns `{ status: 'planned', plan }`.
   Present the plan to the user in two layers: `plan.plain_english` verbatim (the
   jargon-free version), then the technical layer — acceptance criteria and work
   items. Ask ONE approval (AskUserQuestion: approve / adjust). If the user asked
   for changes, edit the plan object directly or re-run plan-only with their
   feedback in `context` — then proceed.

   If the user already pre-approved the whole run in their request ("just run
   it", "full send", a scheduled/unattended session), show the plain-English plan
   as you go but do NOT block on the question — proceed immediately.

4. Run the full loop, passing the approved plan so Fable's plan phase is skipped
   (no second planning spend):

   ```
   Workflow({
     scriptPath: "<this-skill-dir>/scripts/build_verify_loop.js",
     args: {
       task: "<same task>",
       context: "<same context>",
       plan: <the approved plan object from step 3>,
       maxCycles: 10,         // optional; defaults to 10
       minBudgetFloor: 40000  // optional; stop early if token headroom drops below this
     }
   })
   ```

   From here the loop is fully autonomous: build, verify, bless, retry — no
   further approvals. Never interrupt cycles to ask the user anything; the whole
   point of the gate is that approval happened once, up front.

   `args` may also be a bare string if you only have the task text and the user
   pre-approved (this skips the gate entirely and plans+runs in one go).

   Pass `args` as an actual JSON object, not a JSON-encoded string. Some
   delivery paths stringify it anyway (observed in validation: options like
   `mode` were silently dropped and the full loop ran when the gate was
   expected). The script now self-heals by parsing stringified object args, but
   don't rely on that — pass real JSON.

   Calling Workflow from these skill instructions is the user's explicit opt-in to
   multi-agent orchestration — you do not need to ask again.

5. When the workflow returns, first **reconcile the checklist** from the result's
   `status` and `history`, then report. The workflow ran in the background as one
   unit, so you update the checklist in a burst here rather than live — mark
   completed the stages the `history` shows were reached (Plan always; Build and
   Verify once any cycle passed them; Final sign-off if `status` is `green`), and
   for a non-green status leave the stage it stalled on `in_progress` with the
   outstanding issues noted, so the checklist itself shows where it stopped.
   Finish by marking `Report outcome` completed after you summarize.

   Report to the user in caveman style (see "Communication style" below) from the
   result object:
   - `status`: `green` (blessed), `exhausted` (hit the cycle cap still red),
     `stalled` (the same issues came back three cycles running — the loop
     cannot converge on its own; hand the outstanding issues to the user),
     `budget-stopped` / `green-unblessed` (stopped on the token floor, or the
     bless agent was unavailable / named nothing actionable), or `error`.
   - `cycles`: how many build→verify rounds it took.
   - `final_builds`: what the coders changed (the edits are already in the
     workspace).
   - `outstanding_issues`: for any non-green status, the concrete fixes still
     open — surface these so the user can decide whether to run more cycles or
     take over.
   - `history`: the per-gate pass/fail trail, useful if the user asks why it
     looped.

   The actual code changes live in the workspace already — the coders edited real
   files. Do not re-describe every diff; give the status, the cycle count, and
   the outstanding issues, and point to the changed files.

## Run timing & token accounting

The user wants to know, for every run of this skill: how long it ran and how
many tokens it used — live while it runs, and exactly in the final report. The
mechanics:

**Before launching** (each workflow call — the plan-only run and the full run),
record wall-clock start with `date +%s.%N` via Bash. Workflow scripts cannot
read the clock themselves (Date.now is disabled in them), so the main thread
owns wall time.

**While running**, the live view is the workflow progress tree (`/workflows`):
each agent shows its elapsed time and token count as it runs, and the script's
narrator lines carry cumulative token checkpoints (e.g. `cycle 2: smoke green.
[131k tok]`). Tell the user this is where to watch — a live-ticking timer in the
chat itself is not something the interface can stream, so don't pretend
otherwise; point at the tree.

**After completion**, the harness returns exact numbers — use them rather than
estimating: `duration_ms` and total subagent tokens arrive with the task
notification/result, per-agent `tokens` and `durationMs` are in the progress
data, and the result object's `tokens_spent` is the script's own turn-delta
count. Units matter: the live `[Nk tok]` checkpoints and `tokens_spent` count
OUTPUT tokens only (what the models wrote — a live directional gauge), while
the harness per-agent and total numbers include input context too, so the
final total is much larger than the last live checkpoint. Report the harness
total as "total tokens"; never present the two as the same measure. The final
report to the user always ends with a stats line covering the whole skill
invocation:

```
Run stats: 4m 12s wall · 214k tokens · 5 agents · 1 cycle
  plan (fable)      56s   35k
  build (sonnet ×1) 28s   41k
  smoke (haiku)      6s    3k
  verify (opus ×2)  53s   75k
  bless (fable)     90s   45k
```

When the run was split across the plan gate (plan-only workflow + approval +
full workflow), report each part and the combined total, and note that human
approval wait time is excluded — count only workflow runtime. Numbers come from
the harness; never invent or round them into fiction.

## Progress display — the two boxes

Running this skill shows the user two complementary progress views. They are
driven by different mechanisms, and it's worth knowing which does what so you
don't try to make one do the other's job.

- **The workflow progress tree** (`/workflows`) is the *live* view. The Workflow
  engine renders it automatically from the `phases` block in the script's `meta`
  and the `phase()` / `log()` calls in the body. It updates in real time, shows
  each model-agent (`plan:fable`, `build:*`, `verify:opus-A/B`, `bless:fable`) as
  a row under its phase, and — importantly — correctly reflects the loop
  *repeating* across cycles. Nothing extra is needed to produce it; it appears
  every run.

- **The task checklist** is the *durable summary* the main thread manages via
  `TaskCreate` / `TaskUpdate` (step 2 and step 4 above). Because the whole loop
  runs as a single background workflow, the main thread only gets one completion
  signal — so the checklist fills in at milestones (created up front, reconciled
  at the end), not tick-by-tick. Its value is that it persists after the run and
  shows the final outcome at a glance, including where things stalled if the loop
  didn't go green.

Keep the checklist coarse (these phase-level items only). Do **not** poll the
running workflow to make the checklist tick live — that spends main-model tokens
on polling for a cosmetic gain, which fights the whole point of this skill. If
the user explicitly asks for a live-ticking checklist and accepts the cost, then
(and only then) poll the background task's progress between updates; otherwise
the live view is the workflow tree and the checklist is the summary.

## Superpowers integration (phase-mapped, not blanket)

Each phase pulls in the ONE superpowers skill that fits what that phase is doing —
"depending on what is being performed," not all skills every run. Each phase
agent is told to invoke its mapped skill via the Skill tool *and* has the skill's
core principle baked into its prompt, so the behavior holds even if a subagent
can't reach the Skill tool. The mapping:

| Phase | Superpowers skill | Why it fits |
|-------|-------------------|-------------|
| Plan (Fable) | `writing-plans` | Bite-sized, independently-buildable tasks with TDD folded in — exactly the file-disjoint decomposition this loop needs. |
| Build (Sonnet) | `test-driven-development` | Test-first is how "green" becomes real: watch it fail, make it pass. |
| Build rework (Sonnet) | `systematic-debugging` | On a reviewer-triggered failure, find root cause before patching — no symptom fixes. |
| Verify (Opus ×2) | `verification-before-completion` | The iron law "no pass without fresh evidence" is the anti-false-green rule this gate exists to enforce. |
| Bless (Fable) | `verification-before-completion` | Same law at the highest bar — sign off only on evidence Fable gathered itself. |
| Worktree path | `using-git-worktrees` | Only if the user opts into isolated parallel edits to shared files. |
| End of run | `finishing-a-development-branch` | Only if the task is a dev branch to be merged/PR'd. |

Deliberately **excluded** from the loop, and why — because adding them degrades it:

- `brainstorming` — an interactive interview (questions one at a time) with a
  hard gate that blocks all implementation until a human approves the design, on
  every project. The loop's plan gate (step 3) already gives the user what they
  actually need — read the finished plan once, approve once — without the
  interview or the repeated gating. Use brainstorming only *before* starting the
  loop, when the task itself is still fuzzy and the user wants to be interviewed
  into a spec; never inside the loop.
- `dispatching-parallel-agents`, `subagent-driven-development`, `executing-plans`,
  `requesting-code-review` — these *are* what the Workflow already does (parallel
  dispatch, staged execution with review gates). Nesting them means two
  orchestrators fighting, or reviewers spawning reviewers. Their rigor is folded
  into the phase prompts instead of invoked recursively.
- `using-superpowers`, `writing-skills` — meta; irrelevant to running the loop.

If the user genuinely wants *every* superpowers skill invoked every run, that's a
one-line change to the prompts — but say plainly that it adds input-token cost
(each skill's file loads into that agent's context) and risks the conflicts
above, which cuts against the minimize-spend goal.

## Ponytail integration (minimal-code mandate, inlined)

The loop bakes in the ponytail philosophy ("the best code is the code you never
wrote" — MIT-licensed, github.com/DietrichGebert/ponytail) rather than depending
on the plugin being installed. Workflow subagents receive only their scripted
prompts, so a ponytail installation on the user's machine never reaches inside
the loop — the ladder is therefore written directly into the prompts:

- **Planner**: the cheapest work item is the one that doesn't exist — prefer the
  smallest plan that meets the criteria; no unasked-for refactors or
  abstractions.
- **Coders**: walk the six-rung ladder before writing (need to exist → reuse
  repo code → stdlib → platform feature → installed dependency → one line →
  only then minimal code). Lazy about the solution, never about reading.
  Intentional simplifications get a `ponytail:` comment with ceiling + upgrade
  path.
- **Reviewers & bless**: minimal code that meets every criterion is CORRECT, not
  a finding — don't demand architecture beyond the criteria. This line matters:
  without it, minimalist coders and maximalist reviewers churn the loop on
  ideology instead of defects.
- **Never trimmed, at any rung**: trust-boundary input validation, error
  handling that prevents data loss, security, accessibility, and anything
  explicitly requested.

Why this is here at all: less code means smaller diffs, smaller review surface,
fewer issues per cycle, fewer cycles — it compounds with the token ladder.

Do NOT invoke ponytail's own callable skills (`ponytail-review`, `ponytail-audit`,
etc.) inside the loop — they are a second review harness that would fight the
Opus gate, the same conflict as `requesting-code-review`. On the main thread
outside the loop they compose fine.

## Communication style (caveman)

caveman compresses *communication*, so it belongs only where communication is the
product — never where precision is:

- **On** (compressed): the live `log()` narration in the workflow tree, and the
  main thread's final summary to the user. These are already terse and lose
  nothing by dropping filler.
- **Off** (kept precise): Fable's acceptance criteria, the Opus reviewers' issue
  reports, and the fix-lists that feed rework. These are load-bearing — the next
  coding cycle acts on exactly their wording. The phase prompts explicitly tell
  the agents NOT to caveman these. Compressing them would quietly gut the loop's
  quality while saving tokens in the one place you shouldn't.

When reporting the result to the user, write the summary in caveman style (this
matches the user's standing preference and keeps the wrap-up tight): status,
cycles, changed files, outstanding issues — no filler.

## Tuning the ladder

All model routing lives in one place — the `MODELS` constant at the top of
`scripts/build_verify_loop.js`:

```js
const MODELS = { top: 'fable', topFallback: 'opus', coder: 'sonnet', reviewer: 'opus', smoke: 'haiku' }
```

The aliases resolve in the harness to the **newest available version** of each
tier — fable, then the latest Opus, latest Sonnet, latest Haiku. Never pin a
dated model ID here; an alias keeps the loop on the best version of each tier
automatically when new models ship. When the top model is unavailable, plan and
bless retry once on `topFallback` (the next-best tier) instead of failing the
run — the coder stays on Sonnet regardless. Swap these only if the user's
environment uses different names; change nothing else — every stage reads from
this constant.

Knobs the user is likely to ask about:

- **Fewer/more cycles:** `maxCycles` (default 10). Lower it to cap cost harder,
  raise it (or set it very high) to let the loop genuinely run until green —
  that's safe because two other brakes exist: the budget floor, and the stall
  guard. When consecutive rejections implicate the same places with no drop in
  issue count, the loop escalates once to a full re-run with every issue
  handed to every coder; a repeat after that stops as `stalled` instead of
  burning cycles it cannot convert (three consecutive red smoke checks stop
  the same way). So cycles are only spent while the loop is actually
  converging.
- **Harder cost ceiling:** `minBudgetFloor` plus a turn budget target. The loop
  checks remaining headroom before each cycle and before spending Fable, and
  stops cleanly instead of starving the rest of the turn.
- **More parallelism:** parallelism is set by Fable's decomposition, not a fixed
  number. Fable splits the task into file-disjoint work items and one Sonnet runs
  per item. If the user wants more parallel coders, the lever is asking Fable to
  decompose more finely — tell them that, rather than hard-coding a fan-out.

## The one constraint that matters: disjoint files

Parallel coders share one workspace. If two work items edit the same file, they
clobber each other. So Fable is instructed to decompose into work items with
**disjoint file ownership**, and each coder is told to stay within its files. For
small or tightly-coupled tasks Fable will (correctly) return a single work item —
that is not a failure, it just means the task doesn't parallelize cleanly.

If a task genuinely needs parallel edits to overlapping files, that is the case
for git-worktree isolation (each coder in its own worktree, diffs merged after).
That adds real complexity and a merge step; only reach for it if the user
explicitly needs heavy parallel edits to shared files, and say so before adding
it.

## When NOT to reach for this

This loop spends real tokens across several models. It earns that cost when the
task is substantial and correctness matters. Don't wheel it out for a one-line
fix, a quick question, or a task a single agent finishes trivially — for those,
just do the work. The skill is for "build this and have it genuinely verified,"
not for everything.

## Fallback without the Workflow tool

If the Workflow tool isn't available, run the same state machine by hand with the
Agent tool, preserving the ladder and the no-Fable-in-retries rule:

1. One `Agent` with `model: "fable"` to audit, set acceptance criteria, and list
   file-disjoint work items.
2. Parallel `Agent` calls with `model: "sonnet"` (one per work item, in a single
   message so they run concurrently).
3. Two `Agent` calls with `model: "opus"`, given the same criteria but not each
   other's output. Both must pass.
4. On any Opus fail, loop back to step 2 with the collected issues — do **not**
   call Fable. Only when both Opus pass, one `Agent` with `model: "fable"` for
   the final review.
5. Cap at 10 cycles; report status, cycles, and outstanding issues.

The hand-run version is less reliable at faithfully looping — prefer the script
whenever Workflow exists.
