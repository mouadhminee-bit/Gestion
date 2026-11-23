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

  -- Sérialisation des flottants : origine du réglage extra_float_digits (texte / JSON).
  select format('valeur=%s, source=%s, fichier=%s:%s, défaut compilé=%s', setting, source,
      coalesce(sourcefile, '—'), coalesce(sourceline::text, '—'), boot_val)
    into v from pg_settings where name = 'extra_float_digits';
  perform tests.ok(true, 'CONSTAT extra_float_digits de la session d''administration', v);
  select coalesce(string_agg(format('%s / %s : %s',
      coalesce((select datname from pg_database where oid = s.setdatabase), 'toutes bases'),
      coalesce(pg_get_userbyid(nullif(s.setrole, 0)), 'tous rôles'), array_to_string(s.setconfig, ', ')), ' ; '), 'aucun')
    into v from pg_db_role_setting s;
  perform tests.ok(true, 'CONSTAT réglages par base / par rôle (pg_db_role_setting)', v);

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
  -- RPC exposées : exactement les deux portes du protocole ChangeSet (migration 8) et la
  -- récupération des changements (migration 9, V4.1 / M9), exécutables par authenticated
  -- seulement (ni anon, ni service_role, ni PUBLIC — malgré les privilèges par défaut de la
  -- plateforme sur les fonctions de public), toutes propriété de nexora_writer.
  perform tests.eq((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
    'apply_changeset, pull_changes, resolve_changeset', 'Q5 fonctions RPC dans public : apply_changeset, pull_changes et resolve_changeset uniquement');
  for r in select p.oid, p.proname, p.proacl, pg_get_userbyid(p.proowner) as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' loop
    perform tests.ok(has_function_privilege('authenticated', r.oid, 'EXECUTE') and not has_function_privilege('anon', r.oid, 'EXECUTE')
        and not has_function_privilege('service_role', r.oid, 'EXECUTE')
        and not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0),
      format('Q5 %s : exécutable par authenticated seulement', r.proname), r.proacl::text);
    perform tests.eq(r.owner, 'nexora_writer', format('Q5 %s : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme)', r.proname));
  end loop;
  -- P13 : rôle d'écriture et limites d'exécution de la plateforme (constats).
  select format('superuser=%s, bypassrls=%s, login=%s, inherit=%s', rolsuper, rolbypassrls, rolcanlogin, rolinherit) into v from pg_roles where rolname = 'nexora_writer';
  perform tests.ok(true, 'CONSTAT P13 rôle nexora_writer', v);
  perform tests.ok((select not rolsuper and not rolbypassrls and not rolcanlogin from pg_roles where rolname = 'nexora_writer'),
    'P13 nexora_writer : ni superutilisateur, ni BYPASSRLS, ni connexion');
  perform tests.ok(not pg_has_role('authenticator', 'nexora_writer', 'MEMBER') and not pg_has_role('authenticated', 'nexora_writer', 'MEMBER')
      and not pg_has_role('anon', 'nexora_writer', 'MEMBER'), 'P13 ni authenticator, ni authenticated, ni anon ne sont membres de nexora_writer');
  select coalesce(string_agg(format('%s : %s', rolname, array_to_string(rolconfig, ', ')), ' ; ' order by rolname), 'aucun') into v
    from pg_roles where rolname in ('anon', 'authenticated', 'authenticator', 'service_role', 'nexora_writer') and rolconfig is not null;
  perform tests.ok(true, 'CONSTAT P13 réglages des rôles de l''API (statement_timeout, lock_timeout…)', v);
end $$;
