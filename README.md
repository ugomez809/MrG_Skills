# MrG_Skills — Ulises Gomez personal Claude Code marketplace

Personal Claude Code plugin marketplace. One plugin (`mrg-skills`) holds many
skills, so they are globally available in any Claude Code session on any repo.
Add a skill = new folder + push. No settings changes after initial setup.

## Layout

Repo root IS the plugin root (same mechanism as the caveman plugin —
`source: "./"`). One plugin, `skills/` and `commands/` at top level.

```
.claude-plugin/
├── marketplace.json                 # marketplace manifest (source: "./")
└── plugin.json                      # plugin manifest (name: mrg-skills)
skills/                              # many skills live here
└── ug-coding-loop/
    ├── SKILL.md                     # frontmatter: name: ug-coding-loop
    └── scripts/…                    # optional supporting files
commands/                            # optional explicit slash commands
└── ug-coding-loop.md                # /ug-coding-loop
```

Skill resolves as `ug-coding-loop` (namespaced `mrg-skills:ug-coding-loop`),
command as `/ug-coding-loop`. The plugin is named `mrg-skills`; individual
skills keep their own names from each `SKILL.md`.

## Enable globally (one time)

Merge into `~/.claude/settings.json` (merge — do not replace the whole file):

```json
"extraKnownMarketplaces": {
  "mrg-skills": { "source": { "source": "github", "repo": "ugomez809/MrG_Skills" } }
},
"enabledPlugins": { "mrg-skills@mrg-skills": true }
```

Restart Claude Code. The plugin's skills and slash commands become available in
every session, on every repo.

### Local CLI / desktop vs. claude.ai/code (web)

**Local Claude Code CLI / desktop (signed in):** the `settings.json` merge above
is all you need — it fetches this marketplace from GitHub and enables it
globally. Refresh a stale copy with `/plugin marketplace update mrg-skills`.

**claude.ai/code (web):** cloud containers run with
`SKIP_PLUGIN_MARKETPLACE=true` and do **not** fetch personal GitHub
marketplaces at session start (the built-in plugins are pre-baked into the
image). Editing `~/.claude/settings.json` on your own machine never reaches a
web container. To make this plugin load in web sessions, add [`setup.sh`](./setup.sh)
as the **Setup Script** in your claude.ai/code environment settings — it clones
this repo into the container's plugin cache and enables it before the agent
starts, on every web session and every repo. See
https://code.claude.com/docs/en/claude-code-on-the-web for where to set the
environment setup script.

Alternatively, for a single repo, commit the skill as project files:
`.claude/skills/ug-coding-loop/SKILL.md` and
`.claude/commands/ug-coding-loop.md` — those load natively in any session
(web or local) opened on that repo, no marketplace needed.

> **Private repo note:** if `MrG_Skills` is private, fresh or remote containers
> must have your GitHub auth configured to fetch the marketplace. On a machine
> where `gh auth` / git credentials already work for this repo, nothing extra is
> needed.

## Add a future skill (no settings edit)

1. Create `skills/<name>/SKILL.md` with YAML frontmatter:

   ```markdown
   ---
   name: <name>
   description: When to use this skill (be specific — this is the trigger).
   ---

   # Body: instructions Claude follows when the skill runs.
   ```

   Add optional `scripts/`, `references/`, or `assets/` under the same folder.

2. (Optional) Expose an explicit slash command — `commands/<name>.md`:

   ```markdown
   ---
   description: Short description
   ---

   Invoke the `<name>` skill and follow it exactly for this request.
   ```

3. Commit and push. Auto-available in every session — no `settings.json` edit,
   just restart Claude Code (or reload plugins).

## Current skills

- **ug-coding-loop** — tiered, multi-model build-and-verify loop. Fable plans
  and signs off, cheap parallel Sonnet agents build, two Opus reviewers gate
  each cycle. Skill + `/ug-coding-loop` slash command.
