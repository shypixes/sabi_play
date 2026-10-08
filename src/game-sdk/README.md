# Game SDK boundary (V1: definitions only)

Games live in `src/games/<game-id>/` (none exist in V1) and may import ONLY from `@/game-sdk`.
Games must never import from `@/server`, `@/lib/supabase`, or touch wallets/payments.
A game reports a result; the platform validates, settles, and updates the wallet.
Runtime SDK (start/score/finish messages) is planned for a later version.
