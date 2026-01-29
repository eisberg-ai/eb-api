-- Add workspaces, workspace_members, project status/visibility, and model selection metadata.

-- workspaces
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  owner_user_id uuid references auth.users on delete cascade,
  billing_plan text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- workspace membership (replaces project_members)
create table if not exists public.workspace_members (
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users on delete cascade,
  role text check (role in ('owner','admin','editor','viewer')) default 'editor',
  status text check (status in ('active','invited','disabled')) default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (workspace_id, user_id)
);

-- project metadata: workspace, status, visibility, model selection, agent version
alter table public.projects add column if not exists workspace_id uuid;
alter table public.projects add column if not exists status text check (status in ('active','building','failed','archived')) default 'active';
alter table public.projects add column if not exists is_public boolean default false;
alter table public.projects add column if not exists last_build_started_at timestamptz;
alter table public.projects add column if not exists last_build_finished_at timestamptz;
alter table public.projects add column if not exists model_level text check (model_level in ('low','medium','high','extra_high')) default 'low';
alter table public.projects add column if not exists model_alias text;
alter table public.projects add column if not exists agent_version text;

-- model selection per job/build/message/version
alter table public.jobs add column if not exists model_level text check (model_level in ('low','medium','high','extra_high')) default 'low';
alter table public.jobs add column if not exists model_alias text;
alter table public.jobs add column if not exists agent_version text;
alter table public.jobs add column if not exists workspace_id uuid;

alter table public.builds add column if not exists model_level text check (model_level in ('low','medium','high','extra_high')) default 'low';
alter table public.builds add column if not exists model_alias text;
alter table public.builds add column if not exists agent_version text;
alter table public.builds add column if not exists workspace_id uuid;

alter table public.messages add column if not exists model_level text check (model_level in ('low','medium','high','extra_high'));
alter table public.messages add column if not exists model_alias text;
alter table public.messages add column if not exists agent_version text;

do $$
begin
  if to_regclass('public.build_steps') is not null then
    alter table public.build_steps add column if not exists workspace_id uuid;
  end if;
end $$;

alter table public.env_vars add column if not exists workspace_id uuid;

-- backfill workspace_id for existing projects and seed workspaces/members
update public.projects
  set workspace_id = coalesce(workspace_id, gen_random_uuid())
  where workspace_id is null;

insert into public.workspaces (id, name, owner_user_id, created_at)
select distinct p.workspace_id, coalesce(p.name, concat('Workspace ', p.id)), p.owner_user_id, coalesce(p.created_at, now())
from public.projects p
on conflict (id) do nothing;

-- owner is also a member
insert into public.workspace_members (workspace_id, user_id, role, status, created_at)
select distinct p.workspace_id, p.owner_user_id, 'owner', 'active', coalesce(p.created_at, now())
from public.projects p
where p.workspace_id is not null and p.owner_user_id is not null
on conflict (workspace_id, user_id) do nothing;

-- drop project_members table and view if they exist
drop table if exists public.project_members cascade;
drop view if exists public.project_members cascade;

-- helper functions for RLS
create or replace function public.is_workspace_member(wid uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = wid and w.owner_user_id = auth.uid()
  )
  or exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = wid and wm.user_id = auth.uid() and wm.status = 'active'
  );
$$;

create or replace function public.is_project_member(pid text)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = pid
      and public.is_workspace_member(p.workspace_id)
  );
$$;

-- RLS for new tables
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='workspaces' and policyname='workspaces_owner_member_select') then
    create policy workspaces_owner_member_select on public.workspaces
      for select using (public.is_workspace_member(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='workspaces' and policyname='workspaces_owner_insert') then
    create policy workspaces_owner_insert on public.workspaces
      for insert with check (auth.uid() = owner_user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='workspaces' and policyname='workspaces_owner_update') then
    create policy workspaces_owner_update on public.workspaces
      for update using (auth.uid() = owner_user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='workspaces' and policyname='workspaces_owner_delete') then
    create policy workspaces_owner_delete on public.workspaces
      for delete using (auth.uid() = owner_user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='workspace_members' and policyname='workspace_members_rw') then
    create policy workspace_members_rw on public.workspace_members
      using (public.is_workspace_member(workspace_id))
      with check (public.is_workspace_member(workspace_id));
  end if;
end $$;

-- refresh dependent policies to use new is_project_member
do $$
begin
  -- projects
  perform null;
  -- these will be recreated if missing, otherwise existing policies continue to call is_project_member
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
      for update using (public.is_project_member(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='projects_delete') then
    create policy projects_delete on public.projects
      for delete using (auth.uid() = owner_user_id);
  end if;

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

  -- build_steps
  if to_regclass('public.build_steps') is not null then
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='build_steps' and policyname='build_steps_rw') then
      create policy build_steps_rw on public.build_steps
        using (public.is_project_member(project_id))
        with check (public.is_project_member(project_id));
    end if;
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
