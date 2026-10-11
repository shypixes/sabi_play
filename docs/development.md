# Development

## Setup
1. `npm install`
2. Create a Supabase project (dev). Enable Email auth.
3. Run `database/migrations/0001..0004` in order in the Supabase SQL editor (or via Supabase CLI).
   To make the games playable, then run the data script `database/data/game-sdk-v1-practice-configs.sql`.
4. `cp .env.example .env.local` and fill in URL + anon key.
5. `npm run dev` -> http://localhost:3000

## Checks
`npm run typecheck`, `npm test`, `npm run build`. Health: `GET /api/health`. Auth reference: `GET /api/me`.

## Tests
- `npm test` - unit (pure logic) + integration (route handlers with a MOCKED Supabase client). Mocked tests prove our code paths, not RLS.
- `npm run test:db` - real PostgreSQL. Needs `TEST_DATABASE_URL` pointing at a disposable LOCAL server (e.g. `postgres://postgres@127.0.0.1:5432/postgres`); each file creates a temporary database, applies `database/tests/supabase-shim.sql` and all migrations, and drops it. Refuses non-local hosts unless `TEST_DATABASE_ALLOW_REMOTE=1`. Never point it at a real Supabase project. The shim imitates Supabase roles, `auth.uid()` and default grants; it is not hosted Supabase.

## Manual auth/authz test
- /dashboard logged out -> redirects to /login.
- Sign up -> log in -> /dashboard shows name; /login redirects back to /dashboard.
- `GET /api/me` logged out -> 401 envelope.
- In SQL editor as a second user, confirm you cannot read another user's wallet (RLS).

## Conventions
- Sensitive logic only in `src/server` (imports `server-only`). Identity from `requireUser()`, never client input.
- API responses use `ok()/fail()` from `src/lib/api.ts`. Validate input with zod.
- Money: integers only, via `src/lib/money.ts`.
- Deploy: Vercel dev/preview; set the env vars from `.env.example` (service key only as a server secret).
