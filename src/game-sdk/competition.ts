import { z } from "zod";
import type { GameType } from "./types";

/**
 * Game <-> platform competition contract. Games may import this module; it contains NO
 * wallet, payment or database access. A game reports a result; the platform validates it
 * and (in a future version) settles PlayCoins. Games never decide that rewards are paid.
 *
 * Status values mirror database/migrations/0004_competitions.sql.
 */

export const COMPETITION_MODES = ["PRACTICE", "PAID"] as const;
export type CompetitionMode = (typeof COMPETITION_MODES)[number];

export const REWARD_MODELS = ["FIXED", "PRIZE_POOL"] as const;
export type RewardModel = (typeof REWARD_MODELS)[number];

/** Session lifecycle. WAITING is used only by ONE_V_ONE (waiting for the second player). */
export const SESSION_STATUSES = [
  "WAITING", "READY", "IN_PROGRESS", "SUBMITTED", "COMPLETED", "CANCELLED", "ABANDONED",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Result validation:
 *  NOT_SUBMITTED - no result yet
 *  PENDING       - paid result awaiting a trusted validator
 *  UNVERIFIED    - practice result stored as reported by the client; never trusted
 *  VERIFIED / REJECTED - decided by a trusted validator (never by a client)
 */
export const VALIDATION_STATUSES = ["NOT_SUBMITTED", "PENDING", "UNVERIFIED", "VERIFIED", "REJECTED"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const SETTLEMENT_STATUSES = ["NOT_REQUIRED", "PENDING", "COMPLETED"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** Upper bound for scores and PlayCoin amounts in competitions (matches DB CHECKs). */
export const COMPETITION_MAX_VALUE = 1_000_000_000_000;

export type ParticipantSlot = 1 | 2;

/**
 * What a game submits when a session ends. Validated identically by the API (zod) and the
 * database function. ONE_V_ONE: winnerSlot null means a draw.
 */
export const resultSubmissionSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("SCORE_ATTACK"),
    score: z.number().int().min(0).max(COMPETITION_MAX_VALUE),
  }).strict(),
  z.object({
    format: z.literal("ONE_V_ONE"),
    winnerSlot: z.union([z.literal(1), z.literal(2), z.null()]),
  }).strict(),
]);
export type ResultSubmission = z.infer<typeof resultSubmissionSchema>;

export type RewardTerms =
  | { model: "FIXED"; reward: number; targetScore: number | null }
  | { model: "PRIZE_POOL"; platformFeeBps: number; poolSize: number | null; payoutBps: number[] | null };

/** An enabled competition configuration as presented to games and players. */
export type CompetitionOption = {
  configId: string;
  gameId: string;
  format: GameType;
  mode: CompetitionMode;
  label: string;
  /** Integer PlayCoins; 0 for practice. */
  entryFee: number;
  /** null for practice (no competitive reward). */
  reward: RewardTerms | null;
  timeLimitSeconds: number;
};

export type SessionResultView =
  | { format: "SCORE_ATTACK"; score: number }
  | { format: "ONE_V_ONE"; winnerSlot: ParticipantSlot | null };

/** A session as seen by one of its participants. Contains no other players' identifiers. */
export type SessionView = {
  sessionId: string;
  configId: string;
  gameId: string;
  format: GameType;
  mode: CompetitionMode;
  status: SessionStatus;
  validationStatus: ValidationStatus;
  settlementStatus: SettlementStatus;
  yourSlot: ParticipantSlot;
  participantCount: number;
  requiredParticipants: number;
  createdAt: string;
  startedAt: string | null;
  deadlineAt: string | null;
  completedAt: string | null;
  result: SessionResultView | null;
};

/**
 * Operations the platform provides to a running game. The HTTP implementation lives under
 * /api/competitions; a browser runtime wrapper will be added with the first game.
 * Deliberately absent: anything that reads or changes balances, or settles rewards.
 */
export interface GamePlatformApi {
  listCompetitionOptions(filter?: { format?: GameType }): Promise<CompetitionOption[]>;
  createSession(configId: string): Promise<SessionView>;
  getSession(sessionId: string): Promise<SessionView>;
  startSession(sessionId: string): Promise<SessionView>;
  submitResult(sessionId: string, result: ResultSubmission): Promise<SessionView>;
  cancelSession(sessionId: string): Promise<SessionView>;
}
