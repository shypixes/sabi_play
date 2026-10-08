import "server-only";
import { AppError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/types";

/** Reads the caller's own profile through RLS. */
export async function getOwnProfile(userId: string): Promise<Profile> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, display_name, created_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError("NOT_FOUND", "Profile not found.");
  return data as Profile;
}
