import type { GameModule } from "@/game-sdk";

/**
 * Game code loaders, keyed by game id. Imported ONLY by the sandboxed game frame
 * (src/app/game-frame), never by platform pages, so game code never runs in the signed-in
 * platform document. Each loader must point at the manifest's `entry` file (checked by tests).
 */
export const GAME_LOADERS: Readonly<Record<string, () => Promise<{ default: GameModule }>>> = {
  "pop-rush": () => import("./pop-rush/game"),
  "sum-sprint": () => import("./sum-sprint/game"),
};
