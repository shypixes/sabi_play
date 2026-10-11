-- Game SDK v1 (BUILD_LOG v1.3.0): free-practice configurations for the reference game
-- (pop-rush) and the second integration (sum-sprint).
--
-- DATA, NOT A MIGRATION. Run manually, once, in the Supabase SQL editor of the project you want
-- to enable the games on. It changes no schema and touches no wallet data.
--   * Practice only: entry_fee 0, no reward terms, 180-second Score Attack.
--   * Idempotent: skips a game that already has an enabled SCORE_ATTACK config (the schema
--     allows only one enabled config per game and format).
--   * To switch a game off later: update public.competition_configs set enabled = false
--     where game_id = '<id>' and format = 'SCORE_ATTACK';
-- Verified against migrations 0001-0004 on local PostgreSQL by tests/db/game-sdk-practice.test.ts.

insert into public.competition_configs (game_id, format, mode, label, entry_fee, time_limit_seconds, enabled)
select v.game_id, 'SCORE_ATTACK', 'PRACTICE', v.label, 0, 180, true
from (values
  ('pop-rush', 'Pop Rush practice'),
  ('sum-sprint', 'Sum Sprint practice')
) as v (game_id, label)
where not exists (
  select 1 from public.competition_configs c
  where c.game_id = v.game_id and c.format = 'SCORE_ATTACK' and c.enabled
);

-- Check:
-- select id, game_id, mode, entry_fee, time_limit_seconds, enabled
-- from public.competition_configs where game_id in ('pop-rush', 'sum-sprint');
