alter table public.user_profiles
  drop constraint if exists user_profiles_join_method_check;

alter table public.user_profiles
  add constraint user_profiles_join_method_check
  check (join_method in ('waitlist', 'invite', 'promo') or join_method is null);
