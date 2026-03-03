# Orchestrator Extension

Multi-agent workflows for Pi Coding Agent built from four specialised roles:

| Role             | Model  | Capabilities               | Purpose                           |
| ---------------- | ------ | -------------------------- | --------------------------------- |
| **researcher**   | Haiku  | read, grep, find, ls, bash | Gather codebase & web context     |
| **planner**      | Sonnet | read, grep, find, ls       | Turn context into a numbered plan |
| **coder**        | Sonnet | all defaults               | Implement the plan                |
| **orchestrator** | Sonnet | read, grep, find, ls, bash | Self-referential coordinator      |

Each agent runs in an **isolated `pi` subprocess** – its own context window, its own tool set.

---

## Installation

The extension is auto-discovered from `~/.pi/agent/extensions/orchestrator/`.

The four default agent definitions (`researcher.md`, `planner.md`, `coder.md`, `orchestrator.md`) live in `~/.pi/agent/agents/` and are already installed.

No other setup needed.

---

## Usage

### Slash commands

```
/research-and-plan <task>       researcher → planner
/research-plan-code <task>      researcher → planner → coder  (full workflow)
/plan-and-code <task>           planner → coder
/just-code <task>               coder only  (self-contained tasks)
/list-agents                    show all available agents
```

### `orchestrate` tool (LLM-callable)

The LLM can call the `orchestrate` tool directly:

**Single agent**

```json
{ "agent": "researcher", "task": "Find all auth-related code" }
```

**Chain** (sequential, output passed via `{previous}`)

```json
{
  "chain": [
    { "agent": "researcher", "task": "Find all code related to sessions" },
    {
      "agent": "planner",
      "task": "Plan a session-timeout feature using:\n\n{previous}"
    },
    { "agent": "coder", "task": "Implement the plan:\n\n{previous}" }
  ]
}
```

**Parallel**

```json
{
  "tasks": [
    { "agent": "researcher", "task": "Find all model definitions" },
    { "agent": "researcher", "task": "Find all API route handlers" }
  ]
}
```

---

## Agent definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: Short description shown to the LLM
tools: read, bash, grep
model: claude-haiku-4-5
---

System prompt for the agent…
```

**Locations:**

| Path                      | Scope                                        |
| ------------------------- | -------------------------------------------- |
| `~/.pi/agent/agents/*.md` | User-level (always loaded)                   |
| `.pi/agents/*.md`         | Project-level (opt-in: `agentScope: "both"`) |

Project agents override user agents with the same name.

---

## Customising agents

Edit the `.md` files in `~/.pi/agent/agents/` to change any agent's system prompt, model, or tool set. Changes take effect immediately (no restart needed).

To add a new role, drop a new `.md` file there:

```markdown
---
name: reviewer
description: Reviews code changes for correctness and style
tools: read, grep, find, ls, bash
model: claude-sonnet-4-5
---

You are a meticulous code reviewer…
```

Then use it:

```
/orchestrate with chain: researcher → planner → coder → reviewer
```

Or ask the LLM: _"Use orchestrate to run researcher then reviewer on my auth module."_

---

## How it works

1. The extension registers an `orchestrate` tool the LLM can call.
2. Each agent invocation spawns `pi --mode json -p --no-session` as a subprocess with the agent's system prompt injected via `--append-system-prompt`.
3. JSON events are streamed from the subprocess and surfaced as live TUI updates.
4. In chain mode, the final assistant text from each step is substituted for `{previous}` in the next step's task.
5. The `before_agent_start` hook injects a brief context message listing available agents so the LLM knows when to reach for `orchestrate`.

---

## Files

```
~/.pi/agent/extensions/orchestrator/
├── index.ts      Extension entry point – registers tool & commands
├── agents.ts     Agent discovery (reads .md files)
├── runner.ts     Subprocess execution & JSON event parsing
├── render.ts     TUI rendering helpers
└── README.md     This file

~/.pi/agent/agents/
├── orchestrator.md
├── researcher.md
├── planner.md
└── coder.md
```
