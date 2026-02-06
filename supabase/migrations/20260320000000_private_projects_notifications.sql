-- private project expiry fields
alter table public.projects
  add column if not exists private_pending_expiry boolean default false;

alter table public.projects
  add column if not exists private_expiry_at timestamptz;

-- notifications table
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  project_id text references public.projects(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  action jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  expires_at timestamptz
);

create index if not exists notifications_user_created_idx
  on public.notifications(user_id, created_at desc);

create index if not exists notifications_user_read_idx
  on public.notifications(user_id, read_at);

alter table public.notifications enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'notifications'
      and policyname = 'notifications_select_self'
  ) then
    create policy notifications_select_self
      on public.notifications
      for select using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'notifications'
      and policyname = 'notifications_update_self'
  ) then
    create policy notifications_update_self
      on public.notifications
      for update using (auth.uid() = user_id);
  end if;
end $$;

-- device tokens for native notifications
create table if not exists public.notification_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  device_token text not null,
  platform text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz
);

create unique index if not exists notification_devices_user_token_idx
  on public.notification_devices(user_id, device_token);

alter table public.notification_devices enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'notification_devices'
      and policyname = 'notification_devices_select_self'
  ) then
    create policy notification_devices_select_self
      on public.notification_devices
      for select using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'notification_devices'
      and policyname = 'notification_devices_insert_self'
  ) then
    create policy notification_devices_insert_self
      on public.notification_devices
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'notification_devices'
      and policyname = 'notification_devices_update_self'
  ) then
    create policy notification_devices_update_self
      on public.notification_devices
      for update using (auth.uid() = user_id);
  end if;
end $$;
