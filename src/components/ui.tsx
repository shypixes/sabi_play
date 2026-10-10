import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";

/** Small, presentational building blocks shared by the platform pages. */

export function PageHeader({ eyebrow, title, intro }: { eyebrow?: string; title: string; intro?: ReactNode }) {
  return (
    <header className="page-header">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {intro && <p className="page-header__intro">{intro}</p>}
    </header>
  );
}

export function SectionHeader({
  title,
  action,
  id,
}: {
  title: string;
  action?: { href: string; label: string };
  id?: string;
}) {
  return (
    <div className="section-header">
      <h2 id={id}>{title}</h2>
      {action && (
        <Link href={action.href} className="text-link">
          {action.label} <Icon name="arrow-right" size={16} />
        </Link>
      )}
    </div>
  );
}

type BadgeTone = "neutral" | "soon" | "success" | "warning" | "danger";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function ComingSoonBadge() {
  return <Badge tone="soon">Coming soon</Badge>;
}

/** Friendly placeholder for features or data that are not available yet. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  compact,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: { href: string; label: string };
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? " empty-state--compact" : ""}`}>
      <span className="empty-state__icon"><Icon name={icon} size={compact ? 22 : 28} /></span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <Link href={action.href} className="btn btn--ghost">{action.label}</Link>}
    </div>
  );
}

/** Inline error for a single section; the rest of the page keeps working. */
export function SectionError({ title, retryHref }: { title: string; retryHref: string }) {
  return (
    <div className="section-error" role="alert">
      <Icon name="alert" size={20} />
      <div>
        <p className="section-error__title">{title}</p>
        <p>Please try again in a moment.</p>
      </div>
      {/* A plain link re-requests the page, re-running the server fetch. */}
      <a href={retryHref} className="btn btn--ghost btn--sm">Retry</a>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}
