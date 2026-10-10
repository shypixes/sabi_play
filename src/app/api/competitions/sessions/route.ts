import { fail, ok, readJsonBody } from "@/lib/api";
import { createSession } from "@/server/competitions";

export const dynamic = "force-dynamic";

/** POST /api/competitions/sessions { configId } — the creator is always the signed-in user. */
export async function POST(request: Request) {
  try {
    const session = await createSession(await readJsonBody(request));
    return ok({ session }, { status: 201 });
  } catch (err) {
    return fail(err, { action: "api.competitions.sessions.create" });
  }
}
