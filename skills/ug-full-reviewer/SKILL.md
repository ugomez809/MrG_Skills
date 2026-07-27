---
name: ug-full-reviewer
description: >
  Full-repo health audit that finds concrete, verified problems to fix — bugs,
  security defects, architecture debt, and performance issues. Reads an existing
  Graphify knowledge graph (graphify-out/graph.json) to prioritize hotspots and
  builds a lightweight map itself when there isn't one — it never generates a
  graph. Use when the user
  says "audit this repo", "full analysis", "what needs fixing", "repo health
  check", "find issues in this project", or invokes /ug-full-reviewer. Output is
  a dated, severity-ranked report under audits/ where every ranked finding
  survived adversarial verification.
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
- Respect the two agent caps: 16 finders (Phase 2), 15 skeptics (Phase 3).

## Phase 0 — Preflight (cheap, inline)

1. `git rev-parse --show-toplevel`; `git log -1 --format=%ct` for HEAD
   timestamp; note dirty state. **Not a git repo**: note "no git" and skip every
   git-dependent step below (churn, graph age, HEAD sha in the header);
   map by directory structure and imports instead.
2. Detect stack from the manifest(s) present (package.json, pyproject.toml,
   go.mod, Cargo.toml, composer.json, …): language(s), framework, test runner,
   lockfile.
3. Count tracked **source** files — assets and vendored code must not inflate
   the tier (no git: `find` with the same exclusions):

   ```
   git ls-files | grep -Ev '(^|/)(vendor|node_modules|dist|build|out|generated|third_party|audits)/' | grep -Ev '\.(png|jpe?g|svg|gif|ico|lock|min\.js|map|pdf|woff2?)$' | wc -l
   ```

   Tier: **under 50** — no subagents, run the dimensions yourself sequentially.
   **50–500** — 4 dimension finders, whole-repo scope each. **over 500** —
   dimension × subsystem matrix (Phase 2).

   These exclusions also bound finder scope in Phase 2. Finders never audit
   vendored or generated code, and never read prior reports (`audits/`,
   `AUDIT*.md`) as source.

## Phase 1 — Get or build the map

**Never generate a graph.** No `graphify` CLI, no `/graphify` skill, no MCP
call that builds or refreshes one. An audit reads the repo; it does not write
artifacts into it. Read an existing graph if there is one, otherwise map by
hand — a missing graph is never a reason to stop or to build.

1. **`graphify-out/graph.json` exists** — use it. Read `GRAPH_REPORT.md` first
   (cheap summary), then pull the community list and top "god nodes"
   (most-connected) from `graph.json`. Prefer the read-only Graphify MCP tools
   (`query_graph`, `get_neighbors`, `shortest_path`) over parsing JSON by hand.

   Report its age in the header, but use it either way — structure drifts
   slowly, and a stale graph still beats no graph for prioritization. The graph
   is **current** if no tracked file has changed since the commit that last
   touched it:

   ```bash
   GRAPH_SHA=$(git log -1 --format=%H -- graphify-out/graph.json)
   git diff --quiet "$GRAPH_SHA" HEAD -- . ':!audits' && echo current || echo stale
   ```

   Empty `GRAPH_SHA` means the graph is untracked — report "age unknown" and
   skip the diff, do not run it with an empty argument. Never judge age by
   mtime; a fresh clone stamps every file with clone time.
2. **No graph** — build a manual map. Listings and the two commands below are
   free; spend at most ~15 file reads on top:
   - Directory skeleton: `git ls-files` grouped by top-level dir.
   - Entry points: main/index files, route registrations, CLI entrypoints,
     exported package surface.
   - Churn hotspots (dropping paths that no longer exist):

     ```
     git log --format= --name-only -n 300 | sort | uniq -c | sort -rn | sed 's/^ *[0-9]* *//' | while read -r f; do [ -f "$f" ] && echo "$f"; done | head -20
     ```

   - Fan-in hotspots — which internal modules get imported most (adapt the
     globs to the stack from Phase 0):

     ```
     git grep -hoE "(from|import|require)[ (]+['\"][^'\"]+" -- '*.py' '*.ts' '*.tsx' '*.js' | sort | uniq -c | sort -rn | head -20
     ```

Output regardless of path: a **subsystem list** (5–12 named areas with their key
files) and a **hotspot list** (10–20 files ranked by connectedness/churn). God
nodes and high-churn files get audited first and deepest.

## Phase 2 — Fan out finders

Four dimensions, run as parallel subagents when the harness supports it
(Task/Agent tool, or a Workflow with one agent per cell). **Hard cap: 16
finders.** Over 500 files that means 4 dimensions × the top-4 hotspot
subsystems, not the full subsystem list — subsystems left out of the matrix are
covered only via the hotspot lists and MUST be named in the coverage note as
not deeply examined. Under 50 files, skip subagents entirely and run the four
dimensions yourself.

Each finder gets: the subsystem list, its hotspot files, the Phase 0 stack
summary, the Phase 0 exclusions, and the schema below.

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

`line: n/a` and multi-file `file:` are only for genuinely cross-file findings
(missing tests, scattered config, circular imports). Single-location defects
always get a real file:line anchor.

Severity rubric — finders and skeptics both use this, do not improvise:

- **critical**: exploitable now, or data loss/corruption in normal operation.
- **high**: wrong output or crash on realistic input, or a security defect
  needing only mild preconditions.
- **medium**: wrong behavior on edge cases, resource leak, or debt with a
  concrete recurring cost.
- **low**: minor defect on an unlikely path, or cheap cleanup.

Finder prompt must also say: "Return raw findings only. No preamble, no
praise, no summary of the codebase. If a dimension yields nothing real,
return an empty list — do not invent findings to look productive."

## Phase 3 — Triage, then adversarially verify

Findings from Phase 2 are hypotheses. Verification is the expensive phase, so
narrow before spending it:

1. **Dedup** — same file+line+claim from two finders is one finding.
2. **Triage** — rank by severity and keep at most **10 candidates**. Everything
   below the line is dropped: un-ranked, un-verified, never mentioned. This is
   how "prefer 8 confirmed over 40 plausible" actually gets enforced.
3. **Verify every candidate** — spawn a skeptic per candidate (parallel where
   possible): "Try to REFUTE this finding. Read the actual code at file:line
   and its callers/guards. Default to refuted if the failure scenario can't
   occur (input validated upstream, path unreachable, framework handles it).
   Verdict: confirmed | refuted | plausible-unverified, one sentence why."

**Hard cap: 15 skeptics** across candidates, critical second votes, and
retries — 10 candidates leaves 5 spare votes. If you would still exceed it,
cut the lowest-severity candidates.

- Criticals get 2 independent skeptics; majority rules, with the original
  finder's claim as the third vote.
- Refuted → drop silently.
- Plausible-unverified → severity buys nothing. One retry from a different
  angle (second skeptic, or better an objective check). Still unverified → it
  never enters the ranked findings; drop it, or list it in the "Unconfirmed
  leads" appendix.
- Cheap objective checks beat argument: if a finding is testable in one
  command, run it — but **side-effect-safe only**: read-only commands, static
  checks, or the existing test suite when it is plainly local and hermetic.
  Never run anything touching network, databases, or external state.
- Under 50 files (no subagents): verification still happens — an explicit
  self-skepticism pass per candidate, same prompt, same verdicts.

## Phase 4 — Report

Filename comes from commands, never from memory — `date +%F` for the date and
`git rev-parse --short HEAD` for the sha:

```
audits/AUDIT-<date>-<shortsha>.md      # no git → audits/AUDIT-<date>.md
```

Create `audits/` if missing. `ls audits/` first: never overwrite a previous
report — on collision (same-day rerun at the same sha) append `-2`, `-3`, … .
Repo read-only → write to the working/scratch dir and say so.

1. Header: repo, HEAD sha, date, map source (graph — with its age: current /
   stale / unknown — or manual), coverage note — what was NOT examined (skipped dirs, generated
   code, vendored deps, subsystems left out of the matrix), any finder that
   returned empty, and how many findings were triaged out unverified.
2. Findings, severity-ranked, critical first. Each: the schema fields plus the
   verification verdict. Only confirmed findings appear here.
3. "Fix order" — quick wins (< 30 min each) separated from structural work,
   dependencies between fixes noted.
4. Optionally: top 3 findings as a checklist the user can hand straight back
   ("fix these") — the audit's whole point is the next action.
5. "Unconfirmed leads" appendix, only if any survived the Phase 3 retry and you
   chose to keep them. Clearly labeled NOT verified, never mixed into the list.

After writing the file, summarize the top findings in your reply — the file
alone is not the deliverable; the user reads the chat first.

Do not pad. A clean repo gets a short report that says so, with the coverage
note proving you actually looked.
