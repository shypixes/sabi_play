-- 0001: profiles (application data, separate from auth.users identity)

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text unique check (username is null or username ~ '^[a-zA-Z0-9_]{3,20}$'),
  display_name text check (display_name is null or char_length(display_name) between 1 and 40),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- No insert/delete policies: rows are created by trigger only, removed via auth.users cascade.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (username, display_name) on public.profiles to authenticated;
