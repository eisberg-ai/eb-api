-- Reset schema for projects/jobs/builds/messages with Supabase auth ownership

-- Clean out prior tables/functions/policies we don't use anymore
drop table if exists public.build_steps cascade;
drop table if exists public.messages cascade;
drop table if exists public.builds cascade;
drop table if exists public.jobs cascade;
drop table if exists public.project_members cascade;
drop table if exists public.projects cascade;

-- legacy chat tables from early prototype
drop table if exists public.response_session_steps cascade;
drop table if exists public.response_sessions cascade;
drop table if exists public.conversations cascade;
drop function if exists public.update_updated_at_column cascade;

-- helper
drop function if exists public.is_project_member(text);

-- Projects
create table public.projects (
  id text primary key,
  name text,
  owner_user_id uuid references auth.users not null,
  current_version_number int,
  latest_build_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Project collaborators removed - using workspaces instead

-- Jobs queue
create table public.jobs (
  job_id text primary key,
  project_id text references public.projects(id) on delete cascade,
  status text check (status in ('queued','claimed','running','succeeded','failed')) default 'queued',
  payload jsonb,
  result jsonb,
  claimed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index jobs_status_created_idx on public.jobs (status, created_at);

-- Builds (also serve as versions when is_promoted = true)
create table public.builds (
  id text primary key,
  job_id text references public.jobs(job_id) on delete set null,
  project_id text references public.projects(id) on delete cascade,
  version_number int,
  is_promoted boolean default false,
  status text check (status in ('queued','running','succeeded','failed')) default 'queued',
  artifacts jsonb,
  source text, -- raw source archive/base64
  source_encoding text default 'base64',
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index builds_proj_created_idx on public.builds (project_id, created_at);
create index builds_promoted_idx on public.builds (project_id, is_promoted, coalesce(version_number, 0));

-- Messages tied to a project/build
create table public.messages (
  id text primary key,
  project_id text references public.projects(id) on delete cascade,
  build_id text references public.builds(id) on delete set null,
  role text check (role in ('user','agent')) not null,
  type text not null,
  content jsonb not null,
  attachments jsonb,
  model text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  sequence_number bigserial,
  constraint messages_agent_build_check check (role <> 'agent' or build_id is not null),
  constraint messages_content_array_check check (jsonb_typeof(content) = 'array')
);
create index messages_project_sequence_idx on public.messages (project_id, sequence_number);
create index messages_build_created_idx on public.messages (build_id, created_at);

-- Environment variables per project and service
create table public.env_vars (
  id uuid primary key default gen_random_uuid(),
  project_id text references public.projects(id) on delete cascade,
  service text not null,
  key text not null,
  value text not null,
  created_at timestamptz default now()
);
create index env_vars_project_idx on public.env_vars (project_id, service, created_at);

-- RLS: enable and add helper
alter table public.projects enable row level security;
-- project_members table removed
alter table public.jobs enable row level security;
alter table public.builds enable row level security;
alter table public.messages enable row level security;
alter table public.env_vars enable row level security;

create or replace function public.is_project_member(pid text)
returns boolean
language plpgsql
security definer
stable
as $$
begin
  -- check if user is project owner
  if exists (
    select 1 from public.projects p
    where p.id = pid and p.owner_user_id = auth.uid()
  ) then
    return true;
  end if;
  -- check if user is workspace member (if workspaces exist)
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'workspaces'
  ) then
    return exists (
      select 1 from public.projects p
      join public.workspaces w on w.id = p.workspace_id
      join public.workspace_members wm on wm.workspace_id = w.id
      where p.id = pid
      and wm.user_id = auth.uid()
      and wm.status = 'active'
    );
  end if;
  return false;
end;
$$;

do $$
begin
  -- projects
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='projects_select') then
    create policy projects_select on public.projects
      for select using (public.is_project_member(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='projects_insert') then
    create policy projects_insert on public.projects
      for insert with check (auth.uid() = owner_user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='projects_update') then
    create policy projects_update on public.projects
      for update using (auth.uid() = owner_user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='projects_delete') then
    create policy projects_delete on public.projects
      for delete using (auth.uid() = owner_user_id);
  end if;

  -- project_members removed - using workspaces instead

  -- jobs
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='jobs' and policyname='jobs_rw') then
    create policy jobs_rw on public.jobs
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;

  -- builds
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='builds' and policyname='builds_rw') then
    create policy builds_rw on public.builds
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;

  -- messages
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='messages' and policyname='messages_rw') then
    create policy messages_rw on public.messages
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;
  -- env_vars
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='env_vars' and policyname='env_vars_rw') then
    create policy env_vars_rw on public.env_vars
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;
end $$;
