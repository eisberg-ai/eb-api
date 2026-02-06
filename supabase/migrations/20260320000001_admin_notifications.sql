create table if not exists public.notification_broadcasts (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references auth.users on delete set null,
  created_by_email text,
  title text not null,
  body text not null,
  type text not null default 'admin_broadcast',
  action jsonb,
  audience text not null,
  audience_filter jsonb,
  sent_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists notification_broadcasts_created_idx
  on public.notification_broadcasts(created_at desc);

alter table public.notification_broadcasts enable row level security;

alter table public.notifications
  add column if not exists broadcast_id uuid references public.notification_broadcasts(id) on delete set null;

create index if not exists notifications_broadcast_idx
  on public.notifications(broadcast_id);
