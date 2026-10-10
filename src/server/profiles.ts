import "server-only";
import { AppError, queryError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/types";

/** Reads the caller's own profile through RLS. Returns null if the row does not exist. */
export async function findOwnProfile(userId: string): Promise<Profile | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, display_name, created_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw queryError("profiles select", error);
  return (data as Profile | null) ?? null;
}

/** Reads the caller's own profile through RLS. Throws NOT_FOUND if the row does not exist. */
export async function getOwnProfile(userId: string): Promise<Profile> {
  const profile = await findOwnProfile(userId);
  if (!profile) throw new AppError("NOT_FOUND", "Profile not found.");
  return profile;
}

/** Best name to greet a player with. Never falls back to internal identifiers. */
export function playerName(profile: Profile | null): string | null {
  return profile?.display_name ?? (profile?.username ? `@${profile.username}` : null);
}
