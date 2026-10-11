import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, errorOf, type TestDb } from "./harness";

// REAL DB rehearsal of the hosted-project test: the same config row as on Supabase
// (id e3955f36-…, test-game, SCORE_ATTACK, PRACTICE, 180s, created DISABLED), driven through the
// same SQL functions the API calls. Plain PostgreSQL + shim, not hosted Supabase.

const LIVE_CONFIG = "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac";
let db: TestDb;
let player: string;

const create = (uid: string) =>
  db.asUser<{ id: string }>(uid, "select public.competition_create_session($1) as id", [LIVE_CONFIG]).then((r) => r.rows[0]!.id);

beforeAll(async () => {
  db = await createTestDb();
  await db.admin(
    `insert into public.competition_configs (id, game_id, format, mode, label, entry_fee, time_limit_seconds)
     values ($1, 'test-game', 'SCORE_ATTACK', 'PRACTICE', 'Test practice', 0, 180)`,
    [LIVE_CONFIG],
  );
  player = await db.createUser("Tester");
});
afterAll(async () => { await db?.drop(); });

describe("test-game practice session rehearsal", () => {
  it("the config is disabled by default and session creation is refused", async () => {
    const { rows } = await db.admin("select enabled from public.competition_configs where id = $1", [LIVE_CONFIG]);
    expect(rows[0]?.enabled).toBe(false);
    expect(await errorOf(create(player))).toBe("config_disabled");
    expect((await db.admin("select 1 from public.competition_sessions")).rowCount).toBe(0);
  });

  it("enabling is the only change needed; prices and terms stay locked", async () => {
    await db.as("service_role", null, (q) => q("update public.competition_configs set enabled = true where id = $1", [LIVE_CONFIG]));
    expect(await errorOf(db.as("service_role", null, (q) => q("update public.competition_configs set entry_fee = 5 where id = $1", [LIVE_CONFIG]))))
      .toMatch(/config_terms_immutable|violates check constraint/);
    expect(await errorOf(db.as("service_role", null, (q) => q("update public.competition_configs set mode = 'PAID' where id = $1", [LIVE_CONFIG]))))
      .toMatch(/config_terms_immutable|violates check constraint/);
  });

  it("an enabled practice config creates a READY session, then runs to an UNVERIFIED result, with no PlayCoins moved", async () => {
    const walletBefore = (await db.admin("select balance::text, updated_at from public.wallets where user_id = $1", [player])).rows;
    const ledgerBefore = (await db.admin("select count(*)::int as c from public.wallet_transactions")).rows;

    const s = await create(player);
    const view = await db.asUser(player, "select game_id, format, mode, status, validation_status, settlement_status from public.competition_sessions where id = $1", [s]);
    expect(view.rows[0]).toEqual({
      game_id: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE",
      status: "READY", validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED",
    });

    await db.asUser(player, "select public.competition_start_session($1)", [s]);
    const r = await db.asUser<{ r: string }>(player, "select public.competition_submit_result($1, p_score => 1234) as r", [s]);
    expect(r.rows[0]?.r).toBe("UNVERIFIED");

    expect((await db.admin("select balance::text, updated_at from public.wallets where user_id = $1", [player])).rows).toEqual(walletBefore);
    expect((await db.admin("select count(*)::int as c from public.wallet_transactions")).rows).toEqual(ledgerBefore);
  });

  it("another player cannot see the tester's session", async () => {
    const other = await db.createUser("Other");
    expect((await db.asUser(other, "select 1 from public.competition_sessions")).rowCount).toBe(0);
  });

  it("disabling the config again stops new sessions", async () => {
    await db.as("service_role", null, (q) => q("update public.competition_configs set enabled = false where id = $1", [LIVE_CONFIG]));
    expect(await errorOf(create(player))).toBe("config_disabled");
  });
});
