import { gameManifestSchema, type GameManifest, type GameType } from "@/game-sdk";
import { manifest as testGame } from "./test-game/manifest";

/**
 * Platform game catalogue. Each integrated game contributes its `manifest.ts`
 * (see src/games/README.md) and is listed here. NO real games are integrated yet.
 *
 * `test-game` is a TEMPORARY, non-playable entry used to test competition sessions
 * end to end (see src/games/test-game/manifest.ts). Remove it before launch.
 *
 * Manifests are validated against the Game SDK schema at load time.
 */
const MANIFESTS: readonly unknown[] = [testGame];

export const GAMES: readonly GameManifest[] = MANIFESTS.map((m) => gameManifestSchema.parse(m));

/** Games players can see and (once the SDK runtime exists) launch. */
export function listAvailableGames(): readonly GameManifest[] {
  return GAMES.filter((g) => g.status === "ACTIVE");
}

/** True when the game is ACTIVE and declares support for the format. Gates competition sessions. */
export function isGameFormatAvailable(gameId: string, format: GameType): boolean {
  return listAvailableGames().some((g) => g.id === gameId && g.formats.includes(format));
}
