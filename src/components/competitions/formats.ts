import { GAME_TYPE_RULES, type GameType } from "@/game-sdk";

/**
 * Player-facing copy for the platform's competition formats. Player counts and
 * durations are read from GAME_TYPE_RULES (src/game-sdk/types.ts), the platform's
 * single source of truth, so the UI cannot drift from the rules.
 */
export type CompetitionFormat = {
  type: GameType;
  name: string;
  tagline: string;
  description: string;
  /** CSS modifier used for the format's accent colour. */
  tone: "score" | "duel";
  facts: { label: string; value: string }[];
};

function playersLabel(min: number, max: number): string {
  if (min === max) return min === 1 ? "Solo" : `${min} players`;
  return `${min}–${max} players`;
}

export function durationLabel(seconds: number | null): string {
  if (seconds === null) return "Set by the game";
  return seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
}

const score = GAME_TYPE_RULES.SCORE_ATTACK;
const duel = GAME_TYPE_RULES.ONE_V_ONE;

export const COMPETITION_FORMATS: readonly CompetitionFormat[] = [
  {
    type: "SCORE_ATTACK",
    name: "Score Attack",
    tagline: `Beat the clock. ${durationLabel(score.fixedDurationSeconds)} to post your best score.`,
    description:
      "Play a single timed session and push your score as high as you can. When the timer ends, the highest valid score wins.",
    tone: "score",
    facts: [
      { label: "Players", value: playersLabel(score.minPlayers, score.maxPlayers) },
      { label: "Session", value: durationLabel(score.fixedDurationSeconds) },
      { label: "Winner", value: "Highest valid score" },
    ],
  },
  {
    type: "ONE_V_ONE",
    name: "1v1",
    tagline: "Head to head. Two players, one winner.",
    description:
      "Go up directly against another player in the same game. The game's own rules decide who comes out on top.",
    tone: "duel",
    facts: [
      { label: "Players", value: playersLabel(duel.minPlayers, duel.maxPlayers) },
      { label: "Length", value: durationLabel(duel.fixedDurationSeconds) },
      { label: "Winner", value: "Decided by the game" },
    ],
  },
];

export function gameTypeLabel(type: GameType): string {
  return COMPETITION_FORMATS.find((f) => f.type === type)?.name ?? type;
}
