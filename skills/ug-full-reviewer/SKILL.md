---
name: ug-full-reviewer
description: >
  Full-repo health audit that finds concrete, verified problems to fix — bugs,
  security defects, architecture debt, and performance issues. Uses a Graphify
  knowledge graph when one exists (graphify-out/graph.json) to prioritize
  hotspots, builds a lightweight map itself when one doesn't. Use when the user
  says "audit this repo", "full analysis", "what needs fixing", "repo health
  check", "find issues in this project", or invokes /ug-full-reviewer. Output is
  a severity-ranked, dated audit report (audits/AUDIT-<date>-<sha>.md) where
  every ranked finding survived adversarial verification and names a concrete
  failure scenario.
---

# Repo Audit

You are running a structured audit, not a vibe read. The deliverable is a short
list of CONFIRMED problems with file:line anchors and concrete failure
scenarios — not a tour of the codebase, not praise, not style opinions.

Non-negotiable rules for every phase:

- A finding without a concrete failure scenario ("input X in state Y → wrong
  output / crash / security defect") is not a finding. Kill it.
- Never report a problem you have not read the actual source lines of.
- No praise, no "overall the code is well-structured", no restating what code
  does. Only defects and the fix direction.
- Prefer 8 confirmed findings over 40 plausible ones.

## Phase 0 — Preflight (cheap, inline)

1. `git rev-parse --show-toplevel` to confirm you're in a repo; `git log -1
   --format=%ct` for HEAD timestamp; note dirty state. **If this is not a git
   repo**: note "no git" and skip every git-dependent step from here on
   (churn hotspots, graph freshness check, HEAD sha in the report header) —
   map by directory structure and imports instead. Everything else still runs.
2. Detect stack: read the manifest(s) present (package.json, pyproject.toml,
   go.mod, Cargo.toml, composer.json, etc.). Note language(s), framework,
   test runner, lockfile presence.
3. Size check: count tracked **source** files, not everything — assets,
   lockfiles, and vendored code must not inflate the fan-out tier:

   ```
   git ls-files \
     | grep -Ev '(^|/)(vendor|node_modules|dist|build|out|generated|third_party|audits)/' \
     | grep -Ev '\.(png|jpe?g|svg|gif|ico|lock|min\.js|map|pdf|woff2?)$' \
     | wc -l
   ```

   (No git: `find` with the same exclusions.) This sets the fan-out budget in
   Phase 2:
   - < 50 files: no subagents needed; run the dimensions yourself sequentially.
   - 50–500: 4 dimension finders, whole-repo scope each.
   - > 500: dimension × subsystem matrix (Phase 2), capped at 16 finders.

   These same exclusions define finder scope in Phase 2: finders never audit
   vendored/generated code, and never read prior audit reports
   (`AUDIT*.md`, `audits/`) as source.

## Phase 1 — Get or build the map

Graphify-aware, but never blocked on it:

1. **Graph exists and is fresh** — `graphify-out/graph.json` present AND its
   built-at commit equals HEAD. Determine built-at from the graph's own
   metadata SHA if it records one, else `git log -1 --format=%H --
   graphify-out/graph.json`. Do NOT use file mtime — a fresh clone stamps
   every file with clone time, so mtime makes any old graph look new.
   An untracked graph with no metadata SHA counts as stale.
   If fresh: read `GRAPH_REPORT.md` first (cheap summary), then pull from
   `graph.json`: the community list and the top "god nodes" (most-connected).
   If the Graphify MCP tools are available (`query_graph`, `get_neighbors`,
   `shortest_path`), prefer them over parsing JSON by hand.
2. **Graph exists but stale** (built-at ≠ HEAD, or undeterminable): regenerate
   if the `graphify` CLI or `/graphify` skill is available (`graphify .` or
   invoke the skill). If regeneration isn't available, use the stale graph but
   say so in the report header — structure drifts slowly; a slightly stale
   graph still beats no graph for prioritization.
3. **No graph, Graphify available**: run `/graphify .` (or `graphify .`) once,
   then proceed as case 1.
4. **No graph, no Graphify**: build a manual map in ≤ ~15 commands / file
   reads:
   - Directory skeleton: `git ls-files` grouped by top-level dir.
   - Entry points: main/index files, route registrations, CLI entrypoints,
     exported package surface.
   - Hotspots by churn: `git log --format= --name-only -n 300 | sort |
     uniq -c | sort -rn | head -30` — high-churn files are where bugs live.
     Drop paths that no longer exist (deleted/renamed files rank high in
     churn but are dead ends), then keep the top ~20 survivors.
   - Hotspots by fan-in — count which internal modules are imported most,
     e.g. for JS/TS/Python:
     `git grep -hoE "(from|import|require)[ (]+['\"][^'\"]+" -- '*.py' '*.ts' '*.tsx' '*.js' | sort | uniq -c | sort -rn | head -20`
     (adapt the pattern and globs to the stack from Phase 0).

Output of this phase, regardless of path: a **subsystem list** (5–12 named
areas with their key files) and a **hotspot list** (10–20 files ranked by
connectedness/churn). God nodes and high-churn files get audited first and
deepest.

## Phase 2 — Fan out finders

Four dimensions, run as parallel subagents when the harness supports it
(Task/Agent tool, or a Workflow with one agent per cell). **Hard cap: 16
finders total.** For repos > 500 files, that means 4 dimensions × the top-4
hotspot subsystems — not the full subsystem list; subsystems left out of the
matrix are covered only via the hotspot lists, and MUST be named in the
report's coverage note as not deeply examined. Each finder gets: the subsystem
list, its hotspot files, the stack summary from Phase 0, the exclusions from
Phase 0 (vendored/generated dirs, `AUDIT*.md`, `audits/`), and the finding
schema below. Scope each finder to a dimension (and to a subsystem slice when
the repo is > 500 files) so no agent drowns.

Dimensions and what each hunts:

1. **Bugs & correctness** — logic errors, inverted/off-by-one conditions,
   unhandled error paths, race conditions, resource leaks, null/None flows,
   wrong async handling (unawaited promises, missing cancellation), silent
   exception swallowing, dead branches that mask failures.
2. **Security** — defensive review of the current source only. Look for:
   secrets committed into tracked files, injection-prone sinks (SQL, shell,
   template, path traversal) reachable from untrusted input, missing authz
   checks on mutating routes, unsafe deserialization, permissive CORS. Report
   each as a code-quality defect with a concrete failure scenario. Do NOT scan
   git history and do NOT run external audit or vulnerability-scanning tools —
   review the code as written.
3. **Architecture & debt** — dead code (exported-but-never-imported; the graph
   makes this cheap: zero-in-degree nodes), copy-paste duplication, circular
   imports (graph cycles), god modules doing 5 jobs, missing tests on the
   hotspot files specifically (untested god node = top finding), config/env
   handling scattered across files.
4. **Performance** — N+1 query patterns, O(n²) over unbounded input, sync I/O
   on hot paths, missing indexes implied by query patterns, unbounded caches
   or queues, oversized bundle imports (whole-lib imports for one function).

Finding schema — every finder returns findings as exactly:

```
file: path/to/file.py        # or 2–4 files for inherently cross-file findings
line: 142                    # or n/a — NEVER invent a line number
dimension: bugs|security|arch|perf
severity: critical|high|medium|low
summary: one sentence, the defect claim only
failure_scenario: concrete input/state → concrete wrong outcome
fix_direction: one or two sentences, not a full patch
```

`line: n/a` and multi-file `file:` are allowed only for findings that are
genuinely cross-file (missing tests, scattered config, circular imports) —
single-location defects always get a real file:line anchor.

Severity rubric (finders and skeptics both use this — do not improvise):

- **critical**: exploitable now, or causes data loss/corruption in normal
  operation.
- **high**: wrong output or crash on realistic input, or a security defect
  needing only mild preconditions.
- **medium**: wrong behavior on edge cases, resource leak, or debt with a
  concrete recurring cost.
- **low**: minor defect on an unlikely path, or cheap cleanup.

Finder prompt must also say: "Return raw findings only. No preamble, no
praise, no summary of the codebase. If a dimension yields nothing real,
return an empty list — do not invent findings to look productive."

## Phase 3 — Adversarial verify

Findings from Phase 2 are hypotheses. **Every finding gets verified, every
severity** — the report's claim is that nothing ranked survived without
verification, so nothing skips this phase. First dedup: same file+line+claim
from two finders is one finding. Then, for each finding, spawn a skeptic
(parallel where possible) whose prompt is: "Try to REFUTE this finding. Read
the actual code at file:line and its callers/guards. Default to refuted if
the failure scenario can't actually occur (input validated upstream, path
unreachable, framework handles it). Verdict: confirmed | refuted |
plausible-unverified, one sentence why."

- **Critical findings get 2 independent skeptics; majority rules** (with the
  original finder's claim as the third vote). A single lazy skeptic must not
  be able to kill or pass a critical alone.
- Refuted → drop silently.
- Plausible-unverified → severity buys NOTHING here. One retry from a
  different angle: a second skeptic, or better an objective check. Still
  unverified after the retry → it does not enter the ranked findings; either
  drop it or list it only in the clearly-labeled "Unconfirmed leads" appendix.
- Cheap objective checks beat argument: if a finding is testable in one
  command, run it instead of debating — but **side-effect-safe only**:
  read-only commands, static checks, or the existing test suite when it is
  plainly local/hermetic. Never run scripts that touch network, databases,
  or external state as part of verification.
- Small-repo path (< 50 files, no subagents): verification still happens —
  run an explicit self-skepticism pass per finding inline, same prompt, same
  verdicts.

## Phase 4 — Report

Write the report to `audits/AUDIT-<YYYY-MM-DD>-<shortsha>.md` in the repo
root, creating `audits/` if needed (no git → omit the sha). Never overwrite a
previous report: if the name already exists (same-day rerun at the same sha),
append `-2`, `-3`, … . If the repo is read-only, write to the working/scratch
directory instead and say so.

1. Header: repo, HEAD sha, date, map source (fresh graph / stale graph /
  manual), coverage note — what was NOT examined (skipped dirs, generated
  code, vendored deps, subsystems left out of the finder matrix) and any
  finder that returned empty.
2. Findings, severity-ranked, critical first. Each: the schema fields plus
   verification verdict. Only confirmed findings appear in this ranked list.
3. "Fix order" — a short suggested sequence: quick wins (< 30 min each)
   separated from structural work, dependencies between fixes noted.
4. Optionally end with: top 3 findings as a checklist the user can hand
   straight back ("fix these") — the audit's whole point is the next action.
5. "Unconfirmed leads" appendix (only if any survived the Phase 3 retry as
   plausible-unverified and you chose to keep them): clearly labeled as NOT
   verified, never mixed into the ranked list.

After writing the file, summarize the top findings in your reply — the file
alone is not the deliverable; the user reads the chat first.

Do not pad. A clean repo gets a short report that says so, with the coverage
note proving you actually looked.
