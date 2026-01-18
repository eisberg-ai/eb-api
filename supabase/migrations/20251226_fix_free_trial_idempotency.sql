-- Prevent free-trial credits from being re-granted when a user hits $0 and /billing/balance auto-initializes.
-- Also reconcile any credit_balances rows that were overwritten without a matching ledger entry.

create or replace function public.initialize_free_trial(p_user_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  existing_balance numeric;
  new_workspace_id uuid;
  workspaces_exist boolean;
  credit_balances_exist boolean;
  credit_ledger_exist boolean;
  free_credits numeric := 2.5; -- $2.50 free credits
  trial_already_granted boolean;
begin
  raise notice '[initialize_free_trial] starting for user_id: %', p_user_id;

  -- check if tables exist
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'workspaces'
  ) into workspaces_exist;
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'credit_balances'
  ) into credit_balances_exist;
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'credit_ledger'
  ) into credit_ledger_exist;

  raise notice
    '[initialize_free_trial] workspaces_exist: %, credit_balances_exist: %, credit_ledger_exist: %',
    workspaces_exist,
    credit_balances_exist,
    credit_ledger_exist;

  -- ensure subscription record exists
  begin
    insert into public.user_subscriptions (user_id, plan_key, status)
    values (p_user_id, 'free', 'active')
    on conflict (user_id) do nothing;
    raise notice '[initialize_free_trial] user_subscriptions record created/updated';
  exception when others then
    raise warning '[initialize_free_trial] error inserting user_subscriptions: % - %', sqlstate, sqlerrm;
  end;

  -- create "My Workspace" for new user if workspaces table exists
  if workspaces_exist then
    raise notice '[initialize_free_trial] checking for existing workspace';
    select id into new_workspace_id from public.workspaces where owner_user_id = p_user_id limit 1;
    if new_workspace_id is null then
      raise notice '[initialize_free_trial] creating new workspace';
      new_workspace_id := gen_random_uuid();
      begin
        insert into public.workspaces (id, name, owner_user_id, created_at)
        values (new_workspace_id, 'My Workspace', p_user_id, now())
        on conflict (id) do nothing;
        raise notice '[initialize_free_trial] workspace created with id: %', new_workspace_id;
        if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'workspace_members') then
          insert into public.workspace_members (workspace_id, user_id, role, status, created_at)
          values (new_workspace_id, p_user_id, 'owner', 'active', now())
          on conflict (workspace_id, user_id) do nothing;
          raise notice '[initialize_free_trial] workspace_member created';
        else
          raise notice '[initialize_free_trial] workspace_members table does not exist, skipping';
        end if;
      exception when others then
        raise warning '[initialize_free_trial] error creating workspace: % - %', sqlstate, sqlerrm;
      end;
    else
      raise notice '[initialize_free_trial] workspace already exists: %', new_workspace_id;
    end if;
  else
    raise notice '[initialize_free_trial] workspaces table does not exist, skipping workspace creation';
  end if;

  -- initialize credits if tables exist
  if credit_balances_exist then
    raise notice '[initialize_free_trial] checking credit balance';
    begin
      -- ensure credit_balances row exists so balance lookups are stable
      insert into public.credit_balances (user_id, balance)
      values (p_user_id, 0.0)
      on conflict (user_id) do nothing;

      select balance into existing_balance from public.credit_balances where user_id = p_user_id;
      raise notice '[initialize_free_trial] existing_balance: %', existing_balance;

      trial_already_granted := false;
      if credit_ledger_exist then
        select exists (
          select 1
          from public.credit_ledger
          where user_id = p_user_id
            and (
              idempotency_key = 'free_trial'
              or (type = 'purchase' and description = 'Free trial credits')
              or (metadata ->> 'source') = 'free_trial'
            )
        ) into trial_already_granted;
      end if;

      if (existing_balance is null or existing_balance = 0.0) and not trial_already_granted then
        raise notice '[initialize_free_trial] granting free trial credits: $%', free_credits;
        if credit_ledger_exist then
          -- use the ledgered credit delta function so credit_balances stays consistent.
          perform public.apply_credit_delta(
            p_user_id,
            free_credits,
            'purchase',
            'Free trial credits',
            jsonb_build_object('source', 'free_trial'),
            null,
            'usd',
            null,
            null,
            'free_trial'
          );
          raise notice '[initialize_free_trial] credit_ledger entry created (if needed)';
        else
          -- fallback: no ledger table, just set balances.
          update public.credit_balances
          set balance = free_credits, updated_at = now()
          where user_id = p_user_id;
          raise notice '[initialize_free_trial] credit_balances updated (no ledger table)';
        end if;
      else
        raise notice '[initialize_free_trial] free trial already granted or user has credits; skipping grant';
      end if;
    exception when others then
      raise warning '[initialize_free_trial] error with credits: % - %', sqlstate, sqlerrm;
    end;
  else
    raise notice '[initialize_free_trial] credit_balances table does not exist, skipping credit initialization';
  end if;

  raise notice '[initialize_free_trial] completed successfully for user_id: %', p_user_id;
end;
$$;

-- Reconcile any credit_balances rows that were overwritten without a matching ledger entry.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'credit_balances')
    and exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'credit_ledger')
  then
    with latest as (
      select distinct on (user_id) user_id, balance_after
      from public.credit_ledger
      order by user_id, created_at desc
    )
    update public.credit_balances cb
    set balance = latest.balance_after,
        updated_at = now()
    from latest
    where cb.user_id = latest.user_id
      and cb.balance is distinct from latest.balance_after;
  end if;
end $$;

