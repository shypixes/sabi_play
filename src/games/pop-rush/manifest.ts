import type { GameManifestInput } from "@/game-sdk";

/** Pop Rush: the Game SDK v1 reference game (Score Attack, Canvas 2D, no engine). */
export const manifest = {
  schemaVersion: 1,
  id: "pop-rush",
  name: "Pop Rush",
  version: "1.0.0",
  status: "ACTIVE",
  entry: "game.ts",
  sdk: { min: "1.0.0", maxExclusive: "2.0.0" },
  formats: ["SCORE_ATTACK"],
  inputs: ["touch", "pointer"],
  orientations: ["portrait", "landscape"],
  capabilities: [],
  metadata: {
    description: "Pop bubbles before they vanish. Chain hits for a bigger multiplier, grab gold, dodge bombs.",
    howToPlay: "Tap bubbles before they shrink away. Gold bubbles are worth more. Red bombs cost points and break your combo. Missing breaks your combo too.",
  },
  gameConfig: { maxBubbles: 7, bombsAfterSeconds: 20 },
} satisfies GameManifestInput;
