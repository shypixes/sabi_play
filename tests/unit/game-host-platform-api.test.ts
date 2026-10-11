import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPlatformApi, PlatformApiError } from "@/lib/game-host/platform-api";

// UNIT (MOCKED fetch): response validation and failure classification of the host's API client.

const view = () => ({
  sessionId: randomUUID(), configId: randomUUID(), gameId: "pop-rush", format: "SCORE_ATTACK", mode: "PRACTICE", status: "READY",
  validationStatus: "UNVERIFIED", settlementStatus: "NOT_REQUIRED", yourSlot: 1, participantCount: 1, requiredParticipants: 1,
  createdAt: "2026-10-11T12:00:00.000Z", startedAt: null, deadlineAt: null, completedAt: null, result: null,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function apiWith(handler: (url: string, init: RequestInit) => Promise<Response>, timeoutMs = 50) {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createPlatformApi({ timeoutMs, fetch: async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  } });
  return { api, calls };
}

async function failure(p: Promise<unknown>): Promise<PlatformApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PlatformApiError) return err;
    throw err;
  }
  throw new Error("expected a failure");
}

describe("createPlatformApi", () => {
  it("calls the existing routes with JSON bodies and same-origin credentials", async () => {
    const v = view();
    const { api, calls } = apiWith(async () => json(200, { ok: true, data: { session: v } }));
    await api.createSession(v.configId);
    await api.startSession(v.sessionId);
    await api.submitResult(v.sessionId, { format: "SCORE_ATTACK", score: 5 });
    await api.cancelSession(v.sessionId);
    await api.getSession(v.sessionId);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /api/competitions/sessions",
      `POST /api/competitions/sessions/${v.sessionId}/start`,
      `POST /api/competitions/sessions/${v.sessionId}/result`,
      `POST /api/competitions/sessions/${v.sessionId}/cancel`,
      `GET /api/competitions/sessions/${v.sessionId}`,
    ]);
    expect(calls[2]!.init.body).toBe(JSON.stringify({ format: "SCORE_ATTACK", score: 5 }));
    expect(calls.every((c) => c.init.credentials === "same-origin")).toBe(true);
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/json");
  });

  it("classifies definite HTTP errors (not ambiguous) with code and message", async () => {
    const { api } = apiWith(async () => json(409, { ok: false, error: { code: "CONFLICT", message: "The time limit for this session has passed." } }));
    const err = await failure(api.getSession(randomUUID()));
    expect(err).toMatchObject({ kind: "http", status: 409, code: "CONFLICT", message: "The time limit for this session has passed." });
    expect(err.ambiguous).toBe(false);
  });

  it("treats 5xx, network errors, timeouts and malformed answers as ambiguous", async () => {
    const e500 = await failure(apiWith(async () => json(500, { ok: false, error: { code: "INTERNAL", message: "x" } })).api.getSession(randomUUID()));
    expect(e500.ambiguous).toBe(true);
    const net = await failure(apiWith(async () => { throw new TypeError("fetch failed"); }).api.getSession(randomUUID()));
    expect(net).toMatchObject({ kind: "network", ambiguous: true });
    const slow = await failure(apiWith((_u, init) => new Promise((_r, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }), 20).api.getSession(randomUUID()));
    expect(slow).toMatchObject({ kind: "timeout", ambiguous: true });
    const bad = await failure(apiWith(async () => json(200, { ok: true, data: { session: { ...view(), status: "HACKED" } } })).api.getSession(randomUUID()));
    expect(bad).toMatchObject({ kind: "invalid_response", ambiguous: true });
    const html = await failure(apiWith(async () => new Response("<html>", { status: 200 })).api.getSession(randomUUID()));
    expect(html.kind).toBe("invalid_response");
  });

  it("encodes path segments", async () => {
    const { api, calls } = apiWith(async () => json(404, { ok: false, error: { code: "NOT_FOUND", message: "Session not found." } }));
    await failure(api.getSession("../wallet"));
    expect(calls[0]!.url).toBe("/api/competitions/sessions/..%2Fwallet");
  });
});
