-- subscription tracking table
create table if not exists public.user_subscriptions (
  user_id uuid primary key references auth.users on delete cascade,
  plan_key text not null default 'free',
  stripe_subscription_id text unique,
  stripe_customer_id text,
  status text not null default 'active', -- active, canceled, past_due, etc
  current_period_start timestamptz,
  current_period_end timestamptz,
  credits_allocated_this_period numeric(19,4) default 0.0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_subscriptions_stripe_subscription_idx on public.user_subscriptions(stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists user_subscriptions_stripe_customer_idx on public.user_subscriptions(stripe_customer_id) where stripe_customer_id is not null;

alter table public.user_subscriptions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_subscriptions' and policyname='user_subscriptions_select_self') then
    create policy user_subscriptions_select_self on public.user_subscriptions
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- function to initialize free trial for new users
create or replace function public.initialize_free_trial(p_user_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  existing_balance numeric;
  workspace_id uuid;
  workspaces_exist boolean;
  credit_tables_exist boolean;
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

  -- create private "My Workspace" for new user if workspaces table exists
  if workspaces_exist then
    raise notice '[initialize_free_trial] checking for existing workspace';
    select id into workspace_id from public.workspaces where owner_user_id = p_user_id and is_private = true limit 1;
    if workspace_id is null then
      raise notice '[initialize_free_trial] creating new workspace';
      workspace_id := gen_random_uuid();
      begin
        insert into public.workspaces (id, name, owner_user_id, is_private, created_at)
        values (workspace_id, 'My Workspace', p_user_id, true, now())
        on conflict (id) do nothing;
        raise notice '[initialize_free_trial] workspace created with id: %', workspace_id;
        if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'workspace_members') then
          insert into public.workspace_members (workspace_id, user_id, role, status, created_at)
          values (workspace_id, p_user_id, 'owner', 'active', now())
          on conflict (workspace_id, user_id) do nothing;
          raise notice '[initialize_free_trial] workspace_member created';
        else
          raise notice '[initialize_free_trial] workspace_members table does not exist, skipping';
        end if;
      exception when others then
        raise warning '[initialize_free_trial] error creating workspace: % - %', sqlstate, sqlerrm;
      end;
    else
      raise notice '[initialize_free_trial] workspace already exists: %', workspace_id;
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
        raise notice '[initialize_free_trial] granting free trial credits';
        -- grant $20 free trial credits
        insert into public.credit_balances (user_id, balance)
        values (p_user_id, 20.0)
        on conflict (user_id) do update set balance = 20.0;
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
            20.0,
            'Free trial credits',
            jsonb_build_object('source', 'free_trial'),
            20.0
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

-- trigger to initialize free trial when user is created
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  raise notice '[handle_new_user] trigger fired for user_id: %', new.id;
  raise notice '[handle_new_user] user email: %', new.email;
  begin
    perform public.initialize_free_trial(new.id);
    raise notice '[handle_new_user] initialize_free_trial completed successfully';
  exception when others then
    raise warning '[handle_new_user] error in initialize_free_trial: % - %', sqlstate, sqlerrm;
    -- don't fail user creation if initialization fails
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();



