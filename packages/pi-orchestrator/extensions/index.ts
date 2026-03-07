/**
 * Orchestrator Extension
 *
 * Exposes an `orchestrate` tool the LLM can call to run multi-agent
 * workflows built from four specialized roles:
 *
 *   orchestrator  – top-level coordinator (self-referential: the main agent
 *                   can also call this tool to delegate an entire workflow)
 *   researcher    – gathers codebase / web context (read-only, fast model)
 *   planner       – turns context into a numbered plan (read-only)
 *   coder         – implements the plan (full tool access)
 *
 * Supported modes (mirrors the subagent extension for familiarity):
 *   single  – { agent, task }
 *   chain   – { chain: [{agent, task}] }  – {previous} placeholder supported
 *   parallel – { tasks: [{agent, task}] }
 *
 * Pre-built workflows exposed as /commands:
 *   /research-and-plan <task>   → researcher → planner
 *   /research-plan-code <task>  → researcher → planner → coder
 *   /plan-and-code <task>       → planner → coder
 *   /just-code <task>           → coder (single)
 *
 * Agent markdown files live in ~/.pi/agent/agents/ (or .pi/agents/ for
 * project-local overrides, opt-in via agentScope: "both").
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentScope, discoverAgents } from "./agents.js";
import {
  fmtUsage,
  isError,
  renderSingleCollapsed,
  renderSingleExpanded,
  sumUsage,
  type Theme,
} from "./render.js";
import { type AgentResult, getFinalOutput, runAgent } from "./runner.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool parameter schema
// ─────────────────────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({
    description: "Agent name (researcher, planner, coder, orchestrator, …)",
  }),
  task: Type.String({ description: "Task description" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory override" }),
  ),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({
    description: "Task – use {previous} to pass prior agent output",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory override" }),
  ),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: "Which agent dirs to search. Default: user",
  default: "user",
});

const OrchestrateParams = Type.Object({
  // ── single mode
  agent: Type.Optional(
    Type.String({ description: "Agent name for single mode" }),
  ),
  task: Type.Optional(Type.String({ description: "Task for single mode" })),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for single mode" }),
  ),

  // ── parallel mode
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "Parallel tasks array" }),
  ),

  // ── chain mode
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: "Sequential chain; use {previous} in task strings",
    }),
  ),

  // ── options
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Prompt before running project-local agents. Default: true",
      default: true,
    }),
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Details type stored in tool result
// ─────────────────────────────────────────────────────────────────────────────

interface OrchestrateDetails {
  mode: "single" | "parallel" | "chain";
  results: AgentResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // ── Helper: inject status while running ────────────────────────────────

  function setRunningStatus(
    label: string,
    ctx: {
      ui: {
        setStatus: (id: string, s: string | undefined) => void;
        theme: { fg: (c: string, t: string) => string };
      };
    },
  ): void {
    ctx.ui.setStatus("orchestrator", ctx.ui.theme.fg("accent", `⚙ ${label}`));
  }
  function clearStatus(ctx: {
    ui: { setStatus: (id: string, s: string | undefined) => void };
  }): void {
    ctx.ui.setStatus("orchestrator", undefined);
  }

  // ── Main tool ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: [
      "Run multi-agent workflows using researcher, planner, coder, and orchestrator roles.",
      "Modes: single (agent + task), chain (sequential with {previous}), parallel (tasks array).",
      "Built-in agents: researcher (codebase/web context), planner (implementation plan), coder (implementation).",
      "Custom agents can be defined as .md files in ~/.pi/agent/agents/.",
    ].join(" "),
    parameters: OrchestrateParams,

    async execute(_id, params, signal, onUpdate, ctx) {
      const scope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, scope);
      const agents = discovery.agents;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const mode: "single" | "parallel" | "chain" = hasChain
        ? "chain"
        : hasTasks
          ? "parallel"
          : "single";

      if (modeCount !== 1) {
        const available = agents.map((a) => a.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text" as const,
              text: `Provide exactly one mode (single/chain/parallel).\nAvailable agents: ${available}`,
            },
          ],
          details: { mode, results: [] } as OrchestrateDetails,
        };
      }

      // Project-agent confirmation
      const confirmProjectAgents = params.confirmProjectAgents ?? true;
      if (
        (scope === "project" || scope === "both") &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const requested = new Set<string>();
        if (params.chain) for (const s of params.chain) requested.add(s.agent);
        if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
        if (params.agent) requested.add(params.agent);

        const projectOnes = [...requested]
          .map((n) => agents.find((a) => a.name === n))
          .filter((a): a is (typeof agents)[0] => a?.source === "project");

        if (projectOnes.length > 0) {
          const names = projectOnes.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${names}\nSource: ${dir}\n\nOnly continue for trusted repos.`,
          );
          if (!ok)
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Cancelled: project agents not approved.",
                },
              ],
              details: { mode, results: [] } as OrchestrateDetails,
            };
        }
      }

      // ── chain mode ────────────────────────────────────────────────

      if (params.chain && params.chain.length > 0) {
        const results: AgentResult[] = [];
        let previous = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const resolvedTask = step.task.replace(/\{previous\}/g, previous);
          const agentCfg = agents.find((a) => a.name === step.agent);

          if (!agentCfg) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown agent "${step.agent}". Available: ${agents.map((a) => a.name).join(", ")}`,
                },
              ],
              details: { mode: "chain", results } as OrchestrateDetails,
              isError: true,
            };
          }

          if (ctx.hasUI)
            setRunningStatus(
              `${step.agent} (step ${i + 1}/${params.chain.length})`,
              ctx,
            );

          const r = await runAgent(
            step.cwd ?? ctx.cwd,
            agentCfg,
            resolvedTask,
            i + 1,
            signal,
            onUpdate
              ? ({ content, result }) => {
                  const all = [...results, result];
                  onUpdate({
                    content: [{ type: "text", text: content }],
                    details: {
                      mode: "chain",
                      results: all,
                    } as OrchestrateDetails,
                  });
                }
              : undefined,
          );
          results.push(r);

          if (isError(r)) {
            if (ctx.hasUI) clearStatus(ctx);
            const errMsg =
              r.errorMessage ||
              r.stderr ||
              getFinalOutput(r.messages) ||
              "(no output)";
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Chain stopped at step ${i + 1} (${step.agent}): ${errMsg}`,
                },
              ],
              details: { mode: "chain", results } as OrchestrateDetails,
              isError: true,
            };
          }
          previous = getFinalOutput(r.messages);
        }

        if (ctx.hasUI) clearStatus(ctx);
        return {
          content: [
            {
              type: "text" as const,
              text:
                getFinalOutput(results[results.length - 1].messages) ||
                "(no output)",
            },
          ],
          details: { mode: "chain", results } as OrchestrateDetails,
        };
      }

      // ── parallel mode ─────────────────────────────────────────────

      if (params.tasks && params.tasks.length > 0) {
        const MAX = 8;
        const CONCURRENCY = 4;
        if (params.tasks.length > MAX) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX}.`,
              },
            ],
            details: { mode: "parallel", results: [] } as OrchestrateDetails,
          };
        }

        const allResults: AgentResult[] = params.tasks.map((t) => ({
          agent: t.agent,
          agentSource: "unknown" as const,
          task: t.task,
          exitCode: -1,
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
        }));

        if (ctx.hasUI)
          setRunningStatus(`parallel (${params.tasks.length} tasks)`, ctx);

        const emitParallel = () => {
          if (!onUpdate) return;
          const done = allResults.filter((r) => r.exitCode !== -1).length;
          const running = allResults.filter((r) => r.exitCode === -1).length;
          onUpdate({
            content: [
              {
                type: "text",
                text: `Parallel: ${done}/${allResults.length} done, ${running} running…`,
              },
            ],
            details: {
              mode: "parallel",
              results: [...allResults],
            } as OrchestrateDetails,
          });
        };

        // Concurrency-limited map
        let nextIdx = 0;
        const results2: AgentResult[] = new Array(params.tasks.length);
        const workers = Array.from(
          { length: Math.min(CONCURRENCY, params.tasks.length) },
          async () => {
            while (true) {
              const idx = nextIdx++;
              if (idx >= params.tasks!.length) return;
              const t = params.tasks![idx];
              const agentCfg = agents.find((a) => a.name === t.agent);
              if (!agentCfg) {
                allResults[idx] = {
                  ...allResults[idx],
                  exitCode: 1,
                  stderr: `Unknown agent "${t.agent}"`,
                };
                emitParallel();
                results2[idx] = allResults[idx];
                continue;
              }
              const r = await runAgent(
                t.cwd ?? ctx.cwd,
                agentCfg,
                t.task,
                undefined,
                signal,
                ({ result }) => {
                  allResults[idx] = result;
                  emitParallel();
                },
              );
              allResults[idx] = r;
              results2[idx] = r;
              emitParallel();
            }
          },
        );
        await Promise.all(workers);

        if (ctx.hasUI) clearStatus(ctx);
        const successCount = results2.filter((r) => r.exitCode === 0).length;
        const summaries = results2
          .map((r) => {
            const out = getFinalOutput(r.messages);
            return `[${r.agent}] ${r.exitCode === 0 ? "ok" : "failed"}: ${out.slice(0, 80) + (out.length > 80 ? "…" : "") || "(no output)"}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Parallel: ${successCount}/${results2.length} succeeded\n\n${summaries}`,
            },
          ],
          details: {
            mode: "parallel",
            results: results2,
          } as OrchestrateDetails,
        };
      }

      // ── single mode ───────────────────────────────────────────────

      if (params.agent && params.task) {
        const agentCfg = agents.find((a) => a.name === params.agent);
        if (!agentCfg) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown agent "${params.agent}". Available: ${available}`,
              },
            ],
            details: { mode: "single", results: [] } as OrchestrateDetails,
            isError: true,
          };
        }

        if (ctx.hasUI) setRunningStatus(params.agent, ctx);

        const r = await runAgent(
          params.cwd ?? ctx.cwd,
          agentCfg,
          params.task,
          undefined,
          signal,
          onUpdate
            ? ({ content, result }) => {
                onUpdate({
                  content: [{ type: "text", text: content }],
                  details: {
                    mode: "single",
                    results: [result],
                  } as OrchestrateDetails,
                });
              }
            : undefined,
        );

        if (ctx.hasUI) clearStatus(ctx);
        if (isError(r)) {
          const errMsg =
            r.errorMessage ||
            r.stderr ||
            getFinalOutput(r.messages) ||
            "(no output)";
          return {
            content: [
              {
                type: "text" as const,
                text: `Agent ${r.stopReason || "failed"}: ${errMsg}`,
              },
            ],
            details: { mode: "single", results: [r] } as OrchestrateDetails,
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: getFinalOutput(r.messages) || "(no output)",
            },
          ],
          details: { mode: "single", results: [r] } as OrchestrateDetails,
        };
      }

      return {
        content: [{ type: "text" as const, text: "Invalid parameters." }],
        details: { mode: "single", results: [] } as OrchestrateDetails,
      };
    },

    // ── renderCall ─────────────────────────────────────────────────────

    renderCall(args, theme) {
      const scope = args.agentScope ?? "user";
      if (args.chain?.length) {
        let text =
          theme.fg("toolTitle", theme.bold("orchestrate ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 4); i++) {
          const s = args.chain[i];
          const clean = s.task.replace(/\{previous\}/g, "").trim();
          const preview = clean.length > 50 ? clean.slice(0, 50) + "…" : clean;
          text +=
            `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", s.agent)}` +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 4)
          text += `\n  ${theme.fg("muted", `… +${args.chain.length - 4} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks?.length) {
        let text =
          theme.fg("toolTitle", theme.bold("orchestrate ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
          theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 4)) {
          const preview =
            t.task.length > 50 ? t.task.slice(0, 50) + "…" : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 4)
          text += `\n  ${theme.fg("muted", `… +${args.tasks.length - 4} more`)}`;
        return new Text(text, 0, 0);
      }
      const preview = args.task
        ? args.task.length > 70
          ? args.task.slice(0, 70) + "…"
          : args.task
        : "…";
      let text =
        theme.fg("toolTitle", theme.bold("orchestrate ")) +
        theme.fg("accent", args.agent || "…") +
        theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    // ── renderResult ───────────────────────────────────────────────────

    renderResult(result, { expanded }, theme) {
      const details = result.details as OrchestrateDetails | undefined;
      if (!details || details.results.length === 0) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
      }

      const { mode, results } = details;

      // Single
      if (mode === "single" && results.length === 1) {
        return expanded
          ? renderSingleExpanded(results[0], theme as unknown as Theme)
          : new Text(
              renderSingleCollapsed(results[0], theme as unknown as Theme),
              0,
              0,
            );
      }

      // Chain
      if (mode === "chain") {
        const successCount = results.filter((r) => r.exitCode === 0).length;
        const icon =
          successCount === results.length
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");

        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${results.length} steps`)}`,
              0,
              0,
            ),
          );
          for (const r of results) {
            container.addChild(new Text("", 0, 0)); // spacer
            container.addChild(
              renderSingleExpanded(r, theme as unknown as Theme) as ReturnType<
                Container["addChild"]
              > extends infer R
                ? any
                : never,
            );
          }
          const u = fmtUsage(sumUsage(results));
          if (u)
            container.addChild(new Text(theme.fg("dim", `Total: ${u}`), 0, 0));
          return container;
        }

        let text =
          `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}` +
          theme.fg("accent", `${successCount}/${results.length} steps`);
        for (const r of results)
          text += `\n\n${renderSingleCollapsed(r, theme as unknown as Theme)}`;
        const u = fmtUsage(sumUsage(results));
        if (u) text += `\n\n${theme.fg("dim", `Total: ${u}`)}`;
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      // Parallel
      if (mode === "parallel") {
        const running = results.filter((r) => r.exitCode === -1).length;
        const successCount = results.filter((r) => r.exitCode === 0).length;
        const isRunning = running > 0;
        const icon = isRunning
          ? theme.fg("warning", "⏳")
          : successCount < results.length
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
        const status = isRunning
          ? `${successCount + results.filter((r) => r.exitCode > 0).length}/${results.length} done, ${running} running`
          : `${successCount}/${results.length} tasks`;

        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
              0,
              0,
            ),
          );
          for (const r of results) {
            container.addChild(new Text("", 0, 0));
            container.addChild(
              renderSingleExpanded(r, theme as unknown as Theme) as any,
            );
          }
          const u = fmtUsage(sumUsage(results));
          if (u)
            container.addChild(new Text(theme.fg("dim", `Total: ${u}`), 0, 0));
          return container;
        }

        let text =
          `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}` +
          theme.fg("accent", status);
        for (const r of results)
          text += `\n\n${renderSingleCollapsed(r, theme as unknown as Theme)}`;
        if (!isRunning) {
          const u = fmtUsage(sumUsage(results));
          if (u) text += `\n\n${theme.fg("dim", `Total: ${u}`)}`;
        }
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
    },
  });

  // ── Pre-built workflow commands ────────────────────────────────────────

  function sendWorkflow(
    task: string,
    chain: { agent: string; task: string }[],
    label: string,
    ctx: Parameters<typeof setRunningStatus>[1],
  ): void {
    if (!task.trim()) {
      ctx.ui.notify(`Usage: /${label} <task description>`, "warning");
      return;
    }
    // Send a user message that instructs the LLM to call orchestrate
    pi.sendUserMessage(
      [
        {
          type: "text" as const,
          text: [
            `Run the following orchestration workflow for this task: "${task}"`,
            "",
            `Call the \`orchestrate\` tool with this exact chain:`,
            "```json",
            JSON.stringify({ chain }, null, 2),
            "```",
            "",
            "After the chain completes, summarise the outcome for the user.",
          ].join("\n"),
        },
      ],
      { deliverAs: "followUp" },
    );
  }

  pi.registerCommand("research-and-plan", {
    description:
      "researcher → planner: gather context then create an implementation plan",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      sendWorkflow(
        task,
        [
          {
            agent: "researcher",
            task: `Research the codebase and gather context for: ${task}`,
          },
          {
            agent: "planner",
            task: `Create an implementation plan for "${task}" using this research:\n\n{previous}`,
          },
        ],
        "research-and-plan",
        ctx,
      );
    },
  });

  pi.registerCommand("research-plan-code", {
    description:
      "researcher → planner → coder: full workflow from research to implementation",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      sendWorkflow(
        task,
        [
          {
            agent: "researcher",
            task: `Research the codebase and gather context for: ${task}`,
          },
          {
            agent: "planner",
            task: `Create an implementation plan for "${task}" using this research:\n\n{previous}`,
          },
          {
            agent: "coder",
            task: `Implement the following plan:\n\n{previous}`,
          },
        ],
        "research-plan-code",
        ctx,
      );
    },
  });

  pi.registerCommand("plan-and-code", {
    description: "planner → coder: create a plan then implement it",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      sendWorkflow(
        task,
        [
          {
            agent: "planner",
            task: `Create an implementation plan for: ${task}`,
          },
          {
            agent: "coder",
            task: `Implement the following plan:\n\n{previous}`,
          },
        ],
        "plan-and-code",
        ctx,
      );
    },
  });

  pi.registerCommand("just-code", {
    description:
      "coder: delegate a self-contained coding task directly to the coder agent",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /just-code <task description>", "warning");
        return;
      }
      pi.sendUserMessage(
        [
          {
            type: "text" as const,
            text: `Call the \`orchestrate\` tool with a single coder agent for this task:\n\n${task}`,
          },
        ],
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("list-agents", {
    description: "List all available orchestrator agents",
    handler: async (_args, ctx) => {
      const { agents } = discoverAgents(ctx.cwd, "both");
      if (agents.length === 0) {
        ctx.ui.notify(
          "No agents found. Add .md files to ~/.pi/agent/agents/ or .pi/agents/",
          "warning",
        );
        return;
      }
      const lines = agents
        .map((a) => `${a.name} (${a.source}): ${a.description}`)
        .join("\n");
      ctx.ui.notify(`Available agents:\n${lines}`, "info");
    },
  });

  // ── Session start: inject system prompt context ────────────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    const { agents } = discoverAgents(ctx.cwd, "user");
    if (agents.length === 0) return;

    const agentList = agents
      .map((a) => `- **${a.name}**: ${a.description}`)
      .join("\n");

    return {
      message: {
        customType: "orchestrator-agents",
        content: [
          "[ORCHESTRATOR AVAILABLE]",
          "You have access to the `orchestrate` tool for multi-agent workflows.",
          "",
          "Available agents:",
          agentList,
          "",
          "Workflow commands: /research-and-plan, /research-plan-code, /plan-and-code, /just-code",
          "Use the orchestrate tool when a task benefits from specialised roles or isolated context.",
        ].join("\n"),
        display: false,
      },
    };
  });
}
