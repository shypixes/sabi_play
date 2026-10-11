import { describe, expect, it } from "vitest";
import {
  ManifestError,
  SDK_VERSION,
  checkSdkCompatibility,
  compareSemver,
  isInSdkRange,
  isLaunchable,
  isRuntimeCompatible,
  parseSemver,
  registerGames,
  validateManifest,
  type GameManifestInput,
} from "@/game-sdk";

// UNIT: manifest schema v1, SDK compatibility and catalogue registration (no mocks).

const valid = (): GameManifestInput => ({
  schemaVersion: 1,
  id: "sample-game",
  name: "Sample",
  version: "1.2.3",
  status: "ACTIVE",
  entry: "game.ts",
  sdk: { min: "1.0.0", maxExclusive: "2.0.0" },
  formats: ["SCORE_ATTACK"],
  inputs: ["touch"],
  orientations: ["portrait"],
  capabilities: [],
  metadata: { description: "A sample.", howToPlay: "Tap." },
  gameConfig: {},
});

const errorsOf = (raw: unknown): string[] => {
  const r = validateManifest(raw);
  return r.ok ? [] : r.errors;
};

describe("semantic versions", () => {
  it("parses strict MAJOR.MINOR.PATCH only", () => {
    expect(parseSemver("1.10.0")).toEqual({ major: 1, minor: 10, patch: 0 });
    for (const bad of ["1.0", "01.0.0", "1.0.0-beta", "v1.0.0", " 1.0.0", "1.0.0.0", ""]) expect(parseSemver(bad)).toBeNull();
  });
  it("compares numerically and respects [min, maxExclusive)", () => {
    expect(compareSemver("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(isInSdkRange("1.0.0", { min: "1.0.0", maxExclusive: "2.0.0" })).toBe(true);
    expect(isInSdkRange("2.0.0", { min: "1.0.0", maxExclusive: "2.0.0" })).toBe(false);
    expect(isInSdkRange("0.9.9", { min: "1.0.0", maxExclusive: "2.0.0" })).toBe(false);
  });
  it("runtime compatibility needs the same protocol and SDK major", () => {
    expect(isRuntimeCompatible({ protocol: 1, sdkVersion: "1.4.0" }, { protocol: 1, sdkVersion: "1.0.0" })).toBe(true);
    expect(isRuntimeCompatible({ protocol: 2, sdkVersion: "1.0.0" }, { protocol: 1, sdkVersion: "1.0.0" })).toBe(false);
    expect(isRuntimeCompatible({ protocol: 1, sdkVersion: "2.0.0" }, { protocol: 1, sdkVersion: "1.0.0" })).toBe(false);
    expect(isRuntimeCompatible({ protocol: 1, sdkVersion: "nope" }, { protocol: 1, sdkVersion: "1.0.0" })).toBe(false);
  });
});

describe("validateManifest", () => {
  it("accepts a valid v1 manifest", () => {
    expect(validateManifest(valid()).ok).toBe(true);
  });

  it("rejects a missing or unknown schemaVersion with an actionable message", () => {
    const { schemaVersion: _omit, ...noVersion } = valid();
    expect(errorsOf(noVersion).join()).toMatch(/schemaVersion: must be 1/);
    expect(errorsOf({ ...valid(), schemaVersion: 2 }).join()).toMatch(/schemaVersion: must be 1/);
  });

  it("rejects malformed fields with their paths", () => {
    const errors = errorsOf({ ...valid(), id: "Bad Id", version: "1.0", entry: "../x.js", formats: [] });
    expect(errors.some((e) => e.startsWith("id:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("version:") && /semantic version/.test(e))).toBe(true);
    expect(errors.some((e) => e.startsWith("entry:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("formats:"))).toBe(true);
  });

  it("rejects unknown fields and explains platform-owned ones", () => {
    expect(errorsOf({ ...valid(), extra: true }).join()).toMatch(/extra/);
    const errors = errorsOf({ ...valid(), entryFee: 100, timeLimitSeconds: 600 });
    expect(errors.join("\n")).toMatch(/entryFee: entry fees are platform configuration/);
    expect(errors.join("\n")).toMatch(/timeLimitSeconds: time limits are platform configuration/);
  });

  it("rejects forbidden and unknown capabilities, and duplicates", () => {
    expect(errorsOf({ ...valid(), capabilities: ["network"] }).join()).toMatch(/"network" is not allowed/);
    expect(errorsOf({ ...valid(), capabilities: ["wallet"] }).join()).toMatch(/not allowed/);
    expect(errorsOf({ ...valid(), capabilities: ["telepathy"] }).join()).toMatch(/unknown capability "telepathy"; supported: audio, fullscreen/);
    expect(errorsOf({ ...valid(), capabilities: ["audio", "audio"] }).join()).toMatch(/unique/);
    expect(validateManifest({ ...valid(), capabilities: ["audio", "fullscreen"] }).ok).toBe(true);
  });

  it("rejects an inverted SDK range and duplicate list entries", () => {
    expect(errorsOf({ ...valid(), sdk: { min: "2.0.0", maxExclusive: "1.0.0" } }).join()).toMatch(/sdk.min must be lower/);
    expect(errorsOf({ ...valid(), inputs: ["touch", "touch"] }).length).toBeGreaterThan(0);
  });

  it("bounds gameConfig to small JSON values", () => {
    expect(validateManifest({ ...valid(), gameConfig: { speed: 2, mode: "x", on: true } }).ok).toBe(true);
    expect(validateManifest({ ...valid(), gameConfig: { nested: { a: 1 } } }).ok).toBe(false);
    const big = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]));
    expect(validateManifest({ ...valid(), gameConfig: big }).ok).toBe(false);
  });

  it("never throws on garbage", () => {
    for (const raw of [null, undefined, 1, "x", [], () => 1]) expect(validateManifest(raw).ok).toBe(false);
  });
});

describe("SDK compatibility and registration", () => {
  it("explains incompatibility in both directions", () => {
    expect(checkSdkCompatibility({ id: "g", sdk: { min: "1.0.0", maxExclusive: "2.0.0" } }, "1.5.0")).toBeNull();
    expect(checkSdkCompatibility({ id: "g", sdk: { min: "1.1.0", maxExclusive: "2.0.0" } }, "1.0.0")).toMatch(/requires SDK 1.1.0 or newer/);
    expect(checkSdkCompatibility({ id: "g", sdk: { min: "1.0.0", maxExclusive: "1.1.0" } }, "1.1.0")).toMatch(/below 1.1.0 only/);
  });

  it("registers valid manifests and freezes them", () => {
    const games = registerGames([valid(), { ...valid(), id: "other" }]);
    expect(games.map((g) => g.id)).toEqual(["sample-game", "other"]);
    expect(Object.isFrozen(games)).toBe(true);
    expect(Object.isFrozen(games[0])).toBe(true);
  });

  it("refuses duplicate ids instead of overwriting", () => {
    expect(() => registerGames([valid(), { ...valid(), name: "Impostor" }])).toThrow(/duplicate game id/);
  });

  it("refuses incompatible SDK ranges and reports every problem at once", () => {
    try {
      registerGames([{ ...valid(), sdk: { min: "3.0.0", maxExclusive: "4.0.0" } }, { ...valid(), id: "x", version: "bad" }], SDK_VERSION);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      const errors = (err as ManifestError).errors;
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatch(/requires SDK 3.0.0/);
      expect(errors[1]).toMatch(/^game "x": version:/);
    }
  });

  it("launchable means ACTIVE with an entry module", () => {
    expect(isLaunchable({ status: "ACTIVE", entry: "game.ts" })).toBe(true);
    expect(isLaunchable({ status: "ACTIVE", entry: null })).toBe(false);
    expect(isLaunchable({ status: "DRAFT", entry: "game.ts" })).toBe(false);
    expect(isLaunchable({ status: "DISABLED", entry: "game.ts" })).toBe(false);
  });
});
