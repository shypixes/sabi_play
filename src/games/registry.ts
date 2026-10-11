import { isLaunchable, registerGames, type GameManifest, type GameType } from "@/game-sdk";
import { manifest as popRush } from "./pop-rush/manifest";
import { manifest as sumSprint } from "./sum-sprint/manifest";
import { manifest as testGame } from "./test-game/manifest";

/**
 * Platform game catalogue. Each integrated game contributes its `manifest.ts`
 * (see src/games/README.md) and is listed here.
 *
 * - pop-rush: Game SDK v1 reference game.
 * - sum-sprint: minimal second game proving the SDK contract is reusable.
 * - test-game: TEMPORARY, non-playable entry (entry: null) used by /test-panel. Remove before launch.
 *
 * registerGames() validates every manifest (schema v1), checks SDK compatibility and refuses
 * duplicate ids, throwing at module load: an invalid catalogue fails the build and the tests.
 * Game CODE is never imported here (see loaders.ts, used only inside the sandboxed game frame).
 */
const MANIFESTS: readonly unknown[] = [testGame, popRush, sumSprint];

export const GAMES: readonly GameManifest[] = registerGames(MANIFESTS);

/** Games players can see. */
export function listAvailableGames(): readonly GameManifest[] {
  return GAMES.filter((g) => g.status === "ACTIVE");
}

export function findGame(gameId: string): GameManifest | undefined {
  return GAMES.find((g) => g.id === gameId);
}

/** ACTIVE games with an entry module that support the format (what the player can launch). */
export function findLaunchableGame(gameId: string, format: GameType): GameManifest | undefined {
  const game = findGame(gameId);
  return game && isLaunchable(game) && game.formats.includes(format) ? game : undefined;
}

/** True when the game is ACTIVE and declares support for the format. Gates competition sessions. */
export function isGameFormatAvailable(gameId: string, format: GameType): boolean {
  return listAvailableGames().some((g) => g.id === gameId && g.formats.includes(format));
}
