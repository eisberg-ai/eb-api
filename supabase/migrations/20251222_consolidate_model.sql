-- consolidate model_level + model_alias into just model (the alias)
-- the model alias is the source of truth; model_level is no longer used

-- rename model_alias to model on all tables
alter table public.projects rename column model_alias to model;
alter table public.jobs rename column model_alias to model;
alter table public.builds rename column model_alias to model;
alter table public.messages rename column model_alias to model;

-- drop model_level columns (no longer used - model selection is by alias)
alter table public.projects drop column if exists model_level;
alter table public.jobs drop column if exists model_level;
alter table public.builds drop column if exists model_level;
alter table public.messages drop column if exists model_level;






