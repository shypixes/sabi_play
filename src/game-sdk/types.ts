/**
 * Platform game formats and their platform-owned rules. Games cannot override these.
 */
export const GAME_TYPES = ["SCORE_ATTACK", "ONE_V_ONE"] as const;
export type GameType = (typeof GAME_TYPES)[number];

/** Platform-owned rules per format. Games cannot override these. */
export const GAME_TYPE_RULES = {
  SCORE_ATTACK: { minPlayers: 1, maxPlayers: 1, fixedDurationSeconds: 180, winner: "HIGHEST_VALID_SCORE" },
  ONE_V_ONE: { minPlayers: 2, maxPlayers: 2, fixedDurationSeconds: null, winner: "DETERMINED_BY_GAME" },
} as const satisfies Record<GameType, unknown>;
