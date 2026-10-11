import { z } from "zod";
import {
  COMPETITION_MAX_VALUE,
  COMPETITION_MODES,
  GAME_TYPES,
  SESSION_STATUSES,
  SETTLEMENT_STATUSES,
  VALIDATION_STATUSES,
  type CompetitionOption,
  type GamePlatformApi,
  type GameType,
  type ResultSubmission,
  type SessionView,
} from "@/game-sdk";

/**
 * Browser implementation of GamePlatformApi over the EXISTING competition routes
 * (/api/competitions/*). Runs in the platform page only (same origin, the user's own cookie
 * session); game code never sees it. No new endpoint, no credentials handled here.
 */

export type ApiFailureKind = "http" | "network" | "timeout" | "invalid_response";

/**
 * `http` failures are definite answers from the server (except 5xx). `network`, `timeout`,
 * `invalid_response` and 5xx are AMBIGUOUS for mutating calls: the request may have been applied.
 */
export class PlatformApiError extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    readonly status: number | null,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }

  get ambiguous(): boolean {
    return this.kind !== "http" || (this.status !== null && this.status >= 500);
  }
}

const iso = z.string().min(1);
export const sessionViewSchema: z.ZodType<SessionView> = z.object({
  sessionId: z.string().uuid(),
  configId: z.string().uuid(),
  gameId: z.string(),
  format: z.enum(GAME_TYPES),
  mode: z.enum(COMPETITION_MODES),
  status: z.enum(SESSION_STATUSES),
  validationStatus: z.enum(VALIDATION_STATUSES),
  settlementStatus: z.enum(SETTLEMENT_STATUSES),
  yourSlot: z.union([z.literal(1), z.literal(2)]),
  participantCount: z.number().int(),
  requiredParticipants: z.number().int(),
  createdAt: iso,
  startedAt: iso.nullable(),
  deadlineAt: iso.nullable(),
  completedAt: iso.nullable(),
  result: z.union([
    z.object({ format: z.literal("SCORE_ATTACK"), score: z.number().int().min(0).max(COMPETITION_MAX_VALUE) }),
    z.object({ format: z.literal("ONE_V_ONE"), winnerSlot: z.union([z.literal(1), z.literal(2), z.null()]) }),
  ]).nullable(),
});

const errorEnvelope = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) });

export type PlatformApiOptions = { fetch?: typeof fetch; timeoutMs?: number };

export function createPlatformApi(options: PlatformApiOptions = {}): GamePlatformApi {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(path: string, init: RequestInit, dataSchema: z.ZodType<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(path, { ...init, signal: controller.signal, credentials: "same-origin", cache: "no-store" });
    } catch {
      throw controller.signal.aborted
        ? new PlatformApiError("timeout", null, null, "The platform did not answer in time.")
        : new PlatformApiError("network", null, null, "Could not reach the platform.");
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new PlatformApiError(res.ok ? "invalid_response" : "http", res.status, null, "Unexpected response from the platform.");
    }
    if (!res.ok) {
      const env = errorEnvelope.safeParse(body);
      throw new PlatformApiError("http", res.status, env.success ? env.data.error.code : null,
        env.success ? env.data.error.message : `Request failed (HTTP ${res.status}).`);
    }
    const okEnvelope = z.object({ ok: z.literal(true), data: z.unknown() }).safeParse(body);
    const data = okEnvelope.success ? dataSchema.safeParse(okEnvelope.data.data) : null;
    if (!data?.success) throw new PlatformApiError("invalid_response", res.status, null, "Unexpected response from the platform.");
    return data.data;
  }

  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, z.object({ session: sessionViewSchema }))
      .then((d) => d.session);
  const sessionPath = (id: string) => `/api/competitions/sessions/${encodeURIComponent(id)}`;

  return {
    async listCompetitionOptions(filter?: { format?: GameType }) {
      const qs = filter?.format ? `?format=${encodeURIComponent(filter.format)}` : "";
      const data = await call(`/api/competitions/configs${qs}`, { method: "GET" }, z.object({ options: z.array(z.unknown()) }));
      return data.options as CompetitionOption[];
    },
    createSession: (configId: string) => post("/api/competitions/sessions", { configId }),
    getSession: (sessionId: string) =>
      call(sessionPath(sessionId), { method: "GET" }, z.object({ session: sessionViewSchema })).then((d) => d.session),
    startSession: (sessionId: string) => post(`${sessionPath(sessionId)}/start`, {}),
    submitResult: (sessionId: string, result: ResultSubmission) => post(`${sessionPath(sessionId)}/result`, result),
    cancelSession: (sessionId: string) => post(`${sessionPath(sessionId)}/cancel`, {}),
  };
}

/**
 * Best-effort release of a session that never started, when the page is really unloaded (tab
 * closed). Uses the normal cancel route with keepalive; the result is not observable. Never
 * used for started sessions (those stop counting toward the open-session limit at their deadline).
 */
export function releaseSessionOnUnload(sessionId: string): void {
  try {
    void fetch(`/api/competitions/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Unload: nothing more can be done.
  }
}
