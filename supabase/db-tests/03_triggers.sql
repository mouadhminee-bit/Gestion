-- =============================================================================
-- 03 — Métadonnées serveur et immutabilité (en tant qu'utilisateur authentifié)
-- =============================================================================
\set ON_ERROR_STOP on

create temp table trg (u uuid, other uuid, acc uuid);
insert into trg select tests.new_user('trg'), tests.new_user('trg-other'), gen_random_uuid();
grant select on trg to authenticated;

do $$
declare
  u uuid := (select trg.u from trg);
  other uuid := (select trg.other from trg);
  acc uuid := (select trg.acc from trg);
  r record;
  v1 bigint;
  t1 xid8;
begin
  perform tests.as_user(u);
  -- Le client tente d'imposer les métadonnées serveur : elles sont ignorées.
  insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived,
      include_in_total, color, sort_order, created_at, updated_at, version, sync_txid, server_updated_at, deleted_at)
    values (acc, u, 'Banque', 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0,
      '2020-01-02T03:04:05.678Z', '2021-01-02T03:04:05.678Z', 999, '1'::xid8, '2000-01-01', null);
  select * into r from public.accounts where id = acc;
  perform tests.eq(r.version, 1::bigint, 'insertion : version = 1 malgré la valeur envoyée');
  perform tests.eq(r.sync_txid, pg_current_xact_id(), 'insertion : sync_txid = transaction courante');
  perform tests.ok(r.server_updated_at > '2000-01-01'::timestamptz, 'insertion : server_updated_at posé par le serveur');
  perform tests.eq(r.created_at, '2020-01-02T03:04:05.678Z'::timestamptz, 'created_at métier du client conservé à la milliseconde');
  perform tests.eq(r.updated_at, '2021-01-02T03:04:05.678Z'::timestamptz, 'updated_at métier du client conservé');
  perform tests.eq(to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '2020-01-02T03:04:05.678Z',
    'created_at restituable au format ISO du domaine (toISOString)');

  update public.accounts set name = 'Banque 2', version = 0, sync_txid = '1'::xid8 where id = acc;
  update public.accounts set name = 'Banque 3' where id = acc;
  select * into r from public.accounts where id = acc;
  perform tests.eq(r.version, 3::bigint, 'deux mises à jour : version = 3 (chaque mise à jour compte, valeur client ignorée)');
  perform tests.eq(r.sync_txid, pg_current_xact_id(), 'mise à jour : sync_txid = transaction courante');

  -- Immutabilité
  perform tests.throws(format('update public.accounts set id = gen_random_uuid() where id = %L', acc), 'id immuable', '42501');
  perform tests.throws(format('update public.accounts set created_at = now() where id = %L', acc), 'created_at immuable', '42501');
  perform tests.throws(format('update public.accounts set user_id = %L where id = %L', other, acc), 'user_id immuable', '42501');
  perform tests.lives(format('update public.accounts set updated_at = now() where id = %L', acc), 'updated_at métier modifiable par le client');
  perform tests.as_admin();
end $$;

-- Immutabilité des clés naturelles
do $$
declare
  u uuid := tests.new_user('trg-keys');
  ids jsonb := tests.seed(u);
begin
  perform tests.as_user(u);
  perform tests.throws(format('update public.recurring_occurrences set due_date = ''2030-01-01'' where user_id = %L', u), 'recurring_occurrences : due_date immuable', '42501');
  perform tests.throws(format('update public.recurring_occurrences set rule_id = gen_random_uuid() where user_id = %L', u), 'recurring_occurrences : rule_id immuable', '42501');
  perform tests.throws(format('update public.notification_states set id = ''autre'' where user_id = %L', u), 'notification_states : id immuable', '42501');
  perform tests.throws(format('update public.user_settings set user_id = gen_random_uuid() where user_id = %L', u), 'user_settings : user_id immuable', '42501');
  perform tests.lives(format('update public.user_settings set theme = ''light'' where user_id = %L', u), 'user_settings : modification d''un réglage');
  perform tests.as_admin();
end $$;

-- Une écriture même en administrateur passe par le déclencheur (aucun contournement par
-- une valeur forcée de version).
do $$
declare
  u uuid := tests.new_user('trg-admin');
  ids jsonb := tests.seed(u);
  v bigint;
begin
  -- Immutabilité indépendante de la RLS : l'administrateur n'est pas soumis aux politiques,
  -- seul le déclencheur protège user_id.
  perform tests.throws(format('update public.accounts set user_id = %L where id = %L', tests.new_user('trg-admin-2'), ids ->> 'accounts'),
    'administrateur : user_id immuable même sans RLS (déclencheur)', '42501');
  perform tests.throws(format('update public.transactions set created_at = now() where id = %L', ids ->> 'transactions'),
    'administrateur : created_at immuable même sans RLS', '42501');
  update public.budgets set version = 1000 where id = (ids ->> 'budgets')::uuid;
  select version into v from public.budgets where id = (ids ->> 'budgets')::uuid;
  perform tests.eq(v, 2::bigint, 'administrateur : version toujours calculée par le serveur');
end $$;
