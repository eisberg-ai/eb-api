-- Add attachments column to messages table if it doesn't exist
-- This ensures the column exists even if reset_schema was run
alter table public.messages add column if not exists attachments jsonb;









