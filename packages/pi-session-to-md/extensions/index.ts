import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(__dirname, "..", "scripts", "session-to-md.py");

/**
 * Find a working Python 3 interpreter.
 */
async function findPython(): Promise<string> {
  for (const cmd of ["python3", "python"]) {
    try {
      const { stdout } = await execFileAsync(cmd, ["--version"]);
      if (stdout.includes("Python 3")) return cmd;
    } catch {
      // try next
    }
  }
  throw new Error("Python 3 not found. Install Python 3 to use session-to-md.");
}

/**
 * Run the session-to-md.py script with the given arguments.
 */
async function runScript(args: string[]): Promise<string> {
  const python = await findPython();
  const { stdout, stderr } = await execFileAsync(
    python,
    [SCRIPT_PATH, ...args],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  if (stderr && !stderr.startsWith("Written to ")) {
    // stderr may contain the "Written to <path>" message, which is fine
    const realErrors = stderr
      .split("\n")
      .filter((l) => !l.startsWith("Written to "));
    if (realErrors.some((l) => l.trim())) {
      throw new Error(realErrors.join("\n"));
    }
  }
  return stdout;
}

export default function (pi: ExtensionAPI): void {
  // ─── Tool: session_to_md ───────────────────────────────────────────

  pi.registerTool({
    name: "session_to_md",
    label: "Session to Markdown",
    description: [
      "Export the current Pi session (or any session JSONL file) to a",
      "clean Markdown transcript. Reads the session tree, follows the",
      "active branch, and renders user/assistant turns with optional",
      "thinking blocks, tool calls, and tool results.",
    ].join(" "),
    parameters: Type.Object({
      output: Type.Optional(
        Type.String({
          description:
            'Output file path. Defaults to "session-<slug>.md" in the working directory.',
        }),
      ),
      session: Type.Optional(
        Type.String({
          description:
            "Path to a .jsonl session file, a UUID prefix, or a timestamp prefix. " +
            "Omit to use the current session.",
        }),
      ),
      thinking: Type.Optional(
        Type.Boolean({
          description: "Include thinking/reasoning blocks (default: false)",
        }),
      ),
      toolCalls: Type.Optional(
        Type.Boolean({
          description: "Include tool calls (default: true)",
        }),
      ),
      toolResults: Type.Optional(
        Type.Boolean({
          description: "Include tool results (default: true)",
        }),
      ),
      toolDetails: Type.Optional(
        Type.Boolean({
          description: "Include tool-specific detail objects (default: false)",
        }),
      ),
      metadata: Type.Optional(
        Type.Boolean({
          description: "Include the metadata header (default: true)",
        }),
      ),
    }),
    async execute(args, ctx) {
      // Resolve the session file
      let sessionPath = args.session;
      if (!sessionPath) {
        const file = ctx.sessionManager.getSessionFile();
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: "Error: No session file available (ephemeral session). Pass a session path explicitly.",
              },
            ],
            isError: true,
          };
        }
        sessionPath = file;
      }

      // Build script arguments
      const scriptArgs: string[] = [sessionPath];

      // Determine output path
      let outputPath = args.output;
      if (!outputPath) {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (sessionFile) {
          const stem = basename(sessionFile, ".jsonl");
          outputPath = `session-${stem}.md`;
        } else {
          outputPath = "session-export.md";
        }
      }
      scriptArgs.push("-o", resolve(ctx.sessionManager.getCwd(), outputPath));

      // Flags
      if (args.thinking) scriptArgs.push("--thinking");
      if (args.toolCalls === false) scriptArgs.push("--no-tool-calls");
      if (args.toolResults === false) scriptArgs.push("--no-tool-results");
      if (args.toolDetails) scriptArgs.push("--tool-details");
      if (args.metadata === false) scriptArgs.push("--no-metadata");

      try {
        await runScript(scriptArgs);
        const resolvedOut = resolve(ctx.sessionManager.getCwd(), outputPath);
        return {
          content: [
            {
              type: "text",
              text: `Session exported to: ${resolvedOut}`,
            },
          ],
          details: {
            outputPath: resolvedOut,
            sessionPath,
            flags: {
              thinking: args.thinking ?? false,
              toolCalls: args.toolCalls ?? true,
              toolResults: args.toolResults ?? true,
              toolDetails: args.toolDetails ?? false,
              metadata: args.metadata ?? true,
            },
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error exporting session: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ─── Command: /session-to-md ───────────────────────────────────────

  pi.registerCommand("session-to-md", {
    description:
      "Export the current session to a Markdown file. " +
      "Usage: /session-to-md [output.md] [--thinking] [--no-tool-calls] [--no-tool-results] [--tool-details] [--no-metadata]",
    handler: async (rawArgs, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify(
          "No session file (ephemeral session). Use the tool with an explicit path.",
          "error",
        );
        return;
      }

      // Parse arguments from the raw string
      const tokens = (rawArgs || "").split(/\s+/).filter(Boolean);
      const flags: string[] = [];
      let outputPath: string | null = null;

      for (const token of tokens) {
        if (token.startsWith("--")) {
          flags.push(token);
        } else if (!outputPath) {
          outputPath = token;
        }
      }

      // Default output path
      if (!outputPath) {
        const stem = basename(sessionFile, ".jsonl");
        outputPath = `session-${stem}.md`;
      }

      const scriptArgs: string[] = [
        sessionFile,
        "-o",
        resolve(ctx.sessionManager.getCwd(), outputPath),
        ...flags,
      ];

      try {
        await runScript(scriptArgs);
        const resolvedOut = resolve(ctx.sessionManager.getCwd(), outputPath);
        ctx.ui.notify(`Session exported to ${resolvedOut}`, "info");
      } catch (err) {
        ctx.ui.notify(
          `Export failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
