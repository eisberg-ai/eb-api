-- agent_version is only stored on builds, written by the worker
-- remove it from projects, jobs, and messages

alter table public.projects drop column if exists agent_version;
alter table public.jobs drop column if exists agent_version;
alter table public.messages drop column if exists agent_version;

-- ensure agent_version column exists on builds (may already exist)
alter table public.builds add column if not exists agent_version text;






