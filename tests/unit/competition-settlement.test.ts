import { describe, expect, it } from "vitest";
import { competitionConfigRowSchema, type CompetitionConfigRow } from "@/lib/competitions/config";
import { planSettlement, settlementReference, type SettlementInput } from "@/lib/competitions/settlement";

// UNIT: settlement PLANNING (pure). Nothing executes payouts in v1.2.0.

const SESSION = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function config(o: Partial<CompetitionConfigRow>): CompetitionConfigRow {
  return competitionConfigRowSchema.parse({
    id: "22222222-2222-4222-8222-222222222222", game_id: "demo", format: "ONE_V_ONE", mode: "PAID", label: "T",
    entry_fee: 100, reward_model: "PRIZE_POOL", fixed_reward: null, target_score: null, platform_fee_bps: 1000,
    pool_size: null, payout_bps: null, time_limit_seconds: 300, enabled: true, ...o,
  });
}

function input(o: Partial<SettlementInput> = {}): SettlementInput {
  return {
    sessionId: SESSION, config: config({}), status: "COMPLETED", validationStatus: "VERIFIED", settlementStatus: "PENDING",
    participants: [{ userId: A, slot: 1 }, { userId: B, slot: 2 }],
    result: { score: null, winnerUserId: A, isDraw: false }, ...o,
  };
}

describe("settlement planning", () => {
  it("1v1 prize pool: winner gets the pool minus the platform fee (integer, rounded down)", () => {
    expect(planSettlement(input())).toEqual({
      kind: "PAYOUTS",
      entries: [{ userId: A, type: "MATCH_WIN", amount: 180, reference: settlementReference(SESSION, "MATCH_WIN", A) }],
    });
    const odd = planSettlement(input({ config: config({ entry_fee: 7, platform_fee_bps: 1000 }) }));
    expect(odd.kind === "PAYOUTS" && odd.entries[0]?.amount).toBe(13); // pool 14, fee floor(1.4)=1
  });

  it("1v1 fixed reward pays the configured amount to the winner", () => {
    const plan = planSettlement(input({ config: config({ reward_model: "FIXED", fixed_reward: 150, platform_fee_bps: null }), result: { score: null, winnerUserId: B, isDraw: false } }));
    expect(plan).toMatchObject({ kind: "PAYOUTS", entries: [{ userId: B, amount: 150, type: "MATCH_WIN" }] });
  });

  it("1v1 draw and cancelled sessions refund every participant", () => {
    for (const plan of [
      planSettlement(input({ result: { score: null, winnerUserId: null, isDraw: true } })),
      planSettlement(input({ status: "CANCELLED", validationStatus: "NOT_SUBMITTED", result: null })),
    ]) {
      expect(plan.kind).toBe("PAYOUTS");
      if (plan.kind === "PAYOUTS") {
        expect(plan.entries.map((e) => [e.userId, e.type, e.amount])).toEqual([[A, "REFUND", 100], [B, "REFUND", 100]]);
      }
    }
  });

  it("SCORE_ATTACK fixed reward pays only when the target score is reached", () => {
    const sa = config({ format: "SCORE_ATTACK", reward_model: "FIXED", fixed_reward: 300, target_score: 5000, platform_fee_bps: null, time_limit_seconds: 180 });
    const base = { config: sa, participants: [{ userId: A, slot: 1 as const }] };
    expect(planSettlement(input({ ...base, result: { score: 5000, winnerUserId: null, isDraw: false } })))
      .toMatchObject({ kind: "PAYOUTS", entries: [{ userId: A, amount: 300 }] });
    expect(planSettlement(input({ ...base, result: { score: 4999, winnerUserId: null, isDraw: false } })).kind).toBe("NO_PAYOUT");
  });

  it("SCORE_ATTACK prize pools are explicitly not supported yet", () => {
    const pool = config({ format: "SCORE_ATTACK", platform_fee_bps: 500, pool_size: 10, payout_bps: [10_000], time_limit_seconds: 180 });
    expect(planSettlement(input({ config: pool, participants: [{ userId: A, slot: 1 }], result: { score: 1, winnerUserId: null, isDraw: false } })).kind).toBe("NOT_SUPPORTED");
  });

  it("repeated settlement is refused and references are deterministic (ledger idempotency keys)", () => {
    expect(planSettlement(input({ settlementStatus: "COMPLETED" }))).toEqual({ kind: "ALREADY_SETTLED" });
    expect(settlementReference(SESSION, "MATCH_WIN", A)).toBe(settlementReference(SESSION, "MATCH_WIN", A));
    expect(settlementReference(SESSION, "REFUND", A)).not.toBe(settlementReference(SESSION, "MATCH_WIN", A));
  });

  it("never pays practice, unvalidated, rejected or abandoned sessions automatically", () => {
    expect(planSettlement(input({ settlementStatus: "NOT_REQUIRED" })).kind).toBe("NOT_REQUIRED");
    expect(planSettlement(input({ validationStatus: "REJECTED" })).kind).toBe("MANUAL_REVIEW");
    expect(planSettlement(input({ status: "ABANDONED", validationStatus: "NOT_SUBMITTED", result: null })).kind).toBe("MANUAL_REVIEW");
    expect(() => planSettlement(input({ status: "SUBMITTED", validationStatus: "PENDING" }))).toThrow();
    expect(() => planSettlement(input({ validationStatus: "UNVERIFIED" }))).toThrow();
    expect(() => planSettlement(input({ result: { score: null, winnerUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", isDraw: false } }))).toThrow();
  });
});
