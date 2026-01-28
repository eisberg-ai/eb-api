-- Adjust vms table for VM pool allocation.
alter table public.vms drop constraint if exists vms_project_id_key;

alter table public.vms
  alter column project_id drop not null,
  add column if not exists instance_id text,
  add column if not exists base_url text,
  add column if not exists status text check (status in ('idle','busy','starting','error')) default 'idle';

create unique index if not exists vms_instance_id_idx on public.vms (instance_id);
create index if not exists vms_status_idx on public.vms (status);
