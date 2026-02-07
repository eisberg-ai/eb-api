-- Gallery voting primitives and aggregates.
create table if not exists public.gallery_project_votes (
  project_id text not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists gallery_project_votes_project_idx
  on public.gallery_project_votes (project_id, created_at desc);

create index if not exists gallery_project_votes_user_idx
  on public.gallery_project_votes (user_id, created_at desc);

alter table public.gallery_project_votes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'gallery_project_votes'
      and policyname = 'gallery_project_votes_select_own'
  ) then
    create policy gallery_project_votes_select_own
      on public.gallery_project_votes
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'gallery_project_votes'
      and policyname = 'gallery_project_votes_insert_own'
  ) then
    create policy gallery_project_votes_insert_own
      on public.gallery_project_votes
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'gallery_project_votes'
      and policyname = 'gallery_project_votes_delete_own'
  ) then
    create policy gallery_project_votes_delete_own
      on public.gallery_project_votes
      for delete
      using (auth.uid() = user_id);
  end if;
end $$;

create or replace function public.gallery_vote_totals(project_ids text[])
returns table(project_id text, vote_count bigint)
language sql
stable
as $$
  select
    v.project_id,
    count(*)::bigint as vote_count
  from public.gallery_project_votes v
  where project_ids is not null
    and cardinality(project_ids) > 0
    and v.project_id = any(project_ids)
  group by v.project_id;
$$;

grant execute on function public.gallery_vote_totals(text[]) to anon, authenticated, service_role;
