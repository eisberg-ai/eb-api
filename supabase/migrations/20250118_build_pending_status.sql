-- add 'pending' status and metadata column to builds

-- add metadata column
alter table public.builds add column if not exists metadata jsonb;

-- update status constraint to include 'pending'
alter table public.builds drop constraint if exists builds_status_check;
alter table public.builds add constraint builds_status_check
  check (status in ('pending','queued','running','succeeded','failed'));

-- add index for job_id lookup
create index if not exists builds_job_id_idx on public.builds (job_id);
