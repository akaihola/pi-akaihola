/**
 * TUI rendering helpers for the orchestrator tool.
 */

import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import type { AgentResult, UsageStats } from "./runner.js";

export interface Theme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
}

// ── Usage formatting ────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtUsage(u: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
  if (u.input) parts.push(`↑${fmt(u.input)}`);
  if (u.output) parts.push(`↓${fmt(u.output)}`);
  if (u.cacheRead) parts.push(`R${fmt(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${fmt(u.cacheWrite)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (u.contextTokens) parts.push(`ctx:${fmt(u.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function sumUsage(results: AgentResult[]): UsageStats {
  const total: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
  }
  return total;
}

// ── Result icon ─────────────────────────────────────────────────────────────

export function resultIcon(r: AgentResult, theme: Theme): string {
  if (r.exitCode === -1) return theme.fg("warning", "⏳");
  if (
    r.exitCode === 0 &&
    r.stopReason !== "error" &&
    r.stopReason !== "aborted"
  )
    return theme.fg("success", "✓");
  return theme.fg("error", "✗");
}

export function isError(r: AgentResult): boolean {
  return (
    r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted"
  );
}

// ── Display items (tool calls + text from assistant messages) ────────────────

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: AgentResult["messages"]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({
            type: "toolCall",
            name: part.name,
            args: part.arguments,
          });
      }
    }
  }
  return items;
}

function fmtToolCall(
  name: string,
  args: Record<string, any>,
  fg: (c: string, t: string) => string,
): string {
  const shorten = (p: string) => {
    const h = process.env.HOME || "~";
    return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
  };
  switch (name) {
    case "bash": {
      const cmd = String(args.command || "...");
      return (
        fg("muted", "$ ") +
        fg("toolOutput", cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd)
      );
    }
    case "read": {
      const p = shorten(String(args.file_path || args.path || "..."));
      return fg("muted", "read ") + fg("accent", p);
    }
    case "write":
      return (
        fg("muted", "write ") +
        fg("accent", shorten(String(args.file_path || args.path || "...")))
      );
    case "edit":
      return (
        fg("muted", "edit ") +
        fg("accent", shorten(String(args.file_path || args.path || "...")))
      );
    default: {
      const s = JSON.stringify(args);
      return (
        fg("accent", name) +
        fg("dim", " " + (s.length > 50 ? s.slice(0, 50) + "…" : s))
      );
    }
  }
}

function renderItems(
  items: DisplayItem[],
  limit: number | undefined,
  theme: Theme,
): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let out = "";
  if (skipped) out += theme.fg("muted", `… ${skipped} earlier items\n`);
  for (const item of toShow) {
    if (item.type === "text") {
      out +=
        theme.fg("toolOutput", item.text.split("\n").slice(0, 3).join("\n")) +
        "\n";
    } else {
      out +=
        theme.fg("muted", "→ ") +
        fmtToolCall(item.name, item.args, theme.fg.bind(theme)) +
        "\n";
    }
  }
  return out.trimEnd();
}

// ── Single result block (collapsed) ─────────────────────────────────────────

export function renderSingleCollapsed(r: AgentResult, theme: Theme): string {
  const icon = resultIcon(r, theme);
  const items = getDisplayItems(r.messages);
  let text =
    `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}` +
    theme.fg("muted", ` (${r.agentSource})`);
  if (r.step !== undefined) text = theme.fg("muted", `Step ${r.step}: `) + text;
  if (isError(r) && r.stopReason)
    text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  if (isError(r) && r.errorMessage)
    text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
  else if (items.length === 0)
    text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running…)" : "(no output)")}`;
  else text += `\n${renderItems(items, 8, theme)}`;
  const u = fmtUsage(r.usage, r.model);
  if (u) text += `\n${theme.fg("dim", u)}`;
  return text;
}

// ── Single result block (expanded) ──────────────────────────────────────────

export function renderSingleExpanded(
  r: AgentResult,
  theme: Theme,
): import("@mariozechner/pi-tui").Component {
  const mdTheme = getMarkdownTheme();
  const container = new Container();
  const icon = resultIcon(r, theme);
  const items = getDisplayItems(r.messages);

  let header =
    `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}` +
    theme.fg("muted", ` (${r.agentSource})`);
  if (r.step !== undefined)
    header = theme.fg("muted", `Step ${r.step}: `) + header;
  if (isError(r) && r.stopReason)
    header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  container.addChild(new Text(header, 0, 0));

  if (isError(r) && r.errorMessage)
    container.addChild(
      new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
    );

  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
  container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));

  for (const item of items) {
    if (item.type === "toolCall")
      container.addChild(
        new Text(
          theme.fg("muted", "→ ") +
            fmtToolCall(item.name, item.args, theme.fg.bind(theme)),
          0,
          0,
        ),
      );
  }

  // Find final text output
  let finalText = "";
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const msg = r.messages[i];
    if (msg.role === "assistant") {
      for (const p of msg.content) {
        if (p.type === "text") {
          finalText = p.text;
          break;
        }
      }
      if (finalText) break;
    }
  }

  if (finalText) {
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(finalText.trim(), 0, 0, mdTheme));
  }

  const u = fmtUsage(r.usage, r.model);
  if (u) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", u), 0, 0));
  }
  return container;
}
