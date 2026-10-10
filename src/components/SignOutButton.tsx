"use client";

import { useFormStatus } from "react-dom";
import { logout } from "@/app/auth/actions";
import { Icon } from "@/components/icons";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="secondary" disabled={pending}>
      <Icon name="logout" size={20} />
      {pending ? "Signing out…" : "Log out"}
    </button>
  );
}

/** Wraps the existing `logout` server action with a pending state. */
export function SignOutButton() {
  return (
    <form action={logout}>
      <SubmitButton />
    </form>
  );
}
