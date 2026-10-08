# Architecture (modular monolith)

```
src/app        routes, pages, route handlers (thin)
src/components UI components
src/lib        shared utilities: env, supabase clients, errors, logger, api envelope, money
src/server     server-only business logic (auth, profiles; later wallet, match, settlement)
src/game-sdk   platform/game contract: game types, match states, manifest schema
src/games      future games (none in V1); may import ONLY from game-sdk
src/types      shared TS types
database/      SQL migrations
```

## Principle: GAMEPLAY | PLATFORM | MONEY
GAME -> GAME RESULT -> MATCH SYSTEM -> RESULT VALIDATION -> SETTLEMENT -> WALLET.
Games report; the platform decides. Games never touch wallet/payments.

## Game types (platform-defined)
SCORE_ATTACK: 1 player, 180s, highest valid score wins. ONE_V_ONE: 2 players, real-time, game determines winner.
Match states: CREATED, WAITING, READY, IN_PROGRESS, COMPLETED, CANCELLED, ABANDONED, DISPUTED.
Future shape: Match -> Match Players -> Game Session -> Result -> Settlement.

## Wallet (ledger-based; structure only in V1)
`wallets.balance` is a cache of the ledger `wallet_transactions`. Every balance change = one ledger row, in one DB transaction (future SECURITY DEFINER functions). `reference` is unique (idempotency). Clients have read-only access.

## Payments (future)
`PaymentProvider` interface with Demo/Flutterwave/Paystack implementations; wallet only sees verified credits. Not implemented in V1.

## Security
Browser untrusted. Anon key + RLS in browser/user sessions. Service-role key server-only, unused in V1. Middleware gating is UX; RLS and server checks are authoritative. Errors to users are generic; details go to structured, redacted server logs.
