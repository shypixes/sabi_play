import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClient, createFakeState, type FakeState } from "./fake-supabase";

// MOCKED INTEGRATION: real route handlers + real server code + real requireUser(), with the
// Supabase client replaced by a fake. Proves auth gating, input validation, RPC argument
// shaping (never a user id) and error mapping. Does NOT prove RLS or database security.

const state: { fake: FakeState } = { fake: createFakeState() };

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => createFakeClient(state.fake) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const availability = vi.hoisted(() => ({ available: true }));
vi.mock("@/games/registry", () => ({ isGameFormatAvailable: () => availability.available }));

const configsRoute = await import("@/app/api/competitions/configs/route");
const sessionsRoute = await import("@/app/api/competitions/sessions/route");
const sessionRoute = await import("@/app/api/competitions/sessions/[sessionId]/route");
const joinRoute = await import("@/app/api/competitions/sessions/[sessionId]/join/route");
const startRoute = await import("@/app/api/competitions/sessions/[sessionId]/start/route");
const resultRoute = await import("@/app/api/competitions/sessions/[sessionId]/result/route");
const cancelRoute = await import("@/app/api/competitions/sessions/[sessionId]/cancel/route");

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "11111111-1111-4111-8111-111111111111";
const CONFIG = "22222222-2222-4222-8222-222222222222";

const json = (body: unknown, url = "http://test/api") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (sessionId = SESSION) => ({ params: Promise.resolve({ sessionId }) });

function sessionRow(o: Record<string, unknown> = {}) {
  return {
    id: SESSION, config_id: CONFIG, game_id: "demo", format: "SCORE_ATTACK", mode: "PRACTICE", status: "READY",
    validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED", created_at: "2026-10-10T10:00:00Z",
    started_at: null, deadline_at: null, completed_at: null, ...o,
  };
}
function configRow(o: Record<string, unknown> = {}) {
  return {
    id: CONFIG, game_id: "demo", format: "SCORE_ATTACK", mode: "PRACTICE", label: "Practice", entry_fee: 0,
    reward_model: null, fixed_reward: null, target_score: null, platform_fee_bps: null, pool_size: null,
    payout_bps: null, time_limit_seconds: 180, enabled: true, ...o,
  };
}
function signedInWithSession(row = sessionRow(), participants = [{ user_id: ME, slot: 1 }], result: unknown = null) {
  state.fake.user = { id: ME };
  state.fake.tables.competition_sessions = { data: row, error: null };
  state.fake.tables.competition_participants = { data: participants, error: null };
  state.fake.tables.competition_results = { data: result, error: null };
}
async function body(res: Response) {
  return (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
}

beforeEach(() => {
  state.fake = createFakeState();
  availability.available = true;
});

describe("authentication", () => {
  it("every competition route returns 401 without a session and makes no RPC call", async () => {
    const responses = await Promise.all([
      configsRoute.GET(new Request("http://test/api/competitions/configs")),
      sessionsRoute.POST(json({ configId: CONFIG })),
      sessionRoute.GET(new Request("http://test"), params()),
      joinRoute.POST(json({}), params()),
      startRoute.POST(json({}), params()),
      resultRoute.POST(json({ format: "SCORE_ATTACK", score: 10 }), params()),
      cancelRoute.POST(json({}), params()),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect((await body(res)).error?.code).toBe("UNAUTHENTICATED");
    }
    expect(state.fake.rpcCalls).toEqual([]);
  });
});

describe("identity is never client-supplied", () => {
  it("rejects a userId in the create body", async () => {
    state.fake.user = { id: ME };
    const res = await sessionsRoute.POST(json({ configId: CONFIG, userId: OTHER }));
    expect(res.status).toBe(400);
    expect(state.fake.rpcCalls).toEqual([]);
  });

  it("rejects extra fields on join/start/cancel bodies", async () => {
    signedInWithSession();
    for (const route of [joinRoute, startRoute, cancelRoute]) {
      const res = await route.POST(json({ userId: OTHER }), params());
      expect(res.status).toBe(400);
    }
    expect(state.fake.rpcCalls).toEqual([]);
  });

  it("never passes a user id to any database function", async () => {
    signedInWithSession(sessionRow({ status: "IN_PROGRESS", started_at: "x", deadline_at: "y" }));
    state.fake.tables.competition_configs = { data: { game_id: "demo", format: "SCORE_ATTACK" }, error: null };
    state.fake.rpc = {
      competition_create_session: { data: SESSION, error: null },
      competition_start_session: { data: "2026-10-10T10:03:30Z", error: null },
      competition_submit_result: { data: "UNVERIFIED", error: null },
      competition_cancel_session: { data: "ABANDONED", error: null },
      competition_join_session: { data: null, error: null },
    };
    await sessionsRoute.POST(json({ configId: CONFIG }));
    await joinRoute.POST(json({}), params());
    await startRoute.POST(json({}), params());
    await resultRoute.POST(json({ format: "SCORE_ATTACK", score: 1 }), params());
    await cancelRoute.POST(json({}), params());
    expect(state.fake.rpcCalls.map((c) => c.fn)).toEqual([
      "competition_create_session", "competition_join_session", "competition_start_session",
      "competition_submit_result", "competition_cancel_session",
    ]);
    for (const { args } of state.fake.rpcCalls) {
      expect(Object.keys(args).some((k) => /user|uid|owner|creator/i.test(k))).toBe(false);
      expect(JSON.stringify(args)).not.toContain(ME);
    }
  });
});

describe("input validation", () => {
  it("requires a JSON content type and valid JSON", async () => {
    state.fake.user = { id: ME };
    const form = new Request("http://test", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "configId=x" });
    expect((await sessionsRoute.POST(form)).status).toBe(400);
    const broken = new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect((await sessionsRoute.POST(broken)).status).toBe(400);
  });

  it("rejects invalid scores and outcomes before calling the database", async () => {
    signedInWithSession(sessionRow({ status: "IN_PROGRESS", started_at: "x", deadline_at: "y" }));
    for (const bad of [
      { format: "SCORE_ATTACK", score: -1 },
      { format: "SCORE_ATTACK", score: 1.5 },
      { format: "SCORE_ATTACK", score: "999" },
      { format: "SCORE_ATTACK", score: 1e13 },
      { format: "SCORE_ATTACK", score: 5, verified: true },
      { format: "ONE_V_ONE", winnerSlot: 3 },
    ]) {
      expect((await resultRoute.POST(json(bad), params())).status).toBe(400);
    }
    // valid shape, wrong format for this SCORE_ATTACK session
    expect((await resultRoute.POST(json({ format: "ONE_V_ONE", winnerSlot: 1 }), params())).status).toBe(400);
    expect(state.fake.rpcCalls).toEqual([]);
  });

  it("treats malformed session ids exactly like unknown sessions (404, no queries)", async () => {
    state.fake.user = { id: ME };
    const res = await sessionRoute.GET(new Request("http://test"), params("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(state.fake.queries).toEqual([]);
  });

  it("rejects unknown config filters", async () => {
    state.fake.user = { id: ME };
    expect((await configsRoute.GET(new Request("http://test/api?format=BATTLE_ROYALE"))).status).toBe(400);
  });
});

describe("session operations", () => {
  it("creates a session and returns a view without any user identifiers", async () => {
    signedInWithSession();
    state.fake.tables.competition_configs = { data: { game_id: "demo", format: "SCORE_ATTACK" }, error: null };
    state.fake.rpc.competition_create_session = { data: SESSION, error: null };
    const res = await sessionsRoute.POST(json({ configId: CONFIG }));
    expect(res.status).toBe(201);
    const b = await body(res);
    expect(state.fake.rpcCalls).toEqual([{ fn: "competition_create_session", args: { p_config_id: CONFIG } }]);
    expect(b.data?.session).toMatchObject({ sessionId: SESSION, status: "READY", yourSlot: 1, participantCount: 1, requiredParticipants: 1 });
    expect(JSON.stringify(b)).not.toContain(ME);
  });

  it("refuses to create sessions for games that are not available", async () => {
    state.fake.user = { id: ME };
    availability.available = false;
    state.fake.tables.competition_configs = { data: { game_id: "demo", format: "SCORE_ATTACK" }, error: null };
    expect((await sessionsRoute.POST(json({ configId: CONFIG }))).status).toBe(409);
    expect(state.fake.rpcCalls).toEqual([]);
  });

  it("returns 404 for configs and sessions the caller cannot see", async () => {
    state.fake.user = { id: ME };
    expect((await sessionsRoute.POST(json({ configId: CONFIG }))).status).toBe(404);
    // RLS returns no row for someone else's session
    expect((await sessionRoute.GET(new Request("http://test"), params())).status).toBe(404);
    // defence in depth: a row without the caller among participants is still 404
    signedInWithSession(sessionRow(), [{ user_id: OTHER, slot: 1 }]);
    expect((await sessionRoute.GET(new Request("http://test"), params())).status).toBe(404);
  });

  it("maps database rule violations to safe HTTP errors", async () => {
    const cases: [string, number, string][] = [
      ["paid_competitions_disabled", 403, "FORBIDDEN"],
      ["config_disabled", 409, "CONFLICT"],
      ["too_many_open_sessions", 409, "CONFLICT"],
      ["session_not_found", 404, "NOT_FOUND"],
      ["profile_not_found", 403, "FORBIDDEN"],
    ];
    for (const [message, status, code] of cases) {
      state.fake = createFakeState();
      state.fake.user = { id: ME };
      state.fake.tables.competition_configs = { data: { game_id: "demo", format: "SCORE_ATTACK" }, error: null };
      state.fake.rpc.competition_create_session = { data: null, error: { code: "P0001", message } };
      const res = await sessionsRoute.POST(json({ configId: CONFIG }));
      expect([res.status, (await body(res)).error?.code]).toEqual([status, code]);
    }
  });

  it("maps invalid transitions and duplicate submissions to 409", async () => {
    signedInWithSession(sessionRow({ status: "COMPLETED" }));
    state.fake.rpc.competition_start_session = { data: null, error: { code: "P0001", message: "invalid_state" } };
    expect((await startRoute.POST(json({}), params())).status).toBe(409);
    state.fake.rpc.competition_submit_result = { data: null, error: { code: "P0001", message: "invalid_state" } };
    expect((await resultRoute.POST(json({ format: "SCORE_ATTACK", score: 5 }), params())).status).toBe(409);
  });

  it("does not leak internal database errors", async () => {
    signedInWithSession();
    state.fake.rpc.competition_start_session = { data: null, error: { code: "42501", message: "permission denied for table secret_internal" } };
    const res = await startRoute.POST(json({}), params());
    const b = await body(res);
    expect(res.status).toBe(500);
    expect(JSON.stringify(b)).not.toContain("secret_internal");
  });

  it("submits SCORE_ATTACK scores and ONE_V_ONE outcomes with the right arguments", async () => {
    signedInWithSession(sessionRow({ status: "IN_PROGRESS", started_at: "x", deadline_at: "y" }));
    state.fake.rpc.competition_submit_result = { data: "UNVERIFIED", error: null };
    expect((await resultRoute.POST(json({ format: "SCORE_ATTACK", score: 4200 }), params())).status).toBe(200);
    expect(state.fake.rpcCalls.at(-1)?.args).toEqual({ p_session_id: SESSION, p_score: 4200 });

    signedInWithSession(sessionRow({ format: "ONE_V_ONE", status: "IN_PROGRESS", started_at: "x", deadline_at: "y" }),
      [{ user_id: ME, slot: 1 }, { user_id: OTHER, slot: 2 }]);
    state.fake.rpc.competition_submit_result = { data: "UNVERIFIED", error: null };
    await resultRoute.POST(json({ format: "ONE_V_ONE", winnerSlot: null }), params());
    expect(state.fake.rpcCalls.at(-1)?.args).toEqual({ p_session_id: SESSION, p_winner_slot: null, p_is_draw: true });
    await resultRoute.POST(json({ format: "ONE_V_ONE", winnerSlot: 2 }), params());
    expect(state.fake.rpcCalls.at(-1)?.args).toEqual({ p_session_id: SESSION, p_winner_slot: 2, p_is_draw: false });
  });

  it("reports an expired session as 409 instead of accepting the result", async () => {
    signedInWithSession(sessionRow({ status: "IN_PROGRESS", started_at: "x", deadline_at: "y" }));
    state.fake.rpc.competition_submit_result = { data: "EXPIRED", error: null };
    const res = await resultRoute.POST(json({ format: "SCORE_ATTACK", score: 4200 }), params());
    expect(res.status).toBe(409);
  });

  it("presents 1v1 winners by slot, not by user id", async () => {
    signedInWithSession(
      sessionRow({ format: "ONE_V_ONE", status: "COMPLETED", validation_status: "UNVERIFIED", started_at: "x", deadline_at: "y", completed_at: "z" }),
      [{ user_id: ME, slot: 1 }, { user_id: OTHER, slot: 2 }],
      { score: null, winner_user_id: OTHER, is_draw: false },
    );
    const b = await body(await sessionRoute.GET(new Request("http://test"), params()));
    expect(b.data?.session).toMatchObject({ yourSlot: 1, participantCount: 2, validationStatus: "UNVERIFIED", result: { format: "ONE_V_ONE", winnerSlot: 2 } });
    expect(JSON.stringify(b)).not.toContain(OTHER);
  });
});

describe("configuration listing", () => {
  it("lists only valid configs for available games", async () => {
    state.fake.user = { id: ME };
    state.fake.tables.competition_configs = {
      data: [configRow(), configRow({ id: "33333333-3333-4333-8333-333333333333", entry_fee: 5 /* practice with fee: malformed */ })],
      error: null,
    };
    const b = await body(await configsRoute.GET(new Request("http://test/api?format=SCORE_ATTACK")));
    expect(b.data?.options).toEqual([
      { configId: CONFIG, gameId: "demo", format: "SCORE_ATTACK", mode: "PRACTICE", label: "Practice", entryFee: 0, reward: null, timeLimitSeconds: 180 },
    ]);
    availability.available = false;
    expect((await body(await configsRoute.GET(new Request("http://test/api")))).data?.options).toEqual([]);
  });
});
