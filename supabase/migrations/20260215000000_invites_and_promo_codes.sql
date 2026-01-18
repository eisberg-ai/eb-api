create table if not exists public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  created_by uuid references auth.users on delete set null,
  created_by_role text not null default 'user',
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  redeemed_by uuid references auth.users on delete set null,
  redeemed_email text,
  redeemed_at timestamptz,
  max_uses integer not null default 1,
  uses_count integer not null default 0
);

alter table public.invite_codes
  drop constraint if exists invite_codes_role_check;

alter table public.invite_codes
  add constraint invite_codes_role_check
  check (created_by_role in ('user', 'admin', 'system'));

create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  credits numeric not null,
  created_by uuid references auth.users on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  redeemed_by uuid references auth.users on delete set null,
  redeemed_email text,
  redeemed_at timestamptz
);

alter table public.user_profiles add column if not exists join_method text;
alter table public.user_profiles add column if not exists join_code text;
alter table public.user_profiles add column if not exists invites_total integer not null default 5;
alter table public.user_profiles add column if not exists invites_used integer not null default 0;

alter table public.user_profiles
  drop constraint if exists user_profiles_join_method_check;

alter table public.user_profiles
  add constraint user_profiles_join_method_check
  check (join_method in ('waitlist', 'invite') or join_method is null);

alter table public.user_profiles
  drop constraint if exists user_profiles_invites_check;

alter table public.user_profiles
  add constraint user_profiles_invites_check
  check (invites_total >= 0 and invites_used >= 0 and invites_used <= invites_total);

create index if not exists invite_codes_created_by_idx on public.invite_codes (created_by);
create index if not exists invite_codes_redeemed_by_idx on public.invite_codes (redeemed_by);
create index if not exists promo_codes_redeemed_by_idx on public.promo_codes (redeemed_by);
