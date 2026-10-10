import { fail, ok, readJsonBody } from "@/lib/api";
import { startSession } from "@/server/competitions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sessionId: string }> };

/** POST /api/competitions/sessions/:sessionId/start with body {} (JSON required). */
export async function POST(request: Request, { params }: Params) {
  try {
    const body = await readJsonBody(request);
    const { sessionId } = await params;
    return ok({ session: await startSession(sessionId, body) });
  } catch (err) {
    return fail(err, { action: "api.competitions.sessions.start" });
  }
}
