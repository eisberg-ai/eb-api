-- Project-level service tokens for external service proxy usage
create table if not exists public.project_service_tokens (
  project_id text primary key references public.projects(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_used_at timestamptz
);

create index if not exists idx_project_service_tokens_hash on public.project_service_tokens(token_hash);

alter table public.project_service_tokens enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='project_service_tokens' and policyname='project_service_tokens_select') then
    create policy project_service_tokens_select on public.project_service_tokens
      for select using (public.is_project_member(project_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='project_service_tokens' and policyname='project_service_tokens_insert') then
    create policy project_service_tokens_insert on public.project_service_tokens
      for insert with check (public.is_project_member(project_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='project_service_tokens' and policyname='project_service_tokens_update') then
    create policy project_service_tokens_update on public.project_service_tokens
      for update using (public.is_project_member(project_id));
  end if;
end $$;
