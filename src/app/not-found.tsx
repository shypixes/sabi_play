import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

export default function NotFound() {
  return (
    <main className="public-shell error-page">
      <BrandMark />
      <h1>Page not found</h1>
      <p>That page doesn&apos;t exist or has moved.</p>
      <div className="error-page__actions">
        <Link href="/dashboard" className="btn">Go to Home</Link>
      </div>
    </main>
  );
}
