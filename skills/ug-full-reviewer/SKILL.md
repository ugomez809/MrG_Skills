---
name: ug-full-reviewer
description: >
  Full-repo health audit that finds concrete, verified problems to fix — bugs,
  security holes, architecture debt, and performance issues. Uses a Graphify
  knowledge graph when one exists (graphify-out/graph.json) to prioritize
  hotspots, builds a lightweight map itself when one doesn't. Use when the user
  says "audit this repo", "full analysis", "what needs fixing", "repo health
  check", "find issues in this project", or invokes /ug-full-reviewer. Output is a
  severity-ranked AUDIT.md where every finding survived adversarial
  verification and names a concrete failure scenario.
---

# Repo Audit

You are running a structured audit, not a vibe read. The deliverable is a short
list of CONFIRMED problems with file:line anchors and concrete failure
scenarios — not a tour of the codebase, not praise, not style opinions.

Non-negotiable rules for every phase:

- A finding without a concrete failure scenario ("input X in state Y → wrong
  output / crash / exploit") is not a finding. Kill it.
- Never report a problem you have not read the actual source lines of.
- No praise, no "overall the code is well-structured", no restating what code
  does. Only defects and the fix direction.
- Prefer 8 confirmed findings over 40 plausible ones.

## Phase 0 — Preflight (cheap, inline)

1. `git rev-parse --show-toplevel` to confirm you're in a repo; `git log -1
   --format=%ct` for HEAD timestamp; note dirty state.
2. Detect stack: read the manifest(s) present (package.json, pyproject.toml,
   go.mod, Cargo.toml, composer.json, etc.). Note language(s), framework,
   test runner, lockfile presence.
3. Size check: count tracked source files (`git ls-files | wc -l`). This sets
   the fan-out budget in Phase 2:
   - < 50 files: no subagents needed; run the dimensions yourself sequentially.
   - 50–500: 4 dimension finders, whole-repo scope each.
   - > 500: dimension × subsystem matrix (Phase 2).

## Phase 1 — Get or build the map

Graphify-aware, but never blocked on it:

1. **Graph exists and is fresh** — `graphify-out/graph.json` present AND its
   mtime ≥ HEAD commit timestamp: use it. Read `GRAPH_REPORT.md` first (cheap
   summary), then pull from `graph.json`: the community list and the top
   "god nodes" (most-connected). If the Graphify MCP tools are available
   (`query_graph`, `get_neighbors`, `shortest_path`), prefer them over parsing
   JSON by hand.
2. **Graph exists but stale** (mtime < HEAD): regenerate if the `graphify` CLI
   or `/graphify` skill is available (`graphify . ` or invoke the skill).
   If regeneration isn't available, use the stale graph but say so in the
   report header — structure drifts slowly; a slightly stale graph still beats
   no graph for prioritization.
3. **No graph, Graphify available**: run `/graphify .` (or `graphify .`) once,
   then proceed as case 1.
4. **No graph, no Graphify**: build a manual map in ≤ 10 minutes of work:
   - Directory skeleton: `git ls-files` grouped by top-level dir.
   - Entry points: main/index files, route registrations, CLI entrypoints,
     exported package surface.
   - Hotspots by churn: `git log --format= --name-only -n 300 | sort |
     uniq -c | sort -rn | head -20` — high-churn files are where bugs live.
   - Hotspots by fan-in: grep the most-imported internal modules.

Output of this phase, regardless of path: a **subsystem list** (5–12 named
areas with their key files) and a **hotspot list** (10–20 files ranked by
connectedness/churn). God nodes and high-churn files get audited first and
deepest.

## Phase 2 — Fan out finders

Four dimensions, run as parallel subagents when the harness supports it
(Task/Agent tool, or a Workflow with one agent per cell). Each finder gets:
the subsystem list, its hotspot files, the stack summary from Phase 0, and the
finding schema below. Scope each finder to a dimension (and to a subsystem
slice when the repo is > 500 files) so no agent drowns.

Dimensions and what each hunts:

1. **Bugs & correctness** — logic errors, inverted/off-by-one conditions,
   unhandled error paths, race conditions, resource leaks, null/None flows,
   wrong async handling (unawaited promises, missing cancellation), silent
   exception swallowing, dead branches that mask failures.
2. **Security** — hardcoded secrets (also scan git history:
   `git log -p -S` on obvious key patterns if suspicious), injection (SQL,
   shell, template, path traversal), missing authz checks on mutating routes,
   unsafe deserialization, permissive CORS, outdated deps with known CVEs
   (run the ecosystem's audit tool: `npm audit`, `pip-audit`, `cargo audit`,
   `govulncheck` — whichever exists).
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
file: path/to/file.py
line: 142
dimension: bugs|security|arch|perf
severity: critical|high|medium|low
summary: one sentence, the defect claim only
failure_scenario: concrete input/state → concrete wrong outcome
fix_direction: one or two sentences, not a full patch
```

Finder prompt must also say: "Return raw findings only. No preamble, no
praise, no summary of the codebase. If a dimension yields nothing real,
return an empty list — do not invent findings to look productive."

## Phase 3 — Adversarial verify

Findings from Phase 2 are hypotheses. For each medium+ finding, spawn a
skeptic (parallel where possible) whose prompt is: "Try to REFUTE this
finding. Read the actual code at file:line and its callers/guards. Default to
refuted if the failure scenario can't actually occur (input validated
upstream, path unreachable, framework handles it). Verdict: confirmed |
refuted | plausible-unverified, one sentence why."

- Refuted → drop silently.
- Plausible-unverified → keep only if severity ≥ high, tagged as unverified.
- Cheap objective checks beat argument: if a finding is testable in one
  command (run the failing case, run the audit tool, run existing tests),
  run it instead of debating.
- Dedup before verifying: same file+line+claim from two finders is one
  finding.

## Phase 4 — Report

Write `AUDIT.md` in the repo root (or working dir if repo is read-only):

1. Header: repo, HEAD sha, date, map source (fresh graph / stale graph /
  manual), coverage note — what was NOT examined (skipped dirs, generated
  code, vendored deps) and any finder that returned empty.
2. Findings, severity-ranked, critical first. Each: the schema fields plus
   verification verdict. Nothing unconfirmed above the fold.
3. "Fix order" — a short suggested sequence: quick wins (< 30 min each)
   separated from structural work, dependencies between fixes noted.
4. Optionally end with: top 3 findings as a checklist the user can hand
   straight back ("fix these") — the audit's whole point is the next action.

Do not pad. A clean repo gets a short report that says so, with the coverage
note proving you actually looked.
