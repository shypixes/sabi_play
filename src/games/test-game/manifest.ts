import type { GameManifest } from "@/game-sdk";

/**
 * TEMPORARY TEST GAME. Not a real or playable game: there is no gameplay code.
 *
 * It exists only so the competition system (configs -> practice sessions -> results)
 * can be tested end to end against a real Supabase project. The name says so on every
 * screen that lists games.
 *
 * To remove before launch: delete this folder, remove it from src/games/registry.ts,
 * and disable its rows in public.competition_configs (game_id = 'test-game').
 */
export const manifest = {
  id: "test-game",
  name: "Test Game (temporary, not playable)",
  version: "0.0.1",
  formats: ["SCORE_ATTACK"],
  status: "ACTIVE",
} satisfies GameManifest;
