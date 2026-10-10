import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { mapRpcError } from "@/server/competitions";

/**
 * TRUSTED VALIDATOR operation: records VERIFIED / REJECTED for a PAID session's result.
 *
 * Uses the service-role client because no player may ever decide validation. There is
 * deliberately NO API route for this: it is for future server-side validators (e.g. replay
 * verification or an admin tool behind its own authorization). Never wire it to client input
 * without that authorization layer.
 *
 * The database makes this idempotent-safe: only SUBMITTED + PENDING sessions can be validated,
 * so a second call fails with invalid_state (mapped to 409) instead of changing the outcome.
 */
export const validationOutcomeSchema = z.object({
  sessionId: z.string().uuid(),
  outcome: z.enum(["VERIFIED", "REJECTED"]),
  note: z.string().trim().min(1).max(500).optional(),
}).strict();

export async function recordValidationOutcome(input: unknown): Promise<void> {
  const v = validationOutcomeSchema.parse(input);
  const admin = createAdminClient();
  const { error } = await admin.rpc("competition_record_validation", {
    p_session_id: v.sessionId,
    p_outcome: v.outcome,
    p_note: v.note ?? null,
  });
  if (error) throw mapRpcError("competition_record_validation", error);
}
