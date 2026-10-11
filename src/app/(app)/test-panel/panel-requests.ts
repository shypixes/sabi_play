/**
 * TEMPORARY competition test panel: request + result logic (client-safe, no secrets).
 * Remove with the whole src/app/(app)/test-panel folder before launch.
 *
 * Every request goes to the EXISTING API with the browser's own session cookie
 * (same-origin). Nothing here sends a user id, token or service key, and nothing
 * assumes success: results are built only from the real HTTP response.
 *
 * Routes and bodies used (read from src/app/api/competitions/**):
 *   create   POST /api/competitions/sessions                     {"configId": "<uuid>"}
 *   refresh  GET  /api/competitions/sessions/<id>
 *   start    POST /api/competitions/sessions/<id>/start          {}
 *   submit   POST /api/competitions/sessions/<id>/result         {"format":"SCORE_ATTACK","score":<int>}
 *   cancel   POST /api/competitions/sessions/<id>/cancel         {}
 *   whoami   GET  /api/me
 */

/** The free PRACTICE config on the hosted test project (test-game, SCORE_ATTACK, 180s). */
export const TEST_PANEL_CONFIG_ID = "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac";

/**
 * A well-formed id that no real session has (sessions use gen_random_uuid()). The API answers
 * an unknown session exactly like another player's session (404), so this exercises the
 * "not yours" path without ever touching someone else's data.
 */
export const UNKNOWN_SESSION_ID = "00000000-0000-4000-8000-000000000000";

export type PanelAction = "create" | "refresh" | "start" | "submit" | "cancel" | "whoami";

export type PanelRequest = { method: "GET" | "POST"; url: string; body: string | null; init: RequestInit };

/** Only `submit` uses options. `score` is sent as given (rejection tests send invalid values on purpose). */
export type PanelRequestOptions = { score?: number };

type Common = { action: PanelAction; method: string; url: string; requestBody: string | null; durationMs: number; finishedAt: string };

export type PanelResult =
  | (Common & { kind: "response"; httpStatus: number; httpOk: boolean; isJson: boolean; body: unknown; bodyText: string })
  | (Common & { kind: "network-error"; message: string });

export type PanelSummary = { tone: "success" | "warning" | "error"; title: string; details: string[] };

/** The subset of the API's SessionView the panel uses (taken from real responses only). */
export type SessionSnapshot = {
  sessionId: string;
  status: string;
  validationStatus: string | null;
  settlementStatus: string | null;
  mode: string | null;
  format: string | null;
  startedAt: string | null;
  deadlineAt: string | null;
  completedAt: string | null;
  /** SCORE_ATTACK score from `result`, null when no result is stored. */
  resultScore: number | null;
  hasResult: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function buildPanelRequest(action: PanelAction, sessionId: string | null = null, opts: PanelRequestOptions = {}): PanelRequest {
  const headers: Record<string, string> = { accept: "application/json" };
  const base: RequestInit = { credentials: "same-origin", cache: "no-store", redirect: "follow" };
  const post = (url: string, body: string): PanelRequest => ({
    method: "POST", url, body,
    init: { ...base, method: "POST", headers: { ...headers, "content-type": "application/json" }, body },
  });

  if (action === "whoami") return { method: "GET", url: "/api/me", body: null, init: { ...base, method: "GET", headers } };
  if (action === "create") return post("/api/competitions/sessions", JSON.stringify({ configId: TEST_PANEL_CONFIG_ID }));

  if (!isSessionId(sessionId)) throw new Error("A session must be created or loaded first.");
  const path = `/api/competitions/sessions/${encodeURIComponent(sessionId)}`;
  switch (action) {
    case "refresh":
      return { method: "GET", url: path, body: null, init: { ...base, method: "GET", headers } };
    case "submit":
      if (typeof opts.score !== "number") throw new Error("Enter a score first.");
      return post(`${path}/result`, JSON.stringify({ format: "SCORE_ATTACK", score: opts.score }));
    case "start":
    case "cancel":
      // The existing routes require a JSON content type and exactly {}.
      return post(`${path}/${action}`, "{}");
  }
}

export async function runPanelRequest(
  action: PanelAction,
  sessionId: string | null,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => performance.now(),
  opts: PanelRequestOptions = {},
): Promise<PanelResult> {
  const req = buildPanelRequest(action, sessionId, opts);
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

/** True only for a 2xx response with the standard success envelope. */
export function isConfirmedSuccess(result: PanelResult): boolean {
  if (result.kind !== "response" || !result.httpOk || !result.isJson) return false;
  return asEnvelope(result.body)?.ok === true;
}

/** Session id from a successful create/refresh/start/submit/cancel response, or null. */
export function extractSessionId(result: PanelResult): string | null {
  if (!isConfirmedSuccess(result)) return null;
  const id = sessionOf(result)?.sessionId;
  return isSessionId(id) ? id : null;
}

/** Session status from a successful response that contains a session, or null. */
export function extractSessionStatus(result: PanelResult): string | null {
  return extractSession(result)?.status ?? null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The session as reported by a successful response, or null (never fabricated). */
export function extractSession(result: PanelResult): SessionSnapshot | null {
  if (!isConfirmedSuccess(result)) return null;
  const s = sessionOf(result);
  if (!s || !isSessionId(s.sessionId) || typeof s.status !== "string") return null;
  const r = s.result && typeof s.result === "object" ? (s.result as Record<string, unknown>) : null;
  return {
    sessionId: s.sessionId,
    status: s.status,
    validationStatus: str(s.validationStatus),
    settlementStatus: str(s.settlementStatus),
    mode: str(s.mode),
    format: str(s.format),
    startedAt: str(s.startedAt),
    deadlineAt: str(s.deadlineAt),
    completedAt: str(s.completedAt),
    resultScore: r && typeof r.score === "number" ? r.score : null,
    hasResult: r !== null,
  };
}

/** Start is only offered for a known session whose last reported status is READY (as the DB requires). */
export function canStart(sessionId: string | null, status: string | null): boolean {
  return isSessionId(sessionId) && status === "READY";
}

const SUCCESS_TITLE: Record<PanelAction, string> = {
  create: "Practice session created",
  refresh: "Session loaded",
  start: "Session started",
  submit: "Result accepted by the API",
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
    return ["You already have 3 open sessions. Cancel one (see Your sessions) or let in-progress ones pass their deadline."];
  }
  if (status === 409 && /time limit/i.test(message)) {
    return ["The deadline (time limit + 30s grace) had passed. The backend marked the session ABANDONED and did NOT store the result."];
  }
  if (status === 409 && action === "start") {
    return ["Start only works while the session is READY (it may already be started, cancelled or finished). Tap Refresh session to see its current status."];
  }
  if (status === 409 && action === "submit") {
    return ["A result can be submitted once, only while the session is IN_PROGRESS (not before Start, not after a result or cancellation)."];
  }
  if (status === 409 && action === "cancel") {
    return ["Only WAITING, READY or IN_PROGRESS sessions can be cancelled. Finished sessions (COMPLETED, CANCELLED, ABANDONED) cannot change."];
  }
  if (status === 409) return ["The session is not in a state that allows this action."];
  if (status === 403 && /paid/i.test(message)) return ["This configuration is PAID. Paid play is disabled; use the free practice config."];
  if (status === 403 && /profile/i.test(message)) return ["Your account has no profile row in this Supabase project."];
  if (status === 404) {
    return action === "create"
      ? ["The configuration was not found in this Supabase project (check the project the preview points to)."]
      : ["Session not found. The API gives this same answer for unknown sessions and for other players' sessions."];
  }
  if (status === 400 && action === "submit") return ["The score must be a whole number from 0 to 1,000,000,000,000. Nothing was stored."];
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
    if (s && typeof s.startedAt === "string") details.push(`Started: ${s.startedAt}`);
    if (s && typeof s.deadlineAt === "string") details.push(`Deadline: ${s.deadlineAt}`);
    if (s && typeof s.completedAt === "string") details.push(`Completed: ${s.completedAt}`);
    const snap = extractSession(result);
    if (snap?.hasResult) details.push(`Stored result: ${snap.resultScore ?? "(no score)"}`);
    if (result.action === "create" && result.httpStatus !== 201) details.push(`Note: expected HTTP 201, got ${result.httpStatus}.`);
    if (result.action === "submit") {
      details.push(
        snap?.status === "COMPLETED"
          ? "Session completion: the backend reports COMPLETED in this response."
          : `Session completion: NOT reported (status is ${snap?.status ?? "unknown"}).`,
      );
      if (snap?.validationStatus === "UNVERIFIED") {
        details.push("Validation UNVERIFIED: the score is stored but NOT verified. Practice results are never verified.");
      }
    }
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
