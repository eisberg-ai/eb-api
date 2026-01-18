-- add is_private flag to workspaces and drop project_members compatibility view

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'workspaces') then
    alter table public.workspaces add column if not exists is_private boolean default false;
  end if;
end $$;

-- drop project_members table completely
drop table if exists public.project_members cascade;
drop view if exists public.project_members cascade;
