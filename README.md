# pi-akaihola

A workspace for developing Pi extensions. Pi Pi is available here as a coding assistant to help build them.

---

## Getting started (fresh clone)

Pi Pi is not committed to this repo. Install it from its source repo:

```sh
just install-pi-pi
```

This copies the latest `pi-pi.ts`, `themeMap.ts`, agent definitions, and rose-pine theme from `~/repos/ai/pi/pi-vs-claude-code/` into `.pi/`. Run the same command to upgrade.

Then start a session:

```sh
pi
```

Pi Pi loads automatically from `.pi/extensions/` — no `-e` flag needed. Just describe what you want to build and it will research the Pi APIs and write the files for you.

---

## Project layout

```
~/prg/pi-akaihola/
├── justfile                    ← install-pi-pi recipe
├── .gitignore                  ← excludes only .pi/{sessions,cache,logs,tmp}/
└── .pi/                        ← committed to git
    ├── settings.json
    ├── extensions/
    │   ├── pi-pi.ts            ← Pi Pi assistant
    │   └── themeMap.ts         ← theme helper used by pi-pi.ts
    ├── agents/
    │   └── pi-pi/              ← Pi Pi's expert sub-agent definitions
    └── themes/
        └── rose-pine.json      ← Pi Pi's UI theme
```

---

## What is Pi Pi?

Pi Pi is a meta-agent that builds Pi components (extensions, themes, skills, agent definitions, prompt templates, settings). It is _not_ the subject of this workspace — it's the tool being used to develop whatever extensions end up living here.

It runs a two-phase workflow:

1. **Research (parallel)** — dispatches queries to 9 domain-specific expert sub-agents, each spawned as a concurrent `pi --mode json` subprocess.
2. **Build** — synthesises the findings and writes actual files using its code tools.

### Expert roster

| Expert              | Domain                                             |
| ------------------- | -------------------------------------------------- |
| `ext-expert`        | Extensions — tools, events, commands, rendering    |
| `theme-expert`      | Themes — JSON format, 51 color tokens              |
| `skill-expert`      | Skills — SKILL.md packages, frontmatter            |
| `config-expert`     | Settings — settings.json, providers, models        |
| `tui-expert`        | TUI — components, widgets, overlays, footers       |
| `prompt-expert`     | Prompt templates — .md files, `$1`/`$@` args       |
| `agent-expert`      | Agent definitions — .md personas, teams.yaml       |
| `keybinding-expert` | Keyboard shortcuts — `registerShortcut()`, Key IDs |
| `cli-expert`        | CLI flags and invocation                           |

### UI

- **Live expert-grid dashboard** — coloured cards per expert showing status, elapsed time, last output line
- **Custom footer** — model name, active/done expert count, context usage bar
- **Slash commands:** `/experts` (list status), `/experts-grid N` (set grid columns 1–5)
- **Theme:** rose-pine (auto-applied on session start)
