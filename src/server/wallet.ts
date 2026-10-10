import "server-only";
import { z } from "zod";
import { queryError } from "@/lib/errors";
import { playCoins } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import {
  WALLET_TRANSACTION_STATUSES,
  WALLET_TRANSACTION_TYPES,
  type Wallet,
  type WalletTransaction,
} from "@/types";

/**
 * READ-ONLY wallet access for the signed-in player.
 *
 * - Uses the user-scoped server client (anon key + session cookie), so RLS
 *   ("wallets: read own", "wallet_transactions: read own") is enforced by Postgres.
 * - `userId` must come from requireUser()/getCurrentUser(), never from client input.
 *   The explicit filter is defence in depth on top of RLS.
 * - There are intentionally NO write functions here. Balance changes belong to
 *   future server-side atomic database functions (see BUILD_LOG).
 */

/** bigint columns arrive as JSON numbers; reject anything that is not a safe integer. */
const safeInt = z.number().int().refine(Number.isSafeInteger, "unsafe integer");

const walletRowSchema = z.object({
  balance: safeInt,
  updated_at: z.string(),
});

const transactionRowSchema = z.object({
  id: z.string(),
  type: z.enum(WALLET_TRANSACTION_TYPES),
  amount: safeInt,
  balance_after: safeInt,
  status: z.enum(WALLET_TRANSACTION_STATUSES),
  created_at: z.string(),
});

export const TRANSACTION_HISTORY_LIMIT = 50;

/** The caller's wallet, or null if no wallet row exists (never a made-up zero). */
export async function findOwnWallet(userId: string): Promise<Wallet | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("wallets")
    .select("balance, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw queryError("wallets select", error);
  if (!data) return null;
  const row = walletRowSchema.parse(data);
  return { balance: playCoins(row.balance), updatedAt: row.updated_at };
}

/** The caller's most recent ledger rows, newest first. */
export async function listOwnTransactions(
  userId: string,
  limit: number = TRANSACTION_HISTORY_LIMIT,
): Promise<WalletTransaction[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("wallet_transactions")
    .select("id, type, amount, balance_after, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw queryError("wallet_transactions select", error);
  return z.array(transactionRowSchema).parse(data ?? []).map((row) => ({
    id: row.id,
    type: row.type,
    amount: playCoins(row.amount),
    balanceAfter: playCoins(row.balance_after),
    status: row.status,
    createdAt: row.created_at,
  }));
}
