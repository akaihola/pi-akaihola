/**
 * Usage Bars — Claude quota usage in the status bar
 *
 * Shows 5-hour and 7-day Claude Max quota usage as colour-coded bar graphs.
 * Reads OAuth tokens from ~/.claude-code-mux/oauth_tokens.json (managed by
 * Claude Code Mux) rather than requiring pi's own OAuth login.  Handles
 * token refresh automatically using Anthropic's public OAuth endpoint.
 *
 * Usage: pi -e ~/.pi/agent/extensions/usage-bars.ts
 *
 * Inspired by rho/extensions/usage-bars and steipete/CodexBar.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Constants ────────────────────────────────────────────────────────────────

const CCM_TOKEN_FILE = path.join(
  os.homedir(),
  ".claude-code-mux",
  "oauth_tokens.json",
);
const CCM_PROVIDER_ID = "claude-max";

/** Anthropic OAuth client ID (public PKCE client – not a secret) */
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// ── Types ────────────────────────────────────────────────────────────────────

interface CcmToken {
  provider_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO 8601
}

interface CcmTokenFile {
  [providerId: string]: CcmToken;
}

interface ClaudeUsageResponse {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
  };
}

interface TokenRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface UsageState {
  fiveHour: number; // 0–100
  sevenDay: number; // 0–100
  extraSpend?: number;
  extraLimit?: number;
  error?: string;
}

// ── Token helpers ────────────────────────────────────────────────────────────

function readCcmToken(): CcmToken | null {
  try {
    const raw = fs.readFileSync(CCM_TOKEN_FILE, "utf-8");
    const data = JSON.parse(raw) as CcmTokenFile;
    return data[CCM_PROVIDER_ID] ?? null;
  } catch {
    return null;
  }
}

function writeCcmToken(token: CcmToken): void {
  try {
    const raw = fs.readFileSync(CCM_TOKEN_FILE, "utf-8");
    const data = JSON.parse(raw) as CcmTokenFile;
    data[CCM_PROVIDER_ID] = token;
    fs.writeFileSync(CCM_TOKEN_FILE, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
  } catch {
    // Non-fatal – CCM will overwrite with a fresh token next time it runs
  }
}

function isExpiredOrSoon(token: CcmToken): boolean {
  const expiresAt = new Date(token.expires_at).getTime();
  const bufferMs = 5 * 60 * 1000; // 5 minutes
  return Date.now() + bufferMs >= expiresAt;
}

async function refreshCcmToken(token: CcmToken): Promise<CcmToken | null> {
  try {
    const res = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: ANTHROPIC_CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as TokenRefreshResponse;
    const refreshed: CcmToken = {
      provider_id: CCM_PROVIDER_ID,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? token.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    };
    writeCcmToken(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

/** Returns a valid access token, refreshing if needed. Returns null on failure. */
async function getValidToken(): Promise<string | null> {
  let token = readCcmToken();
  if (!token) return null;
  if (isExpiredOrSoon(token)) {
    token = await refreshCcmToken(token);
  }
  return token?.access_token ?? null;
}

// ── Usage fetching ───────────────────────────────────────────────────────────

async function fetchUsage(): Promise<UsageState | null> {
  const accessToken = await getValidToken();
  if (!accessToken) return null;

  try {
    const res = await fetch(ANTHROPIC_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (!res.ok)
      return { fiveHour: 0, sevenDay: 0, error: `HTTP ${res.status}` };
    const data = (await res.json()) as ClaudeUsageResponse;

    const state: UsageState = {
      fiveHour: toPct(data.five_hour?.utilization ?? 0),
      sevenDay: toPct(data.seven_day?.utilization ?? 0),
    };
    if (data.extra_usage?.is_enabled) {
      state.extraSpend = data.extra_usage.used_credits;
      state.extraLimit = data.extra_usage.monthly_limit;
    }
    return state;
  } catch (e) {
    return { fiveHour: 0, sevenDay: 0, error: String(e) };
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Normalize 0–1 fractions and 0–100 values to 0–100 integer percentage */
function toPct(value: number): number {
  if (value > 0 && value <= 1) return Math.round(value * 100);
  return Math.round(value);
}

function formatBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round(clamped / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function buildStatusText(state: UsageState): string {
  let text = `Claude ▸ 5h ${formatBar(state.fiveHour)} ${state.fiveHour}%  7d ${formatBar(state.sevenDay)} ${state.sevenDay}%`;
  if (state.extraSpend != null) {
    text += `  extra: $${state.extraSpend.toFixed(2)}/$${state.extraLimit?.toFixed(2) ?? "?"}`;
  }
  return text;
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let ctx: any = null;
  let lastState: UsageState | null = null;

  function setStatus(text: string) {
    if (ctx?.ui?.setStatus) ctx.ui.setStatus(text);
  }

  async function poll() {
    const state = await fetchUsage();
    lastState = state;
    if (state && !state.error) {
      setStatus(buildStatusText(state));
      pi.events.emit("usage:update", {
        session: state.fiveHour,
        weekly: state.sevenDay,
      });
    } else {
      // Clear status on error rather than showing stale data
      setStatus("");
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => poll(), POLL_INTERVAL_MS);
  }

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;
    await poll();
    startPolling();
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  pi.on("turn_start", async (_event, _ctx) => {
    ctx = _ctx;
  });

  pi.registerCommand("usage", {
    description: "Refresh Claude quota usage bars",
    handler: async (_args, _ctx) => {
      ctx = _ctx;
      await poll();
      if (lastState?.error) {
        _ctx.ui.notify(`Usage fetch failed: ${lastState.error}`, "error");
      } else if (lastState) {
        _ctx.ui.notify(buildStatusText(lastState), "info");
      } else {
        _ctx.ui.notify("No CCM token found at " + CCM_TOKEN_FILE, "error");
      }
    },
  });
}
