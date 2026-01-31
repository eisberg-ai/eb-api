-- Scope project service keys to a specific service stub
alter table public.project_service_tokens
  add column if not exists service_stub text;

update public.project_service_tokens
  set service_stub = 'legacy'
  where service_stub is null;

alter table public.project_service_tokens
  drop constraint if exists project_service_tokens_pkey;

alter table public.project_service_tokens
  alter column service_stub set not null;

alter table public.project_service_tokens
  add primary key (project_id, service_stub);

create index if not exists idx_project_service_tokens_stub on public.project_service_tokens(service_stub);
