import { describe, expect, it } from "vitest";
import { SDK_VERSION, checkSdkCompatibility, isLaunchable, validateManifest } from "@/game-sdk";
import { GAME_LOADERS } from "@/games/loaders";
import { GAMES, findLaunchableGame, isGameFormatAvailable, listAvailableGames } from "@/games/registry";
import { manifest as testGame } from "@/games/test-game/manifest";

// UNIT: the real game registry (no mocks).

describe("game registry", () => {
  it("registers the test game, the reference game and the second integration", () => {
    expect(GAMES.map((g) => g.id)).toEqual(["test-game", "pop-rush", "sum-sprint"]);
    expect(listAvailableGames().map((g) => g.id)).toEqual(["test-game", "pop-rush", "sum-sprint"]);
  });

  it("every manifest is valid v1 and compatible with this SDK", () => {
    for (const g of GAMES) {
      expect(validateManifest(g).ok, g.id).toBe(true);
      expect(checkSdkCompatibility(g, SDK_VERSION), g.id).toBeNull();
    }
  });

  it("test-game stays registered, temporary and NOT launchable", () => {
    const parsed = validateManifest(testGame);
    expect(parsed.ok).toBe(true);
    expect(testGame.name).toMatch(/test/i);
    expect(testGame.name).toMatch(/temporary/i);
    expect(testGame.name).toMatch(/not playable/i);
    expect(testGame.entry).toBeNull();
    expect(testGame.formats).toEqual(["SCORE_ATTACK"]);
    expect(isLaunchable(GAMES[0]!)).toBe(false);
    expect(findLaunchableGame("test-game", "SCORE_ATTACK")).toBeUndefined();
  });

  it("launchable games have a loader for exactly their entry module, and nothing else does", () => {
    const launchable = GAMES.filter(isLaunchable).map((g) => g.id).sort();
    expect(Object.keys(GAME_LOADERS).sort()).toEqual(launchable);
    expect(findLaunchableGame("pop-rush", "SCORE_ATTACK")?.version).toBe("1.0.0");
    expect(findLaunchableGame("pop-rush", "ONE_V_ONE")).toBeUndefined();
    expect(findLaunchableGame("nope", "SCORE_ATTACK")).toBeUndefined();
  });

  it("gates competitions by game AND format", () => {
    expect(isGameFormatAvailable("test-game", "SCORE_ATTACK")).toBe(true);
    expect(isGameFormatAvailable("pop-rush", "SCORE_ATTACK")).toBe(true);
    expect(isGameFormatAvailable("sum-sprint", "SCORE_ATTACK")).toBe(true);
    expect(isGameFormatAvailable("test-game", "ONE_V_ONE")).toBe(false);
    expect(isGameFormatAvailable("pop-rush", "ONE_V_ONE")).toBe(false);
    expect(isGameFormatAvailable("demo", "SCORE_ATTACK")).toBe(false);
    expect(isGameFormatAvailable("Test-Game", "SCORE_ATTACK")).toBe(false); // exact id match only
    expect(isGameFormatAvailable("", "SCORE_ATTACK")).toBe(false);
  });

  it("game ids are unique", () => {
    expect(new Set(GAMES.map((g) => g.id)).size).toBe(GAMES.length);
  });
});
