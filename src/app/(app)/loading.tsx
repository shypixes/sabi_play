import { Skeleton } from "@/components/ui";

/** Route-level loading state shown inside the app shell while a page's server work runs. */
export default function Loading() {
  return (
    <div className="page-loading" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading…</span>
      <Skeleton className="skeleton--title" />
      <Skeleton className="skeleton--text" />
      <Skeleton className="skeleton--block" />
      <Skeleton className="skeleton--block" />
    </div>
  );
}
