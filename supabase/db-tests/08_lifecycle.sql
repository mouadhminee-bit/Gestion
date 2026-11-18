-- =============================================================================
-- 08 — Cycle de vie du compte, profils, fonctions privilégiées
-- =============================================================================
\set ON_ERROR_STOP on

-- Inscription : profil créé, rien d'autre (ensureUser crée paramètres et catégories).
do $$
declare
  u uuid := tests.new_user('Sara');
  r record;
begin
  select * into r from public.profiles where id = u;
  perform tests.ok(found, 'inscription : profil créé automatiquement');
  perform tests.eq(r.display_name, 'Sara', 'inscription : nom repris des métadonnées d''inscription');
  perform tests.eq(r.version, 1::bigint, 'inscription : version 1');
  perform tests.eq((select count(*) from public.user_settings where user_id = u), 0::bigint,
    'inscription : AUCUN user_settings pré-créé (sinon ensureUser ne créerait pas les catégories initiales)');
end $$;

-- Profils : lecture de son seul profil ; écriture par le protocole uniquement, limitée au nom
-- de son propre profil ; ni création, ni suppression, ni autre colonne.
do $$
declare
  a uuid := tests.new_user('pa');
  b uuid := tests.new_user('pb');
  n bigint;
  p jsonb;
begin
  perform tests.as_user(b);
  select count(*) into n from public.profiles;
  perform tests.eq(n, 1::bigint, 'profiles : B ne voit que son profil');
  -- Écritures directes : refusées par privilège.
  perform tests.throws(format('update public.profiles set display_name = ''x'' where id = %L', a), 'profiles : UPDATE direct refusé (profil de A)', '42501');
  perform tests.throws(format('update public.profiles set display_name = ''x'' where id = %L', b), 'profiles : UPDATE direct refusé (son propre profil)', '42501');
  perform tests.throws(format('insert into public.profiles (id, display_name) values (%L, ''x'')', gen_random_uuid()), 'profiles : insertion refusée au client', '42501');
  perform tests.throws(format('delete from public.profiles where id = %L', b), 'profiles : suppression refusée au client', '42501');
  -- Par le protocole.
  p := jsonb_build_object('table', 'profiles', 'type', 'put', 'key', jsonb_build_object('id', b), 'expectedVersion', 1,
    'row', jsonb_build_object('id', b, 'display_name', 'Nouveau nom'));
  perform tests.cs_lives(tests.cs(b, jsonb_build_array(p)), 'profiles : B renomme son profil');
  perform tests.cs_throws(tests.cs(b, jsonb_build_array(jsonb_set(jsonb_set(p, '{key,id}', to_jsonb(a)), '{row,id}', to_jsonb(a)))),
    'profiles : B ne modifie pas le profil de A', 'unauthorized');
  perform tests.cs_throws(tests.cs(b, jsonb_build_array(jsonb_set(p, '{row,created_at}', '"2020-01-01T00:00:00Z"'))),
    'profiles : created_at non modifiable (colonne hors protocole)', 'invalid_row');
  perform tests.cs_throws(tests.cs(b, jsonb_build_array(jsonb_build_object('table', 'profiles', 'type', 'delete', 'key', jsonb_build_object('id', b), 'expectedVersion', 1))),
    'profiles : suppression refusée par le protocole', 'invalid_operation');
  perform tests.cs_throws(tests.cs(b, jsonb_build_array(jsonb_set(p, '{expectedVersion}', 'null'))),
    'profiles : création refusée par le protocole (le profil existe, créé à l''inscription)', 'version_conflict');
  perform tests.as_admin();
  perform tests.eq((select display_name from public.profiles where id = a), 'pa', 'profiles : profil de A intact');
  -- Déclencheur (administrateur) : identifiant et date d'inscription immuables.
  -- (date fixe : now() est l'horodatage de la transaction, donc déjà la valeur du profil créé ci-dessus)
  perform tests.throws(format('update public.profiles set created_at = ''2000-01-01T00:00:00Z'' where id = %L', b), 'profiles : created_at immuable (déclencheur)', '42501');
  perform tests.throws(format('update public.profiles set id = gen_random_uuid() where id = %L', b), 'profiles : id immuable (déclencheur)', '42501');
end $$;

-- Suppression du compte : toutes ses lignes (y compris supprimées logiquement)
-- disparaissent ; celles des autres utilisateurs sont intactes.
do $$
declare
  a uuid := tests.new_user('del-a');
  b uuid := tests.new_user('del-b');
  t record;
  na bigint;
  nb_before bigint;
  nb_after bigint;
  total_a bigint := 0;
begin
  perform tests.seed(a);
  perform tests.seed(b);
  update public.accounts set deleted_at = now() where user_id = a;
  -- Un lot appliqué par A et un par B : le suivi des lots (private.changesets) suit le compte.
  perform tests.as_user(a);
  perform tests.cs_lives(tests.cs(a, jsonb_build_array(tests.cs_put('public.exchange_rates', jsonb_build_object('id', gen_random_uuid(), 'user_id', a,
    'base', 'USD', 'quote', 'MAD', 'rate', 9.9, 'date', '2026-03-01', 'source', 'manual', 'created_at', '2026-10-31T12:00:00.000Z')))), 'lot appliqué par A', true);
  perform tests.as_user(b);
  perform tests.cs_lives(tests.cs(b, jsonb_build_array(tests.cs_put('public.exchange_rates', jsonb_build_object('id', gen_random_uuid(), 'user_id', b,
    'base', 'USD', 'quote', 'MAD', 'rate', 9.9, 'date', '2026-03-01', 'source', 'manual', 'created_at', '2026-10-31T12:00:00.000Z')))), 'lot appliqué par B', true);
  perform tests.as_admin();
  perform tests.eq((select count(*) from private.changesets where user_id = a), 1::bigint, 'suivi des lots : 1 ligne pour A avant la suppression');
  for t in select * from tests.user_tables loop
    execute format('select count(*) from public.%I where user_id = $1', t.name) into na using a;
    total_a := total_a + na;
  end loop;
  perform tests.ok(total_a > 0, format('suppression du compte : A possède %s lignes avant', total_a));
  select sum(c) into nb_before from (select (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I where user_id = %L', name, b), false, true, '')))[1]::text::bigint as c from tests.user_tables) s;
  perform tests.lives_keep(format('select tests.delete_user(%L)', a), 'suppression du compte : cascade valide (clés différées comprises)');
  for t in select * from tests.user_tables loop
    execute format('select count(*) from public.%I where user_id = $1', t.name) into na using a;
    perform tests.eq(na, 0::bigint, format('suppression du compte : %s vidée pour A', t.name));
  end loop;
  perform tests.eq((select count(*) from public.profiles where id = a), 0::bigint, 'suppression du compte : profil supprimé');
  perform tests.eq((select count(*) from private.changesets where user_id = a), 0::bigint, 'suppression du compte : suivi des lots de A supprimé');
  perform tests.eq((select count(*) from private.changesets where user_id = b), 1::bigint, 'suppression du compte de A : suivi des lots de B intact');
  select sum(c) into nb_after from (select (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I where user_id = %L', name, b), false, true, '')))[1]::text::bigint as c from tests.user_tables) s;
  perform tests.eq(nb_after, nb_before, 'suppression du compte de A : lignes de B intactes');
end $$;

-- Fonctions privilégiées : seules les fonctions prévues existent ; aucune fonction interne
-- n'est appelable par un client ; toutes fixent search_path.
do $$
declare
  f record;
begin
  perform tests.eq((select string_agg(s.nspname || '.' || p.proname, ', ' order by s.nspname, p.proname)
                    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                    where s.nspname in ('public', 'private') and p.prosecdef),
    'private.handle_new_user, public.apply_changeset, public.resolve_changeset',
    'fonctions SECURITY DEFINER : exactement handle_new_user (inscription) et les deux portes du protocole');
  perform tests.eq((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'private'),
    'changeset_error, handle_new_user, request_uid, tg_sync_metadata', 'fonctions de private : exactement les quatre prévues');
  for f in select p.oid, s.nspname, p.proname, p.prosecdef, p.proconfig, p.prorettype::regtype::text as rettype, pg_get_userbyid(p.proowner) as owner
           from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname in ('public', 'private') loop
    perform tests.ok(f.proconfig is not null and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%'),
      format('%s.%s : search_path fixé', f.nspname, f.proname));
    perform tests.ok(not has_function_privilege('anon', f.oid, 'EXECUTE'), format('%s.%s : non exécutable par anon', f.nspname, f.proname));
    perform tests.ok(not exists (select 1 from aclexplode(coalesce((select proacl from pg_proc where oid = f.oid), acldefault('f', (select proowner from pg_proc where oid = f.oid)))) a where a.grantee = 0),
      format('%s.%s : aucun droit PUBLIC', f.nspname, f.proname));
    if f.nspname = 'private' then
      perform tests.ok(not has_function_privilege('authenticated', f.oid, 'EXECUTE'), format('private.%s : non exécutable par authenticated', f.proname));
    else
      perform tests.ok(has_function_privilege('authenticated', f.oid, 'EXECUTE') and not has_function_privilege('service_role', f.oid, 'EXECUTE'),
        format('public.%s : exécutable par authenticated seulement', f.proname));
      -- Le propriétaire d'une fonction SECURITY DEFINER ne doit contourner ni la RLS ni les privilèges.
      perform tests.ok((select not rolsuper and not rolbypassrls and not rolcanlogin from pg_roles where rolname = f.owner),
        format('public.%s : propriétaire %s sans superutilisateur, sans BYPASSRLS, sans connexion', f.proname, f.owner));
    end if;
    if f.proname in ('handle_new_user', 'tg_sync_metadata') then
      perform tests.eq(f.rettype, 'trigger', format('private.%s : fonction de déclencheur (non appelable directement)', f.proname));
    end if;
  end loop;
  perform tests.as_user(gen_random_uuid());
  perform tests.throws('select private.handle_new_user()', 'appel direct de handle_new_user refusé', '42501');
  perform tests.throws('select private.tg_sync_metadata()', 'appel direct de tg_sync_metadata refusé', '42501');
  perform tests.throws('select private.request_uid()', 'appel direct de request_uid refusé', '42501');
  perform tests.throws('select private.changeset_error(''x'')', 'appel direct de changeset_error refusé', '42501');
  perform tests.as_admin();
end $$;

-- Les déclencheurs fonctionnent pour un client qui n'a aucun droit sur le schéma private.
do $$
declare
  u uuid := tests.new_user('trg-priv');
begin
  perform tests.as_user(u);
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.exchange_rates', jsonb_build_object('id', gen_random_uuid(), 'user_id', u,
      'base', 'EUR', 'quote', 'MAD', 'rate', 10.9, 'date', '2026-03-01', 'source', 'manual', 'created_at', '2026-10-31T12:00:00.000Z')))),
    'écriture d''un client : déclencheurs exécutés sans droit sur private');
  perform tests.as_admin();
end $$;
