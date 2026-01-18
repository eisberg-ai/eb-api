-- update free trial credits to $2.50 (from $20)
create or replace function public.initialize_free_trial(p_user_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  existing_balance numeric;
  new_workspace_id uuid;
  workspaces_exist boolean;
  credit_tables_exist boolean;
  free_credits numeric := 2.5; -- $2.50 free credits
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
  ) into credit_tables_exist;
  raise notice '[initialize_free_trial] workspaces_exist: %, credit_tables_exist: %', workspaces_exist, credit_tables_exist;
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
  -- check if user already has credits (if credit tables exist)
  if credit_tables_exist then
    raise notice '[initialize_free_trial] checking credit balance';
    begin
      select balance into existing_balance from public.credit_balances where user_id = p_user_id;
      raise notice '[initialize_free_trial] existing_balance: %', existing_balance;
      if existing_balance is null or existing_balance = 0.0 then
        raise notice '[initialize_free_trial] granting free trial credits: $%', free_credits;
        insert into public.credit_balances (user_id, balance)
        values (p_user_id, free_credits)
        on conflict (user_id) do update set balance = free_credits;
        raise notice '[initialize_free_trial] credit_balances updated';
        -- create ledger entry for free trial (only if doesn't exist)
        if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'credit_ledger') then
          insert into public.credit_ledger (
            user_id,
            type,
            credits_delta,
            description,
            metadata,
            balance_after
          )
          select
            p_user_id,
            'purchase',
            free_credits,
            'Free trial credits',
            jsonb_build_object('source', 'free_trial'),
            free_credits
          where not exists (
            select 1 from public.credit_ledger
            where user_id = p_user_id
            and type = 'purchase'
            and description = 'Free trial credits'
          );
          raise notice '[initialize_free_trial] credit_ledger entry created (if needed)';
        else
          raise notice '[initialize_free_trial] credit_ledger table does not exist, skipping';
        end if;
      else
        raise notice '[initialize_free_trial] user already has credits: %, skipping grant', existing_balance;
      end if;
    exception when others then
      raise warning '[initialize_free_trial] error with credits: % - %', sqlstate, sqlerrm;
    end;
  else
    raise notice '[initialize_free_trial] credit tables do not exist, skipping credit initialization';
  end if;
  raise notice '[initialize_free_trial] completed successfully for user_id: %', p_user_id;
end;
$$;






