import type { GameManifestInput } from "@/game-sdk";

/**
 * Sum Sprint: a deliberately small second game proving the Game SDK is reusable. Different
 * mechanics (mental arithmetic) and a different renderer (plain DOM, no canvas), same public
 * SDK contract, no platform-specific code.
 */
export const manifest = {
  schemaVersion: 1,
  id: "sum-sprint",
  name: "Sum Sprint",
  version: "1.0.0",
  status: "ACTIVE",
  entry: "game.ts",
  sdk: { min: "1.0.0", maxExclusive: "2.0.0" },
  formats: ["SCORE_ATTACK"],
  inputs: ["touch", "pointer", "keyboard"],
  orientations: ["portrait"],
  capabilities: [],
  metadata: {
    description: "Answer quick sums against the clock. Streaks multiply your points.",
    howToPlay: "Tap the right answer (or press 1-4). Correct answers in a row raise your multiplier; a wrong answer costs 5 points and resets it.",
  },
  gameConfig: { choices: 4 },
} satisfies GameManifestInput;
