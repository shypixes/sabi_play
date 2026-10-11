/**
 * TEMPORARY competition test panel: request + result logic (client-safe, no secrets).
 * Remove with the whole src/app/(app)/test-panel folder before launch.
 *
 * Every request goes to the EXISTING API with the browser's own session cookie
 * (same-origin). Nothing here sends a user id, token or service key, and nothing
 * assumes success: results are built only from the real HTTP response.
 */

/** The free PRACTICE config on the hosted test project (test-game, SCORE_ATTACK, 180s). */
export const TEST_PANEL_CONFIG_ID = "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac";

export type PanelAction = "create" | "refresh" | "cancel" | "whoami";

export type PanelRequest = { method: "GET" | "POST"; url: string; body: string | null; init: RequestInit };

type Common = { action: PanelAction; method: string; url: string; requestBody: string | null; durationMs: number; finishedAt: string };

export type PanelResult =
  | (Common & { kind: "response"; httpStatus: number; httpOk: boolean; isJson: boolean; body: unknown; bodyText: string })
  | (Common & { kind: "network-error"; message: string });

export type PanelSummary = { tone: "success" | "warning" | "error"; title: string; details: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildPanelRequest(action: PanelAction, sessionId: string | null = null): PanelRequest {
  const headers: Record<string, string> = { accept: "application/json" };
  const base: RequestInit = { credentials: "same-origin", cache: "no-store", redirect: "follow" };

  if (action === "whoami") return { method: "GET", url: "/api/me", body: null, init: { ...base, method: "GET", headers } };

  if (action === "create") {
    const body = JSON.stringify({ configId: TEST_PANEL_CONFIG_ID });
    return {
      method: "POST", url: "/api/competitions/sessions", body,
      init: { ...base, method: "POST", headers: { ...headers, "content-type": "application/json" }, body },
    };
  }

  if (!sessionId || !UUID.test(sessionId)) throw new Error("A session must be created or loaded first.");
  const path = `/api/competitions/sessions/${encodeURIComponent(sessionId)}`;
  if (action === "refresh") return { method: "GET", url: path, body: null, init: { ...base, method: "GET", headers } };
  const body = "{}";
  return {
    method: "POST", url: `${path}/cancel`, body,
    init: { ...base, method: "POST", headers: { ...headers, "content-type": "application/json" }, body },
  };
}

export async function runPanelRequest(
  action: PanelAction,
  sessionId: string | null,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): Promise<PanelResult> {
  const req = buildPanelRequest(action, sessionId);
  const started = now();
  const common = () => ({
    action, method: req.method, url: req.url, requestBody: req.body,
    durationMs: Math.max(0, Math.round(now() - started)), finishedAt: new Date().toISOString(),
  });
  try {
    const res = await fetchImpl(req.url, req.init);
    const bodyText = await res.text();
    let body: unknown = null;
    let isJson = false;
    try {
      body = bodyText.length > 0 ? JSON.parse(bodyText) : null;
      isJson = bodyText.length > 0;
    } catch {
      body = null;
    }
    return { ...common(), kind: "response", httpStatus: res.status, httpOk: res.ok, isJson, body, bodyText };
  } catch (err) {
    return { ...common(), kind: "network-error", message: err instanceof Error ? err.message : String(err) };
  }
}

type Envelope =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

function asEnvelope(body: unknown): Envelope | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.ok === true && b.data && typeof b.data === "object") return { ok: true, data: b.data as Record<string, unknown> };
  if (b.ok === false && b.error && typeof b.error === "object") {
    const e = b.error as Record<string, unknown>;
    if (typeof e.code === "string" && typeof e.message === "string") {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
  }
  return null;
}

function sessionOf(result: PanelResult): Record<string, unknown> | null {
  if (result.kind !== "response") return null;
  const env = asEnvelope(result.body);
  const s = env?.ok ? env.data.session : null;
  return s && typeof s === "object" ? (s as Record<string, unknown>) : null;
}

/** Session id from a successful create/refresh/cancel response, or null. */
export function extractSessionId(result: PanelResult): string | null {
  if (result.kind !== "response" || !result.httpOk) return null;
  const id = sessionOf(result)?.sessionId;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

const SUCCESS_TITLE: Record<PanelAction, string> = {
  create: "Practice session created",
  refresh: "Session loaded",
  cancel: "Session cancelled",
  whoami: "Signed in",
};

function failureHints(action: PanelAction, status: number, code: string, message: string): string[] {
  if (status === 401) return ["You are not signed in, or your login expired. Log in again, then reopen this page."];
  if (status === 409 && /not open right now/i.test(message)) {
    return ["The test configuration is DISABLED. Enable it in the Supabase SQL editor, then try again."];
  }
  if (status === 409 && /game is not available/i.test(message)) {
    return ["This deployment does not register test-game as an ACTIVE Score Attack game."];
  }
  if (status === 409 && /open session/i.test(message)) {
    return ["You already have 3 open sessions. Cancel one (Cancel session) or let in-progress ones expire."];
  }
  if (status === 409) return ["The session is not in a state that allows this action."];
  if (status === 403 && /paid/i.test(message)) return ["This configuration is PAID. Paid play is disabled; use the free practice config."];
  if (status === 403 && /profile/i.test(message)) return ["Your account has no profile row in this Supabase project."];
  if (status === 404) {
    return action === "create"
      ? ["The configuration was not found in this Supabase project (check the project the preview points to)."]
      : ["Session not found (or it belongs to another account)."];
  }
  if (status === 400) return ["The server rejected the request as invalid (see details below)."];
  if (status >= 500) return ["Server error. Check the Vercel function logs for this request; no success was confirmed."];
  return [`Unexpected error code ${code}.`];
}

export function summarize(result: PanelResult): PanelSummary {
  if (result.kind === "network-error") {
    return {
      tone: "error",
      title: "Request did not reach the server",
      details: [result.message, "Check your connection. Nothing was confirmed by the server."],
    };
  }
  const env = asEnvelope(result.body);
  if (!result.isJson || !env) {
    return {
      tone: "error",
      title: `Unexpected response (HTTP ${result.httpStatus})`,
      details: ["The server did not return the standard JSON envelope. Raw response shown below."],
    };
  }
  if (result.httpOk && env.ok) {
    const s = sessionOf(result);
    const details = s
      ? [
          `Status: ${String(s.status)}`,
          `Validation: ${String(s.validationStatus)}`,
          `Settlement: ${String(s.settlementStatus)}`,
          `Game: ${String(s.gameId)} · ${String(s.format)} · ${String(s.mode)}`,
        ]
      : [];
    if (result.action === "create" && result.httpStatus !== 201) details.push(`Note: expected HTTP 201, got ${result.httpStatus}.`);
    return { tone: "success", title: `${SUCCESS_TITLE[result.action]} (HTTP ${result.httpStatus})`, details };
  }
  if (!env.ok) {
    return {
      tone: "error",
      title: `Request failed (HTTP ${result.httpStatus} ${env.error.code})`,
      details: [env.error.message, ...failureHints(result.action, result.httpStatus, env.error.code, env.error.message)],
    };
  }
  return {
    tone: "warning",
    title: `Inconsistent response (HTTP ${result.httpStatus})`,
    details: ["The HTTP status and the JSON envelope disagree. Raw response shown below."],
  };
}

/** Pretty JSON when the body was JSON, otherwise the raw text (never fabricated). */
export function displayBody(result: PanelResult): string {
  if (result.kind !== "response") return "(no response)";
  if (result.isJson) return JSON.stringify(result.body, null, 2);
  return result.bodyText.length > 0 ? result.bodyText : "(empty body)";
}
