import Link from "next/link";
import { APP_NAME } from "@/lib/config";

/** Sabi Play logo: a play-button tile plus the wordmark. Pure SVG/CSS, no image assets. */
export function BrandMark({ href = "/", size = "md" }: { href?: string; size?: "md" | "lg" }) {
  return (
    <Link href={href} className={`brand brand--${size}`} aria-label={`${APP_NAME} home`}>
      <span className="brand__tile" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="100%" height="100%">
          <path d="M9 7.2v9.6a.8.8 0 0 0 1.2.7l7.6-4.8a.8.8 0 0 0 0-1.4l-7.6-4.8A.8.8 0 0 0 9 7.2Z" fill="currentColor" />
        </svg>
      </span>
      <span className="brand__word">{APP_NAME}</span>
    </Link>
  );
}
