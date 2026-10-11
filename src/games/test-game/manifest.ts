import type { GameManifestInput } from "@/game-sdk";

/**
 * TEMPORARY TEST GAME. Not a real or playable game: there is no gameplay code (entry: null,
 * so the platform never launches it).
 *
 * It exists only so the competition system (configs -> practice sessions -> results)
 * can be tested end to end against a real Supabase project, e.g. from /test-panel.
 * The name says so on every screen that lists games.
 *
 * To remove before launch: delete this folder, remove it from src/games/registry.ts,
 * and disable its rows in public.competition_configs (game_id = 'test-game').
 */
export const manifest = {
  schemaVersion: 1,
  id: "test-game",
  name: "Test Game (temporary, not playable)",
  version: "0.0.1",
  status: "ACTIVE",
  entry: null,
  sdk: { min: "1.0.0", maxExclusive: "2.0.0" },
  formats: ["SCORE_ATTACK"],
  inputs: ["touch", "pointer"],
  orientations: ["portrait", "landscape"],
  capabilities: [],
  metadata: {
    description: "Temporary entry for testing competition sessions. Not playable.",
    howToPlay: "Not playable. Used from the Competition Test Panel only.",
  },
  gameConfig: {},
} satisfies GameManifestInput;
