-- Atomic job claim for concurrent workers

create or replace function public.claim_next_job(p_project_id text default null)
returns table (
  job_id text,
  project_id text,
  model text,
  workspace_id uuid,
  payload jsonb
)
language plpgsql
security definer
as $$
declare
  v_job public.jobs%rowtype;
begin
  select *
    into v_job
    from public.jobs j
   where j.status = 'queued'
     and (p_project_id is null or j.project_id = p_project_id)
   order by j.created_at asc
   for update skip locked
   limit 1;

  if not found then
    return;
  end if;

  update public.jobs j
     set status = 'claimed',
         claimed_at = now(),
         updated_at = now()
   where j.job_id = v_job.job_id;

  return query
  select v_job.job_id, v_job.project_id, v_job.model, v_job.workspace_id, v_job.payload;
end;
$$;
