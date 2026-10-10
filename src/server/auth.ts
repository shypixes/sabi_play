import "server-only";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { AppError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

/**
 * Resolve the authenticated user from the verified session, or null.
 * Wrapped in React `cache` so the layout and page of one request share a single
 * Supabase Auth round trip instead of verifying the session repeatedly.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
});

/** Use at the top of every sensitive server operation. Identity ALWAYS comes from here, never from client input. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "You need to log in.");
  return user;
}
