/**
 * Runs a single agent in JSON mode as a subprocess.
 * Streams structured events back via onUpdate.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.js";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface AgentResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export type OnUpdateFn = (partial: {
  content: string;
  result: AgentResult;
}) => void;

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function writeTmpPrompt(
  agentName: string,
  prompt: string,
): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-"));
  const safe = agentName.replace(/[^\w.-]+/g, "_");
  const file = path.join(dir, `prompt-${safe}.md`);
  fs.writeFileSync(file, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, file };
}

export async function runAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateFn | undefined,
): Promise<AgentResult> {
  const result: AgentResult = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: agent.model,
    step,
  };

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0)
    args.push("--tools", agent.tools.join(","));

  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  const emit = () => {
    onUpdate?.({
      content: getFinalOutput(result.messages) || "(running…)",
      result,
    });
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = writeTmpPrompt(agent.name, agent.systemPrompt);
      tmpDir = tmp.dir;
      tmpFile = tmp.file;
      args.push("--append-system-prompt", tmpFile);
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buf = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }

        if (ev.type === "message_end" && ev.message) {
          const msg = ev.message as Message;
          result.messages.push(msg);
          if (msg.role === "assistant") {
            result.usage.turns++;
            const u = msg.usage;
            if (u) {
              result.usage.input += u.input || 0;
              result.usage.output += u.output || 0;
              result.usage.cacheRead += u.cacheRead || 0;
              result.usage.cacheWrite += u.cacheWrite || 0;
              result.usage.cost += u.cost?.total || 0;
              result.usage.contextTokens = u.totalTokens || 0;
            }
            if (!result.model && msg.model) result.model = msg.model;
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          }
          emit();
        }
        if (ev.type === "tool_result_end" && ev.message) {
          result.messages.push(ev.message as Message);
          emit();
        }
      };

      proc.stdout.on("data", (data) => {
        buf += data.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) processLine(l);
      });

      proc.stderr.on("data", (d) => {
        result.stderr += d.toString();
      });

      proc.on("close", (code) => {
        if (buf.trim()) processLine(buf);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
    if (wasAborted) throw new Error("Agent was aborted");
    return result;
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
    if (tmpDir) {
      try {
        fs.rmdirSync(tmpDir);
      } catch {}
    }
  }
}
