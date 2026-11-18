-- =============================================================================
-- 03 — Métadonnées serveur et immutabilité
--
-- Deux niveaux, testés séparément (état final, migration 8) :
--  * le PROTOCOLE (seule voie d'écriture d'un utilisateur authentifié) : une métadonnée
--    serveur envoyée est refusée ; les versions, sync_txid et horodatages serveur sont
--    calculés par le serveur ; les horodatages métier du client sont conservés ;
--  * le DÉCLENCHEUR private.tg_sync_metadata (défense en profondeur, indépendante des
--    privilèges et de la RLS) : testé en administrateur, seul rôle qui écrit directement.
--    (En `authenticated`, une écriture directe échoue désormais par privilège — même
--    SQLSTATE 42501 que le déclencheur : ces cas ne prouveraient plus rien.)
-- =============================================================================
\set ON_ERROR_STOP on

create temp table trg (u uuid, other uuid, acc uuid);
insert into trg select tests.new_user('trg'), tests.new_user('trg-other'), gen_random_uuid();
grant select on trg to authenticated;

-- Protocole, en tant qu'utilisateur authentifié.
do $$
declare
  u uuid := (select trg.u from trg);
  other uuid := (select trg.other from trg);
  acc uuid := (select trg.acc from trg);
  base jsonb;
  op jsonb;
  r record;
  res jsonb;
begin
  perform tests.as_user(u);
  base := jsonb_build_object('id', acc, 'user_id', u, 'name', 'Banque', 'type', 'bank', 'currency', 'MAD', 'initial_balance', 0,
    'initial_balance_date', '2026-03-01', 'archived', false, 'include_in_total', true, 'color', '#fff', 'sort_order', 0,
    'created_at', '2020-01-02T03:04:05.678Z', 'updated_at', '2021-01-02T03:04:05.678Z');
  op := tests.cs_put('public.accounts', base, null);

  -- Le client tente d'imposer les métadonnées serveur : le lot est refusé.
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(jsonb_set(op, '{row,version}', '999'))), 'protocole : version envoyée refusée', 'invalid_row');
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(jsonb_set(op, '{row,sync_txid}', '"1"'))), 'protocole : sync_txid envoyé refusé', 'invalid_row');
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(jsonb_set(op, '{row,server_updated_at}', '"2000-01-01T00:00:00Z"'))), 'protocole : server_updated_at envoyé refusé', 'invalid_row');
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(jsonb_set(op, '{row,deleted_at}', '"2000-01-01T00:00:00Z"'))), 'protocole : deleted_at envoyé refusé', 'invalid_row');
  perform tests.eq((select count(*) from public.accounts where id = acc), 0::bigint, 'protocole : aucun lot refusé n''a rien écrit');

  -- Création : métadonnées calculées par le serveur, horodatages métier conservés.
  res := tests.cs_try(tests.cs(u, jsonb_build_array(op)), true);
  perform tests.eq(res -> 'ok' -> 'versions' -> 0 -> 'version', '1'::jsonb, 'création : version 1 confirmée au client');
  select * into r from public.accounts where id = acc;
  perform tests.eq(r.version, 1::bigint, 'insertion : version = 1');
  perform tests.eq(r.sync_txid, pg_current_xact_id(), 'insertion : sync_txid = transaction courante');
  perform tests.ok(r.server_updated_at > '2000-01-01'::timestamptz, 'insertion : server_updated_at posé par le serveur');
  perform tests.eq(r.created_at, '2020-01-02T03:04:05.678Z'::timestamptz, 'created_at métier du client conservé à la milliseconde');
  perform tests.eq(r.updated_at, '2021-01-02T03:04:05.678Z'::timestamptz, 'updated_at métier du client conservé');
  perform tests.eq(to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '2020-01-02T03:04:05.678Z',
    'created_at restituable au format ISO du domaine (toISOString)');

  -- Deux modifications : chaque écriture compte.
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.accounts', base || '{"name": "Banque 2"}', 1))), 'modification 1 appliquée', true);
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.accounts', base || '{"name": "Banque 3"}', 2))), 'modification 2 appliquée', true);
  select * into r from public.accounts where id = acc;
  perform tests.eq(r.version, 3::bigint, 'deux mises à jour : version = 3 (chaque mise à jour compte)');
  perform tests.eq(r.name, 'Banque 3', 'dernière écriture conservée');
  perform tests.eq(r.sync_txid, pg_current_xact_id(), 'mise à jour : sync_txid = transaction courante');

  -- Immutabilité vue du protocole
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(tests.cs_put('public.accounts', base || '{"created_at": "2022-01-01T00:00:00.000Z"}', 3))),
    'protocole : created_at immuable (refus du déclencheur rapporté)', 'invalid_row', '42501');
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(tests.cs_put('public.accounts', base || jsonb_build_object('user_id', other), 3))),
    'protocole : user_id d''un autre utilisateur refusé', 'unauthorized');
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.accounts', base || '{"updated_at": "2026-11-01T00:00:00.000Z"}', 3))),
    'updated_at métier modifiable par le client');
  -- Une écriture directe n'est plus possible, même sur sa propre ligne.
  perform tests.throws(format('update public.accounts set name = ''Direct'' where id = %L', acc), 'écriture directe refusée (privilège)', '42501');
  perform tests.as_admin();
end $$;

-- Paramètres : modification d'un réglage par le protocole.
do $$
declare
  u uuid := tests.new_user('trg-keys');
  ids jsonb := tests.seed(u);
  s jsonb;
begin
  select to_jsonb(x) into s from public.user_settings x where user_id = u;
  perform tests.as_user(u);
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.user_settings', s || '{"theme": "light"}', (s ->> 'version')::bigint))),
    'user_settings : modification d''un réglage');
  perform tests.as_admin();
end $$;

-- Déclencheur (défense en profondeur) : une écriture même en administrateur passe par lui.
-- L'administrateur n'est soumis ni aux privilèges ni aux politiques : seul le déclencheur
-- protège ici les métadonnées et les colonnes immuables.
do $$
declare
  u uuid := tests.new_user('trg-admin');
  ids jsonb := tests.seed(u);
  acc uuid := gen_random_uuid();
  r record;
  v bigint;
begin
  insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived,
      include_in_total, color, sort_order, created_at, updated_at, version, sync_txid, server_updated_at, deleted_at)
    values (acc, u, 'Banque', 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0,
      '2020-01-02T03:04:05.678Z', '2021-01-02T03:04:05.678Z', 999, '1'::xid8, '2000-01-01', null);
  select * into r from public.accounts where id = acc;
  perform tests.eq(r.version, 1::bigint, 'déclencheur : version = 1 malgré la valeur envoyée');
  perform tests.eq(r.sync_txid, pg_current_xact_id(), 'déclencheur : sync_txid = transaction courante malgré la valeur envoyée');
  perform tests.ok(r.server_updated_at > '2000-01-01'::timestamptz, 'déclencheur : server_updated_at posé par le serveur');
  update public.accounts set name = 'Banque 2', version = 0, sync_txid = '1'::xid8 where id = acc;
  select * into r from public.accounts where id = acc;
  perform tests.eq(r.version, 2::bigint, 'déclencheur : version + 1 (valeur client ignorée)');

  perform tests.throws(format('update public.accounts set id = gen_random_uuid() where id = %L', acc), 'administrateur : id immuable', '42501');
  perform tests.throws(format('update public.accounts set user_id = %L where id = %L', tests.new_user('trg-admin-2'), ids ->> 'accounts'),
    'administrateur : user_id immuable même sans RLS (déclencheur)', '42501');
  perform tests.throws(format('update public.transactions set created_at = now() where id = %L', ids ->> 'transactions'),
    'administrateur : created_at immuable même sans RLS', '42501');
  -- Clés naturelles
  perform tests.throws(format('update public.recurring_occurrences set due_date = ''2030-01-01'' where user_id = %L', u), 'recurring_occurrences : due_date immuable', '42501');
  perform tests.throws(format('update public.recurring_occurrences set rule_id = gen_random_uuid() where user_id = %L', u), 'recurring_occurrences : rule_id immuable', '42501');
  perform tests.throws(format('update public.notification_states set id = ''autre'' where user_id = %L', u), 'notification_states : id immuable', '42501');
  perform tests.throws(format('update public.user_settings set user_id = gen_random_uuid() where user_id = %L', u), 'user_settings : user_id immuable', '42501');
  update public.budgets set version = 1000 where id = (ids ->> 'budgets')::uuid;
  select version into v from public.budgets where id = (ids ->> 'budgets')::uuid;
  perform tests.eq(v, 2::bigint, 'administrateur : version toujours calculée par le serveur');
end $$;
