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

| Flag                | Default | Description                              |
| ------------------- | ------- | ---------------------------------------- |
| `--thinking`        | off     | Include thinking/reasoning blocks        |
| `--no-tool-calls`   | off     | Omit tool calls and their results        |
| `--no-tool-results` | off     | Omit tool results (keep calls)           |
| `--tool-details`    | off     | Include tool-specific detail objects     |
| `--no-metadata`     | off     | Omit the header (date, model, cwd)       |
| `-o FILE`           | stdout  | Write output to a file instead of stdout |

### Examples

```bash
# Full transcript with thinking blocks
python scripts/session-to-md.py session.jsonl --thinking -o full.md

# Just the conversation, no tools
python scripts/session-to-md.py session.jsonl --no-tool-calls -o clean.md

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
/session-to-md                          # export current session
/session-to-md transcript.md            # specify output filename
/session-to-md --thinking               # include thinking blocks
/session-to-md out.md --no-tool-calls   # no tools, just conversation
```

### Tool (for LLM use)

The `session_to_md` tool is available for the agent to call:

```
Export this session to markdown with thinking blocks included.
```

Parameters:

| Parameter     | Type    | Default             | Description                 |
| ------------- | ------- | ------------------- | --------------------------- |
| `output`      | string  | `session-<slug>.md` | Output file path            |
| `session`     | string  | current session     | JSONL path or UUID prefix   |
| `thinking`    | boolean | `false`             | Include thinking blocks     |
| `toolCalls`   | boolean | `true`              | Include tool calls          |
| `toolResults` | boolean | `true`              | Include tool results        |
| `toolDetails` | boolean | `false`             | Include tool detail objects |
| `metadata`    | boolean | `true`              | Include header metadata     |

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
