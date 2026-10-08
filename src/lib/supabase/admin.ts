import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getPublicEnv } from "@/lib/env";
import { getServerEnv } from "@/lib/env.server";

/**
 * Service-role client. BYPASSES RLS. Server only.
 * Not used in V1. Reserved for audited, server-authoritative operations
 * (e.g. settlement). Never call from request handlers that accept raw client input
 * without validating and authorizing first.
 */
export function createAdminClient() {
  const pub = getPublicEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();
  return createSupabaseClient(pub.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
