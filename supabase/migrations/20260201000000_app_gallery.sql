-- App gallery metadata + semantic cache

create extension if not exists vector;

alter table public.projects
  add column if not exists is_gallery boolean default false;

alter table public.projects
  add column if not exists gallery_slug text;

alter table public.projects
  add column if not exists gallery jsonb;

create unique index if not exists projects_gallery_slug_idx
  on public.projects (gallery_slug)
  where gallery_slug is not null;

create table if not exists public.app_gallery_cache (
  id uuid primary key default gen_random_uuid(),
  project_id text references public.projects(id) on delete cascade,
  query_text text not null,
  query_hash text not null,
  query_embedding vector(1536),
  response jsonb not null,
  response_summary text,
  model text,
  agent_version text,
  template_version text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists app_gallery_cache_project_idx
  on public.app_gallery_cache (project_id);

create index if not exists app_gallery_cache_query_hash_idx
  on public.app_gallery_cache (project_id, query_hash);

create index if not exists app_gallery_cache_embedding_idx
  on public.app_gallery_cache
  using ivfflat (query_embedding vector_cosine_ops)
  with (lists = 100);

create or replace function public.match_gallery_cache(
  embedding vector(1536),
  match_project_id text,
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  project_id text,
  query_text text,
  query_hash text,
  response jsonb,
  response_summary text,
  model text,
  agent_version text,
  template_version text,
  created_at timestamptz,
  score float
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.query_text,
    c.query_hash,
    c.response,
    c.response_summary,
    c.model,
    c.agent_version,
    c.template_version,
    c.created_at,
    1 - (c.query_embedding <=> embedding) as score
  from public.app_gallery_cache c
  where c.project_id = match_project_id
    and c.query_embedding is not null
    and 1 - (c.query_embedding <=> embedding) >= match_threshold
  order by c.query_embedding <=> embedding
  limit match_count;
$$;
