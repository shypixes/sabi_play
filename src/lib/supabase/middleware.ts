import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getPublicEnv } from "@/lib/env";
import { isProtectedPath } from "@/lib/routes";

const AUTH_PAGES = ["/login", "/signup"];

// Explicit local type: no dependency on which types @supabase/ssr exports.
type CookieAttributes = {
  domain ? : string;
  expires ? : Date;
  httpOnly ? : boolean;
  maxAge ? : number;
  path ? : string;
  sameSite ? : boolean | "lax" | "strict" | "none";
  secure ? : boolean;
};
type CookiesToSet = { name: string;value: string;options ? : CookieAttributes } [];

/** Refreshes the session cookie and applies coarse route gating (UX only; RLS is the real boundary). */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const env = getPublicEnv();
  
  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list: CookiesToSet) {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  
  // getUser() validates the JWT with Supabase; do not use getSession() for gating.
  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  
  if (!user && isProtectedPath(path)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (user && AUTH_PAGES.includes(path)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }
  return response;
}