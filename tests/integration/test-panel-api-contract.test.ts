import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNKNOWN_SESSION_ID,
  buildPanelRequest,
  extractSession,
  extractSessionStatus,
  runPanelRequest,
  summarize,
  type PanelAction,
} from "@/app/(app)/test-panel/panel-requests";
import { OUT_OF_RANGE_SCORE, completionCheck } from "@/app/(app)/test-panel/panel-lifecycle";
import { createFakeClient, createFakeState, type FakeState } from "./fake-supabase";

// MOCKED INTEGRATION (contract): the TEMPORARY test panel's requests are sent, exactly as built,
// to the REAL route handlers (real requireUser, validation, ownership checks and error mapping)
// with a fake Supabase client and mocked authentication. Proves the panel's endpoints and
// payloads match the existing API and how the API answers. Does NOT prove RLS or database
// behaviour (see tests/db, real PostgreSQL). Remove with src/app/(app)/test-panel.

const state: { fake: FakeState } = { fake: createFakeState() };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => createFakeClient(state.fake) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const createRoute = await import("@/app/api/competitions/sessions/route");
const sessionRoute = await import("@/app/api/competitions/sessions/[sessionId]/route");
const startRoute = await import("@/app/api/competitions/sessions/[sessionId]/start/route");
const resultRoute = await import("@/app/api/competitions/sessions/[sessionId]/result/route");
const cancelRoute = await import("@/app/api/competitions/sessions/[sessionId]/cancel/route");
const meRoute = await import("@/app/api/me/route");

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "11111111-1111-4111-8111-111111111111";
const CONFIG = "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac";

/** A fetch that dispatches the panel's relative URL to the real Next route handler for that path. */
const routedFetch = vi.fn<typeof fetch>(async (input, init) => {
  const url = String(input);
  const req = new Request(`http://preview.test${url}`, init);
  const params = (id: string | undefined) => ({ params: Promise.resolve({ sessionId: id ?? "" }) });
  if (url === "/api/me" && req.method === "GET") return meRoute.GET();
  if (url === "/api/competitions/sessions" && req.method === "POST") return createRoute.POST(req);
  const action = url.match(/^\/api\/competitions\/sessions\/([^/]+)\/(start|result|cancel)$/);
  if (action && req.method === "POST") {
    const route = { start: startRoute, result: resultRoute, cancel: cancelRoute }[action[2] as "start" | "result" | "cancel"];
    return route.POST(req, params(action[1]));
  }
  const one = url.match(/^\/api\/competitions\/sessions\/([^/]+)$/);
  if (one && req.method === "GET") return sessionRoute.GET(req, params(one[1]));
  return new Response("no such route in this test", { status: 599 });
});

function sessionRow(status: string, o: Record<string, unknown> = {}) {
  const started = !["READY", "WAITING", "CANCELLED"].includes(status);
  const finished = ["COMPLETED", "CANCELLED", "ABANDONED"].includes(status);
  return {
    id: SESSION, config_id: CONFIG, game_id: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", status,
    validation_status: status === "COMPLETED" ? "UNVERIFIED" : "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED",
    created_at: "2026-10-11T12:00:00Z",
    started_at: started ? "2026-10-11T12:00:05Z" : null, deadline_at: started ? "2026-10-11T12:03:35Z" : null,
    completed_at: finished ? "2026-10-11T12:01:00Z" : null, ...o,
  };
}
/** Signed in as ME; the session view the routes read back (owner = participants). */
function signedIn(status: string, opts: { owner?: string; score?: number } = {}) {
  state.fake.user = { id: ME } as FakeState["user"];
  state.fake.tables.competition_sessions = { data: sessionRow(status), error: null };
  state.fake.tables.competition_participants = { data: [{ user_id: opts.owner ?? ME, slot: 1 }], error: null };
  state.fake.tables.competition_results = {
    data: opts.score === undefined ? null : { score: opts.score, winner_user_id: null, is_draw: false },
    error: null,
  };
}
const dbError = (message: string) => ({ data: null, error: { code: "P0001", message } });

beforeEach(() => {
  state.fake = createFakeState();
  routedFetch.mockClear();
});

describe("Start (POST .../start {})", () => {
  it("panel URL matches the route file src/app/api/competitions/sessions/[sessionId]/start/route.ts", () => {
    expect(buildPanelRequest("start", SESSION).url).toBe(`/api/competitions/sessions/${SESSION}/start`);
  });

  it("successful start: only competition_start_session(p_session_id), 200, then the refresh reads without RPC", async () => {
    signedIn("IN_PROGRESS");
    state.fake.rpc.competition_start_session = { data: "2026-10-11T12:03:35Z", error: null };
    const r = await runPanelRequest("start", SESSION, routedFetch);
    expect(r).toMatchObject({ kind: "response", httpStatus: 200, httpOk: true });
    expect(state.fake.rpcCalls).toEqual([{ fn: "competition_start_session", args: { p_session_id: SESSION } }]);
    expect(summarize(r)).toMatchObject({ tone: "success", title: "Session started (HTTP 200)" });
    expect(extractSessionStatus(r)).toBe("IN_PROGRESS");
    const refreshed = await runPanelRequest("refresh", SESSION, routedFetch);
    expect(extractSessionStatus(refreshed)).toBe("IN_PROGRESS");
    expect(state.fake.rpcCalls).toHaveLength(1);
  });

  it("invalid session state: invalid_state comes back as 409 with the start hint", async () => {
    signedIn("IN_PROGRESS");
    state.fake.rpc.competition_start_session = dbError("invalid_state");
    const r = await runPanelRequest("start", SESSION, routedFetch);
    expect(r).toMatchObject({ httpStatus: 409, httpOk: false });
    expect(summarize(r).details.join(" ")).toMatch(/Start only works while the session is READY/);
    expect(extractSessionStatus(r)).toBeNull();
  });

  it("the route rejects anything other than the panel's exact body (so the panel must send {})", async () => {
    signedIn("READY");
    const req = buildPanelRequest("start", SESSION);
    expect((await routedFetch(req.url, { ...req.init, body: JSON.stringify({ userId: ME }) })).status).toBe(400);
    expect((await routedFetch(req.url, { ...req.init, headers: { accept: "application/json" } })).status).toBe(400);
    expect(state.fake.rpcCalls).toEqual([]);
  });
});

describe("Submit result (POST .../result {format, score})", () => {
  it("accepted practice result: exact RPC arguments, 200 COMPLETED/UNVERIFIED/NOT_REQUIRED, completion check passes", async () => {
    signedIn("COMPLETED", { score: 4200 }); // the view the route reads back after the RPC
    state.fake.rpc.competition_submit_result = { data: "UNVERIFIED", error: null };
    const r = await runPanelRequest("submit", SESSION, routedFetch, undefined, { score: 4200 });
    expect(r).toMatchObject({ httpStatus: 200, httpOk: true });
    expect(state.fake.rpcCalls).toEqual([{ fn: "competition_submit_result", args: { p_session_id: SESSION, p_score: 4200 } }]);
    const s = summarize(r);
    expect(s.title).toBe("Result accepted by the API (HTTP 200)");
    expect(s.details).toContain("Session completion: the backend reports COMPLETED in this response.");
    const refreshed = await runPanelRequest("refresh", SESSION, routedFetch);
    expect(completionCheck(4200, extractSession(refreshed)).outcome).toBe("pass");
    // The response never carries user ids.
    expect(r.kind === "response" && r.bodyText).not.toContain(ME);
  });

  it("late result: the DB returns EXPIRED (and marks ABANDONED); the API answers 409 'time limit'", async () => {
    signedIn("IN_PROGRESS");
    state.fake.rpc.competition_submit_result = { data: "EXPIRED", error: null };
    const r = await runPanelRequest("submit", SESSION, routedFetch, undefined, { score: 1 });
    expect(r).toMatchObject({ httpStatus: 409 });
    expect(summarize(r).details[0]).toBe("The time limit for this session has passed.");
    expect(summarize(r).details.join(" ")).toMatch(/ABANDONED and did NOT store the result/);
  });

  it.each([["duplicate (session already COMPLETED)", "COMPLETED"], ["before start (READY)", "READY"], ["after cancel", "CANCELLED"]])(
    "%s: invalid_state -> 409 with the submit hint", async (_name, status) => {
      signedIn(status);
      state.fake.rpc.competition_submit_result = dbError("invalid_state");
      const r = await runPanelRequest("submit", SESSION, routedFetch, undefined, { score: 1 });
      expect(r).toMatchObject({ httpStatus: 409 });
      expect(summarize(r).details.join(" ")).toMatch(/submitted once, only while the session is IN_PROGRESS/);
    },
  );

  it("out-of-range score: 400 before any database access", async () => {
    signedIn("IN_PROGRESS");
    const r = await runPanelRequest("submit", SESSION, routedFetch, undefined, { score: OUT_OF_RANGE_SCORE });
    expect(r).toMatchObject({ httpStatus: 400 });
    expect(state.fake.rpcCalls).toEqual([]);
    expect(state.fake.queries).toEqual([]);
  });

  it("the route rejects extra fields (e.g. a userId) in the result body", async () => {
    signedIn("IN_PROGRESS");
    const req = buildPanelRequest("submit", SESSION, { score: 1 });
    const res = await routedFetch(req.url, { ...req.init, body: JSON.stringify({ format: "SCORE_ATTACK", score: 1, userId: ME }) });
    expect(res.status).toBe(400);
    expect(state.fake.rpcCalls).toEqual([]);
  });
});

describe("Cancel (POST .../cancel {})", () => {
  it.each([["READY", "CANCELLED"], ["IN_PROGRESS", "ABANDONED"]])("%s -> %s: 200 with the new status", async (_from, to) => {
    signedIn(to);
    state.fake.rpc.competition_cancel_session = { data: to, error: null };
    const r = await runPanelRequest("cancel", SESSION, routedFetch);
    expect(r).toMatchObject({ httpStatus: 200 });
    expect(state.fake.rpcCalls).toEqual([{ fn: "competition_cancel_session", args: { p_session_id: SESSION } }]);
    expect(extractSessionStatus(r)).toBe(to);
  });

  it("repeat cancellation / finished session: invalid_state -> 409 with the cancel hint", async () => {
    signedIn("CANCELLED");
    state.fake.rpc.competition_cancel_session = dbError("invalid_state");
    const r = await runPanelRequest("cancel", SESSION, routedFetch);
    expect(r).toMatchObject({ httpStatus: 409 });
    expect(summarize(r).details.join(" ")).toMatch(/Only WAITING, READY or IN_PROGRESS sessions can be cancelled/);
  });
});

describe("ownership and access control (mocked auth)", () => {
  it("a user can read their own session", async () => {
    signedIn("READY");
    const r = await runPanelRequest("refresh", SESSION, routedFetch);
    expect(r).toMatchObject({ httpStatus: 200 });
    expect(extractSession(r)?.sessionId).toBe(SESSION);
  });

  it("another user's session is 404 whether RLS hides it or a row slips through (defence in depth); nothing about it is returned", async () => {
    signedIn("READY", { owner: OTHER });
    state.fake.tables.competition_sessions = { data: null, error: null }; // RLS: not a participant
    const hidden = await runPanelRequest("refresh", SESSION, routedFetch);
    expect(hidden).toMatchObject({ httpStatus: 404 });

    signedIn("READY", { owner: OTHER }); // row returned, but the caller is not a participant
    const slipped = await runPanelRequest("refresh", SESSION, routedFetch);
    expect(slipped).toMatchObject({ httpStatus: 404 });
    expect(slipped.kind === "response" && slipped.bodyText).not.toMatch(new RegExp(`${OTHER}|READY|test-game`));
  });

  it("start / cancel / submit on another user's session: 404 and no state change requested", async () => {
    signedIn("IN_PROGRESS", { owner: OTHER });
    state.fake.rpc.competition_start_session = dbError("session_not_found");
    state.fake.rpc.competition_cancel_session = dbError("session_not_found");
    for (const action of ["start", "cancel"] as const) {
      const r = await runPanelRequest(action, SESSION, routedFetch);
      expect(r, action).toMatchObject({ httpStatus: 404 });
    }
    // The database refuses foreign sessions (tests/db); the API maps that to 404.
    expect(state.fake.rpcCalls.map((c) => c.fn)).toEqual(["competition_start_session", "competition_cancel_session"]);

    state.fake.rpcCalls = [];
    const submitted = await runPanelRequest("submit", SESSION, routedFetch, undefined, { score: 1 });
    expect(submitted).toMatchObject({ httpStatus: 404 });
    expect(state.fake.rpcCalls).toEqual([]); // refused while loading the view, before the RPC
  });

  it("the panel's unknown-session probes get 404", async () => {
    signedIn("READY");
    state.fake.tables.competition_sessions = { data: null, error: null };
    state.fake.rpc.competition_cancel_session = dbError("session_not_found");
    expect(await runPanelRequest("refresh", UNKNOWN_SESSION_ID, routedFetch)).toMatchObject({ httpStatus: 404 });
    expect(await runPanelRequest("cancel", UNKNOWN_SESSION_ID, routedFetch)).toMatchObject({ httpStatus: 404 });
  });

  it("unauthenticated: every panel action gets 401 with no database access", async () => {
    state.fake.user = null;
    const actions: [PanelAction, string | null][] = [
      ["whoami", null], ["create", null], ["refresh", SESSION], ["start", SESSION], ["submit", SESSION], ["cancel", SESSION],
    ];
    for (const [action, id] of actions) {
      const r = await runPanelRequest(action, id, routedFetch, undefined, { score: 1 });
      expect(r, action).toMatchObject({ httpStatus: 401 });
    }
    expect(state.fake.rpcCalls).toEqual([]);
    expect(state.fake.queries).toEqual([]);
  });
});
