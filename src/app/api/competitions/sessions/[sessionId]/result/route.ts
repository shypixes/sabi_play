import { fail, ok, readJsonBody } from "@/lib/api";
import { submitResult } from "@/server/competitions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sessionId: string }> };

/**
 * POST /api/competitions/sessions/:sessionId/result
 *   { format: "SCORE_ATTACK", score } | { format: "ONE_V_ONE", winnerSlot: 1 | 2 | null }
 * The stored result is never trusted (UNVERIFIED for practice, PENDING for paid).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const body = await readJsonBody(request);
    const { sessionId } = await params;
    return ok({ session: await submitResult(sessionId, body) });
  } catch (err) {
    return fail(err, { action: "api.competitions.sessions.result" });
  }
}
