import "server-only";
import { z } from "zod";
import { queryError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { cancelOutcome, countsTowardOpenLimit, deadlineInfo, MAX_OPEN_SESSIONS } from "./panel-lifecycle";
import { TEST_PANEL_CONFIG_ID } from "./panel-requests";

/**
 * TEMPORARY competition test panel: the signed-in player's own sessions (read-only).
 * Remove with the whole src/app/(app)/test-panel folder before launch.
 *
 * There is no "list my sessions" API route yet, so this reads competition_sessions with the
 * user-scoped client: RLS only returns sessions the caller participates in, and the query is
 * additionally restricted to sessions the caller created. No service role, no writes.
 */

export const MY_SESSIONS_LIMIT = 50;

const COLUMNS = "id, config_id, game_id, format, mode, status, validation_status, settlement_status, created_at, started_at, deadline_at, completed_at";

const rowSchema = z.object({
  id: z.string().uuid(),
  config_id: z.string().uuid(),
  game_id: z.string(),
  format: z.string(),
  mode: z.string(),
  status: z.string(),
  validation_status: z.string(),
  settlement_status: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  deadline_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

export type MySessionRow = {
  sessionId: string;
  isTestConfig: boolean;
  gameId: string;
  format: string;
  mode: string;
  status: string;
  validationStatus: string;
  settlementStatus: string;
  createdAt: string;
  startedAt: string | null;
  deadlineAt: string | null;
  completedAt: string | null;
  /** Mirrors competition_open_session_count at load time (server clock). */
  countsTowardLimit: boolean;
  deadlinePassed: boolean;
  /** What competition_cancel_session would do, or null if it would refuse. */
  cancelOutcome: "CANCELLED" | "ABANDONED" | null;
};

export type MySessions =
  | { state: "ok"; rows: MySessionRow[]; openCount: number; maxOpen: number; shownLimit: number; loadedAt: string }
  | { state: "error" };

export async function loadMySessions(userId: string, nowMs: number = Date.now()): Promise<MySessions> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("competition_sessions")
      .select(COLUMNS)
      .eq("created_by", userId)
      .order("created_at", { ascending: false })
      .limit(MY_SESSIONS_LIMIT);
    if (error) throw queryError("competition_sessions select (test panel list)", error);

    const rows: MySessionRow[] = [];
    for (const raw of Array.isArray(data) ? data : []) {
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn("test panel: skipping malformed session row", { action: "test-panel.sessions" });
        continue;
      }
      const r = parsed.data;
      rows.push({
        sessionId: r.id,
        isTestConfig: r.config_id === TEST_PANEL_CONFIG_ID,
        gameId: r.game_id,
        format: r.format,
        mode: r.mode,
        status: r.status,
        validationStatus: r.validation_status,
        settlementStatus: r.settlement_status,
        createdAt: r.created_at,
        startedAt: r.started_at,
        deadlineAt: r.deadline_at,
        completedAt: r.completed_at,
        countsTowardLimit: countsTowardOpenLimit(r.status, r.deadline_at, nowMs),
        deadlinePassed: deadlineInfo(r.deadline_at, nowMs)?.passed ?? false,
        cancelOutcome: cancelOutcome(r.status),
      });
    }
    return {
      state: "ok",
      rows,
      openCount: rows.filter((r) => r.countsTowardLimit).length,
      maxOpen: MAX_OPEN_SESSIONS,
      shownLimit: MY_SESSIONS_LIMIT,
      loadedAt: new Date(nowMs).toISOString(),
    };
  } catch (err) {
    logger.error("test panel session list failed", { action: "test-panel.sessions" }, err);
    return { state: "error" };
  }
}
