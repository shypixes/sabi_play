/**
 * MONEY RULES (mandatory)
 *  - NGN is stored as integer KOBO (₦1,000 = 100_000 kobo).
 *  - PlayCoins are integers.
 *  - Never use floats for money. Never do money math with JS floating point.
 *  - The PlayCoin <-> NGN rate is centralized HERE and is intentionally UNSET in V1.
 */

export type Kobo = number & { readonly __brand: "Kobo" };
export type PlayCoins = number & { readonly __brand: "PlayCoins" };

function assertSafeInt(n: number, label: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} must be a safe integer, got ${n}`);
}

export function kobo(n: number): Kobo {
  assertSafeInt(n, "kobo");
  return n as Kobo;
}

export function playCoins(n: number): PlayCoins {
  assertSafeInt(n, "playCoins");
  return n as PlayCoins;
}

/** Whole naira -> kobo using integer math only. */
export function nairaToKobo(wholeNaira: number): Kobo {
  assertSafeInt(wholeNaira, "naira");
  return kobo(wholeNaira * 100);
}

/** Display only. Never feed the result back into calculations. */
export function formatKobo(k: Kobo): string {
  const abs = BigInt(Math.abs(k));
  const naira = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rem = (abs % 100n).toString().padStart(2, "0");
  return `${k < 0 ? "-" : ""}₦${naira}.${rem}`;
}

/** Groups the digits of a non-negative bigint with commas, e.g. 1234567n -> "1,234,567". */
function groupDigits(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Display only. Integer formatting with digit grouping; no floating-point math.
 * `signed: true` prefixes credits with "+" and debits with "−" (U+2212).
 */
export function formatPlayCoins(c: PlayCoins, opts: { signed?: boolean } = {}): string {
  const value = BigInt(c);
  const abs = value < 0n ? -value : value;
  const sign = value < 0n ? "−" : opts.signed && value > 0n ? "+" : "";
  return `${sign}${groupDigits(abs)}`;
}

/**
 * Exchange rate: kobo per 1 PlayCoin, as an integer ratio. NOT DECIDED YET.
 * Set once here when product decides; nowhere else.
 */
export const PLAYCOIN_KOBO_RATE: { koboPerCoinNumerator: bigint; denominator: bigint } | null = null;

function requireRate() {
  if (!PLAYCOIN_KOBO_RATE) throw new Error("PlayCoin/NGN rate is not configured (V1: intentionally unset).");
  return PLAYCOIN_KOBO_RATE;
}

/** Integer-safe (BigInt), floors the result. */
export function koboToPlayCoins(k: Kobo): PlayCoins {
  const r = requireRate();
  return playCoins(Number((BigInt(k) * r.denominator) / r.koboPerCoinNumerator));
}

export function playCoinsToKobo(c: PlayCoins): Kobo {
  const r = requireRate();
  return kobo(Number((BigInt(c) * r.koboPerCoinNumerator) / r.denominator));
}
