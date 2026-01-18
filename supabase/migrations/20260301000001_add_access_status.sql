alter table public.user_profiles
  add column if not exists access_status text default 'pending';

alter table public.user_profiles
  add column if not exists access_status_updated_at timestamptz;

alter table public.user_profiles
  add column if not exists approved_at timestamptz;

alter table public.user_profiles
  add column if not exists approved_by uuid references auth.users on delete set null;

alter table public.user_profiles
  add column if not exists denied_at timestamptz;

alter table public.user_profiles
  add column if not exists denied_by uuid references auth.users on delete set null;

update public.user_profiles
  set access_status = 'pending'
  where access_status is null;

alter table public.user_profiles
  drop constraint if exists user_profiles_access_status_check;

alter table public.user_profiles
  add constraint user_profiles_access_status_check
  check (access_status in ('pending', 'approved', 'denied'));
