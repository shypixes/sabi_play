import type { PlayCoins } from "@/lib/money";

export type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
  created_at: string;
};

/** The caller's own wallet (public.wallets). Balance is an integer PlayCoin amount. */
export type Wallet = {
  balance: PlayCoins;
  updatedAt: string;
};

/** Values allowed by the wallet_transactions CHECK constraints (migration 0002). */
export const WALLET_TRANSACTION_TYPES = [
  "DEPOSIT", "WITHDRAWAL", "MATCH_ENTRY", "MATCH_WIN", "REFUND", "ADJUSTMENT",
] as const;
export const WALLET_TRANSACTION_STATUSES = ["PENDING", "COMPLETED", "FAILED"] as const;

export type WalletTransactionType = (typeof WALLET_TRANSACTION_TYPES)[number];
export type WalletTransactionStatus = (typeof WALLET_TRANSACTION_STATUSES)[number];

/**
 * A ledger row as shown to its owner. `reference` (idempotency key) and `metadata`
 * are deliberately not selected: they are internal and not needed for display.
 * `id` is used only as a React key and is never rendered.
 */
export type WalletTransaction = {
  id: string;
  type: WalletTransactionType;
  /** Signed: credit > 0, debit < 0. */
  amount: PlayCoins;
  balanceAfter: PlayCoins;
  status: WalletTransactionStatus;
  createdAt: string;
};
