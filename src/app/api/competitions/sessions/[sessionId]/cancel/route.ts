import { fail, ok, readJsonBody } from "@/lib/api";
import { cancelSession } from "@/server/competitions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sessionId: string }> };

/** POST /api/competitions/sessions/:sessionId/cancel with body {} (JSON required). */
export async function POST(request: Request, { params }: Params) {
  try {
    const body = await readJsonBody(request);
    const { sessionId } = await params;
    return ok({ session: await cancelSession(sessionId, body) });
  } catch (err) {
    return fail(err, { action: "api.competitions.sessions.cancel" });
  }
}
