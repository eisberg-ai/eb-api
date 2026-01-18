-- Job leases + heartbeat + killed status

alter table public.jobs add column if not exists worker_id text;
alter table public.jobs add column if not exists last_heartbeat timestamptz;

alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('queued','claimed','running','succeeded','failed','killed'));

create index if not exists jobs_last_heartbeat_idx on public.jobs (last_heartbeat);
create index if not exists jobs_worker_id_idx on public.jobs (worker_id);

create or replace function public.claim_next_job(
  p_project_id text default null,
  p_worker_id text default null
)
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
  v_requeue record;
  v_build_id text;
  v_project_id text;
  v_owner_user_id uuid;
  v_spent numeric(20,8);
  v_refunded numeric(20,8);
  v_refund numeric(20,8);
begin
  update public.jobs
     set status = 'killed',
         updated_at = now()
   where status in ('claimed','running')
     and coalesce(last_heartbeat, claimed_at, updated_at, created_at) < now() - interval '10 minutes';

  for v_requeue in
    select j.job_id, j.project_id
      from public.jobs j
     where j.status = 'killed'
       and j.updated_at < now() - interval '15 seconds'
     for update skip locked
  loop
    update public.jobs
       set status = 'queued',
           claimed_at = null,
           worker_id = null,
           last_heartbeat = null,
           result = null,
           updated_at = now()
     where job_id = v_requeue.job_id;

    select b.id, b.project_id
      into v_build_id, v_project_id
      from public.builds b
     where b.job_id = v_requeue.job_id
     order by b.created_at desc
     limit 1;

    if v_build_id is not null then
      update public.builds
         set status = 'queued',
             tasks = '[]'::jsonb,
             artifacts = null,
             started_at = null,
             ended_at = null,
             error_code = null,
             error_message = null,
             updated_at = now()
       where id = v_build_id;

      delete from public.build_steps where build_id = v_build_id;
      delete from public.messages where build_id = v_build_id and type = 'build';
    end if;

    if v_project_id is not null then
      update public.projects
         set status = 'building',
             updated_at = now()
       where id = v_project_id;
    end if;

    if v_build_id is not null then
      select p.owner_user_id
        into v_owner_user_id
        from public.projects p
       where p.id = v_project_id;
      if v_owner_user_id is not null then
        select coalesce(sum(-credits_delta), 0)
          into v_spent
          from public.credit_ledger
         where user_id = v_owner_user_id
           and type = 'spend'
           and (metadata->>'buildId') = v_build_id;
        select coalesce(sum(credits_delta), 0)
          into v_refunded
          from public.credit_ledger
         where user_id = v_owner_user_id
           and type = 'adjustment'
           and (metadata->>'buildId') = v_build_id
           and (metadata->>'reason') = 'killed_refund';
        v_refund := v_spent - v_refunded;
        if v_refund > 0 then
          perform public.apply_credit_delta(
            v_owner_user_id,
            v_refund,
            'adjustment',
            'Killed job refund',
            jsonb_build_object(
              'buildId', v_build_id,
              'jobId', v_requeue.job_id,
              'reason', 'killed_refund'
            ),
            null,
            'usd',
            null,
            null,
            concat('build-killed-refund-', v_build_id, '-', extract(epoch from now())::bigint)
          );
        end if;
      end if;
    end if;
  end loop;

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
         updated_at = now(),
         worker_id = p_worker_id,
         last_heartbeat = now()
   where j.job_id = v_job.job_id;

  return query
  select v_job.job_id, v_job.project_id, v_job.model, v_job.workspace_id, v_job.payload;
end;
$$;
