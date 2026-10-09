"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export type AuthState = { error ? : string;message ? : string };

const credentials = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  password: z.string().min(8, "Password must be at least 8 characters.").max(72),
});

const signupSchema = credentials.extend({
  displayName: z.string().trim().min(1).max(40).optional(),
});

export async function login(_prev: AuthState, formData: FormData): Promise < AuthState > {
  const parsed = credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    logger.warn("login failed", { action: "auth.login", reason: error.code });
    return { error: "Incorrect email or password." };
  }
  redirect("/dashboard");
}

export async function signup(_prev: AuthState, formData: FormData): Promise < AuthState > {
  const parsed = signupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("displayName") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { data: { display_name: parsed.data.displayName } },
  });
  if (error) {
    // Diagnostics only: the user still sees the same generic message.
    // Note: do not name a context key "message" (it would overwrite the log line's own message).
    logger.warn("signup failed", {
      action: "auth.signup",
      reason: error.code,
      status: error.status,
      errorName: error.name,
      authMessage: error.message,
    });
    return { error: "Could not create the account. Try a different email or password." };
  }
  if (!data.session) return { message: "Check your email to confirm your account, then log in." };
  redirect("/dashboard");
}

export async function logout(): Promise < void > {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}