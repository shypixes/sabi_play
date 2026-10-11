import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClient, createFakeState, type FakeState } from "./fake-supabase";

// MOCKED INTEGRATION with the REAL game registry (only Supabase is faked). Proves the API's
// configuration checks for the temporary test-game. The `enabled` and `PAID` checks happen in
// the database; here the fake returns the codes the real functions raise (proven in tests/db).

const state: { fake: FakeState } = { fake: createFakeState() };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => createFakeClient(state.fake) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const configsRoute = await import("@/app/api/competitions/configs/route");
const sessionsRoute = await import("@/app/api/competitions/sessions/route");

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIVE_CONFIG = "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac"; // the config row on the hosted project
const SESSION = "11111111-1111-4111-8111-111111111111";

const post = (body: unknown) =>
  new Request("http://test/api/competitions/sessions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
async function read(res: Response) {
  return (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
}
function configRow(o: Record<string, unknown>) {
  return {
    id: LIVE_CONFIG, game_id: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", label: "Test practice",
    entry_fee: 0, reward_model: null, fixed_reward: null, target_score: null, platform_fee_bps: null,
    pool_size: null, payout_bps: null, time_limit_seconds: 180, enabled: true, ...o,
  };
}
function withConfig(gameId: string, format: string) {
  state.fake.user = { id: ME };
  state.fake.tables.competition_configs = { data: { game_id: gameId, format }, error: null };
}

beforeEach(() => { state.fake = createFakeState(); });

describe("create session: registry checks for test-game", () => {
  it("test-game + SCORE_ATTACK passes the app checks and calls the DB with only the config id", async () => {
    withConfig("test-game", "SCORE_ATTACK");
    state.fake.rpc.competition_create_session = { data: SESSION, error: null };
    state.fake.tables.competition_sessions = {
      data: {
        id: SESSION, config_id: LIVE_CONFIG, game_id: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE",
        status: "READY", validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED",
        created_at: "2026-10-11T10:00:00Z", started_at: null, deadline_at: null, completed_at: null,
      },
      error: null,
    };
    state.fake.tables.competition_participants = { data: [{ user_id: ME, slot: 1 }], error: null };

    const res = await sessionsRoute.POST(post({ configId: LIVE_CONFIG }));
    const body = await read(res);
    expect(res.status).toBe(201);
    expect(state.fake.rpcCalls).toEqual([{ fn: "competition_create_session", args: { p_config_id: LIVE_CONFIG } }]);
    expect(body.data?.session).toMatchObject({
      gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", status: "READY",
      validationStatus: "NOT_SUBMITTED", settlementStatus: "NOT_REQUIRED", yourSlot: 1, requiredParticipants: 1,
    });
  });

  it("test-game + ONE_V_ONE is refused before the DB (format not declared)", async () => {
    withConfig("test-game", "ONE_V_ONE");
    const res = await sessionsRoute.POST(post({ configId: LIVE_CONFIG }));
    expect([res.status, (await read(res)).error?.message]).toEqual([409, "This game is not available."]);
    expect(state.fake.rpcCalls).toEqual([]);
  });

  it("an unregistered game is refused before the DB", async () => {
    withConfig("some-other-game", "SCORE_ATTACK");
    const res = await sessionsRoute.POST(post({ configId: LIVE_CONFIG }));
    expect(res.status).toBe(409);
    expect(state.fake.rpcCalls).toEqual([]);
  });

  it("an unknown config id is 404 before the DB", async () => {
    state.fake.user = { id: ME };
    const res = await sessionsRoute.POST(post({ configId: LIVE_CONFIG }));
    expect(res.status).toBe(404);
    expect(state.fake.rpcCalls).toEqual([]);
  });

  it("a disabled test-game config reaches the DB, which refuses it (409, no session)", async () => {
    withConfig("test-game", "SCORE_ATTACK");
    state.fake.rpc.competition_create_session = { data: null, error: { code: "P0001", message: "config_disabled" } };
    const res = await sessionsRoute.POST(post({ configId: LIVE_CONFIG }));
    expect([res.status, (await read(res)).error?.message]).toEqual([409, "This competition is not open right now."]);
  });

  it("a PAID test-game config is refused by the DB (403); paid play stays disabled", async () => {
    withConfig("test-game", "SCORE_ATTACK");
    state.fake.rpc.competition_create_session = { data: null, error: { code: "P0001", message: "paid_competitions_disabled" } };
    const res = await sessionsRoute.POST(post({ configId: LIVE_CONFIG }));
    expect([res.status, (await read(res)).error?.code]).toEqual([403, "FORBIDDEN"]);
  });
});

describe("list configs with the real registry", () => {
  it("returns only enabled-query rows for test-game SCORE_ATTACK; drops other games, formats and malformed rows", async () => {
    state.fake.user = { id: ME };
    state.fake.tables.competition_configs = {
      data: [
        configRow({}),
        configRow({ id: "33333333-3333-4333-8333-333333333333", format: "ONE_V_ONE", time_limit_seconds: 300, label: "Duel" }),
        configRow({ id: "44444444-4444-4444-8444-444444444444", game_id: "other-game", label: "Other" }),
        configRow({ id: "55555555-5555-4555-8555-555555555555", entry_fee: 10, label: "Broken" }), // practice with fee
      ],
      error: null,
    };
    const res = await configsRoute.GET(new Request("http://test/api/competitions/configs?gameId=test-game"));
    expect((await read(res)).data?.options).toEqual([
      { configId: LIVE_CONFIG, gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", label: "Test practice", entryFee: 0, reward: null, timeLimitSeconds: 180 },
    ]);
    // The API asks the database for enabled configs only, filtered by the requested game.
    const ops = state.fake.queries.find((q) => q.table === "competition_configs")?.ops ?? [];
    expect(ops).toContainEqual(["eq", ["enabled", true]]);
    expect(ops).toContainEqual(["eq", ["game_id", "test-game"]]);
  });
});
