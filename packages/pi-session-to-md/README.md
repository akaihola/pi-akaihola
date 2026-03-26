# pi-session-to-md

Export Pi agent sessions to clean, readable Markdown transcripts.

Works two ways:

1. **Standalone Python CLI** — no Pi required, just Python 3
2. **Pi extension** — `/session-to-md` command + `session_to_md` tool

## Standalone Python CLI

The script reads Pi session JSONL files and renders them as Markdown.

### From a file

```bash
python scripts/session-to-md.py ~/.pi/agent/sessions/--my-project--/2026-03-26T19*.jsonl
```

### From stdin

```bash
cat session.jsonl | python scripts/session-to-md.py -
```

### Find by UUID or timestamp prefix

```bash
python scripts/session-to-md.py fa769cff
python scripts/session-to-md.py "2026-03-26T19"
```

### Write to a file

```bash
python scripts/session-to-md.py session.jsonl -o transcript.md
```

### Options

By default, only user/assistant text is included. Tool calls, tool results,
and thinking blocks are opt-in — each rendered as a collapsible GitHub
Markdown `<details>` block.

| Flag             | Description                                                           |
| ---------------- | --------------------------------------------------------------------- |
| `--thinking`     | Include thinking/reasoning as expandable sections                     |
| `--tool-calls`   | Include tool calls as expandable sections                             |
| `--tool-results` | Include tool results as expandable sections (implies `--tool-calls`)  |
| `--tool-details` | Include tool detail objects inside results (implies `--tool-results`) |
| `--all`          | Include everything: thinking, tool calls, results, and details        |
| `--no-metadata`  | Omit the header (date, model, cwd)                                    |
| `-o FILE`        | Write output to a file instead of stdout                              |

### Examples

```bash
# Clean transcript — just user/assistant conversation
python scripts/session-to-md.py session.jsonl -o clean.md

# Add tool calls as expandable blocks
python scripts/session-to-md.py session.jsonl --tool-calls

# Add tool calls AND their results
python scripts/session-to-md.py session.jsonl --tool-results

# Full export: thinking + tools + results + details
python scripts/session-to-md.py session.jsonl --all -o full.md

# Pipe through other tools
python scripts/session-to-md.py session.jsonl | head -100
cat session.jsonl | python scripts/session-to-md.py - | wc -l
```

## Pi Extension

### Install

```bash
# As a Pi package
pi -e ./packages/pi-session-to-md

# Or add to settings.json
# { "packages": ["./packages/pi-session-to-md"] }
```

### Slash command

```
/session-to-md                          # clean transcript (conversation only)
/session-to-md transcript.md            # specify output filename
/session-to-md --thinking               # + thinking as expandable blocks
/session-to-md --tool-results           # + tool calls & results
/session-to-md out.md --all             # everything included
```

### Tool (for LLM use)

The `session_to_md` tool is available for the agent to call:

```
Export this session to markdown with thinking blocks included.
```

Parameters:

| Parameter     | Type    | Default             | Description                                         |
| ------------- | ------- | ------------------- | --------------------------------------------------- |
| `output`      | string  | `session-<slug>.md` | Output file path                                    |
| `session`     | string  | current session     | JSONL path or UUID prefix                           |
| `thinking`    | boolean | `false`             | Include thinking as expandable sections             |
| `toolCalls`   | boolean | `false`             | Include tool calls as expandable sections           |
| `toolResults` | boolean | `false`             | Include tool results (implies `toolCalls`)          |
| `toolDetails` | boolean | `false`             | Include tool detail objects (implies `toolResults`) |
| `all`         | boolean | `false`             | Include everything                                  |
| `metadata`    | boolean | `true`              | Include header metadata                             |

## Output Format

The Markdown output includes:

- **Header** with session date, model, working directory, and session ID
- **`## 👤 User`** sections for each user message
- **`## 🤖 Assistant`** sections with model/token/cost info
- **`<details>` blocks** for tool calls (`🔧`), results (`📎`), and thinking (`💭`)
- Smart formatting for common tools (bash → code block, edit → diff, etc.)
- **Model change** and **thinking level** annotations as blockquotes
- Compaction and branch summaries in collapsible sections

## How It Works

Pi sessions are stored as JSONL tree structures (not linear lists). The script:

1. Parses all entries from the JSONL file
2. Reconstructs the tree using `id`/`parentId` fields
3. Finds the active branch (root → latest leaf)
4. Renders each entry type appropriately

This means you always get the **current conversation path**, even if the
session has branches from `/tree` navigation.
