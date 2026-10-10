import { z } from "zod";
import { GAME_TYPES } from "./types";

export const GAME_STATUSES = ["DRAFT", "ACTIVE", "DISABLED"] as const;

/**
 * Game manifest. `formats` declares which competition formats the game supports.
 * Player counts and durations are NOT declared here: they are platform-owned
 * (GAME_TYPE_RULES) and games cannot override them.
 */
export const gameManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(60),
  name: z.string().min(1).max(60),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  formats: z
    .array(z.enum(GAME_TYPES))
    .min(1)
    .refine((f) => new Set(f).size === f.length, "formats must be unique"),
  status: z.enum(GAME_STATUSES),
}).strict();

export type GameManifest = z.infer<typeof gameManifestSchema>;
