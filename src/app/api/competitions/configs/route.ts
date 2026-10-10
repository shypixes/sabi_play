import { fail, ok } from "@/lib/api";
import { listCompetitionOptions } from "@/server/competitions";

export const dynamic = "force-dynamic";

/** GET /api/competitions/configs?gameId=&format= — enabled configurations for available games. */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const filter = Object.fromEntries([...params.entries()].filter(([k]) => k === "gameId" || k === "format"));
    const options = await listCompetitionOptions(filter);
    return ok({ options });
  } catch (err) {
    return fail(err, { action: "api.competitions.configs.list" });
  }
}
