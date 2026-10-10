import { fail, ok } from "@/lib/api";
import { getSession } from "@/server/competitions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sessionId: string }> };

/** GET /api/competitions/sessions/:sessionId — participants only (others get 404). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { sessionId } = await params;
    return ok({ session: await getSession(sessionId) });
  } catch (err) {
    return fail(err, { action: "api.competitions.sessions.get" });
  }
}
