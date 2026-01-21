-- Add build dependency chain for follow-up message queueing.
-- Pending builds with depends_on_build_id wait for their dependency to complete.

alter table public.builds add column if not exists depends_on_build_id text references public.builds(id) on delete set null;
create index if not exists builds_depends_on_idx on public.builds(depends_on_build_id);
