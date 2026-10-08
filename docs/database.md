# Database

Conventions: snake_case, uuid keys, timestamptz, FKs everywhere, RLS enabled on every table, writes revoked by default and re-granted narrowly. Money columns are `bigint` (kobo / PlayCoins) - never numeric/float.

| Migration | Contents |
|---|---|
| 0001_profiles | `profiles` (1:1 with auth.users), RLS own-row read/update; update limited to username, display_name |
| 0002_wallet_foundation | `wallets`, `wallet_transactions` (signed integer amounts, unique `reference`), read-own RLS, no client writes |
| 0003_new_user_trigger | creates profile + wallet (balance 0) on signup |

Not yet defined: games, matches, match_players, game_sessions, results, settlements, payments, admin roles.
Exchange rate: undecided; centralized in `src/lib/money.ts` (unset).
