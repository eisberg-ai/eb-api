-- Speed up authored-project lookups when user_id exists.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'messages'
      and column_name = 'user_id'
  ) then
    create index if not exists idx_messages_user_project
      on public.messages (user_id, project_id)
      where user_id is not null;
  end if;
end $$;
