import { redirect } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { BrandMark } from "@/components/BrandMark";
import { getCurrentUser } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Shell for all signed-in areas. Middleware already gates these routes (UX);
 * this layout re-verifies the session server-side. Pages ALSO verify, because
 * Next renders layouts and pages in parallel, so a layout check alone is not a
 * guarantee for the page's own data access. getCurrentUser() is request-cached.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="app">
      <header className="app-header">
        <BrandMark href="/dashboard" />
      </header>
      <AppNav />
      <main className="app-main" id="main">{children}</main>
    </div>
  );
}
