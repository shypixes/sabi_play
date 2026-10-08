"use client";

import { useActionState } from "react";
import type { AuthState } from "@/app/auth/actions";

type Props = {
  action: (prev: AuthState, formData: FormData) => Promise<AuthState>;
  submitLabel: string;
  withDisplayName?: boolean;
};

export function AuthForm({ action, submitLabel, withDisplayName }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction}>
      {withDisplayName && (
        <label>Display name (optional)
          <input name="displayName" type="text" autoComplete="nickname" maxLength={40} />
        </label>
      )}
      <label>Email
        <input name="email" type="email" autoComplete="email" inputMode="email" required />
      </label>
      <label>Password
        <input name="password" type="password" autoComplete={withDisplayName ? "new-password" : "current-password"} minLength={8} required />
      </label>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.message && <p className="notice" role="status">{state.message}</p>}
      <button type="submit" disabled={pending}>{pending ? "Please wait…" : submitLabel}</button>
    </form>
  );
}
