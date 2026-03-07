import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { basename } from "node:path";

interface SessionMeta {
  file: string | null;
  filename: string | null;
  id: string | null;
  shortId: string | null;
  timestamp: string | null;
  slug: string | null;
  name: string | null;
}

function deriveSessionMeta(
  sessionFile: string | null,
  sessionName?: string,
): SessionMeta {
  if (!sessionFile) {
    return {
      file: null,
      filename: null,
      id: null,
      shortId: null,
      timestamp: null,
      slug: null,
      name: sessionName ?? null,
    };
  }

  const filename = basename(sessionFile);
  const match = filename.match(
    /^(?<timestamp>.+?)_(?<id>[0-9a-f-]{36})\.jsonl$/i,
  );
  const id = match?.groups?.id ?? null;
  const timestamp = match?.groups?.timestamp ?? null;
  const shortId = id?.slice(0, 8) ?? null;
  const slug =
    timestamp && shortId
      ? `${timestamp}_${shortId}`
      : filename.replace(/\.jsonl$/i, "");

  return {
    file: sessionFile,
    filename,
    id,
    shortId,
    timestamp,
    slug,
    name: sessionName ?? null,
  };
}

function formatSessionBlock(meta: SessionMeta): string {
  return [
    `Pi-Session: ${meta.id ?? "ephemeral"}`,
    `Pi-Session-Slug: ${meta.slug ?? "ephemeral"}`,
    `Pi-Session-File: ${meta.file ?? "ephemeral"}`,
    `Pi-Session-Name: ${meta.name ?? "(unset)"}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI): void {
  let currentMeta: SessionMeta = deriveSessionMeta(null);

  function refreshMeta(ctx: {
    sessionManager: { getSessionFile: () => string | null };
  }) {
    currentMeta = deriveSessionMeta(
      ctx.sessionManager.getSessionFile(),
      pi.getSessionName() ?? undefined,
    );
  }

  function updateStatus(ctx: {
    ui: { setStatus: (id: string, value: string | undefined) => void };
  }) {
    const parts = [
      currentMeta.shortId
        ? `session ${currentMeta.shortId}`
        : "session ephemeral",
      currentMeta.name ? `name ${currentMeta.name}` : null,
    ].filter(Boolean);
    ctx.ui.setStatus("session-meta", parts.join(" · "));
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshMeta(ctx);
    updateStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    refreshMeta(ctx);
    updateStatus(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    refreshMeta(ctx);
    updateStatus(ctx);
  });

  pi.registerTool({
    name: "session_meta",
    label: "Session Meta",
    description:
      "Return the current Pi session file path, UUID, slug, and a reusable metadata block for plans, notes, and commit footers.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...currentMeta,
                block: formatSessionBlock(currentMeta),
              },
              null,
              2,
            ),
          },
        ],
        details: {
          ...currentMeta,
          block: formatSessionBlock(currentMeta),
        },
      };
    },
  });

  pi.registerCommand("session-meta", {
    description: "Show current session metadata and a reusable stamp block",
    handler: async (_args, ctx) => {
      refreshMeta(ctx);
      updateStatus(ctx);
      ctx.ui.notify(formatSessionBlock(currentMeta), "info");
    },
  });

  pi.registerCommand("session-stamp", {
    description: "Insert a session metadata block into the editor",
    handler: async (_args, ctx) => {
      refreshMeta(ctx);
      updateStatus(ctx);
      ctx.ui.setEditorText(formatSessionBlock(currentMeta));
    },
  });
}
