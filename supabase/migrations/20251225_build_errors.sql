do $$
begin
  create type public.build_error_code as enum (
    'insufficient_balance',
    'dependency_install_failed',
    'worker_error',
    'unknown'
  );
exception
  when duplicate_object then null;
end
$$;

alter table public.builds
  add column if not exists error_code public.build_error_code,
  add column if not exists error_message text,
  add column if not exists retry_of_build_id text references public.builds(id) on delete set null;

create index if not exists builds_retry_of_idx on public.builds (retry_of_build_id);

-- best-effort backfill from legacy metadata.error if it matches known codes
update public.builds
set error_code = (metadata->>'error')::public.build_error_code
where error_code is null
  and metadata ? 'error'
  and (metadata->>'error') in (
    'insufficient_balance',
    'dependency_install_failed',
    'worker_error',
    'unknown'
  );

