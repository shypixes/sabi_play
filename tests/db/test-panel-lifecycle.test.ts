import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelOutcome, countsTowardOpenLimit } from "@/app/(app)/test-panel/panel-lifecycle";
import { createTestDb, errorOf, type TestDb } from "./harness";

// REAL DB (local PostgreSQL + migrations 0001-0004 + Supabase shim; NOT hosted Supabase).
// Backs the TEMPORARY Competition Test Panel (v1.2.4): every lifecycle path the panel exposes is
// driven through the same SQL functions the API routes call, as isolated users, and the panel's
// own predictions (cancel outcome, open-limit counting) are checked against what Postgres does.
// Wallet integrity is asserted across all of it. Remove together with src/app/(app)/test-panel.

const TEST_CONFIG = "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac"; // same row as the hosted test config
let db: TestDb;
let duelConfig: string; // ONE_V_ONE practice config, the only way to get a WAITING session

const rpc = async <T>(user: string, sql: string, params: unknown[]) => (await db.asUser(user, sql, params)).rows[0] as T;
const create = (user: string, cfg = TEST_CONFIG) =>
  rpc<{ id: string }>(user, "select public.competition_create_session($1) as id", [cfg]).then((r) => r.id);
const start = (user: string, s: string) =>
  rpc<{ d: Date }>(user, "select public.competition_start_session($1) as d", [s]).then((r) => r.d);
const cancel = (user: string, s: string) =>
  rpc<{ r: string }>(user, "select public.competition_cancel_session($1) as r", [s]).then((r) => r.r);
const submit = (user: string, s: string, score: number) =>
  rpc<{ r: string }>(user, "select public.competition_submit_result($1, p_score => $2) as r", [s, score]).then((r) => r.r);

/** Everything about a session the panel shows, plus updated_at, so "unchanged" means unchanged. */
const snapshot = async (s: string) => ({
  session: (await db.admin(
    `select status, validation_status, settlement_status, started_at, deadline_at, completed_at,
            validated_at, settled_at, updated_at from public.competition_sessions where id = $1`, [s])).rows[0],
  results: (await db.admin("select format, submitted_by, score, winner_user_id, is_draw from public.competition_results where session_id = $1", [s])).rows,
});
const walletState = async () => ({
  wallets: (await db.admin("select user_id, balance::text, updated_at from public.wallets order by user_id")).rows,
  ledger: (await db.admin("select * from public.wallet_transactions order by id")).rows,
});
/** Test-only time travel: move a session's clock (owner role, guard trigger briefly off). */
async function setDeadline(s: string, deadlineSql: string) {
  await db.admin("alter table public.competition_sessions disable trigger competition_sessions_guard");
  try {
    await db.admin(`update public.competition_sessions set started_at = now() - interval '1 hour', deadline_at = ${deadlineSql} where id = $1`, [s]);
  } finally {
    await db.admin("alter table public.competition_sessions enable trigger competition_sessions_guard");
  }
}
const openCount = async (u: string) =>
  (await db.admin<{ c: number }>("select public.competition_open_session_count($1) as c", [u])).rows[0]!.c;

beforeAll(async () => {
  db = await createTestDb();
  await db.admin(
    `insert into public.competition_configs (id, game_id, format, mode, label, entry_fee, time_limit_seconds, enabled)
     values ($1, 'test-game', 'SCORE_ATTACK', 'PRACTICE', 'Test practice', 0, 180, true)`, [TEST_CONFIG]);
  duelConfig = (await db.admin<{ id: string }>(
    `insert into public.competition_configs (game_id, format, mode, label, entry_fee, time_limit_seconds, enabled)
     values ('test-game', 'ONE_V_ONE', 'PRACTICE', 'Duel practice', 0, 180, true) returning id`)).rows[0]!.id;
});
afterAll(async () => { await db?.drop(); });

/** Every user gets 500 PlayCoins (owner update) right after creation so "unchanged" is meaningful. */
async function userWithCoins(name: string): Promise<string> {
  const u = await db.createUser(name);
  await db.admin("update public.wallets set balance = 500 where user_id = $1", [u]);
  return u;
}

describe("A/B. result submission and completion (practice)", () => {
  it("READY -> start -> submit: exactly one stored result, COMPLETED/UNVERIFIED/NOT_REQUIRED, never settled", async () => {
    const u = await userWithCoins("Completer");
    const s = await create(u);
    expect((await snapshot(s)).session).toMatchObject({ status: "READY", validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED", started_at: null });

    const deadline = await start(u, s);
    const started = (await snapshot(s)).session!;
    expect(started.status).toBe("IN_PROGRESS");
    // deadline = time limit (180s) + 30s grace
    expect((deadline.getTime() - (started.started_at as Date).getTime()) / 1000).toBeCloseTo(210, 0);

    expect(await submit(u, s, 4200)).toBe("UNVERIFIED");
    const done = await snapshot(s);
    expect(done.session).toMatchObject({
      status: "COMPLETED", validation_status: "UNVERIFIED", settlement_status: "NOT_REQUIRED", validated_at: null, settled_at: null,
    });
    expect(done.session!.completed_at).toBeInstanceOf(Date);
    expect(done.results).toEqual([{ format: "SCORE_ATTACK", submitted_by: u, score: "4200", winner_user_id: null, is_draw: false }]);
  });

  it("the player cannot mark their own result verified or settled, nor write results directly", async () => {
    const u = await userWithCoins("Forger");
    const s = await create(u);
    await start(u, s);
    await submit(u, s, 10);
    for (const sql of [
      "update public.competition_sessions set validation_status = 'VERIFIED', validated_at = now() where id = $1",
      "update public.competition_sessions set settlement_status = 'COMPLETED', settled_at = now() where id = $1",
      "update public.competition_results set score = 999 where session_id = $1",
    ]) {
      expect(await errorOf(db.asUser(u, sql, [s])), sql).toMatch(/permission denied/);
    }
    expect(await errorOf(db.asUser(u, "select public.competition_record_validation($1, 'VERIFIED', null)", [s]))).toMatch(/permission denied/);
    expect((await snapshot(s)).session).toMatchObject({ validation_status: "UNVERIFIED", settlement_status: "NOT_REQUIRED" });
  });
});

describe("C. rejected operations leave the session unchanged", () => {
  it("submit before start, start when not READY, duplicate submit, repeat start, repeat cancel", async () => {
    const u = await userWithCoins("Rejecter");
    const s = await create(u);
    let before = await snapshot(s);
    expect(await errorOf(submit(u, s, 1))).toBe("invalid_state"); // before start
    expect(await snapshot(s)).toEqual(before);

    await start(u, s);
    before = await snapshot(s);
    expect(await errorOf(start(u, s))).toBe("invalid_state"); // repeat start
    expect(await snapshot(s)).toEqual(before);

    await submit(u, s, 7);
    before = await snapshot(s);
    expect(await errorOf(submit(u, s, 8))).toBe("invalid_state"); // duplicate submit
    expect(await errorOf(start(u, s))).toBe("invalid_state"); // start a finished session
    expect(await errorOf(cancel(u, s))).toBe("invalid_state"); // cancel a finished session
    expect(await snapshot(s)).toEqual(before);
    expect(before.results).toHaveLength(1);
    expect(before.results[0]?.score).toBe("7");

    const c = await create(u);
    expect(await cancel(u, c)).toBe("CANCELLED");
    before = await snapshot(c);
    expect(await errorOf(cancel(u, c))).toBe("invalid_state"); // repeat cancel
    expect(await errorOf(start(u, c))).toBe("invalid_state");
    expect(await errorOf(submit(u, c, 1))).toBe("invalid_state");
    expect(await snapshot(c)).toEqual(before);
  });

  it("invalid scores are refused by the database too, with nothing stored", async () => {
    const u = await userWithCoins("Range");
    const s = await create(u);
    await start(u, s);
    const before = await snapshot(s);
    expect(await errorOf(submit(u, s, -1))).toBe("invalid_result");
    expect(await errorOf(submit(u, s, 1_000_000_000_001))).toBe("invalid_result");
    expect(await snapshot(s)).toEqual(before);
    expect(await submit(u, s, 1_000_000_000_000)).toBe("UNVERIFIED"); // inclusive upper bound
  });

  it("cancel in each cancellable state gives exactly what the panel predicts", async () => {
    const u = await userWithCoins("Canceller");
    const waiting = await create(u, duelConfig);
    const ready = await create(u);
    const running = await create(u);
    await start(u, running);
    for (const s of [waiting, ready, running]) {
      const status = (await snapshot(s)).session!.status as string;
      const predicted = cancelOutcome(status);
      expect(predicted, status).not.toBeNull();
      expect(await cancel(u, s)).toBe(predicted);
      const after = (await snapshot(s)).session!;
      expect(after.status).toBe(predicted);
      expect(after.completed_at).toBeInstanceOf(Date);
      expect(after.settlement_status).toBe("NOT_REQUIRED");
      expect(cancelOutcome(after.status as string)).toBeNull(); // the panel disables Cancel now
    }
    expect(["WAITING", "READY", "IN_PROGRESS"].map(cancelOutcome)).toEqual(["CANCELLED", "CANCELLED", "ABANDONED"]);
  });

  it("concurrent duplicate submits and cancels: exactly one succeeds", async () => {
    const u = await userWithCoins("Racer");
    const s = await create(u);
    await start(u, s);
    const subs = await Promise.allSettled([submit(u, s, 1), submit(u, s, 2), submit(u, s, 3)]);
    expect(subs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(subs.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.message)).toEqual(["invalid_state", "invalid_state"]);
    expect((await snapshot(s)).results).toHaveLength(1);

    const c = await create(u);
    const cancels = await Promise.allSettled([cancel(u, c), cancel(u, c)]);
    expect(cancels.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("E. deadline and expiry (enforced lazily, only inside competition_submit_result)", () => {
  it("a result just before the deadline is accepted; just after it is EXPIRED, the session ABANDONED, nothing stored", async () => {
    const u = await userWithCoins("Clock");
    const inTime = await create(u);
    await start(u, inTime);
    await setDeadline(inTime, "now() + interval '5 seconds'");
    expect(await submit(u, inTime, 11)).toBe("UNVERIFIED");

    const late = await create(u);
    await start(u, late);
    await setDeadline(late, "now() - interval '1 second'");
    expect(await submit(u, late, 12)).toBe("EXPIRED");
    const after = await snapshot(late);
    expect(after.session).toMatchObject({ status: "ABANDONED", validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED", settled_at: null });
    expect(after.results).toEqual([]);
    expect(await errorOf(submit(u, late, 13))).toBe("invalid_state"); // no second chance
  });

  it("NO automatic expiry: an expired session stays IN_PROGRESS until touched, but stops counting toward the limit", async () => {
    const u = await userWithCoins("Stale");
    const stale = await create(u);
    await start(u, stale);
    await setDeadline(stale, "now() - interval '10 minutes'");
    expect((await snapshot(stale)).session!.status).toBe("IN_PROGRESS"); // nothing moved it

    // Panel counting == database counting.
    const rows = (await db.asUser<{ status: string; deadline_at: Date | null }>(u, "select status, deadline_at from public.competition_sessions where created_by = $1", [u])).rows;
    const panelCount = rows.filter((r) => countsTowardOpenLimit(r.status, r.deadline_at?.toISOString() ?? null, Date.now())).length;
    expect(panelCount).toBe(await openCount(u));
    expect(await openCount(u)).toBe(0);

    // Three more open sessions fit beside the stale one; a fourth does not.
    const fresh = [await create(u), await create(u), await create(u)];
    expect(await openCount(u)).toBe(3);
    expect(await errorOf(create(u))).toBe("too_many_open_sessions");

    // Cleanup through the normal cancel path: stale IN_PROGRESS -> ABANDONED, READY -> CANCELLED.
    expect(cancelOutcome("IN_PROGRESS")).toBe("ABANDONED");
    expect(await cancel(u, stale)).toBe("ABANDONED");
    for (const s of fresh) expect(await cancel(u, s)).toBe("CANCELLED");
    expect(await openCount(u)).toBe(0);
    // History is kept: cancelling never deletes.
    expect((await db.admin("select count(*)::int as c from public.competition_sessions where created_by = $1", [u])).rows[0]?.c).toBe(4);
  });
});

describe("D. ownership and access control (isolated users)", () => {
  it("a user can read and list only their own sessions; another user's session is invisible and untouchable", async () => {
    const a = await userWithCoins("Alice");
    const b = await userWithCoins("Bob");
    const sa = await create(a);
    const sb = await create(b);
    await start(a, sa);
    const aBefore = await snapshot(sa);

    // The panel's list query (load-sessions.ts), run as each user under RLS.
    const list = (u: string) => db.asUser<{ id: string }>(u,
      "select id from public.competition_sessions where created_by = $1 order by created_at desc limit 50", [u]).then((r) => r.rows.map((x) => x.id));
    expect(await list(a)).toEqual([sa]);
    expect(await list(b)).toEqual([sb]);
    // Even without the created_by filter (or with A's id), RLS returns nothing of A's to B.
    expect((await db.asUser(b, "select id from public.competition_sessions")).rows.map((r) => r.id)).toEqual([sb]);
    expect((await db.asUser(b, "select id from public.competition_sessions where created_by = $1", [a])).rowCount).toBe(0);
    expect((await db.asUser(b, "select 1 from public.competition_participants where session_id = $1", [sa])).rowCount).toBe(0);

    // B cannot start, cancel or submit on A's session.
    expect(await errorOf(start(b, sa))).toBe("session_not_found");
    expect(await errorOf(cancel(b, sa))).toBe("session_not_found");
    expect(await errorOf(submit(b, sa, 99))).toBe("session_not_found");
    expect(await snapshot(sa)).toEqual(aBefore);

    // A's own operations still work afterwards.
    expect(await submit(a, sa, 5)).toBe("UNVERIFIED");
    expect((await db.asUser(b, "select 1 from public.competition_results where session_id = $1", [sa])).rowCount).toBe(0);
  });

  it("unauthenticated: anon has no access; a request without a user id is refused", async () => {
    const a = await userWithCoins("Owner");
    const s = await create(a);
    const before = await snapshot(s);
    expect(await errorOf(db.as("anon", null, (q) => q("select * from public.competition_sessions")))).toMatch(/permission denied/);
    for (const fn of ["competition_create_session", "competition_start_session", "competition_cancel_session"]) {
      const arg = fn === "competition_create_session" ? TEST_CONFIG : s;
      expect(await errorOf(db.as("anon", null, (q) => q(`select public.${fn}($1)`, [arg]))), fn).toMatch(/permission denied/);
      expect(await errorOf(db.as("authenticated", null, (q) => q(`select public.${fn}($1)`, [arg]))), fn).toBe("not_authenticated");
    }
    expect(await errorOf(db.as("authenticated", null, (q) => q("select public.competition_submit_result($1, p_score => 1)", [s])))).toBe("not_authenticated");
    expect(await snapshot(s)).toEqual(before);
  });
});

describe("G. wallet integrity", () => {
  it("no competition operation in this file changed any wallet balance or added a ledger entry", async () => {
    // Every user above was given 500 PlayCoins right after creation and none should have moved.
    const now = await walletState();
    expect(now.wallets.length).toBeGreaterThan(0);
    expect(now.wallets.every((w) => w.balance === "500")).toBe(true);
    expect(now.ledger).toEqual([]);
  });

  it("one more full pass (create, start, submit, complete, cancel, expire, rejections) leaves wallets byte-identical", async () => {
    const u = await userWithCoins("Ledger");
    const walletsBefore = await walletState();
    const s1 = await create(u);
    await start(u, s1);
    await submit(u, s1, 100);
    await errorOf(submit(u, s1, 101));
    const s2 = await create(u);
    await cancel(u, s2);
    await errorOf(cancel(u, s2));
    const s3 = await create(u);
    await start(u, s3);
    await cancel(u, s3);
    const s4 = await create(u);
    await start(u, s4);
    await setDeadline(s4, "now() - interval '1 second'");
    await submit(u, s4, 1);
    expect(await walletState()).toEqual(walletsBefore);
  });
});
