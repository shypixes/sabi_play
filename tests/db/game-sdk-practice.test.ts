import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_SCORE } from "@/game-sdk";
import { SUBMISSION_GRACE_SECONDS } from "@/lib/competitions/lifecycle";
import { createTestDb, errorOf, type TestDb } from "./harness";

// REAL DB (local PostgreSQL + Supabase shim + migrations 0001-0004; NOT hosted Supabase).
// Game SDK v1 practice sessions for pop-rush and sum-sprint, through the same SQL functions the
// API routes call, using the exact data script handed over for the hosted project.
// (bigint columns such as entry_fee and score are returned by node-postgres as strings.)

const SCRIPT = readFileSync(join(__dirname, "..", "..", "database/data/game-sdk-v1-practice-configs.sql"), "utf8");
let db: TestDb;
const configs: Record<string, string> = {};

const create = (uid: string, config: string) =>
  db.asUser<{ id: string }>(uid, "select public.competition_create_session($1) as id", [config]).then((r) => r.rows[0]!.id);
const start = (uid: string, s: string) => db.asUser(uid, "select public.competition_start_session($1)", [s]);
const submit = (uid: string, s: string, score: number) =>
  db.asUser<{ r: string }>(uid, "select public.competition_submit_result($1, p_score => $2) as r", [s, score]).then((r) => r.rows[0]!.r);
const cancel = (uid: string, s: string) => db.asUser(uid, "select public.competition_cancel_session($1)", [s]);
const row = (uid: string, s: string) =>
  db.asUser(uid, "select status, validation_status, settlement_status, started_at, deadline_at from public.competition_sessions where id = $1", [s]).then((r) => r.rows[0]);

beforeAll(async () => {
  db = await createTestDb();
  await db.admin(SCRIPT); // as the SQL editor would (migration owner)
  const { rows } = await db.admin<{ id: string; game_id: string }>("select id, game_id from public.competition_configs");
  for (const r of rows) configs[r.game_id] = r.id;
});
afterAll(async () => { await db?.drop(); });

describe("hosted data script", () => {
  it("creates one enabled, free, reward-less 180 s practice config per game", async () => {
    const { rows } = await db.admin(
      `select game_id, format, mode, entry_fee::int as entry_fee, reward_model, fixed_reward, time_limit_seconds, enabled
       from public.competition_configs order by game_id`);
    expect(rows).toEqual(["pop-rush", "sum-sprint"].map((game_id) => ({
      game_id, format: "SCORE_ATTACK", mode: "PRACTICE", entry_fee: 0, reward_model: null, fixed_reward: null, time_limit_seconds: 180, enabled: true,
    })));
  });

  it("is idempotent", async () => {
    await db.admin(SCRIPT);
    expect((await db.admin("select 1 from public.competition_configs")).rowCount).toBe(2);
  });
});

describe.each(["pop-rush", "sum-sprint"])("%s practice session", (gameId) => {
  it("READY -> IN_PROGRESS -> COMPLETED with an UNVERIFIED result and no wallet effect", async () => {
    const u = await db.createUser();
    const wallet = (await db.admin("select balance::text, updated_at from public.wallets where user_id = $1", [u])).rows;
    const ledger = (await db.admin("select count(*)::int as c from public.wallet_transactions")).rows;

    const s = await create(u, configs[gameId]!);
    expect(await row(u, s)).toMatchObject({ status: "READY", validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED", started_at: null });
    await start(u, s);
    const started = await row(u, s);
    expect(started?.status).toBe("IN_PROGRESS");
    // deadline = start + time limit + grace (the SDK's endsAt/deadlineAt are derived from these)
    expect((started!.deadline_at as Date).getTime() - (started!.started_at as Date).getTime()).toBe((180 + SUBMISSION_GRACE_SECONDS) * 1000);

    expect(await submit(u, s, 4321)).toBe("UNVERIFIED");
    expect(await row(u, s)).toMatchObject({ status: "COMPLETED", validation_status: "UNVERIFIED", settlement_status: "NOT_REQUIRED" });
    expect((await db.asUser(u, "select score::text as score from public.competition_results where session_id = $1", [s])).rows).toEqual([{ score: "4321" }]);

    expect((await db.admin("select balance::text, updated_at from public.wallets where user_id = $1", [u])).rows).toEqual(wallet);
    expect((await db.admin("select count(*)::int as c from public.wallet_transactions")).rows).toEqual(ledger);
  });

  it("a retried submission is refused and the first result stands (basis of the host's reconcile)", async () => {
    const u = await db.createUser();
    const s = await create(u, configs[gameId]!);
    await start(u, s);
    expect(await submit(u, s, 10)).toBe("UNVERIFIED");
    expect(await errorOf(submit(u, s, 10))).toBe("invalid_state");
    expect(await errorOf(submit(u, s, 999))).toBe("invalid_state");
    expect((await db.asUser(u, "select score::text as score from public.competition_results where session_id = $1", [s])).rows).toEqual([{ score: "10" }]);
  });
});

describe("limits and isolation", () => {
  it("the SDK's MAX_SCORE equals the database limit", async () => {
    const u = await db.createUser();
    const ok = await create(u, configs["pop-rush"]!);
    await start(u, ok);
    expect(await submit(u, ok, MAX_SCORE)).toBe("UNVERIFIED");
    const over = await create(u, configs["pop-rush"]!);
    await start(u, over);
    expect(await errorOf(submit(u, over, MAX_SCORE + 1))).toBe("invalid_result");
    await cancel(u, over);
  });

  it("no result before the platform starts the session", async () => {
    const u = await db.createUser();
    const s = await create(u, configs["sum-sprint"]!);
    expect(await errorOf(submit(u, s, 5))).toBe("invalid_state");
    await cancel(u, s);
    expect((await row(u, s))?.status).toBe("CANCELLED");
  });

  it("another player can neither see nor submit to my session", async () => {
    const me = await db.createUser();
    const other = await db.createUser();
    const s = await create(me, configs["pop-rush"]!);
    await start(me, s);
    expect(await row(other, s)).toBeUndefined();
    expect(await errorOf(submit(other, s, 1))).toBe("session_not_found");
    expect(await errorOf(cancel(other, s))).toBe("session_not_found");
    expect((await row(me, s))?.status).toBe("IN_PROGRESS");
  });

  it("exit mid-game (cancel) abandons the session; an abandoned session accepts no result", async () => {
    const u = await db.createUser();
    const s = await create(u, configs["pop-rush"]!);
    await start(u, s);
    await cancel(u, s);
    expect((await row(u, s))?.status).toBe("ABANDONED");
    expect(await errorOf(submit(u, s, 1))).toBe("invalid_state");
  });

  it("a READY session left behind counts toward the open-session limit; started ones stop counting after the deadline", async () => {
    const u = await db.createUser();
    const ids = [await create(u, configs["pop-rush"]!), await create(u, configs["pop-rush"]!), await create(u, configs["sum-sprint"]!)];
    expect(await errorOf(create(u, configs["pop-rush"]!))).toBe("too_many_open_sessions");
    await start(u, ids[0]!);
    await db.admin("alter table public.competition_sessions disable trigger competition_sessions_guard");
    await db.admin("update public.competition_sessions set started_at = now() - interval '1 hour', deadline_at = now() - interval '1 minute' where id = $1", [ids[0]]);
    await db.admin("alter table public.competition_sessions enable trigger competition_sessions_guard");
    const fourth = await create(u, configs["pop-rush"]!); // the expired IN_PROGRESS one no longer counts
    expect(fourth).toBeTruthy();
    expect((await row(u, ids[0]!))?.status).toBe("IN_PROGRESS"); // no automatic expiry
    expect(await submit(u, ids[0]!, 5)).toBe("EXPIRED");
    expect((await row(u, ids[0]!))?.status).toBe("ABANDONED");
  });
});
