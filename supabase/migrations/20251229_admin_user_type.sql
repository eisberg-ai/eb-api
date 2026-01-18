-- Add admin user type for privileged actions.

alter table public.user_profiles add column if not exists user_type text default 'user';
update public.user_profiles set user_type = 'user' where user_type is null;
alter table public.user_profiles drop constraint if exists user_profiles_user_type_check;
alter table public.user_profiles add constraint user_profiles_user_type_check
  check (user_type in ('user','admin'));

create or replace function public.is_admin_user(p_user_id uuid)
returns boolean
language sql
security definer
as $$
  select exists (
    select 1 from public.user_profiles
    where user_id = p_user_id and user_type = 'admin'
  );
$$;
