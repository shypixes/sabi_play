import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

// game-frame/ is excluded: the sandboxed game document needs no session, and must never receive
// session cookie refreshes (see src/app/game-frame).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|game-frame/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
