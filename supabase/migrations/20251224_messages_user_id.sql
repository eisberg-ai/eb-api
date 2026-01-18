-- add user_id to messages and drop redundant author column
alter table public.messages add column if not exists user_id uuid;
alter table public.messages drop column if exists author;
