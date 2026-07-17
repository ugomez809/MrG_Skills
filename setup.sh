#!/bin/bash
# mrg-skills — install lines for your claude.ai/code environment Setup Script.
#
# Web/cloud containers do NOT auto-fetch personal marketplaces per session; the
# environment Setup Script installs plugins at container init with the
# `claude plugin` CLI (same as caveman/superpowers/codex). Append these lines to
# that script so ug-coding-loop, ug-full-reviewer, and any future skill load in
# every web session, on any repo.
#
# The `update` line is what makes NEW skills appear: `marketplace add` skips a
# marketplace that already exists (reused containers keep a stale clone), so
# `update` re-pulls latest main before install.
claude plugin marketplace add ugomez809/MrG_Skills || true
claude plugin marketplace update mrg-skills || true
claude plugin install mrg-skills@mrg-skills || true
