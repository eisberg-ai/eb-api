-- Add project_services and media tables for service management and media storage

-- drop old services table if it exists (replaced by code-based service definitions)
drop table if exists public.services cascade;

-- project_services table for tracking enabled services per project
create table if not exists public.project_services (
  project_id text not null references public.projects(id) on delete cascade,
  service_stub text not null,
  config jsonb,
  enabled_at timestamptz default now(),
  primary key (project_id, service_stub)
);

create index if not exists idx_project_services_project on public.project_services(project_id);
create index if not exists idx_project_services_stub on public.project_services(service_stub);

-- media table for uploaded audio and images
create table if not exists public.media (
  id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('audio', 'image')),
  r2_key text not null,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_media_project on public.media(project_id);
create index if not exists idx_media_owner on public.media(owner_user_id);
create index if not exists idx_media_type on public.media(type);

-- RLS for project_services (users can manage services for their projects)
alter table public.project_services enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='project_services' and policyname='project_services_select') then
    create policy project_services_select on public.project_services
      for select using (public.is_project_member(project_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='project_services' and policyname='project_services_insert') then
    create policy project_services_insert on public.project_services
      for insert with check (public.is_project_member(project_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='project_services' and policyname='project_services_update') then
    create policy project_services_update on public.project_services
      for update using (public.is_project_member(project_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='project_services' and policyname='project_services_delete') then
    create policy project_services_delete on public.project_services
      for delete using (public.is_project_member(project_id));
  end if;
end $$;

-- RLS for media (users can only access their own project media)
alter table public.media enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='media' and policyname='media_select') then
    create policy media_select on public.media
      for select using (public.is_project_member(project_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='media' and policyname='media_insert') then
    create policy media_insert on public.media
      for insert with check (auth.uid() = owner_user_id and public.is_project_member(project_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='media' and policyname='media_delete') then
    create policy media_delete on public.media
      for delete using (auth.uid() = owner_user_id);
  end if;
end $$;










