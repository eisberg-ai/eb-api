-- Add 'file' type to media table for reference files, PDFs, etc.
-- drop all existing type constraints (they may have auto-generated names)
do $$
declare
  r record;
begin
  for r in (
    select constraint_name
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'media'
      and constraint_type = 'CHECK'
      and constraint_name like '%type%'
  ) loop
    execute format('alter table public.media drop constraint if exists %I', r.constraint_name);
  end loop;
end $$;
alter table public.media add constraint media_type_check check (type in ('audio', 'image', 'file'));








