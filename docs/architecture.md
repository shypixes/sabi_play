# Architecture (modular monolith)

```
src/app        routes, pages, route handlers (thin)
src/components UI components
src/lib        shared utilities: env, supabase clients, errors, logger, api envelope, money,
               competitions/ (pure config, lifecycle and settlement-planning rules)
src/server     server-only business logic (auth, profiles, wallet reads, competitions; later settlement)
src/game-sdk   public Game SDK v1: manifest schema/validator, host<->game protocol, game client (README.md)
src/lib/game-host  platform side of the SDK: GameHostController + the competition-API adapter
src/games      games (pop-rush reference, sum-sprint second integration, temporary test-game);
               may import ONLY from game-sdk
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

## Game SDK v1 (games in an isolated frame)
Contract and usage: `src/game-sdk/README.md`. Flow: /games/<id>/play (authenticated) renders
`GameHost`, which creates, starts, submits and cancels the practice session through the EXISTING
/api/competitions/* routes (no new API, table or migration). The game runs in a sandboxed iframe
(/game-frame/<id>) and only talks to `GameHost` through the typed postMessage protocol; the host
validates every message and turns `submit` into the existing result request. No second backend,
scoring service or auth path.

Isolation layers (no single one is relied on):
1. `sandbox="allow-scripts"` only: opaque origin, so no cookies, storage, or access to the app DOM,
   no forms, popups or top navigation. `allow` delegates only granted capabilities (autoplay, fullscreen).
2. Frame CSP (next.config.ts): `connect-src 'none'` (no network), `default-src 'none'`, `frame-ancestors 'self'`,
   no forms/workers/objects/sub-frames; `Referrer-Policy: no-referrer`; restrictive Permissions-Policy.
3. Middleware skips /game-frame/: the frame response never touches the Supabase session (no Set-Cookie).
4. The frame receives no credential at all: no token, no user id; the session id is not a secret
   and every privileged call is made by the HOST with the user's own cookie and authorized by the server
   (ownership via RLS + SECURITY DEFINER RPCs; non-participants get 404).
5. Protocol: strict zod schemas, 4 KiB cap, origin `"null"` + source === this iframe's window,
   session id, protocol version and allowed sequence checks; 10 violations end the game.
6. The server stays authoritative: start only from READY, one result per session, deadline enforced
   by the DB, practice results UNVERIFIED / NOT_REQUIRED, no wallet effect. Client scores are never trusted.

Known limitations (accepted for v1, documented rather than hidden):
- postMessage to the frame uses target `"*"`: a sandboxed frame's opaque origin cannot be named.
  Delivery is bound to the iframe's window and messages carry no credentials.
- Game code can navigate its own frame (e.g. to an external page). That page inherits the sandbox and
  can only send the same protocol messages the game could already send; the CSP does not govern it.
  It could leak the (non-secret) session id or score. A cross-site game origin would be stronger.
- `window.open` is silently blocked by the sandbox (no error is thrown in the game).
- No automatic expiry (backend): a session left IN_PROGRESS by a closed tab stays IN_PROGRESS until a
  late result (-> ABANDONED) or cancel; it stops counting toward the open limit after its deadline.
  On pagehide the host releases a READY session (keepalive cancel); an IN_PROGRESS one is not cancelled
  on unload. In-app navigation and Exit cancel through the normal route.
- Past the deadline the game may still submit; the server refuses it (EXPIRED -> ABANDONED).
- Request bodies are capped at 16 KiB (src/lib/api.ts); there is no rate limiter (none exists to reuse).
- The game version and submission id are checked client/host side but not stored (needs a migration).
- An unknown /games/<id>/play renders the not-found UI with HTTP 200 (Next.js streaming limitation).
- Fullscreen/autoplay are only delegated when the manifest declares them; everything else is denied.

## Wallet (ledger-based; structure only in V1)
`wallets.balance` is a cache of the ledger `wallet_transactions`. Every balance change = one ledger row, in one DB transaction (future SECURITY DEFINER functions). `reference` is unique (idempotency). Clients have read-only access.

## Payments (future)
`PaymentProvider` interface with Demo/Flutterwave/Paystack implementations; wallet only sees verified credits. Not implemented in V1.

## Security
Browser untrusted. Anon key + RLS in browser/user sessions. Service-role key server-only; used only by src/server/competition-validation.ts (trusted validator, no route). Middleware gating is UX; RLS and server checks are authoritative. Errors to users are generic; details go to structured, redacted server logs.
