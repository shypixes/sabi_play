import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Icon } from "@/components/icons";
import { SectionError, Skeleton } from "@/components/ui";
import { CURRENCY_NAME } from "@/lib/config";
import { logger } from "@/lib/logger";
import { formatPlayCoins } from "@/lib/money";
import { findOwnWallet } from "@/server/wallet";

type Variant = "summary" | "hero";

/**
 * Shows the signed-in player's REAL wallet balance (public.wallets via RLS).
 * Async server component: wrap in <Suspense fallback={<BalanceCardSkeleton />}>.
 * `userId` must come from getCurrentUser() on the server.
 */
export async function BalanceCard({ userId, variant = "summary" }: { userId: string; variant?: Variant }) {
  let wallet;
  try {
    wallet = await findOwnWallet(userId);
  } catch (err) {
    unstable_rethrow(err);
    logger.error("wallet balance load failed", { action: "wallet.balance", userId }, err);
    return <SectionError title="We couldn't load your balance." retryHref={variant === "hero" ? "/wallet" : "/dashboard"} />;
  }

  if (!wallet) {
    return (
      <div className="balance-card balance-card--missing" role="status">
        <span className="balance-card__label"><Icon name="wallet" size={18} /> Wallet</span>
        <p className="balance-card__missing">Your wallet isn&apos;t set up yet.</p>
        <p className="balance-card__hint">
          Wallets are created automatically when an account is registered. If this persists, please contact support.
        </p>
      </div>
    );
  }

  return (
    <section className={`balance-card balance-card--${variant}`} aria-label={`${CURRENCY_NAME} balance`}>
      <span className="balance-card__label"><Icon name="coin" size={18} /> Balance</span>
      <p className="balance-card__amount">
        <span className="balance-card__value">{formatPlayCoins(wallet.balance)}</span>
        <span className="balance-card__unit">{CURRENCY_NAME}</span>
      </p>
      {variant === "summary" && (
        <Link href="/wallet" className="balance-card__link">
          View wallet <Icon name="arrow-right" size={16} />
        </Link>
      )}
    </section>
  );
}

export function BalanceCardSkeleton({ variant = "summary" }: { variant?: Variant }) {
  return (
    <div className={`balance-card balance-card--${variant}`} aria-busy="true" aria-label="Loading balance">
      <Skeleton className="skeleton--text" />
      <Skeleton className="skeleton--amount" />
      {variant === "summary" && <Skeleton className="skeleton--text skeleton--short" />}
    </div>
  );
}
