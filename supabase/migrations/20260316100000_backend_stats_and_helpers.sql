-- Backend function invocation stats
create table if not exists public.backend_function_stats (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null,
  function_name text not null,
  invocation_count bigint not null default 0,
  last_invoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique(app_id, function_name)
);

create index if not exists backend_function_stats_app_id_idx
  on public.backend_function_stats(app_id);

-- Helper function to get table stats for a schema
create or replace function public.get_schema_table_stats(schema_name text)
returns table(table_name text, row_count bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if schema_name is null then
    raise exception 'schema_name is required';
  end if;
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  return query
    select
      c.relname::text as table_name,
      c.reltuples::bigint as row_count
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = schema_name
      and c.relkind = 'r';
end;
$$;

revoke all on function public.get_schema_table_stats(text) from public;
grant execute on function public.get_schema_table_stats(text) to service_role;

-- Helper function to drop an app schema
create or replace function public.drop_app_schema(app_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  app_id_norm text;
  schema_name text;
begin
  if app_id is null then
    raise exception 'app_id is required';
  end if;
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  app_id_norm := replace(app_id::text, '-', '');
  schema_name := format('app_%s', app_id_norm);

  execute format('drop schema if exists %I cascade', schema_name);
end;
$$;

revoke all on function public.drop_app_schema(uuid) from public;
grant execute on function public.drop_app_schema(uuid) to service_role;

-- Helper function to increment function invocation count
create or replace function public.increment_function_invocation(
  p_app_id uuid,
  p_function_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_app_id is null or p_function_name is null then
    raise exception 'app_id and function_name are required';
  end if;

  insert into public.backend_function_stats (app_id, function_name, invocation_count, last_invoked_at)
  values (p_app_id, p_function_name, 1, now())
  on conflict (app_id, function_name)
  do update set
    invocation_count = backend_function_stats.invocation_count + 1,
    last_invoked_at = now();
end;
$$;

revoke all on function public.increment_function_invocation(uuid, text) from public;
grant execute on function public.increment_function_invocation(uuid, text) to service_role;
