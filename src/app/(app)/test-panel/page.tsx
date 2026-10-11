import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { isGameFormatAvailable } from "@/games/registry";
import { getCurrentUser } from "@/server/auth";
import { isTestPanelEnabled, loadTestConfig } from "./load-config";
import { TestPanel } from "./TestPanel";

/**
 * TEMPORARY "Competition Test Panel" at /test-panel.
 *
 * - Signed-in users only: the (app) layout and this page both verify the session server-side.
 * - Returns 404 in Vercel PRODUCTION; available in preview deployments and local dev.
 * - Not linked from the navigation. Uses only the existing /api routes.
 *
 * REMOVE BEFORE LAUNCH: delete src/app/(app)/test-panel/ and tests/**\/test-panel*.test.ts(x).
 */

export const dynamic = "force-dynamic";
export const metadata = { title: "Competition Test Panel", robots: { index: false, follow: false } };

export default async function TestPanelPage() {
  if (!isTestPanelEnabled()) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const config = await loadTestConfig();

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow="Temporary"
        title="Competition Test Panel"
        intro="Test free practice sessions against the real API from your phone. Not a player feature."
      />
      <TestPanel email={user.email ?? null} config={config} registryReady={isGameFormatAvailable("test-game", "SCORE_ATTACK")} />
    </div>
  );
}
