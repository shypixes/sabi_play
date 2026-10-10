// Public, non-secret configuration. Safe in client and server code.
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Sabi Play";

/**
 * Display name of the single in-game currency. "PlayCoins" is the name already used
 * in src/lib/money.ts and BUILD_LOG decisions. Change it HERE only when product
 * terminology is finalized.
 */
export const CURRENCY_NAME = "PlayCoins";

/** Time zone used to render dates server-side (servers run in UTC; players are in Nigeria). */
export const APP_TIME_ZONE = "Africa/Lagos";
