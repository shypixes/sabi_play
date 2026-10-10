import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_STATUSES } from "@/game-sdk";
import { canTransition } from "@/lib/competitions/lifecycle";
import { createTestDb, errorOf, type TestDb } from "./harness";

// REAL DB (PostgreSQL + Supabase shim + migrations 0001-0004). Not hosted Supabase.

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db?.drop(); });

type Cfg = Record<string, unknown>;
const base: Cfg = { game_id: "demo", format: "SCORE_ATTACK", mode: "PRACTICE", label: "Practice", entry_fee: 0, time_limit_seconds: 180 };
let n = 0;

/** Inserts a config as service_role (the only role allowed to write configs). */
function insertConfig(overrides: Cfg) {
  const row: Cfg = { ...base, label: `cfg-${++n}`, ...overrides };
  const cols = Object.keys(row);
  return db.as("service_role", null, (q) =>
    q<{ id: string }>(
      `insert into public.competition_configs (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(row),
    ),
  );
}
const paidFixedSA: Cfg = { mode: "PAID", entry_fee: 100, reward_model: "FIXED", fixed_reward: 150, target_score: 5000 };
const paidPool1v1: Cfg = { format: "ONE_V_ONE", mode: "PAID", entry_fee: 100, reward_model: "PRIZE_POOL", platform_fee_bps: 1000, time_limit_seconds: 300 };
const paidPoolSA: Cfg = { mode: "PAID", entry_fee: 50, reward_model: "PRIZE_POOL", platform_fee_bps: 500, pool_size: 10, payout_bps: [6000, 3000, 1000] };

describe("competition_configs constraints", () => {
  it("accepts practice, paid fixed and paid prize-pool configs, with multiple arbitrary tiers per game+format", async () => {
    await insertConfig({});
    await insertConfig({ format: "ONE_V_ONE", time_limit_seconds: 600 });
    await insertConfig(paidFixedSA);
    await insertConfig({ ...paidFixedSA, entry_fee: 1000, fixed_reward: 1800 });
    await insertConfig({ ...paidFixedSA, label: "any name ops chooses", entry_fee: 7 });
    await insertConfig(paidPool1v1);
    await insertConfig(paidPoolSA);
    const { rows } = await db.admin("select count(*)::int as c from public.competition_configs where game_id = 'demo' and format = 'SCORE_ATTACK' and mode = 'PAID'");
    expect(rows[0]?.c).toBe(4);
  });

  it("defaults new configs to disabled", async () => {
    const { rows: [cfg] } = await insertConfig({});
    const { rows } = await db.admin("select enabled from public.competition_configs where id = $1", [cfg?.id]);
    expect(rows[0]?.enabled).toBe(false);
  });

  it.each<[string, Cfg]>([
    ["practice with an entry fee", { entry_fee: 10 }],
    ["practice with a reward model", { reward_model: "FIXED", fixed_reward: 10 }],
    ["practice with a pool parameter", { platform_fee_bps: 0 }],
    ["paid with zero fee", { ...paidFixedSA, entry_fee: 0 }],
    ["paid with negative fee", { ...paidFixedSA, entry_fee: -1 }],
    ["paid without reward model", { mode: "PAID", entry_fee: 100 }],
    ["fixed without amount", { ...paidFixedSA, fixed_reward: null }],
    ["fixed SCORE_ATTACK without target", { ...paidFixedSA, target_score: null }],
    ["fixed with pool params", { ...paidFixedSA, platform_fee_bps: 100 }],
    ["fixed ONE_V_ONE with target", { ...paidPool1v1, reward_model: "FIXED", platform_fee_bps: null, fixed_reward: 150, target_score: 10 }],
    ["pool without fee", { ...paidPool1v1, platform_fee_bps: null }],
    ["pool fee of 100%", { ...paidPool1v1, platform_fee_bps: 10000 }],
    ["1v1 pool with ranks", { ...paidPool1v1, pool_size: 2, payout_bps: [10000] }],
    ["SA pool split not totalling 10000", { ...paidPoolSA, payout_bps: [5000, 4000] }],
    ["SA pool split with zero share", { ...paidPoolSA, payout_bps: [10000, 0] }],
    ["SA pool with more ranks than entrants", { ...paidPoolSA, pool_size: 2, payout_bps: [5000, 3000, 2000] }],
    ["SA pool without size", { ...paidPoolSA, pool_size: null }],
    ["SCORE_ATTACK time limit other than 180", { time_limit_seconds: 120 }],
    ["ONE_V_ONE time limit too long", { format: "ONE_V_ONE", time_limit_seconds: 3601 }],
    ["fee above the maximum", { ...paidFixedSA, entry_fee: "1000000000001" }],
    ["unknown format", { format: "BATTLE_ROYALE" }],
    ["unknown mode", { mode: "FREE" }],
    ["blank label", { label: "   " }],
    ["invalid game id", { game_id: "Bad Game" }],
  ])("rejects %s", async (_name, overrides) => {
    expect(await errorOf(insertConfig(overrides))).toMatch(/violates check constraint|invalid input|invalid_/);
  });

  it("rejects non-integer amounts at the type level", async () => {
    expect(await errorOf(insertConfig({ ...paidFixedSA, entry_fee: 1.5 }))).toMatch(/invalid input syntax for type bigint/);
  });

  it("rejects duplicate tier labels for the same game and format", async () => {
    await insertConfig({ label: "Gold" });
    expect(await errorOf(insertConfig({ label: "Gold" }))).toMatch(/competition_configs_label_unique/);
  });

  it("keeps commercial terms immutable; only label and enabled can change", async () => {
    const { rows: [cfg] } = await insertConfig(paidFixedSA);
    await db.as("service_role", null, (q) => q("update public.competition_configs set enabled = true, label = 'Renamed' where id = $1", [cfg?.id]));
    for (const set of ["entry_fee = 1", "fixed_reward = 999", "mode = 'PRACTICE'", "time_limit_seconds = 180, target_score = 1"]) {
      expect(await errorOf(db.as("service_role", null, (q) => q(`update public.competition_configs set ${set} where id = $1`, [cfg?.id]))))
        .toMatch(/config_terms_immutable|violates check constraint/);
    }
  });
});

describe("lifecycle source of truth", () => {
  it("the SQL transition table is identical to src/lib/competitions/lifecycle.ts", async () => {
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        const { rows } = await db.admin<{ ok: boolean }>("select public.competition_status_transition_allowed($1, $2) as ok", [from, to]);
        expect(rows[0]?.ok, `${from} -> ${to}`).toBe(canTransition(from, to));
      }
    }
  });
});

describe("existing behaviour is preserved", () => {
  it("the auth trigger still creates a profile and a zero-balance wallet", async () => {
    const id = await db.createUser("Ada");
    const { rows: p } = await db.admin("select display_name from public.profiles where id = $1", [id]);
    const { rows: w } = await db.admin("select balance::int as balance from public.wallets where user_id = $1", [id]);
    expect(p[0]?.display_name).toBe("Ada");
    expect(w[0]?.balance).toBe(0);
  });

  it("players can still read their own profile and wallet, and update their profile", async () => {
    const id = await db.createUser();
    expect((await db.asUser(id, "select id from public.profiles")).rows).toEqual([{ id }]);
    expect((await db.asUser(id, "select user_id from public.wallets")).rows).toEqual([{ user_id: id }]);
    await db.asUser(id, "update public.profiles set display_name = 'New name' where id = $1", [id]);
  });

  it("users without competition history can still be deleted (cascade unchanged)", async () => {
    const id = await db.createUser();
    await db.admin("delete from auth.users where id = $1", [id]);
    expect((await db.admin("select 1 from public.profiles where id = $1", [id])).rowCount).toBe(0);
  });

  it("migration 0004 only added competition tables", async () => {
    const { rows } = await db.admin<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by 1");
    expect(rows.map((r) => r.tablename)).toEqual([
      "competition_configs", "competition_participants", "competition_results", "competition_sessions",
      "profiles", "wallet_transactions", "wallets",
    ]);
  });
});
