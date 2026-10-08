-- 0002: wallet foundation (STRUCTURE ONLY - no write paths in V1)
-- All amounts are INTEGERS (bigint). NGN = kobo, PlayCoins = whole coins. Never numeric/float.

create table public.wallets (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  balance    bigint not null default 0 check (balance >= 0),   -- PlayCoins
  updated_at timestamptz not null default now()
);

create table public.wallet_transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.wallets (user_id) on delete restrict,
  type          text not null check (type in
                  ('DEPOSIT','WITHDRAWAL','MATCH_ENTRY','MATCH_WIN','REFUND','ADJUSTMENT')),
  amount        bigint not null check (amount <> 0),            -- signed PlayCoins: credit > 0, debit < 0
  balance_after bigint not null check (balance_after >= 0),
  status        text not null default 'PENDING' check (status in ('PENDING','COMPLETED','FAILED')),
  reference     text not null unique,                           -- idempotency key
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index wallet_transactions_user_created_idx
  on public.wallet_transactions (user_id, created_at desc);

alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;

create policy "wallets: read own" on public.wallets
  for select to authenticated using (user_id = (select auth.uid()));

create policy "wallet_transactions: read own" on public.wallet_transactions
  for select to authenticated using (user_id = (select auth.uid()));

-- Clients may READ only. All mutation will happen via server-side, atomic
-- SECURITY DEFINER functions introduced in a later version (balance update + ledger row in one transaction).
revoke all on public.wallets, public.wallet_transactions from anon, authenticated;
grant select on public.wallets, public.wallet_transactions to authenticated;
