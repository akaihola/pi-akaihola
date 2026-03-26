#!/usr/bin/env python3
"""Convert a Pi agent session JSONL file to Markdown.

Usage:
    # From file to stdout
    python session-to-md.py session.jsonl

    # From file to file
    python session-to-md.py session.jsonl -o transcript.md

    # From stdin
    cat session.jsonl | python session-to-md.py -

    # With all optional content
    python session-to-md.py session.jsonl --thinking --tool-details

    # Minimal: just user/assistant text, no tool calls
    python session-to-md.py session.jsonl --no-tool-calls

    # Find session by UUID or timestamp prefix
    python session-to-md.py fa769cff
    python session-to-md.py "2026-03-26T19"

The session argument may be:
  - A full path to a .jsonl file
  - ``-`` to read from stdin
  - A session UUID or prefix (searched under ~/.pi/agent/sessions/)
  - A timestamp prefix (matched against session filenames)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from textwrap import dedent

_SESSIONS_ROOT = Path.home() / ".pi" / "agent" / "sessions"


# ---------------------------------------------------------------------------
# Session file resolution
# ---------------------------------------------------------------------------


def _find_session_file(id_or_path: str) -> Path:
    """Resolve a session identifier to a JSONL file path.

    Accepts a full path, a UUID (or prefix), or a timestamp prefix.
    """
    p = Path(id_or_path).expanduser()
    if p.exists():
        return p
    if not _SESSIONS_ROOT.exists():
        raise FileNotFoundError(
            f"Sessions root not found: {_SESSIONS_ROOT}\n"
            f"(looked for session matching {id_or_path!r})"
        )
    for candidate in sorted(_SESSIONS_ROOT.rglob("*.jsonl")):
        stem = candidate.stem
        if id_or_path in stem or stem.startswith(id_or_path):
            return candidate
        if "_" in stem and id_or_path in stem.split("_", 1)[1]:
            return candidate
    raise FileNotFoundError(
        f"Session not found: {id_or_path!r}\nSearched under {_SESSIONS_ROOT}"
    )


# ---------------------------------------------------------------------------
# JSONL parsing
# ---------------------------------------------------------------------------


def _parse_jsonl(lines: list[str]) -> list[dict]:
    """Parse JSONL lines into a list of dicts, skipping malformed lines."""
    entries: list[dict] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


# ---------------------------------------------------------------------------
# Tree → branch extraction
# ---------------------------------------------------------------------------


def _extract_branch(entries: list[dict]) -> list[dict]:
    """Extract the active branch (root → leaf) from a tree of entries.

    Pi sessions are stored as a tree where each entry has ``id`` and
    ``parentId`` fields.  The "active branch" is the path from root to the
    leaf with the latest timestamp (i.e. the most recent conversation path).
    """
    # Separate header from tree entries
    tree_entries: list[dict] = []
    for e in entries:
        if e.get("type") == "session" and "version" in e:
            continue  # Skip session header (metadata only)
        else:
            tree_entries.append(e)

    if not tree_entries:
        return []

    # Index by id
    by_id: dict[str, dict] = {}
    children: dict[str | None, list[str]] = {}
    for e in tree_entries:
        eid = e.get("id")
        if eid:
            by_id[eid] = e
        pid = e.get("parentId")
        if eid is not None:
            children.setdefault(pid, []).append(eid)

    # Find leaves (entries with no children)
    all_ids = set(by_id.keys())
    parent_ids = set()
    for clist in children.values():
        parent_ids.update(clist)
    # A leaf is any entry whose id never appears as a parentId of another
    child_ids = set()
    for e in tree_entries:
        pid = e.get("parentId")
        if pid:
            child_ids.add(pid)
    leaves = [eid for eid in all_ids if eid not in child_ids]

    if not leaves:
        # Fallback: treat entire list as linear
        return tree_entries

    # Pick the leaf with the latest timestamp
    def _ts(eid: str) -> str:
        return by_id[eid].get("timestamp", "")

    leaf_id = max(leaves, key=_ts)

    # Walk from leaf to root
    branch: list[dict] = []
    current: str | None = leaf_id
    visited: set[str] = set()
    while current and current in by_id and current not in visited:
        visited.add(current)
        branch.append(by_id[current])
        current = by_id[current].get("parentId")

    branch.reverse()
    return branch


# ---------------------------------------------------------------------------
# Session metadata extraction
# ---------------------------------------------------------------------------


def _extract_metadata(
    entries: list[dict],
) -> dict[str, str | None]:
    """Pull session-level metadata from header and early entries."""
    meta: dict[str, str | None] = {
        "cwd": None,
        "name": None,
        "id": None,
        "timestamp": None,
        "model": None,
    }
    for e in entries[:30]:
        etype = e.get("type", "")
        if etype == "session":
            meta["cwd"] = e.get("cwd")
            meta["id"] = e.get("id")
            meta["timestamp"] = e.get("timestamp")
        elif etype == "session_info":
            meta["name"] = e.get("name")
        elif etype == "model_change" and not meta["model"]:
            provider = e.get("provider", "")
            model_id = e.get("modelId", "")
            meta["model"] = f"{provider}/{model_id}" if provider else model_id
    return meta


# ---------------------------------------------------------------------------
# Content block rendering
# ---------------------------------------------------------------------------


def _render_text_block(block: dict) -> str:
    """Render a text content block."""
    return block.get("text", "")


def _render_thinking_block(block: dict) -> str:
    """Render a thinking content block."""
    thinking = block.get("thinking", "")
    if not thinking:
        return ""
    return f"<details>\n<summary>💭 Thinking</summary>\n\n{thinking}\n\n</details>\n"


def _render_tool_call(
    block: dict,
    *,
    include_details: bool = False,
) -> str:
    """Render a tool call block."""
    name = block.get("name", "unknown")
    args = block.get("arguments", {})

    # Format arguments
    if isinstance(args, dict):
        # For common tools, show a compact representation
        if name == "bash" and "command" in args:
            args_str = f"```bash\n{args['command']}\n```"
        elif name == "read" and "path" in args:
            parts = [f"**Path:** `{args['path']}`"]
            if args.get("offset"):
                parts.append(f"**Offset:** {args['offset']}")
            if args.get("limit"):
                parts.append(f"**Limit:** {args['limit']}")
            args_str = "  \n".join(parts)
        elif name == "write" and "path" in args:
            content = args.get("content", "")
            preview = content[:500]
            if len(content) > 500:
                preview += f"\n... ({len(content)} chars total)"
            args_str = f"**Path:** `{args['path']}`\n\n```\n{preview}\n```"
        elif name == "edit" and "path" in args:
            old = args.get("oldText", "")
            new = args.get("newText", "")
            args_str = (
                f"**Path:** `{args['path']}`\n\n"
                f"```diff\n- {old[:300]}\n+ {new[:300]}\n```"
            )
        else:
            args_str = f"```json\n{json.dumps(args, indent=2, ensure_ascii=False)}\n```"
    else:
        args_str = f"```\n{args}\n```"

    return (
        f"<details>\n"
        f"<summary>🔧 <code>{name}</code></summary>\n\n"
        f"{args_str}\n\n"
        f"</details>\n"
    )


def _render_tool_result(
    entry: dict,
    *,
    include_details: bool = False,
) -> str:
    """Render a toolResult message."""
    msg = entry.get("message", {})
    tool_name = msg.get("toolName", "unknown")
    is_error = msg.get("isError", False)
    content = msg.get("content", [])

    # Gather text content
    texts: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                texts.append(block.get("text", ""))
            elif isinstance(block, dict) and block.get("type") == "image":
                texts.append(f"[Image: {block.get('mimeType', 'image')}]")
    elif isinstance(content, str):
        texts.append(content)

    text = "\n".join(texts)

    # Truncate very long tool results
    max_len = 2000
    if len(text) > max_len:
        text = text[:max_len] + f"\n\n... (truncated, {len(text)} chars total)"

    error_marker = " ❌ Error" if is_error else ""
    header = f"📎 Result: `{tool_name}`{error_marker}"

    parts = [
        f"<details>\n<summary>{header}</summary>\n",
    ]
    if text.strip():
        parts.append(f"\n```\n{text}\n```\n")

    # Include tool-specific details if requested
    if include_details:
        details = msg.get("details")
        if details:
            parts.append(
                f"\n<details>\n<summary>Details</summary>\n\n"
                f"```json\n{json.dumps(details, indent=2, ensure_ascii=False)}\n```\n\n"
                f"</details>\n"
            )

    parts.append("\n</details>\n")
    return "".join(parts)


# ---------------------------------------------------------------------------
# Main Markdown rendering
# ---------------------------------------------------------------------------


def render_markdown(
    entries: list[dict],
    *,
    include_thinking: bool = False,
    include_tool_calls: bool = True,
    include_tool_results: bool = True,
    include_tool_details: bool = False,
    include_metadata: bool = True,
) -> str:
    """Render a list of session entries as a Markdown document."""
    meta = _extract_metadata(entries)
    branch = _extract_branch(entries)

    lines: list[str] = []

    # --- Header ---
    title = meta["name"] or meta.get("id", "Session")
    lines.append(f"# {title}\n")

    if include_metadata:
        if meta["timestamp"]:
            try:
                dt = datetime.fromisoformat(meta["timestamp"].replace("Z", "+00:00"))
                lines.append(f"**Date:** {dt.strftime('%Y-%m-%d %H:%M UTC')}  ")
            except ValueError:
                lines.append(f"**Date:** {meta['timestamp']}  ")
        if meta["model"]:
            lines.append(f"**Model:** {meta['model']}  ")
        if meta["cwd"]:
            lines.append(f"**CWD:** `{meta['cwd']}`  ")
        if meta["id"]:
            lines.append(f"**Session:** `{meta['id']}`  ")
        lines.append("")

    lines.append("---\n")

    # --- Conversation turns ---
    current_role: str | None = None
    pending_tool_calls: dict[str, str] = {}  # callId → tool name (for pairing)
    turn_parts: list[str] = []

    def flush_turn() -> None:
        nonlocal current_role, turn_parts
        if turn_parts:
            body = "\n".join(turn_parts).strip()
            if body:
                lines.append(body)
                lines.append("")
            turn_parts.clear()

    for entry in branch:
        etype = entry.get("type", "")

        # --- Model changes ---
        if etype == "model_change":
            flush_turn()
            current_role = None
            provider = entry.get("provider", "")
            model_id = entry.get("modelId", "")
            model = f"{provider}/{model_id}" if provider else model_id
            lines.append(f"> *Model changed to **{model}***\n")
            continue

        # --- Compaction ---
        if etype == "compaction":
            flush_turn()
            current_role = None
            summary = entry.get("summary", "")
            if summary:
                lines.append(
                    f"<details>\n<summary>📦 Context compacted</summary>\n\n"
                    f"{summary}\n\n</details>\n"
                )
            continue

        # --- Thinking level changes ---
        if etype == "thinking_level_change":
            flush_turn()
            current_role = None
            level = entry.get("thinkingLevel", "")
            lines.append(f"> *Thinking level: **{level}***\n")
            continue

        # --- Messages ---
        if etype != "message":
            continue

        msg = entry.get("message", {})
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "")

        # --- User message ---
        if role == "user":
            flush_turn()
            current_role = "user"
            lines.append("---\n")
            lines.append("## 👤 User\n")
            content = msg.get("content", "")
            if isinstance(content, str):
                turn_parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type", "")
                    if btype == "text":
                        turn_parts.append(block.get("text", ""))
                    elif btype == "image":
                        mime = block.get("mimeType", "image")
                        turn_parts.append(f"*[Attached image: {mime}]*")
            continue

        # --- Assistant message ---
        if role == "assistant":
            if current_role != "assistant":
                flush_turn()
                current_role = "assistant"
                lines.append("---\n")
                lines.append("## 🤖 Assistant\n")

                # Show model/usage info
                model = msg.get("model", "")
                provider = msg.get("provider", "")
                usage = msg.get("usage", {})
                info_parts: list[str] = []
                if provider and model:
                    info_parts.append(f"`{provider}/{model}`")
                elif model:
                    info_parts.append(f"`{model}`")
                if usage:
                    tokens = usage.get("totalTokens")
                    cost = usage.get("cost", {})
                    total_cost = cost.get("total") if isinstance(cost, dict) else None
                    if tokens:
                        info_parts.append(f"{tokens:,} tokens")
                    if total_cost:
                        info_parts.append(f"${total_cost:.4f}")
                if info_parts:
                    turn_parts.append(f"*{' · '.join(info_parts)}*\n")

            content = msg.get("content", [])
            if isinstance(content, str):
                turn_parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type", "")
                    if btype == "text":
                        text = _render_text_block(block)
                        if text:
                            turn_parts.append(text)
                    elif btype == "thinking" and include_thinking:
                        rendered = _render_thinking_block(block)
                        if rendered:
                            turn_parts.append(rendered)
                    elif btype == "toolCall":
                        call_id = block.get("id", "")
                        call_name = block.get("name", "")
                        if call_id:
                            pending_tool_calls[call_id] = call_name
                        if include_tool_calls:
                            turn_parts.append(
                                _render_tool_call(
                                    block, include_details=include_tool_details
                                )
                            )
            continue

        # --- Tool results ---
        if role == "toolResult":
            if not include_tool_results:
                continue
            # Keep tool results grouped under the assistant turn
            if current_role != "assistant":
                flush_turn()
                current_role = "assistant"
                lines.append("---\n")
                lines.append("## 🤖 Assistant\n")
            turn_parts.append(
                _render_tool_result(entry, include_details=include_tool_details)
            )
            continue

        # --- Bash executions (user ! commands) ---
        if role == "bashExecution":
            flush_turn()
            current_role = None
            command = msg.get("command", "")
            output = msg.get("output", "")
            exit_code = msg.get("exitCode", "")
            lines.append("---\n")
            lines.append("## ⚡ Shell Command\n")
            lines.append(f"```bash\n{command}\n```\n")
            if output:
                exit_marker = f" (exit {exit_code})" if exit_code else ""
                lines.append(
                    f"<details>\n<summary>Output{exit_marker}</summary>\n\n"
                    f"```\n{output}\n```\n\n</details>\n"
                )
            continue

        # --- Compaction summary ---
        if role == "compactionSummary":
            flush_turn()
            current_role = None
            summary = msg.get("summary", "")
            if summary:
                lines.append(
                    f"<details>\n<summary>📦 Compaction summary</summary>\n\n"
                    f"{summary}\n\n</details>\n"
                )
            continue

        # --- Branch summary ---
        if role == "branchSummary":
            flush_turn()
            current_role = None
            summary = msg.get("summary", "")
            if summary:
                lines.append(
                    f"<details>\n<summary>🌿 Branch summary</summary>\n\n"
                    f"{summary}\n\n</details>\n"
                )
            continue

        # --- Custom messages ---
        if role == "custom":
            custom_type = msg.get("customType", "")
            content = msg.get("content", "")
            if content:
                flush_turn()
                current_role = None
                lines.append(
                    f"<details>\n<summary>📌 {custom_type or 'Custom'}</summary>\n\n"
                    f"{content}\n\n</details>\n"
                )
            continue

    flush_turn()

    # --- Footer ---
    lines.append("\n---\n")
    lines.append(
        f"*Exported from [Pi](https://github.com/AiAgent-Labs/pi-coding-agent)"
        f" session `{meta.get('id', 'unknown')}`*\n"
    )

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert a Pi agent session JSONL file to Markdown.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=dedent("""\
            examples:
              %(prog)s session.jsonl                      # file → stdout
              %(prog)s session.jsonl -o transcript.md     # file → file
              cat session.jsonl | %(prog)s -              # stdin → stdout
              %(prog)s fa769cff                           # find by UUID prefix
              %(prog)s session.jsonl --thinking            # include thinking blocks
              %(prog)s session.jsonl --no-tool-calls       # omit tool calls & results
        """),
    )
    parser.add_argument(
        "session",
        help=(
            "Path to a .jsonl session file, '-' for stdin, "
            "or a session UUID/timestamp prefix"
        ),
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="Output file path (default: stdout)",
    )
    parser.add_argument(
        "--thinking",
        action="store_true",
        default=False,
        help="Include thinking/reasoning blocks (default: omit)",
    )
    parser.add_argument(
        "--no-thinking",
        action="store_true",
        default=False,
        help="Exclude thinking blocks (default; for explicitness)",
    )
    parser.add_argument(
        "--tool-calls",
        action="store_true",
        default=None,
        help="Include tool calls (default: yes)",
    )
    parser.add_argument(
        "--no-tool-calls",
        action="store_true",
        default=False,
        help="Exclude tool calls and their results",
    )
    parser.add_argument(
        "--tool-results",
        action="store_true",
        default=None,
        help="Include tool results (default: yes)",
    )
    parser.add_argument(
        "--no-tool-results",
        action="store_true",
        default=False,
        help="Exclude tool results (keep tool calls only)",
    )
    parser.add_argument(
        "--tool-details",
        action="store_true",
        default=False,
        help="Include tool-specific detail objects (default: omit)",
    )
    parser.add_argument(
        "--no-metadata",
        action="store_true",
        default=False,
        help="Omit the metadata header (date, model, cwd)",
    )

    args = parser.parse_args()

    # --- Read input ---
    if args.session == "-":
        raw_lines = sys.stdin.read().splitlines()
    else:
        try:
            path = _find_session_file(args.session)
        except FileNotFoundError as exc:
            print(str(exc), file=sys.stderr)
            sys.exit(1)
        raw_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()

    entries = _parse_jsonl(raw_lines)
    if not entries:
        print("No entries found in input.", file=sys.stderr)
        sys.exit(1)

    # --- Resolve flags ---
    include_thinking = args.thinking and not args.no_thinking
    include_tool_calls = not args.no_tool_calls
    include_tool_results = not args.no_tool_results and not args.no_tool_calls
    if args.tool_results is True:
        include_tool_results = True

    # --- Render ---
    md = render_markdown(
        entries,
        include_thinking=include_thinking,
        include_tool_calls=include_tool_calls,
        include_tool_results=include_tool_results,
        include_tool_details=args.tool_details,
        include_metadata=not args.no_metadata,
    )

    # --- Write output ---
    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(md, encoding="utf-8")
        print(f"Written to {out_path}", file=sys.stderr)
    else:
        print(md)


if __name__ == "__main__":
    main()
