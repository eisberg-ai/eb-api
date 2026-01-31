-- Add enable/disable controls to project services
alter table public.project_services
  add column if not exists enabled boolean default true,
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_reason text;
