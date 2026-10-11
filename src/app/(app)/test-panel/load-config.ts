import "server-only";
import { competitionConfigRowSchema } from "@/lib/competitions/config";
import { queryError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { TEST_PANEL_CONFIG_ID } from "./panel-requests";

/**
 * TEMPORARY competition test panel: server-side helpers.
 * Remove with the whole src/app/(app)/test-panel folder before launch.
 */

/** Hidden in Vercel PRODUCTION (VERCEL_ENV is set by Vercel). Available in previews and local dev. */
export function isTestPanelEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV !== "production";
}

export type TestConfigSummary =
  | {
      state: "found";
      label: string; gameId: string; format: string; mode: string;
      entryFee: number; timeLimitSeconds: number; enabled: boolean;
    }
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "error" };

/** Reads the test config as the signed-in user (RLS applies; configs are readable by authenticated users). */
export async function loadTestConfig(): Promise<TestConfigSummary> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("competition_configs")
      .select("id, game_id, format, mode, label, entry_fee, reward_model, fixed_reward, target_score, platform_fee_bps, pool_size, payout_bps, time_limit_seconds, enabled")
      .eq("id", TEST_PANEL_CONFIG_ID)
      .maybeSingle();
    if (error) throw queryError("competition_configs select (test panel)", error);
    if (!data) return { state: "missing" };
    const row = competitionConfigRowSchema.safeParse(data);
    if (!row.success) return { state: "invalid" };
    return {
      state: "found",
      label: row.data.label,
      gameId: row.data.game_id,
      format: row.data.format,
      mode: row.data.mode,
      entryFee: row.data.entry_fee,
      timeLimitSeconds: row.data.time_limit_seconds,
      enabled: row.data.enabled,
    };
  } catch (err) {
    logger.error("test panel config load failed", { action: "test-panel.config" }, err);
    return { state: "error" };
  }
}
