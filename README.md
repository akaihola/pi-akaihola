# pi-akaihola

> This is a prototype developed using AI coding agents and not intended for production use.

A monorepo for developing and distributing reusable Pi extension packages. Pi Pi is available here as a repo-local coding assistant to help build them.

---

## Getting started

Install the repo-local Pi Pi helper into `.pi/`:

```sh
just install-pi-pi
```

Then start a session:

```sh
pi
```

The local Pi session loads:

- `pi-pi` directly from `.pi/extensions/pi-pi.ts`
- distributable extensions from `packages/` via `.pi/settings.json`

That keeps `.pi/` as the workshop for this repository, while the reusable extension implementations live under `packages/`.

---

## Project layout

```text
~/prg/pi-akaihola/
├── package.json                ← workspace root and optional meta-package entrypoint
├── justfile                    ← helper recipes for local development
├── packages/                   ← distributable Pi packages
│   ├── pi-orchestrator/
│   │   ├── package.json
│   │   ├── README.md
│   │   └── extensions/
│   ├── pi-session-meta/
│   │   ├── package.json
│   │   ├── README.md
│   │   └── extensions/
│   └── pi-usage-bars/
│       ├── package.json
│       ├── README.md
│       └── extensions/
└── .pi/                        ← repo-local Pi config and authoring support
    ├── settings.json
    ├── extensions/
    │   ├── pi-pi.ts            ← local meta-agent helper, installed from upstream
    │   └── themeMap.ts         ← helper used by pi-pi.ts
    ├── agents/
    │   └── pi-pi/              ← Pi Pi's expert sub-agent definitions
    └── themes/
        └── rose-pine.json      ← Pi Pi's UI theme
```

---

## Packages

Current distributable packages:

- `@akaihola/pi-session-meta` — exposes the current Pi session path, UUID, slug, and stamp commands
- `@akaihola/pi-orchestrator` — runs researcher/planner/coder/orchestrator workflows in isolated Pi subprocesses
- `@akaihola/pi-usage-bars` — shows Claude quota usage in the status bar using Claude Code Mux OAuth tokens

Each package is independently installable and publishable.

## Install options

Use one package when you want a single feature:

```sh
pi install npm:@akaihola/pi-session-meta
```

Use a local package path when developing in this repo:

```sh
pi install -l ./packages/pi-session-meta
```

Use `-e` for a one-off smoke test without persisting settings:

```sh
pi -e ./packages/pi-session-meta
```

Use the whole repo when you want all packaged extensions exposed by the root meta-package:

```sh
pi install git:github.com/<you-or-org>/pi-akaihola
```

---

## Publishing

Publish an individual package with the manual GitHub Actions workflow in `.github/workflows/publish-package.yml`.

Before running it:

- add an `NPM_TOKEN` repository secret with publish access
- bump the target package version in `packages/<name>/package.json`
- choose the package directory from the workflow dispatch form

The workflow validates the selected package manifest and runs `npm publish` from that package directory only.

---

## Local development model

This repo uses a split layout:

- `packages/` contains the actual reusable extension implementations
- `.pi/` contains only repo-local Pi configuration, themes, agents, and helper extensions

Think of it as workshop versus product:

- `.pi/settings.json` is maintainer wiring for this monorepo only
- `packages/*` is what downstream users install, publish, and depend on

`.pi/settings.json` therefore uses `packages` entries pointing at `../packages/...` rather than treating `.pi/extensions/` as the source of distributable code.

---

## Pi Pi

Pi Pi is a meta-agent that builds Pi components such as extensions, themes, skills, agent definitions, prompt templates, and settings. It is not the primary product of this repo; it is the local tool used to help author the packages that live here.

It runs a two-phase workflow:

1. **Research** — dispatches queries to domain-specific expert sub-agents in parallel
2. **Build** — synthesises the findings and writes actual files using code tools
