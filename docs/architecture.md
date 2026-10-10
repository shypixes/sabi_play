# Architecture (modular monolith)

```
src/app        routes, pages, route handlers (thin)
src/components UI components
src/lib        shared utilities: env, supabase clients, errors, logger, api envelope, money,
               competitions/ (pure config, lifecycle and settlement-planning rules)
src/server     server-only business logic (auth, profiles, wallet reads, competitions; later settlement)
src/game-sdk   platform/game contract: game types, manifest schema (formats), competition contract
src/games      future games (none in V1); may import ONLY from game-sdk
src/types      shared TS types
database/      SQL migrations; database/tests: Supabase shim for real-PostgreSQL tests
tests/         unit, integration (mocked Supabase) and db (real PostgreSQL) suites
```

## Principle: GAMEPLAY | PLATFORM | MONEY
GAME -> GAME RESULT -> MATCH SYSTEM -> RESULT VALIDATION -> SETTLEMENT -> WALLET.
Games report; the platform decides. Games never touch wallet/payments.

## Game types (platform-defined)
SCORE_ATTACK: 1 player, 180s, highest valid score wins. ONE_V_ONE: 2 players, real-time, game determines winner.
Game manifests declare `formats` they support; player counts and durations stay platform-owned.

## Competitions (v1.2.0 foundation)
Config (game, format, PRACTICE/PAID, entry fee, reward model FIXED/PRIZE_POOL) -> Session -> Participants
(1 for SCORE_ATTACK, 2 for ONE_V_ONE) -> Result -> Validation -> Settlement tracking.
Session status: WAITING (1v1 only) -> READY -> IN_PROGRESS -> COMPLETED (practice) or SUBMITTED -> COMPLETED
(paid, after a trusted validator); WAITING/READY -> CANCELLED; IN_PROGRESS -> ABANDONED (quit or deadline).
Validation: client results are never trusted (practice UNVERIFIED; paid PENDING until VERIFIED/REJECTED by
service_role). Settlement: NOT_REQUIRED (practice) or PENDING -> COMPLETED exactly once.
The database (migration 0004) is authoritative: player writes only through SECURITY DEFINER functions that
take identity from auth.uid(); triggers enforce transitions for every role. Paid sessions cannot be created
and nothing pays out until atomic wallet functions exist. API: /api/competitions/* (see docs/database.md).

## Wallet (ledger-based; structure only in V1)
`wallets.balance` is a cache of the ledger `wallet_transactions`. Every balance change = one ledger row, in one DB transaction (future SECURITY DEFINER functions). `reference` is unique (idempotency). Clients have read-only access.

## Payments (future)
`PaymentProvider` interface with Demo/Flutterwave/Paystack implementations; wallet only sees verified credits. Not implemented in V1.

## Security
Browser untrusted. Anon key + RLS in browser/user sessions. Service-role key server-only; used only by src/server/competition-validation.ts (trusted validator, no route). Middleware gating is UX; RLS and server checks are authoritative. Errors to users are generic; details go to structured, redacted server logs.
