create table if not exists public.preview_shares (
  token_hash text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  build_id text not null references public.builds(id) on delete cascade,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  last_accessed_at timestamptz,
  revoked_at timestamptz
);

create index if not exists preview_shares_project_id_idx on public.preview_shares(project_id);
create index if not exists preview_shares_build_id_idx on public.preview_shares(build_id);

alter table public.preview_shares enable row level security;
