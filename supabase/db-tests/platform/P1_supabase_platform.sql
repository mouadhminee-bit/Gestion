-- =============================================================================
-- P1 — Contrôles propres à la plateforme Supabase (exécuté UNIQUEMENT par
-- scripts/qualify-supabase.sh, sur la pile Supabase locale ; jamais en mode éphémère).
-- Les lignes « CONSTAT » consignent une réponse (Q1…Q6 de docs/LOT3B_PLAN.md) sans
-- conditionner la réussite ; les autres sont de vraies assertions.
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  r record;
  v text;
begin
  perform tests.ok(true, 'CONSTAT version du serveur', version());

  -- Modèle de rôles Supabase
  for r in select * from (values ('anon'), ('authenticated'), ('service_role'), ('authenticator')) x(name) loop
    perform tests.ok(exists (select 1 from pg_roles where rolname = r.name), format('rôle %s présent', r.name));
  end loop;
  perform tests.ok((select not rolcanlogin from pg_roles where rolname = 'anon'), 'anon : pas de connexion directe');
  perform tests.ok((select not rolcanlogin from pg_roles where rolname = 'authenticated'), 'authenticated : pas de connexion directe');
  perform tests.ok((select not rolbypassrls from pg_roles where rolname = 'anon'), 'anon : soumis à la RLS');
  perform tests.ok((select not rolbypassrls from pg_roles where rolname = 'authenticated'), 'authenticated : soumis à la RLS');
  perform tests.ok((select rolbypassrls from pg_roles where rolname = 'service_role'), 'service_role : contourne la RLS (clé serveur uniquement)');
  for r in select * from (values ('anon'), ('authenticated')) x(name) loop
    perform tests.ok(exists (select 1 from pg_roles where rolname = 'authenticator') and pg_has_role('authenticator', r.name, 'MEMBER'),
      format('authenticator (PostgREST) peut endosser %s', r.name));
  end loop;

  -- Q1 : le propriétaire des tables contourne-t-il la RLS forcée ?
  select format('postgres : superuser=%s, bypassrls=%s ; rôle administrateur des tests = %s',
      rolsuper, rolbypassrls, (select admin_role from tests.config))
    into v from pg_roles where rolname = 'postgres';
  perform tests.ok(true, 'CONSTAT Q1 rôle postgres et RLS forcée', v);
  perform tests.ok((select tableowner from pg_tables where schemaname = 'public' and tablename = 'transactions') is not null,
    'CONSTAT propriétaire des tables', (select tableowner from pg_tables where schemaname = 'public' and tablename = 'transactions'));

  -- Q2 : déclencheur sur auth.users accepté par la plateforme
  perform tests.ok(exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created'),
    'Q2 déclencheur on_auth_user_created présent sur auth.users');

  -- Q3 : création directe d'un utilisateur fictif dans auth.users (sinon les suites 02-08 auraient échoué)
  perform tests.ok(exists (select 1 from auth.users where email like '%@example.test'), 'Q3 utilisateurs fictifs créés directement dans auth.users');
  perform tests.eq((select count(*) from auth.users where email not like '%@example.test'), 0::bigint,
    'base de qualification : aucun utilisateur autre que les comptes fictifs');

  -- Q4 : dblink (sessions concurrentes de la suite 07)
  perform tests.ok(exists (select 1 from pg_extension where extname = 'dblink'), 'Q4 dblink disponible (suite de synchronisation exécutée)');

  -- Q5 : surfaces d'accès propres à Supabase
  select string_agg(extname || ' ' || extversion, ', ' order by extname) into v from pg_extension;
  perform tests.ok(true, 'CONSTAT extensions installées', v);
  select string_agg(evtname, ', ' order by evtname) into v from pg_event_trigger;
  perform tests.ok(true, 'CONSTAT déclencheurs d''événements', coalesce(v, 'aucun'));
  select string_agg(format('%s → %s (%s)', pg_get_userbyid(defaclrole), coalesce(n.nspname, '*'), defaclacl::text), ' ; ')
    into v from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'public' or n.nspname is null;
  perform tests.ok(true, 'CONSTAT Q5 privilèges par défaut sur public (révoqués table par table par la migration 6)', coalesce(v, 'aucun'));
  for r in select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' loop
    perform tests.ok(not has_table_privilege('anon', r.oid, 'SELECT') and not has_table_privilege('anon', r.oid, 'INSERT'),
      format('Q5 %s : invisible pour anon (API REST et GraphQL)', r.relname));
  end loop;
  perform tests.ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname = 'public'), 'Q5 aucune fonction RPC dans public');
end $$;
