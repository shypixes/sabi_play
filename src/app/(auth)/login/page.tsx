import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";
import { login } from "@/app/auth/actions";

export default function LoginPage() {
  return (
    <>
      <h1>Log in</h1>
      <p className="auth-card__intro">Welcome back. Pick up where you left off.</p>
      <AuthForm action={login} submitLabel="Log in" />
      <p>No account? <Link href="/signup">Sign up</Link></p>
    </>
  );
}
