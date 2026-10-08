import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";
import { login } from "@/app/auth/actions";

export default function LoginPage() {
  return (
    <>
      <h1>Log in</h1>
      <AuthForm action={login} submitLabel="Log in" />
      <p>No account? <Link href="/signup">Sign up</Link></p>
    </>
  );
}
