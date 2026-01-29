create table if not exists public.app_users (
  app_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (app_id, user_id)
);

create index if not exists app_users_user_id_idx on public.app_users(user_id);

create or replace function public.create_app_schema(app_id uuid, create_items boolean default false)
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

  execute format('create schema if not exists %I', schema_name);
  execute format('grant usage on schema %I to service_role', schema_name);
  execute format('grant all on all tables in schema %I to service_role', schema_name);
  execute format('grant all on all sequences in schema %I to service_role', schema_name);

  if create_items then
    execute format(
      'create table if not exists %I.items (
        id uuid primary key default gen_random_uuid(),
        label text not null,
        created_at timestamptz not null default now()
      )',
      schema_name
    );
    execute format('grant all on %I.items to service_role', schema_name);
  end if;
end;
$$;

revoke all on function public.create_app_schema(uuid, boolean) from public;
grant execute on function public.create_app_schema(uuid, boolean) to service_role;

-- PoC fixtures so PostgREST can boot with app schemas listed in config.toml.
create schema if not exists app_11111111111111111111111111111111;
grant usage on schema app_11111111111111111111111111111111 to service_role;
create table if not exists app_11111111111111111111111111111111.items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  created_at timestamptz not null default now()
);
grant all on app_11111111111111111111111111111111.items to service_role;

create schema if not exists app_22222222222222222222222222222222;
grant usage on schema app_22222222222222222222222222222222 to service_role;
create table if not exists app_22222222222222222222222222222222.items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  created_at timestamptz not null default now()
);
grant all on app_22222222222222222222222222222222.items to service_role;
