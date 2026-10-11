import { z } from "zod";
import { GAME_TYPES } from "./types";
import { SDK_VERSION, SEMVER_PATTERN, compareSemver, isInSdkRange } from "./version";

/**
 * Game manifest, schema version 1.
 *
 * A manifest describes the game only. Everything the platform owns (entry fees, rewards, time
 * limits, player counts, modes, settlement) lives in `competition_configs` and GAME_TYPE_RULES
 * and is REJECTED here, so a game can never grant itself platform privileges.
 */

export const MANIFEST_SCHEMA_VERSION = 1;
export const GAME_STATUSES = ["DRAFT", "ACTIVE", "DISABLED"] as const;
export const GAME_INPUTS = ["touch", "pointer", "keyboard"] as const;
export const GAME_ORIENTATIONS = ["portrait", "landscape"] as const;
export type GameOrientation = (typeof GAME_ORIENTATIONS)[number];
export type GameInput = (typeof GAME_INPUTS)[number];
export type GameStatus = (typeof GAME_STATUSES)[number];

/**
 * Capabilities a game may request. Each maps to a narrowly scoped iframe permission
 * (see GAME_CAPABILITY_PERMISSIONS); nothing else is ever delegated to game code.
 */
export const GAME_CAPABILITIES = ["audio", "fullscreen"] as const;
export type GameCapability = (typeof GAME_CAPABILITIES)[number];
export const GAME_CAPABILITY_PERMISSIONS: Readonly<Record<GameCapability, string | null>> = {
  audio: "autoplay",
  fullscreen: "fullscreen",
};

/** Capabilities that are never granted, with the reason shown to the game developer. */
const FORBIDDEN_CAPABILITIES: Readonly<Record<string, string>> = {
  network: "games cannot make network requests; talk to the platform through the SDK",
  storage: "games run in an isolated origin without cookies or storage",
  "same-origin": "games never run with the platform's origin",
  camera: "camera access is not available to games",
  microphone: "microphone access is not available to games",
  geolocation: "location access is not available to games",
  payments: "games never handle payments",
  wallet: "games never access wallets; the platform settles results",
  clipboard: "clipboard access is not available to games",
  popups: "games cannot open windows",
  "top-navigation": "games cannot navigate the platform page",
};

/** Platform-owned settings that must never appear in a game manifest. */
const PLATFORM_KEYS: Readonly<Record<string, string>> = {
  entryFee: "entry fees", reward: "rewards", rewards: "rewards", prize: "prizes",
  timeLimitSeconds: "time limits", durationSeconds: "durations", deadline: "deadlines",
  mode: "competition modes", minPlayers: "player counts", maxPlayers: "player counts",
  settlement: "settlement", validation: "result validation", wallet: "wallets",
};

const semver = z.string().regex(SEMVER_PATTERN, "must be a semantic version MAJOR.MINOR.PATCH, e.g. 1.0.0");
const uniqueList = <T extends z.ZodTypeAny>(item: T, what: string) =>
  z.array(item).min(1, `declare at least one ${what}`)
    .refine((list) => new Set(list).size === list.length, `${what} values must be unique`);

/** Game-specific, non-privileged gameplay settings passed back to the game in its session context. */
export const gameConfigSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/, "config keys: letters/digits, max 32"), z.union([
    z.number().finite(), z.boolean(), z.string().max(64),
  ]))
  .refine((c) => Object.keys(c).length <= 16, "at most 16 gameConfig entries");
export type GameConfig = z.infer<typeof gameConfigSchema>;

export const gameManifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION, {
    errorMap: () => ({ message: `must be ${MANIFEST_SCHEMA_VERSION} (the only manifest schema this platform supports)` }),
  }),
  /** Stable id; also the competition_configs.game_id. Never reuse an id for a different game. */
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, "lowercase letters, digits and inner dashes, max 60"),
  name: z.string().trim().min(1).max(60),
  /** Game release version (semver). Sent to the game in its context and checked at launch. */
  version: semver,
  status: z.enum(GAME_STATUSES),
  /** Module file in src/games/<id>/ exporting the game (see GameModule). null = not launchable. */
  entry: z.string().regex(/^[a-z0-9-]+\.tsx?$/, "a .ts/.tsx file name in the game's folder").nullable(),
  /** SDK versions the game works with: min inclusive, maxExclusive exclusive. */
  sdk: z.object({ min: semver, maxExclusive: semver }).strict()
    .refine((r) => !SEMVER_PATTERN.test(r.min) || !SEMVER_PATTERN.test(r.maxExclusive) || compareSemver(r.min, r.maxExclusive) < 0,
      "sdk.min must be lower than sdk.maxExclusive"),
  /** Competition formats the game supports. Durations and player counts stay platform-owned. */
  formats: uniqueList(z.enum(GAME_TYPES), "format"),
  inputs: uniqueList(z.enum(GAME_INPUTS), "input"),
  orientations: uniqueList(z.enum(GAME_ORIENTATIONS), "orientation"),
  capabilities: z.array(z.string().max(40)).max(16)
    .superRefine((caps, ctx) => {
      caps.forEach((cap, i) => {
        const forbidden = FORBIDDEN_CAPABILITIES[cap];
        if (forbidden) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `"${cap}" is not allowed: ${forbidden}` });
        else if (!(GAME_CAPABILITIES as readonly string[]).includes(cap)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `unknown capability "${cap}"; supported: ${GAME_CAPABILITIES.join(", ")}` });
        }
      });
      if (new Set(caps).size !== caps.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "capabilities must be unique" });
    })
    .transform((caps) => caps as GameCapability[]),
  /** Descriptive, game-specific metadata (display only). */
  metadata: z.object({
    description: z.string().trim().min(1).max(200),
    howToPlay: z.string().trim().min(1).max(300),
  }).strict(),
  gameConfig: gameConfigSchema,
}).strict();

export type GameManifest = z.infer<typeof gameManifestSchema>;
/** The input type of a manifest file (what a game author writes). */
export type GameManifestInput = z.input<typeof gameManifestSchema>;

export type ManifestValidation = { ok: true; manifest: GameManifest } | { ok: false; errors: string[] };

function describeIssues(raw: unknown, error: z.ZodError): string[] {
  const out: string[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of Object.keys(raw)) {
      const what = PLATFORM_KEYS[key];
      if (what) out.push(`${key}: ${what} are platform configuration (competition_configs), not part of a game manifest`);
    }
  }
  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys && issue.keys.every((k) => PLATFORM_KEYS[k] && issue.path.length === 0)) continue;
    const path = issue.path.length ? issue.path.join(".") : "(manifest)";
    out.push(`${path}: ${issue.message}`);
  }
  return out;
}

/** Validates a manifest and reports every problem with its field path. Never throws. */
export function validateManifest(raw: unknown): ManifestValidation {
  const parsed = gameManifestSchema.safeParse(raw);
  return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false, errors: describeIssues(raw, parsed.error) };
}

/** Null when the game supports `sdkVersion`, otherwise an actionable explanation. */
export function checkSdkCompatibility(manifest: Pick<GameManifest, "id" | "sdk">, sdkVersion: string = SDK_VERSION): string | null {
  if (isInSdkRange(sdkVersion, manifest.sdk)) return null;
  const direction = compareSemver(sdkVersion, manifest.sdk.min) < 0
    ? `requires SDK ${manifest.sdk.min} or newer; update the platform SDK or lower sdk.min`
    : `supports SDK versions below ${manifest.sdk.maxExclusive} only; test the game with SDK ${sdkVersion} and raise sdk.maxExclusive`;
  return `Game "${manifest.id}" is not compatible with SDK ${sdkVersion}: it ${direction}.`;
}

export class ManifestError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`Invalid game registration:\n- ${errors.join("\n- ")}`);
    this.name = "ManifestError";
  }
}

/**
 * Validates a set of manifests for the catalogue. Throws ManifestError listing EVERY problem:
 * malformed manifests, SDK incompatibility, and duplicate ids (a duplicate never silently
 * replaces an existing game). Used by src/games/registry.ts at module load, so an invalid
 * catalogue fails the build and the tests instead of reaching players.
 */
export function registerGames(raws: readonly unknown[], sdkVersion: string = SDK_VERSION): readonly GameManifest[] {
  const errors: string[] = [];
  const games: GameManifest[] = [];
  const seen = new Map<string, number>();
  raws.forEach((raw, index) => {
    const label = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      ? `game "${(raw as { id: string }).id}"` : `manifest #${index + 1}`;
    const result = validateManifest(raw);
    if (!result.ok) {
      errors.push(...result.errors.map((e) => `${label}: ${e}`));
      return;
    }
    const m = result.manifest;
    const incompatible = checkSdkCompatibility(m, sdkVersion);
    if (incompatible) errors.push(incompatible);
    const first = seen.get(m.id);
    if (first !== undefined) {
      errors.push(`${label}: duplicate game id (already registered by manifest #${first + 1}); ids are permanent and must be unique`);
      return;
    }
    seen.set(m.id, index);
    if (!incompatible) games.push(m);
  });
  if (errors.length) throw new ManifestError(errors);
  return Object.freeze(games.map((g) => Object.freeze(g)));
}

/** A game the platform can start: ACTIVE, has an entry module. */
export function isLaunchable(m: Pick<GameManifest, "status" | "entry">): boolean {
  return m.status === "ACTIVE" && m.entry !== null;
}
