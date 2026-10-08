import Link from "next/link";
import { APP_NAME } from "@/lib/config";

export default function Home() {
  return (
    <>
      <h1>{APP_NAME}</h1>
      <p>Competitive games. Foundation build.</p>
      <p><Link href="/login">Log in</Link> or <Link href="/signup">create an account</Link>.</p>
    </>
  );
}
