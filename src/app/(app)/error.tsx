"use client";

import Link from "next/link";
import { Icon } from "@/components/icons";

/** Route-level error boundary for signed-in pages. Shows a generic message only. */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="error-page" role="alert">
      <span className="error-page__icon"><Icon name="alert" size={28} /></span>
      <h1>Something went wrong</h1>
      <p>We couldn&apos;t load this page. Please try again.</p>
      <div className="error-page__actions">
        <button type="button" onClick={reset}>Try again</button>
        <Link href="/dashboard" className="btn btn--ghost">Go to Home</Link>
      </div>
    </div>
  );
}
