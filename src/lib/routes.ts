/**
 * Signed-in application areas. Single source of truth for the main navigation
 * and for middleware route gating (src/lib/supabase/middleware.ts), so a new
 * area cannot be added to the nav without also being protected.
 */
export const APP_NAV = [
  { href: "/dashboard", label: "Home", icon: "home" },
  { href: "/games", label: "Games", icon: "games" },
  { href: "/competitions", label: "Competitions", icon: "trophy" },
  { href: "/wallet", label: "Wallet", icon: "wallet" },
  { href: "/profile", label: "Profile", icon: "user" },
] as const;

export type AppNavItem = (typeof APP_NAV)[number];
export type NavIconName = AppNavItem["icon"];

export const PROTECTED_PREFIXES: readonly string[] = APP_NAV.map((item) => item.href);

/** True for "/wallet" and "/wallet/…", but not "/walletx". */
export function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => matchesPrefix(pathname, p));
}
