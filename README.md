# MrG_Skills — Ulises Gomez personal Claude Code marketplace

Personal Claude Code plugin marketplace. One plugin (`mrg-skills`) holds many
skills, so they are globally available in any Claude Code session on any repo.
Add a skill = new folder + push. No settings changes after initial setup.

## Layout

```
.claude-plugin/marketplace.json      # marketplace manifest (lists the plugin)
mrg-skills/                          # the ONE plugin
├── .claude-plugin/plugin.json       # plugin manifest
├── skills/                          # many skills live here
│   └── ug-coding-loop/
│       ├── SKILL.md                 # frontmatter: name + description
│       └── scripts/…                # optional supporting files
└── commands/                        # optional explicit slash commands
    └── ug-coding-loop.md            # /ug-coding-loop
```

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

> **Private repo note:** if `MrG_Skills` is private, fresh or remote containers
> must have your GitHub auth configured to fetch the marketplace. On a machine
> where `gh auth` / git credentials already work for this repo, nothing extra is
> needed.

## Add a future skill (no settings edit)

1. Create `mrg-skills/skills/<name>/SKILL.md` with YAML frontmatter:

   ```markdown
   ---
   name: <name>
   description: When to use this skill (be specific — this is the trigger).
   ---

   # Body: instructions Claude follows when the skill runs.
   ```

   Add optional `scripts/`, `references/`, or `assets/` under the same folder.

2. (Optional) Expose an explicit slash command —
   `mrg-skills/commands/<name>.md`:

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
