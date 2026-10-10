import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";
import { signup } from "@/app/auth/actions";

export default function SignupPage() {
  return (
    <>
      <h1>Create account</h1>
      <p className="auth-card__intro">Join to get ready for Score Attack and 1v1.</p>
      <AuthForm action={signup} submitLabel="Sign up" withDisplayName />
      <p>Already registered? <Link href="/login">Log in</Link></p>
    </>
  );
}
