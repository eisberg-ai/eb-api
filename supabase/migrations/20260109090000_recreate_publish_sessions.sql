-- Recreate publish sessions/secrets tables dropped by remote schema snapshot

create table if not exists public.publish_secrets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  payload_encrypted text not null,
  key_id text not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.publish_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id text references public.projects(id) on delete cascade,
  user_id uuid references auth.users on delete set null,
  status text not null default 'draft' check (status in ('draft','submitting','failed','submitted')),
  active_step integer not null default 0,
  form_data jsonb not null default '{}'::jsonb,
  logs jsonb not null default '[]'::jsonb,
  last_error text,
  secrets_id uuid references public.publish_secrets(id) on delete set null,
  secrets_meta jsonb not null default '{}'::jsonb,
  submission_started_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'workspaces') then
    alter table public.publish_sessions
      add column if not exists workspace_id uuid references public.workspaces(id) on delete set null;
  else
    alter table public.publish_sessions
      add column if not exists workspace_id uuid;
  end if;
end $$;

create index if not exists publish_sessions_project_idx on public.publish_sessions (project_id, created_at desc);
create index if not exists publish_sessions_user_idx on public.publish_sessions (user_id, created_at desc);

alter table public.publish_sessions enable row level security;
alter table public.publish_secrets enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='publish_sessions' and policyname='publish_sessions_rw') then
    create policy publish_sessions_rw on public.publish_sessions
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;
end $$;
