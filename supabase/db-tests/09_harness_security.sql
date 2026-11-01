-- =============================================================================
-- 09 — Sécurité de l'outillage de test lui-même (dblink et fonctions d'aide)
--
-- L'outillage ne doit ouvrir AUCUN privilège supplémentaire aux rôles applicatifs : en
-- particulier, ni anon ni authenticated ne peuvent ouvrir une connexion dblink, et
-- dblink_connect_u (connexion sans mot de passe) n'est accessible à aucun rôle non
-- superutilisateur. Les assertions RLS des fichiers 01 à 08 ne dépendent pas de dblink.
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  sch text := tests.dblink_schema();
  r record;
  n int;
begin
  perform tests.eq(sch, 'tests_dblink', 'dblink installé dans le schéma dédié tests_dblink');
  select count(*) into n from pg_depend d join pg_extension e on e.oid = d.refobjid
    join pg_proc p on p.oid = d.objid
    where d.classid = 'pg_proc'::regclass and d.deptype = 'e' and e.extname = 'dblink'
      and p.pronamespace = 'tests'::regnamespace;
  perform tests.eq(n, 0, 'aucune fonction de l''extension dblink dans le schéma tests (ouvert aux rôles applicatifs)');
  for r in select * from (values ('anon'), ('authenticated')) x(role) loop
    perform tests.ok(not has_schema_privilege(r.role, 'tests_dblink', 'USAGE'), format('%s : aucun accès au schéma tests_dblink', r.role));
    perform tests.ok(not has_schema_privilege(r.role, 'tests_dblink', 'CREATE'), format('%s : aucune création dans tests_dblink', r.role));
  end loop;
  for r in select * from (values ('anon'), ('authenticated'), ('service_role')) x(role) loop
    perform tests.ok(not has_function_privilege(r.role, 'tests_dblink.dblink_connect_u(text, text)', 'EXECUTE')
                 and not has_function_privilege(r.role, 'tests_dblink.dblink_connect_u(text)', 'EXECUTE'),
      format('%s : dblink_connect_u non exécutable', r.role));
  end loop;
  select count(*) into n from pg_proc p where p.pronamespace = 'tests'::regnamespace and p.prosecdef;
  perform tests.eq(n, 0, 'aucune fonction SECURITY DEFINER dans l''outillage de test (schéma tests)');
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by 1) into sch
    from pg_proc p where p.pronamespace = 'tests_dblink'::regnamespace and p.prosecdef;
  perform tests.eq(sch, 'dblink_connect_u(text), dblink_connect_u(text, text)',
    'tests_dblink : seules les fonctions SECURITY DEFINER de l''extension sont dblink_connect_u (inaccessibles, ci-dessus)');

  -- Tentatives réelles d'un utilisateur authentifié et d'anon
  perform tests.as_user(gen_random_uuid());
  perform tests.throws('select tests.db_connect(''intrus'')', 'authenticated : ouverture d''une session dblink refusée', 'P0001');
  perform tests.throws('select tests_dblink.dblink_connect(''intrus'', ''host=127.0.0.1'')', 'authenticated : appel direct de dblink_connect refusé', '42501');
  perform tests.throws('select tests_dblink.dblink_connect_u(''intrus'', ''host=127.0.0.1'')', 'authenticated : appel direct de dblink_connect_u refusé', '42501');
  perform tests.as_anon();
  perform tests.throws('select tests_dblink.dblink_connect(''intrus'', ''host=127.0.0.1'')', 'anon : appel direct de dblink_connect refusé', '42501');
  perform tests.as_admin();
end $$;
