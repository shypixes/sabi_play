import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPanelRequest, extractSessionStatus, runPanelRequest, summarize } from "@/app/(app)/test-panel/panel-requests";
import { createFakeClient, createFakeState, type FakeState } from "./fake-supabase";

// MOCKED INTEGRATION (contract): the TEMPORARY test panel's start/refresh requests are sent,
// exactly as built, to the REAL route handlers (real requireUser, validation and error mapping)
// with a fake Supabase client. Proves the panel's endpoint and payload match the existing API.
// Does NOT prove RLS or database behaviour (see tests/db). Remove with src/app/(app)/test-panel.

const state: { fake: FakeState } = { fake: createFakeState() };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => createFakeClient(state.fake) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const startRoute = await import("@/app/api/competitions/sessions/[sessionId]/start/route");
const sessionRoute = await import("@/app/api/competitions/sessions/[sessionId]/route");

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "11111111-1111-4111-8111-111111111111";
const CONFIG = "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac";

/** A fetch that dispatches the panel's relative URL to the real Next route handler for that path. */
const routedFetch = vi.fn<typeof fetch>(async (input, init) => {
  const url = String(input);
  const req = new Request(`http://preview.test${url}`, init);
  const start = url.match(/^\/api\/competitions\/sessions\/([^/]+)\/start$/);
  if (start && req.method === "POST") return startRoute.POST(req, { params: Promise.resolve({ sessionId: start[1] ?? "" }) });
  const one = url.match(/^\/api\/competitions\/sessions\/([^/]+)$/);
  if (one && req.method === "GET") return sessionRoute.GET(req, { params: Promise.resolve({ sessionId: one[1] ?? "" }) });
  return new Response("no such route in this test", { status: 599 });
});

function sessionRow(status: string) {
  const started = status !== "READY";
  return {
    id: SESSION, config_id: CONFIG, game_id: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", status,
    validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED", created_at: "2026-10-11T12:00:00Z",
    started_at: started ? "2026-10-11T12:00:05Z" : null, deadline_at: started ? "2026-10-11T12:03:35Z" : null, completed_at: null,
  };
}
function signedIn(status: string) {
  state.fake.user = { id: ME } as FakeState["user"];
  state.fake.tables.competition_sessions = { data: sessionRow(status), error: null };
  state.fake.tables.competition_participants = { data: [{ user_id: ME, slot: 1 }], error: null };
  state.fake.tables.competition_results = { data: null, error: null };
}

beforeEach(() => {
  state.fake = createFakeState();
  routedFetch.mockClear();
});

describe("panel Start request against the real start route", () => {
  it("panel URL matches the route file src/app/api/competitions/sessions/[sessionId]/start/route.ts", () => {
    expect(buildPanelRequest("start", SESSION).url).toBe(`/api/competitions/sessions/${SESSION}/start`);
  });

  it("successful start: route accepts the panel's body, calls only competition_start_session(p_session_id), returns 200", async () => {
    signedIn("IN_PROGRESS"); // the view the route reads back after the RPC updated the row
    state.fake.rpc.competition_start_session = { data: "2026-10-11T12:03:35Z", error: null };
    const r = await runPanelRequest("start", SESSION, routedFetch);
    expect(r).toMatchObject({ kind: "response", httpStatus: 200, httpOk: true });
    expect(state.fake.rpcCalls).toEqual([{ fn: "competition_start_session", args: { p_session_id: SESSION } }]);
    expect(summarize(r)).toMatchObject({ tone: "success", title: "Session started (HTTP 200)" });
    expect(extractSessionStatus(r)).toBe("IN_PROGRESS");

    // The automatic refresh the panel performs next: GET through the real session route, no RPC.
    const refreshed = await runPanelRequest("refresh", SESSION, routedFetch);
    expect(refreshed).toMatchObject({ httpStatus: 200 });
    expect(extractSessionStatus(refreshed)).toBe("IN_PROGRESS");
    expect(state.fake.rpcCalls).toHaveLength(1);
  });

  it("invalid session state: the DB's invalid_state comes back as 409 with the panel's start hint", async () => {
    signedIn("IN_PROGRESS");
    state.fake.rpc.competition_start_session = { data: null, error: { code: "P0001", message: "invalid_state" } };
    const r = await runPanelRequest("start", SESSION, routedFetch);
    expect(r).toMatchObject({ httpStatus: 409, httpOk: false });
    const s = summarize(r);
    expect(s.title).toBe("Request failed (HTTP 409 CONFLICT)");
    expect(s.details[0]).toBe("That action is not allowed in the session's current state.");
    expect(s.details.join(" ")).toMatch(/Start only works while the session is READY/);
    expect(extractSessionStatus(r)).toBeNull();
  });

  it("failed start: signed out -> 401 before any RPC; unknown session -> 404", async () => {
    state.fake.user = null;
    const unauth = await runPanelRequest("start", SESSION, routedFetch);
    expect(unauth).toMatchObject({ httpStatus: 401 });
    expect(state.fake.rpcCalls).toEqual([]);

    signedIn("READY");
    state.fake.rpc.competition_start_session = { data: null, error: { code: "P0001", message: "session_not_found" } };
    const missing = await runPanelRequest("start", SESSION, routedFetch);
    expect(missing).toMatchObject({ httpStatus: 404 });
    expect(summarize(missing).tone).toBe("error");
  });

  it("the route would reject anything other than the panel's exact body (so the panel must send {})", async () => {
    signedIn("READY");
    const req = buildPanelRequest("start", SESSION);
    const extra = await routedFetch(req.url, { ...req.init, body: JSON.stringify({ userId: ME }) });
    expect(extra.status).toBe(400);
    const noType = await routedFetch(req.url, { ...req.init, headers: { accept: "application/json" } });
    expect(noType.status).toBe(400);
    expect(state.fake.rpcCalls).toEqual([]);
  });
});
