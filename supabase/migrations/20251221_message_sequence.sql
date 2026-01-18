-- add sequence number for proper message ordering within a project
alter table public.messages add column if not exists sequence_number serial;

-- create index for efficient ordering
create index if not exists idx_messages_project_sequence
  on public.messages(project_id, sequence_number);

-- backfill existing messages with sequence based on created_at and id
with numbered as (
  select id, row_number() over (
    partition by project_id
    order by created_at asc, id asc
  ) as seq
  from public.messages
)
update public.messages m
set sequence_number = n.seq
from numbered n
where m.id = n.id;






