-- Increase credit precision for tiny LLM charges and update apply_credit_delta to use numeric amounts.

do $$
begin
  if exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'credit_ledger'
  ) then
    -- drop the existing check constraint so we can change column types safely
    alter table public.credit_ledger drop constraint if exists credit_ledger_credits_delta_check;
    alter table public.credit_ledger alter column credits_delta type numeric(20,8) using credits_delta::numeric(20,8);
    alter table public.credit_ledger alter column balance_after type numeric(20,8) using balance_after::numeric(20,8);
    alter table public.credit_ledger add constraint credit_ledger_credits_delta_check check (credits_delta <> 0);
  end if;

  if exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'credit_balances'
  ) then
    alter table public.credit_balances alter column balance type numeric(20,8) using balance::numeric(20,8);
    alter table public.credit_balances alter column balance set default 0.0;
  end if;
end $$;

-- remove the legacy integer signature so callers always use the high-precision version
drop function if exists public.apply_credit_delta(
  uuid, integer, text, text, jsonb, integer, text, text, text, text
);

create or replace function public.apply_credit_delta(
  p_user_id uuid,
  p_delta numeric(20,8),
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
  current_balance numeric(20,8);
  new_balance numeric(20,8);
  entry public.credit_ledger;
begin
  if p_type not in ('purchase','spend','adjustment') then
    raise exception 'invalid_type';
  end if;
  if coalesce(p_delta, 0) = 0 then
    raise exception 'credits_delta_must_be_nonzero';
  end if;

  if p_idempotency_key is not null then
    select * into entry
    from public.credit_ledger
    where user_id = p_user_id and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return entry;
    end if;
  end if;

  if p_stripe_event_id is not null then
    select * into entry
    from public.credit_ledger
    where stripe_event_id = p_stripe_event_id
    limit 1;
    if found then
      return entry;
    end if;
  end if;

  insert into public.credit_balances (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select balance into current_balance
  from public.credit_balances
  where user_id = p_user_id
  for update;

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
  )
  values (
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
