-- 0004: competition foundation (configurations, sessions, participants, results)
--
-- Scope (v1.2.0):
--  * PRACTICE sessions work end to end (create -> [join] -> start -> submit -> completed).
--  * PAID configurations and sessions are fully modelled and constrained, but paid sessions
--    CANNOT be created: entry-fee debits and payouts need atomic wallet functions that do not
--    exist yet. Settlement is tracked (settlement_status) but nothing in this migration moves
--    PlayCoins or touches wallets / wallet_transactions.
--  * Client-submitted results are never trusted: PRACTICE results are stored as UNVERIFIED,
--    PAID results wait as PENDING until a trusted validator (service_role only) records
--    VERIFIED or REJECTED.
--
-- Security model: players can only READ rows of sessions they participate in. All player writes
-- go through the SECURITY DEFINER functions below, which derive identity from auth.uid() and
-- validate every transition. Triggers enforce lifecycle invariants for every role (including
-- service_role and direct SQL), so mistakes in future server code cannot corrupt state.
--
-- Safe to apply on the v1 schema (0001-0003): only creates new objects. Runs in one transaction.

begin;

-- ===================================================================================
-- Pure helpers (immutable, no data access)
-- ===================================================================================

-- Prize-pool payout split by rank, in basis points: each share > 0, total exactly 10000.
create function public.competition_payout_bps_valid(bps integer[])
returns boolean
language sql immutable
set search_path = ''
as $$
  select bps is not null
     and array_ndims(bps) = 1
     and cardinality(bps) between 1 and 100
     and array_position(bps, null) is null
     and (select bool_and(b > 0) and sum(b) = 10000 from unnest(bps) as b)
$$;

-- Single source of truth for session status transitions (mirrored in src/lib/competitions/lifecycle.ts;
-- a database test asserts both tables are identical).
create function public.competition_status_transition_allowed(from_status text, to_status text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select (from_status, to_status) in (
    ('WAITING',     'READY'),
    ('WAITING',     'CANCELLED'),
    ('READY',       'IN_PROGRESS'),
    ('READY',       'CANCELLED'),
    ('IN_PROGRESS', 'SUBMITTED'),   -- PAID: result awaits validation
    ('IN_PROGRESS', 'COMPLETED'),   -- PRACTICE: result recorded as UNVERIFIED
    ('IN_PROGRESS', 'ABANDONED'),   -- player quit or deadline passed
    ('SUBMITTED',   'COMPLETED')    -- validator recorded VERIFIED / REJECTED
  )
$$;

-- ===================================================================================
-- competition_configs: per-game, per-format entry/reward tiers (arbitrary, data-driven)
-- ===================================================================================

create table public.competition_configs (
  id                 uuid primary key default gen_random_uuid(),
  game_id            text not null check (game_id ~ '^[a-z0-9-]+$' and char_length(game_id) <= 60),
  format             text not null check (format in ('SCORE_ATTACK', 'ONE_V_ONE')),
  mode               text not null check (mode in ('PRACTICE', 'PAID')),
  label              text not null check (char_length(btrim(label)) between 1 and 40),
  entry_fee          bigint not null default 0,          -- PlayCoins
  reward_model       text check (reward_model in ('FIXED', 'PRIZE_POOL')),
  fixed_reward       bigint,                             -- FIXED: PlayCoins paid to a winner
  target_score       bigint,                             -- FIXED + SCORE_ATTACK: score needed to win
  platform_fee_bps   integer,                            -- PRIZE_POOL: platform share of the pool
  pool_size          integer,                            -- PRIZE_POOL + SCORE_ATTACK: entrants per pool
  payout_bps         integer[],                          -- PRIZE_POOL + SCORE_ATTACK: split by rank
  time_limit_seconds integer not null,
  enabled            boolean not null default false,     -- open for NEW sessions
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint competition_configs_label_unique unique (game_id, format, label),
  constraint competition_configs_identity_unique unique (id, game_id, format, mode),

  -- SCORE_ATTACK duration is platform-owned (GAME_TYPE_RULES.SCORE_ATTACK = 180s).
  constraint competition_configs_time_limit check (
    (format = 'SCORE_ATTACK' and time_limit_seconds = 180)
    or (format = 'ONE_V_ONE' and time_limit_seconds between 30 and 3600)
  ),
  constraint competition_configs_ranges check (
    entry_fee between 0 and 1000000000000
    and (fixed_reward is null or fixed_reward between 1 and 1000000000000)
    and (target_score is null or target_score between 1 and 1000000000000)
    and (platform_fee_bps is null or platform_fee_bps between 0 and 9999)
    and (pool_size is null or pool_size between 2 and 1000)
  ),
  -- Practice: free, and no competitive PlayCoins reward of any kind.
  constraint competition_configs_practice check (
    mode <> 'PRACTICE' or (
      entry_fee = 0 and reward_model is null and fixed_reward is null and target_score is null
      and platform_fee_bps is null and pool_size is null and payout_bps is null
    )
  ),
  -- Paid: positive entry fee and a reward model.
  constraint competition_configs_paid check (
    mode <> 'PAID' or (entry_fee > 0 and reward_model is not null)
  ),
  constraint competition_configs_fixed check (
    reward_model is distinct from 'FIXED' or (
      fixed_reward is not null
      and platform_fee_bps is null and pool_size is null and payout_bps is null
      and case format when 'SCORE_ATTACK' then target_score is not null else target_score is null end
    )
  ),
  constraint competition_configs_prize_pool check (
    reward_model is distinct from 'PRIZE_POOL' or (
      fixed_reward is null and target_score is null and platform_fee_bps is not null
      and case format
        when 'ONE_V_ONE' then pool_size is null and payout_bps is null      -- winner takes the pool
        else pool_size is not null
             and public.competition_payout_bps_valid(payout_bps)
             and cardinality(payout_bps) <= pool_size
      end
    )
  )
);

create index competition_configs_lookup_idx
  on public.competition_configs (game_id, format) where enabled;

-- Commercial terms are immutable once created (sessions reference them). To change a price,
-- create a new config and disable the old one. Only label and enabled may change.
create function public.competition_configs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.game_id, new.format, new.mode, new.entry_fee, new.reward_model, new.fixed_reward,
      new.target_score, new.platform_fee_bps, new.pool_size, new.payout_bps, new.time_limit_seconds,
      new.created_at)
     is distinct from
     (old.id, old.game_id, old.format, old.mode, old.entry_fee, old.reward_model, old.fixed_reward,
      old.target_score, old.platform_fee_bps, old.pool_size, old.payout_bps, old.time_limit_seconds,
      old.created_at) then
    raise exception 'config_terms_immutable'
      using detail = 'Create a new competition config and disable this one.';
  end if;
  return new;
end $$;

create trigger competition_configs_guard
  before update on public.competition_configs
  for each row execute function public.competition_configs_guard();

create trigger competition_configs_set_updated_at
  before update on public.competition_configs
  for each row execute function public.set_updated_at();

-- ===================================================================================
-- competition_sessions
-- ===================================================================================

create table public.competition_sessions (
  id                uuid primary key default gen_random_uuid(),
  config_id         uuid not null,
  game_id           text not null,
  format            text not null,
  mode              text not null,
  created_by        uuid not null references public.profiles (id) on delete restrict,
  status            text not null check (status in
                      ('WAITING', 'READY', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETED', 'CANCELLED', 'ABANDONED')),
  validation_status text not null default 'NOT_SUBMITTED' check (validation_status in
                      ('NOT_SUBMITTED', 'PENDING', 'UNVERIFIED', 'VERIFIED', 'REJECTED')),
  validation_note   text check (char_length(validation_note) <= 500),
  settlement_status text not null check (settlement_status in ('NOT_REQUIRED', 'PENDING', 'COMPLETED')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  started_at        timestamptz,
  deadline_at       timestamptz,
  completed_at      timestamptz,
  validated_at      timestamptz,
  settled_at        timestamptz,

  -- game/format/mode are copies that MUST match the (immutable) config.
  constraint competition_sessions_config_fk
    foreign key (config_id, game_id, format, mode)
    references public.competition_configs (id, game_id, format, mode) on delete restrict,
  constraint competition_sessions_id_format_unique unique (id, format),

  constraint competition_sessions_score_attack_no_waiting check (format <> 'SCORE_ATTACK' or status <> 'WAITING'),
  constraint competition_sessions_settlement_required check ((mode = 'PRACTICE') = (settlement_status = 'NOT_REQUIRED')),
  constraint competition_sessions_timing check (
    (started_at is null) = (status in ('WAITING', 'READY', 'CANCELLED'))
    and (deadline_at is null) = (started_at is null)
    and (deadline_at is null or deadline_at > started_at)
    and (completed_at is null) = (status not in ('COMPLETED', 'CANCELLED', 'ABANDONED'))
  ),
  constraint competition_sessions_validation check (
    case status
      when 'SUBMITTED' then validation_status = 'PENDING'
      when 'COMPLETED' then (mode = 'PRACTICE' and validation_status = 'UNVERIFIED')
                         or (mode = 'PAID' and validation_status in ('VERIFIED', 'REJECTED'))
      else validation_status = 'NOT_SUBMITTED'
    end
    and (validated_at is null) = (validation_status not in ('VERIFIED', 'REJECTED'))
  ),
  constraint competition_sessions_settlement check (
    (settled_at is null) = (settlement_status <> 'COMPLETED')
    and (settlement_status <> 'COMPLETED' or status in ('COMPLETED', 'CANCELLED', 'ABANDONED'))
  )
);

create index competition_sessions_created_by_idx on public.competition_sessions (created_by, created_at desc);

-- Enforces identity immutability, allowed status/validation/settlement transitions and
-- write-once history fields for EVERY role.
create function public.competition_sessions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.config_id, new.game_id, new.format, new.mode, new.created_by, new.created_at)
     is distinct from
     (old.id, old.config_id, old.game_id, old.format, old.mode, old.created_by, old.created_at) then
    raise exception 'session_identity_immutable';
  end if;

  if new.status is distinct from old.status
     and not public.competition_status_transition_allowed(old.status, new.status) then
    raise exception 'invalid_status_transition' using detail = format('%s -> %s', old.status, new.status);
  end if;

  if new.validation_status is distinct from old.validation_status
     and (old.validation_status, new.validation_status) not in (
       ('NOT_SUBMITTED', 'PENDING'), ('NOT_SUBMITTED', 'UNVERIFIED'),
       ('PENDING', 'VERIFIED'), ('PENDING', 'REJECTED')) then
    raise exception 'invalid_validation_transition'
      using detail = format('%s -> %s', old.validation_status, new.validation_status);
  end if;

  -- Settlement can happen exactly once: PENDING -> COMPLETED. Never reversed or repeated.
  if new.settlement_status is distinct from old.settlement_status
     and (old.settlement_status, new.settlement_status) is distinct from ('PENDING', 'COMPLETED') then
    raise exception 'invalid_settlement_transition'
      using detail = format('%s -> %s', old.settlement_status, new.settlement_status);
  end if;

  if (old.started_at is not null and new.started_at is distinct from old.started_at)
     or (old.deadline_at is not null and new.deadline_at is distinct from old.deadline_at)
     or (old.completed_at is not null and new.completed_at is distinct from old.completed_at)
     or (old.validated_at is not null and new.validated_at is distinct from old.validated_at)
     or (old.validation_note is not null and new.validation_note is distinct from old.validation_note)
     or (old.settled_at is not null and new.settled_at is distinct from old.settled_at) then
    raise exception 'session_history_immutable';
  end if;

  return new;
end $$;

create trigger competition_sessions_guard
  before update on public.competition_sessions
  for each row execute function public.competition_sessions_guard();

create trigger competition_sessions_set_updated_at
  before update on public.competition_sessions
  for each row execute function public.set_updated_at();

-- ===================================================================================
-- competition_participants: one row per player per session
-- ===================================================================================

create table public.competition_participants (
  session_id uuid not null,
  format     text not null,
  user_id    uuid not null references public.profiles (id) on delete restrict,
  slot       smallint not null,
  joined_at  timestamptz not null default now(),

  primary key (session_id, user_id),                               -- no duplicate player per session
  constraint competition_participants_slot_unique unique (session_id, slot),
  constraint competition_participants_session_fk
    foreign key (session_id, format) references public.competition_sessions (id, format) on delete cascade,
  -- SCORE_ATTACK: slot 1 only (1 player). ONE_V_ONE: slots 1 and 2 (2 players).
  constraint competition_participants_slot_allowed check (slot = 1 or (slot = 2 and format = 'ONE_V_ONE'))
);

create index competition_participants_user_idx on public.competition_participants (user_id);

create function public.competition_participants_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'participants_immutable';
end $$;

create trigger competition_participants_guard
  before update on public.competition_participants
  for each row execute function public.competition_participants_guard();

-- Participant count must match the session state at commit time (deferred so a session and its
-- participants can be written in one transaction). SECURITY DEFINER because deferred triggers
-- fire at COMMIT, when the session role is back to `authenticated` and RLS would hide rows.
create function public.competition_check_participants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_format     text;
  v_status     text;
  v_count      integer;
  v_required   integer;
begin
  if tg_table_name = 'competition_sessions' then
    v_session_id := new.id;
  else
    v_session_id := coalesce(new.session_id, old.session_id);
  end if;

  select s.format, s.status into v_format, v_status
  from public.competition_sessions s where s.id = v_session_id;
  if not found then
    return null;  -- session deleted in the same transaction
  end if;

  select count(*) into v_count from public.competition_participants p where p.session_id = v_session_id;
  v_required := case v_format when 'SCORE_ATTACK' then 1 else 2 end;

  if v_count < 1 then
    raise exception 'participant_count_invalid' using detail = 'A session needs at least one participant.';
  end if;
  if v_status = 'WAITING' and v_count >= v_required then
    raise exception 'participant_count_invalid' using detail = 'A full session cannot be WAITING.';
  end if;
  if v_status in ('READY', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETED', 'ABANDONED') and v_count <> v_required then
    raise exception 'participant_count_invalid'
      using detail = format('%s needs exactly %s participant(s) in status %s.', v_format, v_required, v_status);
  end if;
  return null;
end $$;

create constraint trigger competition_sessions_participant_count
  after insert or update on public.competition_sessions
  deferrable initially deferred
  for each row execute function public.competition_check_participants();

create constraint trigger competition_participants_count
  after insert or delete on public.competition_participants
  deferrable initially deferred
  for each row execute function public.competition_check_participants();

-- ===================================================================================
-- competition_results: the single result submitted for a session (immutable record)
-- ===================================================================================

create table public.competition_results (
  session_id     uuid primary key,                -- one result per session: duplicates impossible
  format         text not null,
  submitted_by   uuid not null,
  score          bigint,                          -- SCORE_ATTACK
  winner_user_id uuid,                            -- ONE_V_ONE (null when draw)
  is_draw        boolean not null default false,  -- ONE_V_ONE
  submitted_at   timestamptz not null default now(),

  constraint competition_results_session_fk
    foreign key (session_id, format) references public.competition_sessions (id, format) on delete restrict,
  constraint competition_results_submitter_fk
    foreign key (session_id, submitted_by) references public.competition_participants (session_id, user_id),
  constraint competition_results_winner_fk
    foreign key (session_id, winner_user_id) references public.competition_participants (session_id, user_id),
  constraint competition_results_shape check (
    case format
      when 'SCORE_ATTACK' then score is not null and score between 0 and 1000000000000
                               and winner_user_id is null and not is_draw
      else score is null and is_draw = (winner_user_id is null)
    end
  )
);

create function public.competition_results_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'results_immutable';
end $$;

create trigger competition_results_guard
  before update or delete on public.competition_results
  for each row execute function public.competition_results_guard();

-- ===================================================================================
-- Row Level Security: players read only what they participate in. No client writes.
-- ===================================================================================

-- SECURITY DEFINER so policies can check membership without recursive RLS evaluation.
create function public.competition_is_participant(p_session_id uuid)
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.competition_participants p
    where p.session_id = p_session_id and p.user_id = (select auth.uid())
  )
$$;

alter table public.competition_configs      enable row level security;
alter table public.competition_sessions     enable row level security;
alter table public.competition_participants enable row level security;
alter table public.competition_results      enable row level security;

-- Configurations are not secret (game, price, reward terms); the API lists enabled ones.
create policy "competition_configs: authenticated read" on public.competition_configs
  for select to authenticated using (true);

create policy "competition_sessions: participants read" on public.competition_sessions
  for select to authenticated using (public.competition_is_participant(id));

create policy "competition_participants: co-participants read" on public.competition_participants
  for select to authenticated using (public.competition_is_participant(session_id));

create policy "competition_results: participants read" on public.competition_results
  for select to authenticated using (public.competition_is_participant(session_id));

revoke all on public.competition_configs, public.competition_sessions,
              public.competition_participants, public.competition_results
  from anon, authenticated;
grant select on public.competition_configs, public.competition_sessions,
                public.competition_participants, public.competition_results
  to authenticated;

-- ===================================================================================
-- Player operations (SECURITY DEFINER; identity from auth.uid(); never from arguments)
-- Errors are raised with stable snake_case messages mapped by src/server/competitions.ts.
-- ===================================================================================

-- Max concurrent open sessions per player (abuse guard). Mirrored in lifecycle.ts.
create function public.competition_open_session_count(p_user_id uuid)
returns integer
language sql stable
set search_path = ''
as $$
  select count(*)::integer
  from public.competition_participants p
  join public.competition_sessions s on s.id = p.session_id
  where p.user_id = p_user_id
    and (s.status in ('WAITING', 'READY') or (s.status = 'IN_PROGRESS' and s.deadline_at > now()))
$$;

-- Locks the caller's profile row: serialises a player's own session operations so the open-session
-- limit cannot be bypassed with concurrent requests.
create function public.competition_lock_player(p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'not_authenticated';
  end if;
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'profile_not_found';
  end if;
end $$;

create function public.competition_create_session(p_config_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_config     public.competition_configs%rowtype;
  v_session_id uuid;
begin
  perform public.competition_lock_player(v_uid);

  select * into v_config from public.competition_configs c where c.id = p_config_id for share;
  if not found then
    raise exception 'config_not_found';
  end if;
  if not v_config.enabled then
    raise exception 'config_disabled';
  end if;
  -- Paid entry requires an atomic PlayCoins debit, which does not exist yet.
  if v_config.mode = 'PAID' then
    raise exception 'paid_competitions_disabled';
  end if;
  if public.competition_open_session_count(v_uid) >= 3 then
    raise exception 'too_many_open_sessions';
  end if;

  insert into public.competition_sessions (config_id, game_id, format, mode, created_by, status, settlement_status)
  values (
    v_config.id, v_config.game_id, v_config.format, v_config.mode, v_uid,
    case v_config.format when 'SCORE_ATTACK' then 'READY' else 'WAITING' end,
    case v_config.mode when 'PRACTICE' then 'NOT_REQUIRED' else 'PENDING' end
  )
  returning id into v_session_id;

  insert into public.competition_participants (session_id, format, user_id, slot)
  values (v_session_id, v_config.format, v_uid, 1);

  return v_session_id;
end $$;

-- Direct join of a known ONE_V_ONE session (invite primitive). NOT matchmaking.
-- Compatibility is structural: both players share the session's single config (same tier).
create function public.competition_join_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_session public.competition_sessions%rowtype;
begin
  perform public.competition_lock_player(v_uid);

  select * into v_session from public.competition_sessions s where s.id = p_session_id for update;
  if not found then
    raise exception 'session_not_found';
  end if;
  if exists (select 1 from public.competition_participants p
             where p.session_id = p_session_id and p.user_id = v_uid) then
    raise exception 'already_joined';
  end if;
  if v_session.format <> 'ONE_V_ONE' or v_session.status <> 'WAITING' then
    raise exception 'session_not_joinable';
  end if;
  if v_session.mode = 'PAID' then
    raise exception 'paid_competitions_disabled';
  end if;
  if public.competition_open_session_count(v_uid) >= 3 then
    raise exception 'too_many_open_sessions';
  end if;

  insert into public.competition_participants (session_id, format, user_id, slot)
  values (p_session_id, v_session.format, v_uid, 2);
  update public.competition_sessions set status = 'READY' where id = p_session_id;
end $$;

-- Locks a session the caller participates in. Non-participants get session_not_found
-- (no information about other players' sessions is revealed).
create function public.competition_lock_own_session(p_session_id uuid, p_user_id uuid)
returns public.competition_sessions
language plpgsql
set search_path = ''
as $$
declare
  v_session public.competition_sessions%rowtype;
begin
  if p_user_id is null then
    raise exception 'not_authenticated';
  end if;
  select s.* into v_session
  from public.competition_sessions s
  where s.id = p_session_id
    and exists (select 1 from public.competition_participants p
                where p.session_id = s.id and p.user_id = p_user_id)
  for update of s;
  if not found then
    raise exception 'session_not_found';
  end if;
  return v_session;
end $$;

create function public.competition_start_session(p_session_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session  public.competition_sessions%rowtype;
  v_limit    integer;
  v_deadline timestamptz;
begin
  v_session := public.competition_lock_own_session(p_session_id, auth.uid());
  if v_session.status <> 'READY' then
    raise exception 'invalid_state';
  end if;

  select c.time_limit_seconds into v_limit from public.competition_configs c where c.id = v_session.config_id;
  -- Deadline = time limit + 30s grace for network latency (mirrored in lifecycle.ts).
  v_deadline := now() + make_interval(secs => v_limit + 30);

  update public.competition_sessions
  set status = 'IN_PROGRESS', started_at = now(), deadline_at = v_deadline
  where id = p_session_id;
  return v_deadline;
end $$;

-- Records the single result for a session. Returns the resulting validation status:
--   'UNVERIFIED' (practice, stored but not trusted), 'PENDING' (paid, awaits validator),
--   or 'EXPIRED' (deadline passed: session marked ABANDONED, result not stored).
create function public.competition_submit_result(
  p_session_id  uuid,
  p_score       bigint default null,
  p_winner_slot smallint default null,
  p_is_draw     boolean default false
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_session public.competition_sessions%rowtype;
  v_winner  uuid;
  v_draw    boolean := coalesce(p_is_draw, false);
begin
  v_session := public.competition_lock_own_session(p_session_id, v_uid);

  -- Covers duplicates: after the first submission the session is no longer IN_PROGRESS.
  if v_session.status <> 'IN_PROGRESS' then
    raise exception 'invalid_state';
  end if;

  if now() > v_session.deadline_at then
    update public.competition_sessions set status = 'ABANDONED', completed_at = now() where id = p_session_id;
    return 'EXPIRED';
  end if;

  if v_session.format = 'SCORE_ATTACK' then
    if p_score is null or p_score < 0 or p_score > 1000000000000 or p_winner_slot is not null or v_draw then
      raise exception 'invalid_result';
    end if;
  else
    if p_score is not null or v_draw = (p_winner_slot is not null) then
      raise exception 'invalid_result';
    end if;
    if p_winner_slot is not null then
      select p.user_id into v_winner from public.competition_participants p
      where p.session_id = p_session_id and p.slot = p_winner_slot;
      if not found then
        raise exception 'invalid_result';
      end if;
    end if;
  end if;

  insert into public.competition_results (session_id, format, submitted_by, score, winner_user_id, is_draw)
  values (p_session_id, v_session.format, v_uid,
          case when v_session.format = 'SCORE_ATTACK' then p_score end, v_winner, v_draw);

  if v_session.mode = 'PRACTICE' then
    update public.competition_sessions
    set status = 'COMPLETED', validation_status = 'UNVERIFIED', completed_at = now()
    where id = p_session_id;
    return 'UNVERIFIED';
  end if;

  update public.competition_sessions
  set status = 'SUBMITTED', validation_status = 'PENDING'
  where id = p_session_id;
  return 'PENDING';
end $$;

-- WAITING/READY -> CANCELLED; IN_PROGRESS -> ABANDONED. Returns the new status.
create function public.competition_cancel_session(p_session_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.competition_sessions%rowtype;
  v_next    text;
begin
  v_session := public.competition_lock_own_session(p_session_id, auth.uid());
  v_next := case v_session.status
              when 'WAITING' then 'CANCELLED'
              when 'READY' then 'CANCELLED'
              when 'IN_PROGRESS' then 'ABANDONED'
            end;
  if v_next is null then
    raise exception 'invalid_state';
  end if;
  update public.competition_sessions set status = v_next, completed_at = now() where id = p_session_id;
  return v_next;
end $$;

-- ===================================================================================
-- Trusted validator operation: service_role ONLY (never exposed to players).
-- SECURITY INVOKER: the caller must already hold write privileges on the table.
-- The conditional update makes repeated validation of the same session impossible.
-- ===================================================================================

create function public.competition_record_validation(
  p_session_id uuid,
  p_outcome    text,
  p_note       text default null
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_outcome is null or p_outcome not in ('VERIFIED', 'REJECTED') then
    raise exception 'invalid_validation_outcome';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'invalid_validation_note';
  end if;

  update public.competition_sessions
  set validation_status = p_outcome, validation_note = p_note, validated_at = now(),
      status = 'COMPLETED', completed_at = now()
  where id = p_session_id and status = 'SUBMITTED' and validation_status = 'PENDING';
  if not found then
    raise exception 'invalid_state';
  end if;
end $$;

-- ===================================================================================
-- Function privileges. Postgres grants EXECUTE to PUBLIC by default and Supabase adds
-- anon/authenticated via default privileges, so revoke explicitly, then grant narrowly.
-- Pure immutable helpers (payout_bps_valid, status_transition_allowed) stay callable:
-- they read no data and are used inside CHECK constraints and triggers.
-- ===================================================================================

revoke execute on function
  public.competition_configs_guard(),
  public.competition_sessions_guard(),
  public.competition_participants_guard(),
  public.competition_results_guard(),
  public.competition_check_participants(),
  public.competition_open_session_count(uuid),
  public.competition_lock_player(uuid),
  public.competition_lock_own_session(uuid, uuid),
  public.competition_is_participant(uuid),
  public.competition_create_session(uuid),
  public.competition_join_session(uuid),
  public.competition_start_session(uuid),
  public.competition_submit_result(uuid, bigint, smallint, boolean),
  public.competition_cancel_session(uuid),
  public.competition_record_validation(uuid, text, text)
  from public, anon, authenticated;

grant execute on function
  public.competition_is_participant(uuid),          -- evaluated inside RLS policies
  public.competition_create_session(uuid),
  public.competition_join_session(uuid),
  public.competition_start_session(uuid),
  public.competition_submit_result(uuid, bigint, smallint, boolean),
  public.competition_cancel_session(uuid)
  to authenticated;

grant execute on function public.competition_record_validation(uuid, text, text) to service_role;

commit;
