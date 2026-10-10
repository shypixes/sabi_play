import { fail, ok, readJsonBody } from "@/lib/api";
import { joinSession } from "@/server/competitions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sessionId: string }> };

/** POST /api/competitions/sessions/:sessionId/join with body {} (JSON required). */
export async function POST(request: Request, { params }: Params) {
  try {
    const body = await readJsonBody(request);
    const { sessionId } = await params;
    return ok({ session: await joinSession(sessionId, body) });
  } catch (err) {
    return fail(err, { action: "api.competitions.sessions.join" });
  }
}
