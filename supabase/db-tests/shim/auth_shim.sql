-- =============================================================================
-- ÉMULATION SUPABASE — RÉSERVÉE AUX TESTS LOCAUX (scripts/db-test.sh)
--
-- NE JAMAIS APPLIQUER À UN PROJET SUPABASE : ces objets y existent déjà.
-- Reproduit le strict nécessaire pour exécuter les migrations et tester la RLS :
--  * rôles anon / authenticated / service_role (comme Supabase) ;
--  * privilèges par défaut de Supabase sur le schéma public (tout accordé aux trois
--    rôles) — afin que les tests vérifient que les migrations les RÉVOQUENT bien ;
--  * schéma auth : table auth.users, fonctions auth.uid() et auth.jwt() lisant les
--    réglages request.jwt.claim(s) exactement comme PostgREST/Supabase.
-- =============================================================================

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
-- Rôle de connexion de PostgREST : membre des rôles qu'il endosse (comme Supabase).
create role authenticator nologin noinherit;
grant anon, authenticated, service_role to authenticator;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  aud text,
  role text,
  created_at timestamptz not null default now()
);

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
