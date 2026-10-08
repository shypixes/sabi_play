import { z } from "zod";
import { GAME_TYPES } from "./types";

export const GAME_STATUSES = ["DRAFT", "ACTIVE", "DISABLED"] as const;

export const gameManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(60),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  type: z.enum(GAME_TYPES),
  minPlayers: z.number().int().min(1),
  maxPlayers: z.number().int().min(1),
  durationSeconds: z.number().int().positive().nullable(),
  status: z.enum(GAME_STATUSES),
});

export type GameManifest = z.infer<typeof gameManifestSchema>;
