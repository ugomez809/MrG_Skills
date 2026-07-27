# Changelog

One plugin (`mrg-skills`), one version, two skills. Each entry says which skill
changed, since the shared version number can't.

**Bumping the version is not bookkeeping — it gates delivery.** Claude Code
only ships an update to installed users when `version` changes in
`.claude-plugin/plugin.json` *and* `.claude-plugin/marketplace.json`. Forget the
bump and your fix sits on `main` while every installed copy stays on the old
one. Both files must move together; they drifted apart once (see 0.7.1).

## 0.8.0 — 2026-07-27

### ug-full-reviewer

Three rounds of fixes after a review of the skill found the audit could stall
before ever producing a report.

- **Never generates a knowledge graph.** Reads `graphify-out/graph.json` if it
  is already there, maps the repo by hand if not. The old "generate one if
  missing" path was both an unwanted side effect and a logic loop: it built a
  graph, classified the untracked result as stale, and sent itself back to
  rebuild it.
- **Graph age is a report note, not a decision.** Age is judged by whether any
  tracked file changed since the graph's commit. The previous check demanded
  the graph's commit equal HEAD, which marked every graph stale the moment any
  later commit landed.
- **Verification can no longer run away.** Findings are deduped, triaged to at
  most 10 candidates, then verified — capped at 15 skeptics. Previously every
  finding at every severity got its own skeptic, so a large repo could spawn
  60+ agents and stall before writing anything.
- **Unverified findings cannot publish on severity alone.** They get one retry,
  then are dropped or confined to a clearly labeled "Unconfirmed leads"
  appendix. Criticals get two skeptics with majority rule.
- **Reports are dated and never overwrite.** Output moved from a single
  `AUDIT.md` to `audits/AUDIT-<date>-<shortsha>.md`, with the date and sha read
  from `date +%F` and `git rev-parse --short HEAD` rather than guessed.
- Fan-out capped at 16 finders; severity rubric defined; schema allows `line:
  n/a` for genuinely cross-file findings instead of inviting invented line
  numbers; churn command no longer truncates paths containing spaces.
- Plugin description now names both skills — it read "coding loop and more",
  which made the shared version look like it belonged to the other skill.

## 0.7.1 — 2026-07-27

Repair only. The preceding commit named 0.7.1 but left both manifests at
0.7.0, so no installed copy would have received it.

## 0.2.0 – 0.7.0 — 2026-07-27

### ug-coding-loop

Successive hardening of the build-and-verify loop: stall guards and stall-
detection fixes, model fallback, focused review cycles, reviewer-lane dedup,
plan validation, ownership grown from real edits, smoke-test rework targeted at
the implicated coders, the smoke state machine collapsed into a single counter,
a committed test suite, and a cap on `tests_run` in grader payloads.

## 0.1.0 — 2026-07-16

Initial marketplace and plugin setup with **ug-coding-loop**, later flattened so
the plugin root is the repo root and the skill resolves correctly. `setup.sh`
added for claude.ai/code web sessions.

**ug-full-reviewer** was added on 2026-07-17 without a version bump, so it
shipped under 0.1.0 rather than getting a release of its own.
