-- Add attachments column to messages table
alter table public.messages add column if not exists attachments jsonb;


