-- TEST ONLY. Never apply to a real Supabase project (it already provides all of this).
--
-- Recreates the minimum Supabase environment the migrations depend on, on a plain PostgreSQL
-- database, so tests/db can exercise constraints, triggers, grants and RLS for real:
--   * roles anon / authenticated / service_role (service_role bypasses RLS, like Supabase)
--   * auth schema with auth.users and auth.uid() (reads request.jwt.claims like PostgREST)
--   * Supabase's default privileges: ALL on new public tables/functions/sequences for
--     anon, authenticated and service_role. Migrations must therefore revoke explicitly,
--     exactly as on hosted Supabase.
-- Known difference: here migrations run as a superuser; on Supabase they run as `postgres`.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema auth;

create table auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
