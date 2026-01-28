-- Add vms table for per-project Cloud Run runtimes
create table if not exists public.vms (
  id uuid primary key default gen_random_uuid(),
  project_id text references public.projects(id) on delete cascade unique,
  mode text check (mode in ('stopped','serving','building')) default 'stopped',
  desired_build_id text references public.builds(id) on delete set null,
  service_name text,
  region text,
  runtime_state text check (runtime_state in ('stopped','starting','serving','building','stopping','error')) default 'stopped',
  lease_owner text,
  lease_expires_at timestamptz,
  last_start_at timestamptz,
  last_shutdown_at timestamptz,
  last_heartbeat_at timestamptz,
  current_source_tar_gz text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists vms_project_id_idx on public.vms (project_id);

alter table public.vms enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'vms' and policyname = 'vms_rw'
  ) then
    create policy vms_rw on public.vms
      using (public.is_project_member(project_id))
      with check (public.is_project_member(project_id));
  end if;
end $$;
