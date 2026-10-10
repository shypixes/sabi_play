import { unstable_rethrow } from "next/navigation";
import { Badge, EmptyState, SectionError, Skeleton } from "@/components/ui";
import { APP_TIME_ZONE, CURRENCY_NAME } from "@/lib/config";
import { logger } from "@/lib/logger";
import { formatPlayCoins } from "@/lib/money";
import { listOwnTransactions, TRANSACTION_HISTORY_LIMIT } from "@/server/wallet";
import type { WalletTransactionStatus, WalletTransactionType } from "@/types";

const TYPE_LABEL: Record<WalletTransactionType, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  MATCH_ENTRY: "Match entry",
  MATCH_WIN: "Match win",
  REFUND: "Refund",
  ADJUSTMENT: "Adjustment",
};

const STATUS: Record<WalletTransactionStatus, { label: string; tone: "success" | "warning" | "danger" }> = {
  COMPLETED: { label: "Completed", tone: "success" },
  PENDING: { label: "Pending", tone: "warning" },
  FAILED: { label: "Failed", tone: "danger" },
};

const dateFormat = new Intl.DateTimeFormat("en-NG", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: APP_TIME_ZONE,
});

/**
 * The signed-in player's ledger (public.wallet_transactions via RLS), newest first.
 * Async server component: wrap in <Suspense fallback={<TransactionListSkeleton />}>.
 */
export async function TransactionList({ userId }: { userId: string }) {
  let transactions;
  try {
    transactions = await listOwnTransactions(userId);
  } catch (err) {
    unstable_rethrow(err);
    logger.error("wallet transactions load failed", { action: "wallet.transactions", userId }, err);
    return <SectionError title="We couldn't load your transaction history." retryHref="/wallet" />;
  }

  if (transactions.length === 0) {
    return (
      <EmptyState icon="receipt" title="No transactions yet">
        Every change to your {CURRENCY_NAME} balance will be listed here.
      </EmptyState>
    );
  }

  return (
    <>
      <ul className="tx-list">
        {transactions.map((tx) => {
          const status = STATUS[tx.status];
          const direction = tx.amount > 0 ? "credit" : "debit";
          return (
            <li key={tx.id} className="tx">
              <div className="tx__main">
                <span className="tx__type">{TYPE_LABEL[tx.type]}</span>
                <time className="tx__date" dateTime={tx.createdAt}>{dateFormat.format(new Date(tx.createdAt))}</time>
              </div>
              <div className="tx__side">
                <span className={`tx__amount tx__amount--${direction}${tx.status === "FAILED" ? " tx__amount--void" : ""}`}>
                  {formatPlayCoins(tx.amount, { signed: true })}
                  <span className="visually-hidden"> {CURRENCY_NAME}</span>
                </span>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
            </li>
          );
        })}
      </ul>
      {transactions.length === TRANSACTION_HISTORY_LIMIT && (
        <p className="fine-print">Showing your latest {TRANSACTION_HISTORY_LIMIT} transactions.</p>
      )}
    </>
  );
}

export function TransactionListSkeleton() {
  return (
    <ul className="tx-list" aria-busy="true" aria-label="Loading transactions">
      {[0, 1, 2].map((i) => (
        <li key={i} className="tx">
          <div className="tx__main"><Skeleton className="skeleton--text" /><Skeleton className="skeleton--text skeleton--short" /></div>
          <Skeleton className="skeleton--pill" />
        </li>
      ))}
    </ul>
  );
}
