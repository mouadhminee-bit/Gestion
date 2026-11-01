-- =============================================================================
-- PROFIL « supabase-like » — RÉSERVÉ AUX TESTS LOCAUX (PG_PROFILE=supabase-like)
--
-- Exécuté par le superutilisateur `supabase_admin` après auth_shim.sql. Reproduit la
-- répartition des privilèges de Supabase qui a fait échouer la 1re exécution réelle :
--  * `postgres` n'est PAS superutilisateur ; il possède la base et applique les migrations ;
--  * les extensions sont créées par le superutilisateur (comme supautils) : `postgres`
--    n'en possède pas les fonctions, et dblink_connect_u lui est refusé ;
--  * `postgres` peut endosser anon / authenticated / service_role et agir sur auth.users ;
--  * rôle `authenticator` (PostgREST).
-- NE JAMAIS APPLIQUER À SUPABASE.
-- =============================================================================

-- Comme Supabase (PostgreSQL ≥ 16, migration 20250605172253) : option ADMIN.
grant anon, authenticated, service_role to postgres with admin option;

grant usage on schema auth to postgres;
grant all on table auth.users to postgres;
grant execute on function auth.uid(), auth.jwt() to postgres;

-- Privilèges par défaut que Supabase applique aux objets créés par postgres.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

-- dblink créé par le superutilisateur dans un schéma appartenant à postgres (supautils).
create schema tests_dblink authorization postgres;
create extension dblink schema tests_dblink;
