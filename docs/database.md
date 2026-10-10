# Database

Conventions: snake_case, uuid keys, timestamptz, FKs everywhere, RLS enabled on every table, writes revoked by default and re-granted narrowly. Money columns are `bigint` (kobo / PlayCoins) - never numeric/float.

| Migration | Contents |
|---|---|
| 0001_profiles | `profiles` (1:1 with auth.users), RLS own-row read/update; update limited to username, display_name |
| 0002_wallet_foundation | `wallets`, `wallet_transactions` (signed integer amounts, unique `reference`), read-own RLS, no client writes |
| 0003_new_user_trigger | creates profile + wallet (balance 0) on signup |
| 0004_competitions | `competition_configs`, `competition_sessions`, `competition_participants`, `competition_results`; lifecycle guard triggers; participant-count constraint triggers; participant-only read RLS; player RPCs; service_role validation RPC |

## Competitions (0004)
- **Configs** are data, not code: any number of tiers per game+format (label unique per game+format). Practice: fee 0, no reward. Paid: fee > 0 plus FIXED (`fixed_reward`; SCORE_ATTACK also `target_score`) or PRIZE_POOL (`platform_fee_bps`; SCORE_ATTACK also `pool_size` + `payout_bps` summing to 10000). Terms are immutable; to change a price create a new config and disable the old one. New configs default to `enabled = false`. Only service_role / SQL editor can write configs.
- **Sessions** copy game/format/mode from the config via a composite FK, so both 1v1 players are structurally on the same tier.
- **Player RPCs** (granted to `authenticated`, identity from `auth.uid()`): `competition_create_session(config_id)`, `competition_join_session(session_id)` (direct join, not matchmaking), `competition_start_session`, `competition_submit_result(session_id, p_score | p_winner_slot, p_is_draw)`, `competition_cancel_session`. Errors are stable codes (e.g. `invalid_state`, `session_not_found`) mapped in `src/server/competitions.ts`.
- **Validator RPC** `competition_record_validation(session_id, outcome, note)`: service_role only; SUBMITTED+PENDING -> COMPLETED+VERIFIED/REJECTED, once.
- **RLS**: players read configs and only the sessions/participants/results they take part in. No direct client writes on any competition table. Paid session creation raises `paid_competitions_disabled`.
- **Deleting users**: users with competition history cannot be hard-deleted (FK `on delete restrict`), matching the existing ledger rule. Users without history are unaffected.
- Not yet: settlement/wallet movements, matchmaking, leaderboards, tournaments.

Not yet defined: games table (games live in code: src/games/registry.ts), settlement execution, payments, admin roles.
Exchange rate: undecided; centralized in `src/lib/money.ts` (unset).
