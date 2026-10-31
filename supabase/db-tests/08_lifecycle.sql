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

-- Profils : lecture et nom de son seul profil ; ni insertion, ni suppression, ni autre colonne.
do $$
declare
  a uuid := tests.new_user('pa');
  b uuid := tests.new_user('pb');
  n bigint;
begin
  perform tests.as_user(b);
  select count(*) into n from public.profiles;
  perform tests.eq(n, 1::bigint, 'profiles : B ne voit que son profil');
  perform tests.eq(tests.affected(format('update public.profiles set display_name = ''x'' where id = %L', a)), 0::bigint,
    'profiles : B ne modifie pas le profil de A');
  perform tests.lives(format('update public.profiles set display_name = ''Nouveau nom'' where id = %L', b), 'profiles : B renomme son profil');
  perform tests.throws(format('update public.profiles set created_at = now() where id = %L', b), 'profiles : created_at non modifiable (privilège de colonne)', '42501');
  perform tests.throws(format('update public.profiles set id = gen_random_uuid() where id = %L', b), 'profiles : id non modifiable', '42501');
  perform tests.throws(format('insert into public.profiles (id, display_name) values (%L, ''x'')', gen_random_uuid()), 'profiles : insertion refusée au client', '42501');
  perform tests.throws(format('delete from public.profiles where id = %L', b), 'profiles : suppression refusée au client', '42501');
  perform tests.as_admin();
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
  select sum(c) into nb_after from (select (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I where user_id = %L', name, b), false, true, '')))[1]::text::bigint as c from tests.user_tables) s;
  perform tests.eq(nb_after, nb_before, 'suppression du compte de A : lignes de B intactes');
end $$;

-- Fonctions privilégiées : seules les fonctions prévues existent, aucune n'est appelable
-- par un client, toutes fixent search_path.
do $$
declare
  f record;
  n int;
begin
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname in ('public', 'private') and p.prosecdef;
  perform tests.eq(n, 1, 'une seule fonction SECURITY DEFINER (private.handle_new_user)');
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig, p.prorettype::regtype::text as rettype
           from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'private' loop
    perform tests.ok(f.proconfig is not null and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%'),
      format('private.%s : search_path fixé', f.proname));
    perform tests.ok(not has_function_privilege('authenticated', f.oid, 'EXECUTE'), format('private.%s : non exécutable par authenticated', f.proname));
    perform tests.ok(not has_function_privilege('anon', f.oid, 'EXECUTE'), format('private.%s : non exécutable par anon', f.proname));
    perform tests.eq(f.rettype, 'trigger', format('private.%s : fonction de déclencheur (non appelable directement)', f.proname));
  end loop;
  perform tests.as_user(gen_random_uuid());
  perform tests.throws('select private.handle_new_user()', 'appel direct de handle_new_user refusé', '42501');
  perform tests.throws('select private.tg_sync_metadata()', 'appel direct de tg_sync_metadata refusé', '42501');
  perform tests.as_admin();
end $$;

-- Les déclencheurs fonctionnent pour un client qui n'a aucun droit sur le schéma private.
do $$
declare
  u uuid := tests.new_user('trg-priv');
begin
  perform tests.as_user(u);
  perform tests.lives(format($f$insert into public.exchange_rates (id, user_id, base, quote, rate, date, source, created_at)
    values (gen_random_uuid(), %L, 'EUR', 'MAD', 10.9, '2026-03-01', 'manual', now())$f$, u),
    'écriture d''un client : déclencheurs exécutés sans droit sur private');
  perform tests.as_admin();
end $$;
