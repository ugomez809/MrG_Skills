#!/usr/bin/env bash
# mrg-skills — cloud environment setup script for claude.ai/code (web) sessions.
#
# Web/cloud containers run with SKIP_PLUGIN_MARKETPLACE=true and do NOT fetch
# personal GitHub marketplaces at session start. This script reproduces what
# the pre-baked plugins do: clone this marketplace into the local plugin cache
# and enable it in ~/.claude/settings.json — so ug-coding-loop and the
# /ug-coding-loop command load in every web session, on any repo.
#
# Paste this as the Setup Script in your claude.ai/code environment settings.
set -euo pipefail

REPO="ugomez809/MrG_Skills"
NAME="mrg-skills"
CACHE="${HOME}/.claude/plugins/marketplaces/${NAME}"

# 1. Clone (or refresh) the marketplace into the local plugin cache.
rm -rf "${CACHE}"
git clone --depth 1 "https://github.com/${REPO}.git" "${CACHE}"

# 2. Enable it in ~/.claude/settings.json (merge — never clobber other plugins).
python3 - "$NAME" "$REPO" <<'PY'
import json, os, sys
name, repo = sys.argv[1], sys.argv[2]
path = os.path.expanduser("~/.claude/settings.json")
data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
data.setdefault("extraKnownMarketplaces", {})[name] = {
    "source": {"source": "github", "repo": repo}
}
data.setdefault("enabledPlugins", {})[f"{name}@{name}"] = True
with open(path, "w") as f:
    json.dump(data, f, indent=2)
print(f"enabled {name}@{name} in {path}")
PY

echo "mrg-skills installed: skill 'ug-coding-loop' + command '/ug-coding-loop' ready."
