-- Projects with ownership
create table if not exists public.projects (
  id text primary key,
  owner_user_id uuid references auth.users not null,
  current_version_number int,
  latest_build_id text,
  created_at timestamptz default now()
);

-- Project members (optional collaborators)
create table if not exists public.project_members (
  project_id text references public.projects(id) on delete cascade,
  user_id uuid references auth.users on delete cascade,
  role text check (role in ('owner','editor','viewer')) default 'editor',
  created_at timestamptz default now(),
  primary key (project_id, user_id)
);

-- Jobs queue
create table if not exists public.jobs (
  job_id text primary key,
  project_id text references public.projects(id) on delete cascade,
  status text check (status in ('queued','claimed','running','succeeded','failed')) default 'queued',
  payload jsonb,
  claimed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists jobs_status_created_idx on public.jobs (status, created_at);

-- Builds (also the promoted versions when is_promoted = true)
create table if not exists public.builds (
  id text primary key,
  project_id text references public.projects(id) on delete cascade,
  version_number int,
  status text check (status in ('queued','running','succeeded','failed')) default 'queued',
  is_promoted boolean default false,
  tasks jsonb,
  artifacts jsonb,
  source text,
  source_encoding text default 'base64',
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists builds_proj_created_idx on public.builds (project_id, created_at);
create index if not exists builds_promoted_idx on public.builds (project_id, is_promoted, version_number);

-- Build steps (per-build status)
create table if not exists public.build_steps (
  project_id text references public.projects(id) on delete cascade,
  build_id text references public.builds(id) on delete cascade,
  step_id text,
  title text,
  status text check (status in ('pending','in_progress','completed','failed')),
  message text,
  updated_at timestamptz default now(),
  primary key (project_id, build_id, step_id)
);

-- Messages (chat + build/action events)
create table if not exists public.messages (
  id text primary key,
  project_id text references public.projects(id) on delete cascade,
  type text check (type in ('text','build','action')),
  author text,
  content text,
  build_id text references public.builds(id),
  version_number int,
  metadata jsonb,
  created_at timestamptz default now()
);
create index if not exists messages_project_created_idx on public.messages (project_id, created_at);

-- Enable RLS
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.jobs enable row level security;
alter table public.builds enable row level security;
alter table public.build_steps enable row level security;
alter table public.messages enable row level security;

-- Helper function for membership
create or replace function public.is_project_member(pid text)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.projects p
    where p.id = pid and p.owner_user_id = auth.uid()
  )
  or exists (
    select 1 from public.project_members pm
    where pm.project_id = pid and pm.user_id = auth.uid()
  );
$$;

-- Policies: allow owners/members; service role bypasses RLS automatically
do $$
begin
  -- projects
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='projects_owner_member_select') then
    create policy projects_owner_member_select on public.projects
      for select using (public.is_project_member(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='projects_owner_insert') then
    create policy projects_owner_insert on public.projects
      for insert with check (auth.uid() = owner_user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='projects_owner_update') then
    create policy projects_owner_update on public.projects
      for update using (auth.uid() = owner_user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='projects_owner_delete') then
    create policy projects_owner_delete on public.projects
      for delete using (auth.uid() = owner_user_id);
  end if;

  -- project_members
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='project_members' and policyname='project_members_owner_member') then
    create policy project_members_owner_member on public.project_members
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;

  -- jobs
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='jobs' and policyname='jobs_owner_member') then
    create policy jobs_owner_member on public.jobs
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;

  -- builds
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='builds' and policyname='builds_owner_member') then
    create policy builds_owner_member on public.builds
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;

  -- build_steps
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='build_steps' and policyname='build_steps_owner_member') then
    create policy build_steps_owner_member on public.build_steps
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;

  -- messages
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='messages' and policyname='messages_owner_member') then
    create policy messages_owner_member on public.messages
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;
end $$;
