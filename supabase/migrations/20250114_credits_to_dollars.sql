-- Convert credit system from integer credits to dollar amounts (numeric)

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'credit_ledger') then
    -- drop the check constraint first so we can alter the column
    alter table public.credit_ledger drop constraint if exists credit_ledger_credits_delta_check;
    alter table public.credit_ledger alter column credits_delta type numeric(19,4) using credits_delta::numeric(19,4);
    alter table public.credit_ledger alter column balance_after type numeric(19,4) using balance_after::numeric(19,4);
    -- recreate the check constraint for credits_delta (non-zero)
    alter table public.credit_ledger add constraint credit_ledger_credits_delta_check check (credits_delta <> 0);
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'credit_balances') then
    -- convert balance columns to numeric (dollars)
    alter table public.credit_balances alter column balance type numeric(19,4) using balance::numeric(19,4);
    alter table public.credit_balances alter column balance set default 0.0;
  end if;
end $$;



