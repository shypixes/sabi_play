import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BODY_BYTES } from "@/lib/api";
import { GameHostController } from "@/lib/game-host/controller";
import { createPlatformApi } from "@/lib/game-host/platform-api";
import { FakeClock, FakeGameEnv, POP_RUSH_TEST_MANIFEST, flush } from "../helpers/game-fakes";
import { connectToPlatform } from "@/game-sdk";
import { createFakeClient, createFakeState, type FakeState } from "./fake-supabase";

// MOCKED INTEGRATION: the REAL host controller + REAL platform API client + REAL Next route
// handlers + REAL server code (auth gating, zod validation, registry gate, error mapping).
// Only Supabase is faked: a small stateful model mirroring migration 0004's transitions sits
// behind rpc(). It proves our layers fit together; database rules are proven in tests/db.

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONFIG = randomUUID();

type Row = Record<string, unknown> & { id: string; status: string };
const db: { session: Row | null; score: number | null; participant: string; gameId: string; format: string; now: number; fake: FakeState } = {
  session: null, score: null, participant: ME, gameId: "pop-rush", format: "SCORE_ATTACK", now: 0, fake: createFakeState(),
};
const clock = new FakeClock();
const iso = () => new Date(clock.now()).toISOString();

/** Re-publish the model as the fake client's table answers (RLS: only the participant sees rows). */
function publish() {
  const visible = db.session && db.fake.user?.id === db.participant;
  db.fake.tables.competition_configs = { data: { game_id: db.gameId, format: db.format }, error: null };
  db.fake.tables.competition_sessions = { data: visible ? db.session : null, error: null };
  db.fake.tables.competition_participants = { data: visible ? [{ user_id: db.participant, slot: 1 }] : [], error: null };
  db.fake.tables.competition_results = { data: visible && db.score !== null ? { score: db.score, winner_user_id: null, is_draw: false } : null, error: null };
}

const raise = (message: string) => ({ data: null, error: { code: "P0001", message } });

function rpc(fn: string, args: Record<string, unknown>) {
  if (!db.fake.user) return raise("not_authenticated");
  const s = db.session;
  const mine = s && s.id === args.p_session_id && db.fake.user.id === db.participant;
  switch (fn) {
    case "competition_create_session":
      db.session = {
        id: randomUUID(), config_id: CONFIG, game_id: db.gameId, format: db.format, mode: "PRACTICE", status: "READY",
        validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED", created_at: iso(), started_at: null, deadline_at: null, completed_at: null,
      };
      db.score = null;
      return { data: db.session.id, error: null };
    case "competition_start_session":
      if (!mine) return raise("session_not_found");
      if (s.status !== "READY") return raise("invalid_state");
      Object.assign(s, { status: "IN_PROGRESS", started_at: iso(), deadline_at: new Date(clock.now() + 210_000).toISOString() });
      return { data: s.deadline_at, error: null };
    case "competition_submit_result":
      if (!mine) return raise("session_not_found");
      if (s.status !== "IN_PROGRESS") return raise("invalid_state");
      if (clock.now() > Date.parse(String(s.deadline_at))) {
        Object.assign(s, { status: "ABANDONED", completed_at: iso() });
        return { data: "EXPIRED", error: null };
      }
      Object.assign(s, { status: "COMPLETED", validation_status: "UNVERIFIED", completed_at: iso() });
      db.score = Number(args.p_score);
      return { data: "UNVERIFIED", error: null };
    case "competition_cancel_session":
      if (!mine) return raise("session_not_found");
      if (s.status === "READY") Object.assign(s, { status: "CANCELLED", completed_at: iso() });
      else if (s.status === "IN_PROGRESS") Object.assign(s, { status: "ABANDONED", completed_at: iso() });
      else return raise("invalid_state");
      return { data: null, error: null };
    default:
      return raise(`no fake for ${fn}`);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    publish();
    const client = createFakeClient(db.fake);
    return {
      ...client,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        db.fake.rpcCalls.push({ fn, args });
        const r = rpc(fn, args);
        publish();
        return r;
      },
    };
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const sessionsRoute = await import("@/app/api/competitions/sessions/route");
const sessionRoute = await import("@/app/api/competitions/sessions/[sessionId]/route");
const startRoute = await import("@/app/api/competitions/sessions/[sessionId]/start/route");
const resultRoute = await import("@/app/api/competitions/sessions/[sessionId]/result/route");
const cancelRoute = await import("@/app/api/competitions/sessions/[sessionId]/cancel/route");

/** fetch() that dispatches to the real route handlers, as Next would. */
const requests: { method: string; path: string; body: string | null }[] = [];
const routeFetch: typeof fetch = async (input, init) => {
  const path = String(input);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : null;
  requests.push({ method, path, body });
  const req = new Request(`http://test${path}`, { method, headers: init?.headers, body });
  const m = /^\/api\/competitions\/sessions(?:\/([^/]+)(?:\/(start|result|cancel))?)?$/.exec(path);
  if (!m) return new Response("not found", { status: 404 });
  const ctx = { params: Promise.resolve({ sessionId: decodeURIComponent(m[1] ?? "") }) };
  if (!m[1]) return sessionsRoute.POST(req);
  if (!m[2]) return sessionRoute.GET(req, ctx);
  return { start: startRoute.POST, result: resultRoute.POST, cancel: cancelRoute.POST }[m[2] as "start" | "result" | "cancel"](req, ctx);
};

function harness(gameId = "pop-rush") {
  const env = new FakeGameEnv(clock);
  const frame = { name: "frame" };
  const controller = new GameHostController({
    api: createPlatformApi({ fetch: routeFetch }),
    launch: { gameId, gameVersion: "1.0.0", configId: CONFIG, timeLimitSeconds: 180, gameConfig: {} },
    now: clock.now, sleep: async () => undefined, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  controller.attachFrame({ post: (m) => env.deliver(m), openChannel: (init) => env.openChannel(init), isFromGame: (m) => m.source === frame && m.origin === "null" });
  env.onPost = (m) => controller.receive({ data: m, origin: "null", source: frame });
  return { env, controller };
}

async function playing() {
  const h = harness();
  await h.controller.createSession();
  const p = connectToPlatform({ manifest: POP_RUSH_TEST_MANIFEST, env: h.env });
  await flush(40);
  const sdk = await p;
  sdk.ready();
  await flush(40);
  await h.controller.start();
  await flush(40);
  expect(sdk.phase).toBe("playing");
  return { ...h, sdk };
}

beforeEach(() => {
  db.fake = createFakeState();
  db.fake.user = { id: ME };
  db.session = null;
  db.score = null;
  db.participant = ME;
  db.gameId = "pop-rush";
  db.format = "SCORE_ATTACK";
  requests.length = 0;
});

describe("game host <-> real competition routes", () => {
  it("completes a practice session through the existing endpoints only", async () => {
    const { sdk, controller } = await playing();
    clock.advance(180_000);
    const outcome = sdk.submitResult({ score: 5150 });
    await flush(80);
    expect(await outcome).toMatchObject({ status: "completed", score: 5150, validation: "UNVERIFIED", settlement: "NOT_REQUIRED" });
    expect(controller.getState().session).toMatchObject({ status: "COMPLETED", result: { format: "SCORE_ATTACK", score: 5150 } });
    expect(requests.map((r) => `${r.method} ${r.path.replace(/[0-9a-f-]{36}/, ":id")}`)).toEqual([
      "POST /api/competitions/sessions",
      "POST /api/competitions/sessions/:id/start",
      "POST /api/competitions/sessions/:id/result",
    ]);
    // The DB receives only ids and the score: never a user id, verification or settlement field.
    expect(db.fake.rpcCalls.map((c) => [c.fn, Object.keys(c.args).sort()])).toEqual([
      ["competition_create_session", ["p_config_id"]],
      ["competition_start_session", ["p_session_id"]],
      ["competition_submit_result", ["p_score", "p_session_id"]],
    ]);
    expect(JSON.parse(requests[2]!.body!)).toEqual({ format: "SCORE_ATTACK", score: 5150 });
  });

  it("a late result is rejected as EXPIRED using the server's real error", async () => {
    const { sdk } = await playing();
    clock.advance(211_000);
    const outcome = sdk.submitResult({ score: 1 });
    await flush(80);
    expect(await outcome).toMatchObject({ status: "rejected", reason: "EXPIRED" });
    expect(db.session).toMatchObject({ status: "ABANDONED" });
    expect(db.score).toBeNull();
  });

  it("a session that already has a different result reports ALREADY_SUBMITTED", async () => {
    const { sdk } = await playing();
    rpc("competition_submit_result", { p_session_id: db.session!.id, p_score: 3 });
    const outcome = sdk.submitResult({ score: 4 });
    await flush(80);
    expect(await outcome).toMatchObject({ status: "rejected", reason: "ALREADY_SUBMITTED" });
    expect(db.score).toBe(3);
  });

  it("signing out mid-game: the result is refused as UNAUTHENTICATED, never retried", async () => {
    const { sdk } = await playing();
    db.fake.user = null;
    const outcome = sdk.submitResult({ score: 4 });
    await flush(80);
    expect(await outcome).toMatchObject({ status: "rejected", reason: "UNAUTHENTICATED" });
    expect(requests.filter((r) => r.path.endsWith("/result"))).toHaveLength(1);
  });

  it("another player's session is invisible (404 -> INVALID_SESSION)", async () => {
    const { sdk } = await playing();
    db.participant = randomUUID();
    const outcome = sdk.submitResult({ score: 4 });
    await flush(80);
    expect(await outcome).toMatchObject({ status: "rejected", reason: "INVALID_SESSION" });
  });

  it("signed-out players cannot create sessions; the host shows the server's message", async () => {
    db.fake.user = null;
    const { controller } = harness();
    await controller.createSession();
    expect(controller.getState()).toMatchObject({ phase: "idle", message: "You need to log in." });
    expect(db.fake.rpcCalls).toEqual([]);
  });

  it("exiting mid-game abandons the session through the real cancel route", async () => {
    const { controller } = await playing();
    await controller.exit();
    expect(db.session).toMatchObject({ status: "ABANDONED" });
    expect(requests.at(-1)).toMatchObject({ method: "POST", body: "{}" });
  });

  it("the registry gate still applies: a ONE_V_ONE config for pop-rush is refused before the DB", async () => {
    db.format = "ONE_V_ONE";
    const { controller } = harness();
    await controller.createSession();
    expect(controller.getState()).toMatchObject({ phase: "idle", message: "This game is not available." });
    expect(db.fake.rpcCalls).toEqual([]);
  });

  it("the result route refuses oversized bodies and extra fields", async () => {
    await playing();
    const id = db.session!.id;
    const big = await routeFetch(`/api/competitions/sessions/${id}/result`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "SCORE_ATTACK", score: 1, pad: "x".repeat(MAX_JSON_BODY_BYTES) }),
    });
    expect(big.status).toBe(400);
    const extra = await routeFetch(`/api/competitions/sessions/${id}/result`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "SCORE_ATTACK", score: 1, validationStatus: "VALID" }),
    });
    expect(extra.status).toBe(400);
    const fractional = await routeFetch(`/api/competitions/sessions/${id}/result`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "SCORE_ATTACK", score: 1.5 }),
    });
    expect(fractional.status).toBe(400);
    expect(db.score).toBeNull();
  });
});
