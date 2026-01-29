-- consolidate model_level + model_alias into just model (the alias)
-- the model alias is the source of truth; model_level is no longer used

-- rename model_alias to model on all tables when model doesn't already exist,
-- otherwise drop model_alias to avoid conflicts during reset.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'projects' and column_name = 'model_alias'
  ) then
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'projects' and column_name = 'model'
    ) then
      alter table public.projects drop column model_alias;
    else
      alter table public.projects rename column model_alias to model;
    end if;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'jobs' and column_name = 'model_alias'
  ) then
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'jobs' and column_name = 'model'
    ) then
      alter table public.jobs drop column model_alias;
    else
      alter table public.jobs rename column model_alias to model;
    end if;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'builds' and column_name = 'model_alias'
  ) then
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'builds' and column_name = 'model'
    ) then
      alter table public.builds drop column model_alias;
    else
      alter table public.builds rename column model_alias to model;
    end if;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'messages' and column_name = 'model_alias'
  ) then
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'messages' and column_name = 'model'
    ) then
      alter table public.messages drop column model_alias;
    else
      alter table public.messages rename column model_alias to model;
    end if;
  end if;
end $$;

-- drop model_level columns (no longer used - model selection is by alias)
alter table public.projects drop column if exists model_level;
alter table public.jobs drop column if exists model_level;
alter table public.builds drop column if exists model_level;
alter table public.messages drop column if exists model_level;





