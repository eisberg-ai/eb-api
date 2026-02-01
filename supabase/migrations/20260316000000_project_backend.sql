alter table public.projects
  add column if not exists backend_enabled boolean default false;

alter table public.projects
  add column if not exists backend_app_id uuid;

create unique index if not exists projects_backend_app_id_idx
  on public.projects (backend_app_id)
  where backend_app_id is not null;
