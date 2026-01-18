-- Credit system tables for ledgered balances and Stripe mapping

create table public.credit_balances (
  user_id uuid primary key references auth.users on delete cascade,
  balance integer not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  type text not null check (type in ('purchase','spend','adjustment')),
  credits_delta integer not null check (credits_delta <> 0),
  description text,
  metadata jsonb,
  amount_cents integer,
  currency text default 'usd',
  stripe_payment_intent_id text,
  stripe_event_id text,
  idempotency_key text,
  balance_after integer not null,
  created_at timestamptz not null default now()
);
create index credit_ledger_user_created_idx on public.credit_ledger (user_id, created_at desc);
create unique index credit_ledger_stripe_event_uidx on public.credit_ledger (stripe_event_id) where stripe_event_id is not null;
create unique index credit_ledger_idempotency_uidx on public.credit_ledger (user_id, idempotency_key) where idempotency_key is not null;
create index credit_ledger_payment_intent_idx on public.credit_ledger (stripe_payment_intent_id) where stripe_payment_intent_id is not null;

create table public.stripe_customers (
  user_id uuid primary key references auth.users on delete cascade,
  customer_id text not null unique,
  created_at timestamptz not null default now()
);

alter table public.credit_balances enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.stripe_customers enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='credit_balances' and policyname='credit_balances_select_self') then
    create policy credit_balances_select_self on public.credit_balances
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='credit_ledger' and policyname='credit_ledger_select_self') then
    create policy credit_ledger_select_self on public.credit_ledger
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='stripe_customers' and policyname='stripe_customers_select_self') then
    create policy stripe_customers_select_self on public.stripe_customers
      for select using (auth.uid() = user_id);
  end if;
end $$;

create or replace function public.apply_credit_delta(
  p_user_id uuid,
  p_delta integer,
  p_type text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_amount_cents integer default null,
  p_currency text default 'usd',
  p_stripe_payment_intent_id text default null,
  p_stripe_event_id text default null,
  p_idempotency_key text default null
)
returns public.credit_ledger
language plpgsql
security definer
as $$
declare
  current_balance integer;
  new_balance integer;
  entry public.credit_ledger;
begin
  if p_type not in ('purchase','spend','adjustment') then
    raise exception 'invalid_type';
  end if;
  if p_delta = 0 then
    raise exception 'credits_delta_must_be_nonzero';
  end if;

  if p_idempotency_key is not null then
    select * into entry from public.credit_ledger where user_id = p_user_id and idempotency_key = p_idempotency_key limit 1;
    if found then
      return entry;
    end if;
  end if;

  if p_stripe_event_id is not null then
    select * into entry from public.credit_ledger where stripe_event_id = p_stripe_event_id limit 1;
    if found then
      return entry;
    end if;
  end if;

  insert into public.credit_balances (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select balance into current_balance from public.credit_balances where user_id = p_user_id for update;
  new_balance := current_balance + p_delta;
  if new_balance < 0 then
    raise exception 'insufficient_balance';
  end if;

  update public.credit_balances
  set balance = new_balance, updated_at = now()
  where user_id = p_user_id;

  insert into public.credit_ledger (
    user_id,
    type,
    credits_delta,
    description,
    metadata,
    amount_cents,
    currency,
    stripe_payment_intent_id,
    stripe_event_id,
    idempotency_key,
    balance_after
  ) values (
    p_user_id,
    p_type,
    p_delta,
    p_description,
    coalesce(p_metadata, '{}'::jsonb),
    p_amount_cents,
    coalesce(p_currency, 'usd'),
    p_stripe_payment_intent_id,
    p_stripe_event_id,
    p_idempotency_key,
    new_balance
  )
  returning * into entry;

  return entry;
end;
$$;
