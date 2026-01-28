-- Ensure messages.id has a unique constraint for upserts.
create unique index if not exists messages_id_unique_idx on public.messages (id);
