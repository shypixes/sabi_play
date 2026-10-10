import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, errorOf, type TestDb } from "./harness";

// REAL DB (PostgreSQL + Supabase shim + migrations 0001-0004). Roles and JWT claims are switched
// like PostgREST does, so RLS/grants/triggers are exercised for real. Not hosted Supabase.

let db: TestDb;
let saPractice: string;
let duelPractice: string;
let paidDuel: string;
let disabledCfg: string;

async function config(values: Record<string, unknown>, enabled = true): Promise<string> {
  const row = { game_id: "demo", format: "SCORE_ATTACK", mode: "PRACTICE", entry_fee: 0, time_limit_seconds: 180, enabled, ...values };
  const cols = Object.keys(row);
  const { rows } = await db.admin<{ id: string }>(
    `insert into public.competition_configs (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return rows[0]!.id;
}

const rpc = async <T>(user: string, sql: string, params: unknown[]) => (await db.asUser(user, sql, params)).rows[0] as T;
const create = (user: string, cfg: string) =>
  rpc<{ id: string }>(user, "select public.competition_create_session($1) as id", [cfg]).then((r) => r.id);
const join = (user: string, s: string) => db.asUser(user, "select public.competition_join_session($1)", [s]);
const start = (user: string, s: string) => db.asUser(user, "select public.competition_start_session($1)", [s]);
const cancel = (user: string, s: string) =>
  rpc<{ r: string }>(user, "select public.competition_cancel_session($1) as r", [s]).then((r) => r.r);
const submitScore = (user: string, s: string, score: unknown) =>
  rpc<{ r: string }>(user, "select public.competition_submit_result($1, p_score => $2) as r", [s, score]).then((r) => r.r);
const submitDuel = (user: string, s: string, winnerSlot: number | null, draw: boolean) =>
  rpc<{ r: string }>(user, "select public.competition_submit_result($1, p_winner_slot => $2::smallint, p_is_draw => $3) as r", [s, winnerSlot, draw]).then((r) => r.r);
const session = async (id: string) =>
  (await db.admin("select status, validation_status, settlement_status, deadline_at, started_at from public.competition_sessions where id = $1", [id])).rows[0];
const finish = async (user: string, cfg = saPractice) => {
  const s = await create(user, cfg);
  await cancel(user, s);
  return s;
};

/** A PAID session in IN_PROGRESS, built directly by the owner role (paid creation is disabled for players). */
async function paidInProgress(a: string, b: string): Promise<string> {
  const c = await db.pool.connect();
  try {
    await c.query("begin");
    const { rows } = await c.query<{ id: string }>(
      `insert into public.competition_sessions (config_id, game_id, format, mode, created_by, status, settlement_status, started_at, deadline_at)
       values ($1, 'demo', 'ONE_V_ONE', 'PAID', $2, 'IN_PROGRESS', 'PENDING', now(), now() + interval '10 minutes') returning id`,
      [paidDuel, a],
    );
    const id = rows[0]!.id;
    await c.query("insert into public.competition_participants (session_id, format, user_id, slot) values ($1, 'ONE_V_ONE', $2, 1), ($1, 'ONE_V_ONE', $3, 2)", [id, a, b]);
    await c.query("commit");
    return id;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  db = await createTestDb();
  saPractice = await config({ label: "SA practice" });
  duelPractice = await config({ format: "ONE_V_ONE", label: "Duel practice", time_limit_seconds: 300 });
  paidDuel = await config({ format: "ONE_V_ONE", mode: "PAID", label: "Duel 100", entry_fee: 100, reward_model: "PRIZE_POOL", platform_fee_bps: 1000, time_limit_seconds: 300 });
  disabledCfg = await config({ label: "Disabled" }, false);
});
afterAll(async () => { await db?.drop(); });

describe("practice SCORE_ATTACK lifecycle", () => {
  it("create -> start -> submit completes with an UNVERIFIED result and no settlement", async () => {
    const u = await db.createUser();
    const s = await create(u, saPractice);
    expect(await session(s)).toMatchObject({ status: "READY", validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED" });
    await start(u, s);
    const started = await session(s);
    expect(started?.status).toBe("IN_PROGRESS");
    // deadline = 180s limit + 30s grace
    expect((started!.deadline_at.getTime() - started!.started_at.getTime()) / 1000).toBe(210);
    expect(await submitScore(u, s, 4200)).toBe("UNVERIFIED");
    expect(await session(s)).toMatchObject({ status: "COMPLETED", validation_status: "UNVERIFIED", settlement_status: "NOT_REQUIRED" });
    const { rows } = await db.asUser(u, "select score::int as score from public.competition_results where session_id = $1", [s]);
    expect(rows).toEqual([{ score: 4200 }]);
  });

  it("rejects duplicate results, results before start and invalid scores", async () => {
    const u = await db.createUser();
    const s = await create(u, saPractice);
    expect(await errorOf(submitScore(u, s, 10))).toBe("invalid_state"); // not started
    await start(u, s);
    for (const bad of [-1, "1000000000001", null]) expect(await errorOf(submitScore(u, s, bad))).toBe("invalid_result");
    expect(await errorOf(submitScore(u, s, 1.5))).toMatch(/invalid input syntax for type bigint/);
    expect(await errorOf(submitDuel(u, s, 1, false))).toBe("invalid_result"); // wrong shape for format
    expect(await submitScore(u, s, 100)).toBe("UNVERIFIED");
    expect(await errorOf(submitScore(u, s, 999_999))).toBe("invalid_state"); // duplicate
    const { rows } = await db.admin("select score::int as score from public.competition_results where session_id = $1", [s]);
    expect(rows).toEqual([{ score: 100 }]); // first result kept
  });

  it("rejects invalid transitions through the player functions", async () => {
    const u = await db.createUser();
    const s = await create(u, saPractice);
    expect(await errorOf(join(u, s))).toBe("already_joined");
    await start(u, s);
    expect(await errorOf(start(u, s))).toBe("invalid_state");
    expect(await cancel(u, s)).toBe("ABANDONED");
    expect(await errorOf(cancel(u, s))).toBe("invalid_state");
    expect(await errorOf(start(u, s))).toBe("invalid_state");
  });

  it("marks late results EXPIRED (session ABANDONED) without storing them", async () => {
    const u = await db.createUser();
    const s = await create(u, saPractice);
    await start(u, s);
    // Simulate time passing: move the session's timestamps into the past (owner role, test only).
    await db.admin("alter table public.competition_sessions disable trigger competition_sessions_guard");
    await db.admin("update public.competition_sessions set started_at = now() - interval '1 hour', deadline_at = now() - interval '1 minute' where id = $1", [s]);
    await db.admin("alter table public.competition_sessions enable trigger competition_sessions_guard");
    expect(await submitScore(u, s, 50)).toBe("EXPIRED");
    expect(await session(s)).toMatchObject({ status: "ABANDONED", validation_status: "NOT_SUBMITTED" });
    expect((await db.admin("select 1 from public.competition_results where session_id = $1", [s])).rowCount).toBe(0);
  });

  it("refuses disabled configs, unknown configs and paid configs", async () => {
    const u = await db.createUser();
    expect(await errorOf(create(u, disabledCfg))).toBe("config_disabled");
    expect(await errorOf(create(u, "00000000-0000-4000-8000-000000000000"))).toBe("config_not_found");
    expect(await errorOf(create(u, paidDuel))).toBe("paid_competitions_disabled");
  });

  it("limits open sessions per player, even under concurrent requests", async () => {
    const u = await db.createUser();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => create(u, saPractice)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const reasons = results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : []));
    expect(reasons).toEqual(["too_many_open_sessions", "too_many_open_sessions"]);
  });
});

describe("practice ONE_V_ONE lifecycle", () => {
  it("WAITING -> join -> READY -> start -> submit (winner by slot) -> COMPLETED/UNVERIFIED", async () => {
    const [a, b] = [await db.createUser(), await db.createUser()];
    const s = await create(a, duelPractice);
    expect((await session(s))?.status).toBe("WAITING");
    expect(await errorOf(start(a, s))).toBe("invalid_state"); // cannot start alone
    await join(b, s);
    expect((await session(s))?.status).toBe("READY");
    await start(b, s);
    expect(await submitDuel(a, s, 2, false)).toBe("UNVERIFIED");
    expect(await errorOf(submitDuel(b, s, 1, false))).toBe("invalid_state"); // opponent cannot overwrite
    const { rows } = await db.admin("select winner_user_id, is_draw from public.competition_results where session_id = $1", [s]);
    expect(rows).toEqual([{ winner_user_id: b, is_draw: false }]);
  });

  it("accepts draws and rejects ill-defined outcomes", async () => {
    const [a, b] = [await db.createUser(), await db.createUser()];
    const s = await create(a, duelPractice);
    await join(b, s);
    await start(a, s);
    expect(await errorOf(submitDuel(a, s, 1, true))).toBe("invalid_result"); // winner and draw
    expect(await errorOf(submitDuel(a, s, null, false))).toBe("invalid_result"); // neither
    expect(await errorOf(submitDuel(a, s, 3, false))).toMatch(/invalid_result|violates check/);
    expect(await errorOf(submitScore(a, s, 10))).toBe("invalid_result");
    expect(await submitDuel(a, s, null, true)).toBe("UNVERIFIED");
  });

  it("allows exactly two participants: no third player, no double join, no joining twice concurrently", async () => {
    const [a, b, c, d] = [await db.createUser(), await db.createUser(), await db.createUser(), await db.createUser()];
    const s = await create(a, duelPractice);
    const raced = await Promise.allSettled([join(b, s), join(c, s)]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(raced.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : []))).toEqual(["session_not_joinable"]);
    expect(await errorOf(join(d, s))).toBe("session_not_joinable");
    expect(await errorOf(join(a, s))).toBe("already_joined");
    const { rows } = await db.admin("select count(*)::int as c from public.competition_participants where session_id = $1", [s]);
    expect(rows[0]?.c).toBe(2);
  });

  it("cannot join SCORE_ATTACK sessions or finished sessions", async () => {
    const [a, b] = [await db.createUser(), await db.createUser()];
    const sa = await create(a, saPractice);
    expect(await errorOf(join(b, sa))).toBe("session_not_joinable");
    const duel = await create(a, duelPractice);
    expect(await cancel(a, duel)).toBe("CANCELLED");
    expect(await errorOf(join(b, duel))).toBe("session_not_joinable");
  });
});

describe("authorization and RLS", () => {
  it("players see only sessions, participants and results they belong to", async () => {
    const [a, b, outsider] = [await db.createUser(), await db.createUser(), await db.createUser()];
    const s = await create(a, duelPractice);
    await join(b, s);
    await start(a, s);
    await submitDuel(a, s, 1, false);
    for (const table of ["competition_sessions", "competition_participants", "competition_results"]) {
      const col = table === "competition_sessions" ? "id" : "session_id";
      expect((await db.asUser(outsider, `select 1 from public.${table} where ${col} = $1`, [s])).rowCount, table).toBe(0);
      expect((await db.asUser(b, `select 1 from public.${table} where ${col} = $1`, [s])).rowCount, table).toBeGreaterThan(0);
    }
  });

  it("non-participants cannot act on a session and learn nothing (session_not_found)", async () => {
    const [a, outsider] = [await db.createUser(), await db.createUser()];
    const s = await create(a, saPractice);
    expect(await errorOf(start(outsider, s))).toBe("session_not_found");
    expect(await errorOf(cancel(outsider, s))).toBe("session_not_found");
    expect(await errorOf(submitScore(outsider, s, 1))).toBe("session_not_found");
    expect((await session(s))?.status).toBe("READY");
  });

  it("anonymous users can read nothing and call nothing", async () => {
    for (const table of ["competition_configs", "competition_sessions", "competition_participants", "competition_results"]) {
      expect(await errorOf(db.as("anon", null, (q) => q(`select 1 from public.${table}`)))).toMatch(/permission denied for table/);
    }
    for (const fn of ["competition_create_session", "competition_join_session", "competition_start_session", "competition_cancel_session"]) {
      expect(await errorOf(db.as("anon", null, (q) => q(`select public.${fn}($1)`, [saPractice])))).toMatch(/permission denied for function/);
    }
  });

  it("authenticated users cannot write competition tables directly", async () => {
    const a = await db.createUser();
    const s = await create(a, saPractice);
    const attempts = [
      ["insert into public.competition_configs (game_id, format, mode, label, time_limit_seconds) values ('x', 'SCORE_ATTACK', 'PRACTICE', 'x', 180)", []],
      ["update public.competition_configs set enabled = true", []],
      ["insert into public.competition_sessions (config_id, game_id, format, mode, created_by, status, settlement_status) values ($1, 'demo', 'SCORE_ATTACK', 'PRACTICE', $2, 'READY', 'NOT_REQUIRED')", [saPractice, a]],
      ["update public.competition_sessions set status = 'COMPLETED' where id = $1", [s]],
      ["update public.competition_sessions set validation_status = 'VERIFIED' where id = $1", [s]],
      ["delete from public.competition_sessions where id = $1", [s]],
      ["insert into public.competition_participants (session_id, format, user_id, slot) values ($1, 'SCORE_ATTACK', $2, 1)", [s, a]],
      ["delete from public.competition_participants where session_id = $1", [s]],
      ["insert into public.competition_results (session_id, format, submitted_by, score) values ($1, 'SCORE_ATTACK', $2, 1)", [s, a]],
    ] as const;
    for (const [sql, params] of attempts) {
      expect(await errorOf(db.asUser(a, sql, [...params])), sql).toMatch(/permission denied for table/);
    }
  });

  it("internal helpers and the validator function are not callable by players", async () => {
    const a = await db.createUser();
    const s = await create(a, saPractice);
    for (const sql of [
      "select public.competition_record_validation($1, 'VERIFIED')",
      "select public.competition_lock_own_session($1, auth.uid())",
      "select public.competition_open_session_count(auth.uid())",
      "select public.competition_lock_player(auth.uid())",
    ]) {
      const params = sql.includes("$1") ? [s] : [];
      expect(await errorOf(db.asUser(a, sql, params)), sql).toMatch(/permission denied for function/);
    }
  });

  it("player functions require an authenticated identity", async () => {
    expect(await errorOf(db.as("authenticated", null, (q) => q("select public.competition_create_session($1)", [saPractice]))))
      .toBe("not_authenticated");
  });
});

describe("paid sessions: validation and settlement tracking", () => {
  it("a paid result stays PENDING; only service_role can record VERIFIED, exactly once", async () => {
    const [a, b] = [await db.createUser(), await db.createUser()];
    const s = await paidInProgress(a, b);
    expect(await submitDuel(a, s, 1, false)).toBe("PENDING");
    expect(await session(s)).toMatchObject({ status: "SUBMITTED", validation_status: "PENDING", settlement_status: "PENDING" });
    expect(await errorOf(cancel(a, s))).toBe("invalid_state"); // cannot cancel away a submitted result

    await db.as("service_role", null, (q) => q("select public.competition_record_validation($1, 'VERIFIED', 'replay ok')", [s]));
    expect(await session(s)).toMatchObject({ status: "COMPLETED", validation_status: "VERIFIED" });
    expect(await errorOf(db.as("service_role", null, (q) => q("select public.competition_record_validation($1, 'REJECTED')", [s]))))
      .toBe("invalid_state");
    expect(await errorOf(db.as("service_role", null, (q) => q("select public.competition_record_validation($1, 'MAYBE')", [s]))))
      .toBe("invalid_validation_outcome");
  });

  it("settlement can be marked complete once and never repeated or reversed", async () => {
    const [a, b] = [await db.createUser(), await db.createUser()];
    const s = await paidInProgress(a, b);
    // Not allowed before the session is terminal.
    expect(await errorOf(db.as("service_role", null, (q) => q("update public.competition_sessions set settlement_status = 'COMPLETED', settled_at = now() where id = $1", [s]))))
      .toMatch(/competition_sessions_settlement/);
    await submitDuel(b, s, 2, false);
    await db.as("service_role", null, (q) => q("select public.competition_record_validation($1, 'VERIFIED')", [s]));

    const settle = "update public.competition_sessions set settlement_status = 'COMPLETED', settled_at = now() where id = $1 and settlement_status = 'PENDING'";
    expect((await db.as("service_role", null, (q) => q(settle, [s]))).rowCount).toBe(1);
    expect((await db.as("service_role", null, (q) => q(settle, [s]))).rowCount).toBe(0); // idempotent guard
    expect(await errorOf(db.as("service_role", null, (q) => q("update public.competition_sessions set settled_at = now() where id = $1", [s]))))
      .toBe("session_history_immutable");
    expect(await errorOf(db.as("service_role", null, (q) => q("update public.competition_sessions set settlement_status = 'PENDING', settled_at = null where id = $1", [s]))))
      .toBe("invalid_settlement_transition");
    expect(await errorOf(db.admin("update public.competition_sessions set settlement_status = 'NOT_REQUIRED', settled_at = null where id = $1", [s])))
      .toBe("invalid_settlement_transition"); // even the owner role
  });

  it("guards apply to service_role too: no invalid status/validation changes, no edits to results", async () => {
    const [a, b] = [await db.createUser(), await db.createUser()];
    const s = await paidInProgress(a, b);
    const svc = (sql: string) => errorOf(db.as("service_role", null, (q) => q(sql, [s])));
    expect(await svc("update public.competition_sessions set status = 'READY', started_at = null, deadline_at = null where id = $1")).toBe("invalid_status_transition");
    expect(await svc("update public.competition_sessions set mode = 'PRACTICE', settlement_status = 'NOT_REQUIRED' where id = $1")).toMatch(/session_identity_immutable|invalid_settlement/);
    expect(await svc("update public.competition_participants set slot = 2 where session_id = $1 and slot = 1")).toBe("participants_immutable");
    await submitDuel(a, s, 1, false);
    expect(await svc("update public.competition_results set winner_user_id = null, is_draw = true where session_id = $1")).toBe("results_immutable");
    expect(await svc("delete from public.competition_results where session_id = $1")).toBe("results_immutable");
    expect(await svc("update public.competition_sessions set validation_status = 'UNVERIFIED' where id = $1")).toMatch(/invalid_validation_transition|violates check/);
  });
});

describe("participant count invariants (enforced for every role at commit)", () => {
  it("a SCORE_ATTACK session cannot have a second participant", async () => {
    const [a, b] = [await db.createUser(), await db.createUser()];
    const s = await create(a, saPractice);
    expect(await errorOf(db.admin("insert into public.competition_participants (session_id, format, user_id, slot) values ($1, 'SCORE_ATTACK', $2, 2)", [s, b])))
      .toMatch(/competition_participants_slot_allowed/);
  });

  it("a session cannot be committed without participants, nor a READY duel with one player", async () => {
    const a = await db.createUser();
    expect(await errorOf(db.admin(
      "insert into public.competition_sessions (config_id, game_id, format, mode, created_by, status, settlement_status) values ($1, 'demo', 'SCORE_ATTACK', 'PRACTICE', $2, 'READY', 'NOT_REQUIRED')",
      [saPractice, a],
    ))).toBe("participant_count_invalid");
    const s = await create(a, duelPractice);
    expect(await errorOf(db.admin("update public.competition_sessions set status = 'READY' where id = $1", [s]))).toBe("participant_count_invalid");
    expect(await errorOf(db.admin("delete from public.competition_participants where session_id = $1", [s]))).toBe("participant_count_invalid");
  });

  it("the same player cannot occupy both slots", async () => {
    const a = await db.createUser();
    const s = await create(a, duelPractice);
    expect(await errorOf(db.admin("insert into public.competition_participants (session_id, format, user_id, slot) values ($1, 'ONE_V_ONE', $2, 2)", [s, a])))
      .toMatch(/competition_participants_pkey/);
  });
});

describe("wallet protection", () => {
  it("no competition operation changes balances or writes ledger rows", async () => {
    const snapshot = async () => ({
      wallets: (await db.admin("select user_id, balance::text, updated_at from public.wallets order by user_id")).rows,
      ledger: (await db.admin("select count(*)::int as c from public.wallet_transactions")).rows[0],
    });
    const before = await snapshot();
    const [a, b] = [await db.createUser(), await db.createUser()];
    const afterUsers = await snapshot();
    const s = await create(a, duelPractice);
    await join(b, s);
    await start(a, s);
    await submitDuel(b, s, null, true);
    const p = await paidInProgress(a, b);
    await submitDuel(a, p, 1, false);
    await db.as("service_role", null, (q) => q("select public.competition_record_validation($1, 'VERIFIED')", [p]));
    await finish(a);
    expect(await snapshot()).toEqual(afterUsers);
    expect(afterUsers.ledger).toEqual(before.ledger);
  });

  it("players still cannot write wallets or ledger rows directly", async () => {
    const a = await db.createUser();
    expect(await errorOf(db.asUser(a, "update public.wallets set balance = 1000000 where user_id = $1", [a])))
      .toMatch(/permission denied/);
    expect(await errorOf(db.asUser(a, "insert into public.wallet_transactions (user_id, type, amount, balance_after, reference) values ($1, 'MATCH_WIN', 10, 10, 'x')", [a])))
      .toMatch(/permission denied|row-level security/);
  });

  it("users with competition history cannot be hard-deleted (same rule as the wallet ledger)", async () => {
    const a = await db.createUser();
    await create(a, saPractice);
    expect(await errorOf(db.admin("delete from auth.users where id = $1", [a]))).toMatch(/violates foreign key constraint/);
  });
});
