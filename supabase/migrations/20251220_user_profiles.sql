-- user profiles table for tracking user state and preferences
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users on delete cascade,
  is_first_login boolean not null default true,
  current_workspace_id uuid references public.workspaces(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

-- users can read their own profile
create policy user_profiles_select_self on public.user_profiles
  for select using (auth.uid() = user_id);

-- users can update their own profile
create policy user_profiles_update_self on public.user_profiles
  for update using (auth.uid() = user_id);

-- update initialize_free_trial to create profile with current_workspace_id
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
  profiles_exist boolean;
  free_credits numeric := 2.5;
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
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'user_profiles'
  ) into profiles_exist;
  raise notice '[initialize_free_trial] workspaces: %, credits: %, profiles: %', workspaces_exist, credit_tables_exist, profiles_exist;
  -- ensure subscription record exists
  begin
    insert into public.user_subscriptions (user_id, plan_key, status)
    values (p_user_id, 'free', 'active')
    on conflict (user_id) do nothing;
    raise notice '[initialize_free_trial] user_subscriptions record created/updated';
  exception when others then
    raise warning '[initialize_free_trial] error inserting user_subscriptions: % - %', sqlstate, sqlerrm;
  end;
  -- create default workspace for new user
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
        end if;
      exception when others then
        raise warning '[initialize_free_trial] error creating workspace: % - %', sqlstate, sqlerrm;
      end;
    else
      raise notice '[initialize_free_trial] workspace already exists: %', new_workspace_id;
    end if;
  end if;
  -- create user profile with current_workspace_id
  if profiles_exist and new_workspace_id is not null then
    begin
      insert into public.user_profiles (user_id, is_first_login, current_workspace_id)
      values (p_user_id, true, new_workspace_id)
      on conflict (user_id) do update set
        current_workspace_id = coalesce(public.user_profiles.current_workspace_id, new_workspace_id);
      raise notice '[initialize_free_trial] user_profile created/updated';
    exception when others then
      raise warning '[initialize_free_trial] error creating profile: % - %', sqlstate, sqlerrm;
    end;
  end if;
  -- grant free credits
  if credit_tables_exist then
    raise notice '[initialize_free_trial] checking credit balance';
    begin
      select balance into existing_balance from public.credit_balances where user_id = p_user_id;
      if existing_balance is null or existing_balance = 0.0 then
        raise notice '[initialize_free_trial] granting free trial credits: $%', free_credits;
        insert into public.credit_balances (user_id, balance)
        values (p_user_id, free_credits)
        on conflict (user_id) do update set balance = free_credits;
        if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'credit_ledger') then
          insert into public.credit_ledger (
            user_id, type, credits_delta, description, metadata, balance_after
          )
          select p_user_id, 'purchase', free_credits, 'Free trial credits',
            jsonb_build_object('source', 'free_trial'), free_credits
          where not exists (
            select 1 from public.credit_ledger
            where user_id = p_user_id and type = 'purchase' and description = 'Free trial credits'
          );
        end if;
      end if;
    exception when others then
      raise warning '[initialize_free_trial] error with credits: % - %', sqlstate, sqlerrm;
    end;
  end if;
  raise notice '[initialize_free_trial] completed for user_id: %', p_user_id;
end;
$$;






