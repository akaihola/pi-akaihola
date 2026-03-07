# @akaihola/pi-orchestrator

Multi-agent workflows for Pi Coding Agent built from four specialised roles:

| Role             | Model  | Capabilities               | Purpose                           |
| ---------------- | ------ | -------------------------- | --------------------------------- |
| **researcher**   | Haiku  | read, grep, find, ls, bash | Gather codebase and web context   |
| **planner**      | Sonnet | read, grep, find, ls       | Turn context into a numbered plan |
| **coder**        | Sonnet | all defaults               | Implement the plan                |
| **orchestrator** | Sonnet | read, grep, find, ls, bash | Self-referential coordinator      |

Each agent runs in an isolated `pi` subprocess with its own context window and tool set.

## Install

Install the published package:

```sh
pi install npm:@akaihola/pi-orchestrator
```

For local development in this repo:

```sh
pi install -l ./packages/pi-orchestrator
```

For a one-off smoke test without persisting settings:

```sh
pi -e ./packages/pi-orchestrator
```

## Usage

### Slash commands

```text
/research-and-plan <task>       researcher -> planner
/research-plan-code <task>      researcher -> planner -> coder
/plan-and-code <task>           planner -> coder
/just-code <task>               coder only
/list-agents                    show all available agents
```

### `orchestrate` tool

Single agent:

```json
{ "agent": "researcher", "task": "Find all auth-related code" }
```

Chain:

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

Parallel:

```json
{
  "tasks": [
    { "agent": "researcher", "task": "Find all model definitions" },
    { "agent": "researcher", "task": "Find all API route handlers" }
  ]
}
```

## Agent definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: Short description shown to the LLM
tools: read, bash, grep
model: claude-haiku-4-5
---

System prompt for the agent...
```

Locations:

- `~/.pi/agent/agents/*.md` for user-level agents
- `.pi/agents/*.md` for project-level agents when `agentScope: "both"`

Project agents override user agents with the same name.
