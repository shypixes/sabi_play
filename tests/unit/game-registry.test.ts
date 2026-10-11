import { describe, expect, it } from "vitest";
import { gameManifestSchema } from "@/game-sdk";
import { GAMES, isGameFormatAvailable, listAvailableGames } from "@/games/registry";
import { manifest as testGame } from "@/games/test-game/manifest";

// UNIT: the real game registry (no mocks).

describe("game registry", () => {
  it("registers exactly one game: the temporary test-game", () => {
    expect(GAMES.map((g) => g.id)).toEqual(["test-game"]);
  });

  it("test-game is ACTIVE, SCORE_ATTACK only, and passes the strict manifest schema", () => {
    expect(gameManifestSchema.parse(testGame)).toEqual({
      id: "test-game",
      name: "Test Game (temporary, not playable)",
      version: "0.0.1",
      formats: ["SCORE_ATTACK"],
      status: "ACTIVE",
    });
    expect(listAvailableGames().map((g) => g.id)).toEqual(["test-game"]);
  });

  it("test-game is visibly labelled as temporary and not playable", () => {
    expect(testGame.name).toMatch(/test/i);
    expect(testGame.name).toMatch(/temporary/i);
    expect(testGame.name).toMatch(/not playable/i);
  });

  it("gates competitions by game AND format", () => {
    expect(isGameFormatAvailable("test-game", "SCORE_ATTACK")).toBe(true);
    expect(isGameFormatAvailable("test-game", "ONE_V_ONE")).toBe(false);
    expect(isGameFormatAvailable("demo", "SCORE_ATTACK")).toBe(false);
    expect(isGameFormatAvailable("Test-Game", "SCORE_ATTACK")).toBe(false); // exact id match only
    expect(isGameFormatAvailable("", "SCORE_ATTACK")).toBe(false);
  });

  it("game ids are unique", () => {
    expect(new Set(GAMES.map((g) => g.id)).size).toBe(GAMES.length);
  });
});
