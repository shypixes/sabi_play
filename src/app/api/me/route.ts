import { fail, ok } from "@/lib/api";
import { requireUser } from "@/server/auth";
import { getOwnProfile } from "@/server/profiles";

export const dynamic = "force-dynamic";

/** Reference pattern for protected routes: authenticate -> authorize (RLS) -> respond with envelope. */
export async function GET() {
  try {
    const user = await requireUser();
    const profile = await getOwnProfile(user.id);
    return ok({ profile });
  } catch (err) {
    return fail(err, { action: "api.me.get" });
  }
}
