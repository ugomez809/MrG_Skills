#!/bin/bash
# mrg-skills — install line for your claude.ai/code environment Setup Script.
#
# Web/cloud containers do NOT auto-fetch personal marketplaces per session.
# Instead the environment Setup Script installs plugins at container init with
# the `claude plugin` CLI (same as caveman/superpowers/codex). Append these two
# lines to that script so ug-coding-loop and /ug-coding-loop load in every web
# session, on any repo.
claude plugin marketplace add ugomez809/MrG_Skills || true
claude plugin install mrg-skills@mrg-skills || true
