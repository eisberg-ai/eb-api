-- Service invocation tracking: add counter and timestamp to project_services
alter table public.project_services
  add column if not exists invocation_count bigint not null default 0,
  add column if not exists last_invoked_at timestamptz;

-- Helper function to atomically increment invocation count
create or replace function public.increment_service_invocation(
  p_project_id text,
  p_service_stub text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_project_id is null or p_service_stub is null then
    raise exception 'project_id and service_stub are required';
  end if;

  update public.project_services
  set invocation_count = invocation_count + 1,
      last_invoked_at = now()
  where project_id = p_project_id
    and service_stub = p_service_stub;
end;
$$;

revoke all on function public.increment_service_invocation(text, text) from public;
grant execute on function public.increment_service_invocation(text, text) to service_role;
