-- Allow draft status for projects.
alter table public.projects add column if not exists status text default 'active';
alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check
  check (status in ('draft', 'active', 'building', 'failed', 'archived'));
