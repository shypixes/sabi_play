/**
 * Platform game types and match states. Definitions only; no gameplay logic in V1.
 */
export const GAME_TYPES = ["SCORE_ATTACK", "ONE_V_ONE"] as const;
export type GameType = (typeof GAME_TYPES)[number];

export const MATCH_STATES = [
  "CREATED", "WAITING", "READY", "IN_PROGRESS",
  "COMPLETED", "CANCELLED", "ABANDONED", "DISPUTED",
] as const;
export type MatchState = (typeof MATCH_STATES)[number];

/** Platform-owned rules per type. Games cannot override these. */
export const GAME_TYPE_RULES = {
  SCORE_ATTACK: { minPlayers: 1, maxPlayers: 1, fixedDurationSeconds: 180, winner: "HIGHEST_VALID_SCORE" },
  ONE_V_ONE: { minPlayers: 2, maxPlayers: 2, fixedDurationSeconds: null, winner: "DETERMINED_BY_GAME" },
} as const satisfies Record<GameType, unknown>;
