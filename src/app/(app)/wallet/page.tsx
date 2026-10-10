import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Icon } from "@/components/icons";
import { PageHeader, SectionHeader } from "@/components/ui";
import { BalanceCard, BalanceCardSkeleton } from "@/components/wallet/BalanceCard";
import { TransactionList, TransactionListSkeleton } from "@/components/wallet/TransactionList";
import { CURRENCY_NAME } from "@/lib/config";
import { getCurrentUser } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wallet" };

/** Read-only wallet view. There are deliberately no deposit/withdraw controls in this version. */
export default async function WalletPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="stack-lg">
      <PageHeader eyebrow="Account" title="Wallet" intro={`Your ${CURRENCY_NAME} balance and activity.`} />

      <Suspense fallback={<BalanceCardSkeleton variant="hero" />}>
        <BalanceCard userId={user.id} variant="hero" />
      </Suspense>

      <div className="notice-panel" role="note">
        <Icon name="lock" size={20} />
        <p>Adding and withdrawing {CURRENCY_NAME} isn&apos;t available yet. Your balance can only change through the platform.</p>
      </div>

      <section aria-labelledby="history" className="stack">
        <SectionHeader id="history" title="Transaction history" />
        <Suspense fallback={<TransactionListSkeleton />}>
          <TransactionList userId={user.id} />
        </Suspense>
      </section>
    </div>
  );
}
