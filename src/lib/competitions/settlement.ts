import type { ParticipantSlot, SessionStatus, SettlementStatus, ValidationStatus } from "@/game-sdk";
import { playCoins, type PlayCoins } from "@/lib/money";
import type { CompetitionConfigRow } from "@/lib/competitions/config";
import { isTerminal } from "@/lib/competitions/lifecycle";

/**
 * Settlement PLANNING only. Nothing here moves PlayCoins: paid settlement is disabled until
 * atomic wallet functions exist (see BUILD_LOG v1.2.0). This module defines what a settlement
 * WOULD pay so reward rules are fully determined and testable today.
 *
 * Each planned entry carries a deterministic `reference`. wallet_transactions.reference is
 * UNIQUE, so once a future wallet function inserts these rows, paying the same session twice
 * is impossible at the database level.
 */

export type SettlementEntry = {
  userId: string;
  type: "MATCH_WIN" | "REFUND";
  amount: PlayCoins;
  reference: string;
};

export type SettlementPlan =
  | { kind: "NOT_REQUIRED" }
  | { kind: "ALREADY_SETTLED" }
  | { kind: "PAYOUTS"; entries: SettlementEntry[] }
  | { kind: "NO_PAYOUT"; reason: string }
  | { kind: "MANUAL_REVIEW"; reason: string }
  | { kind: "NOT_SUPPORTED"; reason: string };

export type SettlementInput = {
  sessionId: string;
  config: CompetitionConfigRow;
  status: SessionStatus;
  validationStatus: ValidationStatus;
  settlementStatus: SettlementStatus;
  participants: { userId: string; slot: ParticipantSlot }[];
  result: { score: number | null; winnerUserId: string | null; isDraw: boolean } | null;
};

export function settlementReference(sessionId: string, type: SettlementEntry["type"], userId: string): string {
  return `competition:${sessionId}:${type.toLowerCase()}:${userId}`;
}

function entry(sessionId: string, userId: string, type: SettlementEntry["type"], amount: bigint): SettlementEntry {
  return { userId, type, amount: playCoins(Number(amount)), reference: settlementReference(sessionId, type, userId) };
}

function refundAll(input: SettlementInput): SettlementPlan {
  return {
    kind: "PAYOUTS",
    entries: input.participants.map((p) => entry(input.sessionId, p.userId, "REFUND", BigInt(input.config.entry_fee))),
  };
}

export function planSettlement(input: SettlementInput): SettlementPlan {
  const { config, status, validationStatus, result } = input;

  if (config.mode === "PRACTICE" || input.settlementStatus === "NOT_REQUIRED") return { kind: "NOT_REQUIRED" };
  if (input.settlementStatus === "COMPLETED") return { kind: "ALREADY_SETTLED" };
  if (!isTerminal(status)) throw new Error(`cannot settle a session in status ${status}`);

  // Never started: everyone gets their entry fee back.
  if (status === "CANCELLED") return refundAll(input);
  // Policy for quitting mid-game (forfeit vs refund) is a product decision not yet made.
  if (status === "ABANDONED") return { kind: "MANUAL_REVIEW", reason: "abandoned session" };
  if (validationStatus === "REJECTED") return { kind: "MANUAL_REVIEW", reason: "result rejected by validation" };
  if (validationStatus !== "VERIFIED") throw new Error(`cannot settle with validation status ${validationStatus}`);
  if (!result) throw new Error("verified session has no result");

  if (config.format === "SCORE_ATTACK") {
    if (config.reward_model === "PRIZE_POOL") {
      return { kind: "NOT_SUPPORTED", reason: "SCORE_ATTACK prize pools need sessions grouped into pools" };
    }
    const [player] = input.participants;
    if (!player || result.score === null || config.fixed_reward === null || config.target_score === null) {
      throw new Error("incomplete SCORE_ATTACK settlement input");
    }
    return result.score >= config.target_score
      ? { kind: "PAYOUTS", entries: [entry(input.sessionId, player.userId, "MATCH_WIN", BigInt(config.fixed_reward))] }
      : { kind: "NO_PAYOUT", reason: "target score not reached" };
  }

  // ONE_V_ONE
  if (result.isDraw) return refundAll(input);
  const winner = input.participants.find((p) => p.userId === result.winnerUserId);
  if (!winner) throw new Error("winner is not a participant");

  if (config.reward_model === "FIXED") {
    if (config.fixed_reward === null) throw new Error("fixed reward missing");
    return { kind: "PAYOUTS", entries: [entry(input.sessionId, winner.userId, "MATCH_WIN", BigInt(config.fixed_reward))] };
  }
  if (config.platform_fee_bps === null) throw new Error("platform fee missing");
  // Integer math only: pool = 2 x entry fee; platform fee rounds DOWN; winner takes the rest.
  const pool = BigInt(config.entry_fee) * 2n;
  const fee = (pool * BigInt(config.platform_fee_bps)) / 10_000n;
  return { kind: "PAYOUTS", entries: [entry(input.sessionId, winner.userId, "MATCH_WIN", pool - fee)] };
}
