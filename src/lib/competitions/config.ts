import { z } from "zod";
import {
  COMPETITION_MAX_VALUE,
  COMPETITION_MODES,
  GAME_TYPES,
  GAME_TYPE_RULES,
  REWARD_MODELS,
  type CompetitionOption,
  type RewardTerms,
} from "@/game-sdk";

/**
 * Competition configuration rules. These MIRROR the CHECK constraints on
 * public.competition_configs (migration 0004): the database is authoritative, this is
 * defence in depth so malformed rows are rejected before reaching players.
 */

export const ONE_V_ONE_TIME_LIMIT = { min: 30, max: 3600 } as const;
export const MAX_PLATFORM_FEE_BPS = 9999;
export const POOL_SIZE = { min: 2, max: 1000 } as const;
const BPS_TOTAL = 10_000;

const amount = z.number().int().min(1).max(COMPETITION_MAX_VALUE);

/** Row shape as returned by PostgREST (snake_case, bigint as JSON number). */
export const competitionConfigRowSchema = z
  .object({
    id: z.string().uuid(),
    game_id: z.string().regex(/^[a-z0-9-]+$/).max(60),
    format: z.enum(GAME_TYPES),
    mode: z.enum(COMPETITION_MODES),
    label: z.string().trim().min(1).max(40),
    entry_fee: z.number().int().min(0).max(COMPETITION_MAX_VALUE),
    reward_model: z.enum(REWARD_MODELS).nullable(),
    fixed_reward: amount.nullable(),
    target_score: amount.nullable(),
    platform_fee_bps: z.number().int().min(0).max(MAX_PLATFORM_FEE_BPS).nullable(),
    pool_size: z.number().int().min(POOL_SIZE.min).max(POOL_SIZE.max).nullable(),
    payout_bps: z.array(z.number().int()).nullable(),
    time_limit_seconds: z.number().int(),
    enabled: z.boolean(),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const rewardParams = [c.fixed_reward, c.target_score, c.platform_fee_bps, c.pool_size, c.payout_bps];

    if (c.format === "SCORE_ATTACK" && c.time_limit_seconds !== GAME_TYPE_RULES.SCORE_ATTACK.fixedDurationSeconds) {
      issue("SCORE_ATTACK time limit must equal the platform duration");
    }
    if (c.format === "ONE_V_ONE"
      && (c.time_limit_seconds < ONE_V_ONE_TIME_LIMIT.min || c.time_limit_seconds > ONE_V_ONE_TIME_LIMIT.max)) {
      issue("ONE_V_ONE time limit out of range");
    }

    if (c.mode === "PRACTICE") {
      if (c.entry_fee !== 0) issue("practice must have a zero entry fee");
      if (c.reward_model !== null || rewardParams.some((p) => p !== null)) {
        issue("practice must not have a competitive reward");
      }
      return;
    }

    // PAID
    if (c.entry_fee <= 0) issue("paid configuration needs a positive entry fee");
    if (c.reward_model === null) {
      issue("paid configuration needs a reward model");
      return;
    }

    if (c.reward_model === "FIXED") {
      if (c.fixed_reward === null) issue("fixed reward amount is required");
      if (c.platform_fee_bps !== null || c.pool_size !== null || c.payout_bps !== null) {
        issue("fixed reward must not have prize-pool parameters");
      }
      if (c.format === "SCORE_ATTACK" && c.target_score === null) issue("SCORE_ATTACK fixed reward needs a target score");
      if (c.format === "ONE_V_ONE" && c.target_score !== null) issue("ONE_V_ONE fixed reward must not have a target score");
      return;
    }

    // PRIZE_POOL
    if (c.fixed_reward !== null || c.target_score !== null) issue("prize pool must not have fixed-reward parameters");
    if (c.platform_fee_bps === null) issue("prize pool needs a platform fee (basis points)");
    if (c.format === "ONE_V_ONE") {
      if (c.pool_size !== null || c.payout_bps !== null) issue("ONE_V_ONE prize pool is winner-takes-all");
      return;
    }
    if (c.pool_size === null) issue("SCORE_ATTACK prize pool needs a pool size");
    if (!isValidPayoutSplit(c.payout_bps)) issue("payout split must be positive basis points totalling 10000");
    else if (c.pool_size !== null && c.payout_bps.length > c.pool_size) issue("more paid ranks than pool entrants");
  });

export type CompetitionConfigRow = z.infer<typeof competitionConfigRowSchema>;

export function isValidPayoutSplit(bps: number[] | null): bps is number[] {
  return bps !== null
    && bps.length >= 1 && bps.length <= 100
    && bps.every((b) => Number.isInteger(b) && b > 0)
    && bps.reduce((a, b) => a + b, 0) === BPS_TOTAL;
}

export function rewardTerms(row: CompetitionConfigRow): RewardTerms | null {
  if (row.reward_model === "FIXED" && row.fixed_reward !== null) {
    return { model: "FIXED", reward: row.fixed_reward, targetScore: row.target_score };
  }
  if (row.reward_model === "PRIZE_POOL" && row.platform_fee_bps !== null) {
    return { model: "PRIZE_POOL", platformFeeBps: row.platform_fee_bps, poolSize: row.pool_size, payoutBps: row.payout_bps };
  }
  return null;
}

export function toCompetitionOption(row: CompetitionConfigRow): CompetitionOption {
  return {
    configId: row.id,
    gameId: row.game_id,
    format: row.format,
    mode: row.mode,
    label: row.label,
    entryFee: row.entry_fee,
    reward: rewardTerms(row),
    timeLimitSeconds: row.time_limit_seconds,
  };
}
