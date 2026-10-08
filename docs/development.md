# Development

## Setup
1. `npm install`
2. Create a Supabase project (dev). Enable Email auth.
3. Run `database/migrations/0001..0003` in order in the Supabase SQL editor (or via Supabase CLI).
4. `cp .env.example .env.local` and fill in URL + anon key.
5. `npm run dev` -> http://localhost:3000

## Checks
`npm run typecheck`, `npm run build`. Health: `GET /api/health`. Auth reference: `GET /api/me`.

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
