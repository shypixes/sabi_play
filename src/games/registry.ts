import { gameManifestSchema, type GameManifest, type GameType } from "@/game-sdk";

/**
 * Platform game catalogue. Each integrated game will contribute its `manifest.ts`
 * (see src/games/README.md) and be listed here. NO games are integrated yet, so
 * this list is intentionally empty and the Games UI shows its empty state.
 *
 * Manifests are validated against the Game SDK schema at load time.
 */
const MANIFESTS: readonly unknown[] = [];

export const GAMES: readonly GameManifest[] = MANIFESTS.map((m) => gameManifestSchema.parse(m));

/** Games players can see and (once the SDK runtime exists) launch. */
export function listAvailableGames(): readonly GameManifest[] {
  return GAMES.filter((g) => g.status === "ACTIVE");
}

/** True when the game is ACTIVE and declares support for the format. Gates competition sessions. */
export function isGameFormatAvailable(gameId: string, format: GameType): boolean {
  return listAvailableGames().some((g) => g.id === gameId && g.formats.includes(format));
}
