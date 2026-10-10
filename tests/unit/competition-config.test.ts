import { describe, expect, it } from "vitest";
import {
  competitionConfigRowSchema,
  isValidPayoutSplit,
  toCompetitionOption,
  type CompetitionConfigRow,
} from "@/lib/competitions/config";

// UNIT: pure validation logic. Mirrors the DB CHECK constraints (proven separately in tests/db).

const ID = "7f1c1d1e-8a5b-4c1b-9f0e-2b5d0c7a9e11";

function practice(overrides: Partial<CompetitionConfigRow> = {}): Record<string, unknown> {
  return {
    id: ID, game_id: "demo-game", format: "SCORE_ATTACK", mode: "PRACTICE", label: "Practice",
    entry_fee: 0, reward_model: null, fixed_reward: null, target_score: null, platform_fee_bps: null,
    pool_size: null, payout_bps: null, time_limit_seconds: 180, enabled: true, ...overrides,
  };
}
const paidFixedScore = (o: Partial<CompetitionConfigRow> = {}) =>
  practice({ mode: "PAID", label: "Any tier name", entry_fee: 250, reward_model: "FIXED", fixed_reward: 400, target_score: 5000, ...o });
const paidPool1v1 = (o: Partial<CompetitionConfigRow> = {}) =>
  practice({ format: "ONE_V_ONE", mode: "PAID", label: "Pool duel", entry_fee: 100, reward_model: "PRIZE_POOL", platform_fee_bps: 1000, time_limit_seconds: 300, ...o });
const paidPoolScore = (o: Partial<CompetitionConfigRow> = {}) =>
  practice({ mode: "PAID", label: "Pool score", entry_fee: 50, reward_model: "PRIZE_POOL", platform_fee_bps: 500, pool_size: 10, payout_bps: [6000, 3000, 1000], ...o });

const valid = (row: unknown) => competitionConfigRowSchema.safeParse(row).success;

describe("competition config validation", () => {
  it("accepts practice SCORE_ATTACK and ONE_V_ONE configs", () => {
    expect(valid(practice())).toBe(true);
    expect(valid(practice({ format: "ONE_V_ONE", time_limit_seconds: 600 }))).toBe(true);
  });

  it("rejects practice with an entry fee or any reward", () => {
    expect(valid(practice({ entry_fee: 1 }))).toBe(false);
    expect(valid(practice({ reward_model: "FIXED" }))).toBe(false);
    expect(valid(practice({ fixed_reward: 10 }))).toBe(false);
    expect(valid(practice({ platform_fee_bps: 0 }))).toBe(false);
  });

  it("accepts paid FIXED and PRIZE_POOL configs with arbitrary tier labels and prices", () => {
    expect(valid(paidFixedScore())).toBe(true);
    expect(valid(paidFixedScore({ label: "Whatever ops wants", entry_fee: 1, fixed_reward: 999_999 }))).toBe(true);
    expect(valid(practice({ format: "ONE_V_ONE", mode: "PAID", entry_fee: 100, reward_model: "FIXED", fixed_reward: 180, time_limit_seconds: 300 }))).toBe(true);
    expect(valid(paidPool1v1())).toBe(true);
    expect(valid(paidPoolScore())).toBe(true);
  });

  it("rejects paid configs without a positive fee or a reward model", () => {
    expect(valid(paidFixedScore({ entry_fee: 0 }))).toBe(false);
    expect(valid(paidFixedScore({ entry_fee: -5 }))).toBe(false);
    expect(valid(paidFixedScore({ reward_model: null, fixed_reward: null, target_score: null }))).toBe(false);
  });

  it("rejects non-integer, unsafe or out-of-range amounts", () => {
    expect(valid(paidFixedScore({ entry_fee: 2.5 }))).toBe(false);
    expect(valid(paidFixedScore({ fixed_reward: 0 }))).toBe(false);
    expect(valid(paidFixedScore({ fixed_reward: 1_000_000_000_001 }))).toBe(false);
    expect(valid(paidPool1v1({ platform_fee_bps: 10_000 }))).toBe(false);
  });

  it("enforces FIXED reward rules per format", () => {
    expect(valid(paidFixedScore({ target_score: null }))).toBe(false); // SCORE_ATTACK needs a target
    expect(valid(paidFixedScore({ platform_fee_bps: 100 }))).toBe(false); // no pool params
    expect(valid(practice({ format: "ONE_V_ONE", mode: "PAID", entry_fee: 100, reward_model: "FIXED", fixed_reward: 180, target_score: 10, time_limit_seconds: 300 }))).toBe(false);
  });

  it("enforces PRIZE_POOL rules", () => {
    expect(valid(paidPool1v1({ platform_fee_bps: null }))).toBe(false);
    expect(valid(paidPool1v1({ pool_size: 2 }))).toBe(false); // 1v1 is winner-takes-all
    expect(valid(paidPool1v1({ fixed_reward: 10 }))).toBe(false);
    expect(valid(paidPoolScore({ pool_size: null }))).toBe(false);
    expect(valid(paidPoolScore({ payout_bps: [5000, 4000] }))).toBe(false); // sums to 9000
    expect(valid(paidPoolScore({ payout_bps: [10_000, 0] }))).toBe(false);
    expect(valid(paidPoolScore({ pool_size: 2, payout_bps: [5000, 3000, 2000] }))).toBe(false); // more ranks than entrants
  });

  it("enforces platform-owned time limits", () => {
    expect(valid(practice({ time_limit_seconds: 120 }))).toBe(false); // SCORE_ATTACK is fixed at 180s
    expect(valid(practice({ format: "ONE_V_ONE", time_limit_seconds: 29 }))).toBe(false);
    expect(valid(practice({ format: "ONE_V_ONE", time_limit_seconds: 3601 }))).toBe(false);
  });

  it("rejects unknown formats, modes and malformed identifiers", () => {
    expect(valid(practice({ format: "BATTLE_ROYALE" as never }))).toBe(false);
    expect(valid(practice({ mode: "FREE" as never }))).toBe(false);
    expect(valid(practice({ game_id: "Bad Game!" }))).toBe(false);
    expect(valid(practice({ label: "   " }))).toBe(false);
  });

  it("validates payout splits with integer basis points only", () => {
    expect(isValidPayoutSplit([10_000])).toBe(true);
    expect(isValidPayoutSplit([5000, 5000])).toBe(true);
    expect(isValidPayoutSplit([])).toBe(false);
    expect(isValidPayoutSplit([9999.5, 0.5])).toBe(false);
    expect(isValidPayoutSplit(null)).toBe(false);
  });

  it("maps rows to player-facing options", () => {
    const opt = toCompetitionOption(competitionConfigRowSchema.parse(paidPoolScore()));
    expect(opt).toMatchObject({ configId: ID, mode: "PAID", entryFee: 50, timeLimitSeconds: 180 });
    expect(opt.reward).toEqual({ model: "PRIZE_POOL", platformFeeBps: 500, poolSize: 10, payoutBps: [6000, 3000, 1000] });
    expect(toCompetitionOption(competitionConfigRowSchema.parse(practice())).reward).toBeNull();
  });
});
