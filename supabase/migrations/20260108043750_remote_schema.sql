drop extension if exists "pg_net";

drop policy "publish_sessions_rw" on "public"."publish_sessions";

revoke delete on table "public"."publish_secrets" from "anon";

revoke insert on table "public"."publish_secrets" from "anon";

revoke references on table "public"."publish_secrets" from "anon";

revoke select on table "public"."publish_secrets" from "anon";

revoke trigger on table "public"."publish_secrets" from "anon";

revoke truncate on table "public"."publish_secrets" from "anon";

revoke update on table "public"."publish_secrets" from "anon";

revoke delete on table "public"."publish_secrets" from "authenticated";

revoke insert on table "public"."publish_secrets" from "authenticated";

revoke references on table "public"."publish_secrets" from "authenticated";

revoke select on table "public"."publish_secrets" from "authenticated";

revoke trigger on table "public"."publish_secrets" from "authenticated";

revoke truncate on table "public"."publish_secrets" from "authenticated";

revoke update on table "public"."publish_secrets" from "authenticated";

revoke delete on table "public"."publish_secrets" from "service_role";

revoke insert on table "public"."publish_secrets" from "service_role";

revoke references on table "public"."publish_secrets" from "service_role";

revoke select on table "public"."publish_secrets" from "service_role";

revoke trigger on table "public"."publish_secrets" from "service_role";

revoke truncate on table "public"."publish_secrets" from "service_role";

revoke update on table "public"."publish_secrets" from "service_role";

revoke delete on table "public"."publish_sessions" from "anon";

revoke insert on table "public"."publish_sessions" from "anon";

revoke references on table "public"."publish_sessions" from "anon";

revoke select on table "public"."publish_sessions" from "anon";

revoke trigger on table "public"."publish_sessions" from "anon";

revoke truncate on table "public"."publish_sessions" from "anon";

revoke update on table "public"."publish_sessions" from "anon";

revoke delete on table "public"."publish_sessions" from "authenticated";

revoke insert on table "public"."publish_sessions" from "authenticated";

revoke references on table "public"."publish_sessions" from "authenticated";

revoke select on table "public"."publish_sessions" from "authenticated";

revoke trigger on table "public"."publish_sessions" from "authenticated";

revoke truncate on table "public"."publish_sessions" from "authenticated";

revoke update on table "public"."publish_sessions" from "authenticated";

revoke delete on table "public"."publish_sessions" from "service_role";

revoke insert on table "public"."publish_sessions" from "service_role";

revoke references on table "public"."publish_sessions" from "service_role";

revoke select on table "public"."publish_sessions" from "service_role";

revoke trigger on table "public"."publish_sessions" from "service_role";

revoke truncate on table "public"."publish_sessions" from "service_role";

revoke update on table "public"."publish_sessions" from "service_role";

alter table "public"."publish_secrets" drop constraint "publish_secrets_user_id_fkey";

alter table "public"."publish_sessions" drop constraint "publish_sessions_project_id_fkey";

alter table "public"."publish_sessions" drop constraint "publish_sessions_secrets_id_fkey";

alter table "public"."publish_sessions" drop constraint "publish_sessions_status_check";

alter table "public"."publish_sessions" drop constraint "publish_sessions_user_id_fkey";

alter table "public"."builds" drop constraint "builds_status_check";

alter table "public"."publish_secrets" drop constraint "publish_secrets_pkey";

alter table "public"."publish_sessions" drop constraint "publish_sessions_pkey";

drop index if exists "public"."publish_secrets_pkey";

drop index if exists "public"."publish_sessions_pkey";

drop index if exists "public"."publish_sessions_project_idx";

drop index if exists "public"."publish_sessions_user_idx";

drop table "public"."publish_secrets";

drop table "public"."publish_sessions";

alter table "public"."builds" add constraint "builds_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))) not valid;

alter table "public"."builds" validate constraint "builds_status_check";


