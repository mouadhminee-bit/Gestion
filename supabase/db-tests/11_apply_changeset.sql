-- =============================================================================
-- 11 — apply_changeset / resolve_changeset (Lot 4, étape 4.4)
--
-- Protocole ChangeSet v1 côté serveur : versions, atomicité, idempotence, suppression
-- logique, sécurité (authentification, isolation, liste blanche, métadonnées serveur,
-- écritures directes révoquées), concurrence entre sessions (dblink).
-- Données fictives uniquement (utilisateurs @example.test).
-- =============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Outils (fonctions temporaires de la session)
-- ---------------------------------------------------------------------------
create function pg_temp.cs(uid uuid, ops jsonb, cid uuid default gen_random_uuid()) returns jsonb language sql as $$
  select jsonb_build_object('protocol', 1, 'changesetId', cid, 'userId', uid, 'ops', ops)
$$;
create function pg_temp.put(tbl text, k jsonb, expected bigint, r jsonb) returns jsonb language sql as $$
  select jsonb_build_object('table', tbl, 'type', 'put', 'key', k, 'expectedVersion', expected, 'row', r)
$$;
create function pg_temp.del(tbl text, k jsonb, expected bigint) returns jsonb language sql as $$
  select jsonb_build_object('table', tbl, 'type', 'delete', 'key', k, 'expectedVersion', expected)
$$;
-- Appel isolé : renvoie le résultat ou l'erreur ; en cas d'erreur, tout est annulé
-- (contraintes différées vérifiées immédiatement, comme à la validation de la requête).
create function pg_temp.try(p jsonb) returns jsonb language plpgsql as $$
declare
  r jsonb;
  d text;
begin
  r := public.apply_changeset(p);
  set constraints all immediate;
  set constraints all deferred;
  return jsonb_build_object('ok', r);
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return jsonb_build_object('state', sqlstate, 'code', sqlerrm, 'detail', case when d ~ '^\{' then d::jsonb end);
end $$;
create function pg_temp.try_resolve(id text) returns jsonb language plpgsql as $$
declare
  d text;
begin
  return jsonb_build_object('ok', public.resolve_changeset(id));
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return jsonb_build_object('state', sqlstate, 'code', sqlerrm, 'detail', case when d ~ '^\{' then d::jsonb end);
end $$;
create function pg_temp.ts() returns text language sql as $$ select '2026-10-31T12:00:00.000Z' $$;
create function pg_temp.acc(uid uuid, id uuid, name text default 'Compte') returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'user_id', uid, 'created_at', pg_temp.ts(), 'updated_at', pg_temp.ts(), 'name', name,
    'type', 'bank', 'currency', 'MAD', 'initial_balance', 0, 'initial_balance_date', '2026-01-01', 'archived', false,
    'include_in_total', true, 'color', '#000', 'description', null, 'sort_order', 0)
$$;
create function pg_temp.goal(uid uuid, id uuid, saved bigint default 0, name text default 'Objectif') returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'user_id', uid, 'created_at', pg_temp.ts(), 'updated_at', pg_temp.ts(), 'name', name,
    'description', null, 'target_amount', 100000, 'currency', 'MAD', 'saved_amount', saved, 'target_date', null, 'priority', 'low',
    'linked_account_id', null, 'track_linked_account', false, 'monthly_contribution', null, 'status', 'active', 'icon', 'X', 'color', '#fff')
$$;
create function pg_temp.contrib(uid uuid, id uuid, goal uuid, amount bigint) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'user_id', uid, 'goal_id', goal, 'date', '2026-03-01', 'amount', amount, 'note', null, 'created_at', pg_temp.ts())
$$;
create function pg_temp.tx(uid uuid, id uuid, acc uuid, amount bigint default 100) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'user_id', uid, 'created_at', pg_temp.ts(), 'updated_at', pg_temp.ts(), 'type', 'expense',
    'direction', 'out', 'amount', amount, 'currency', 'MAD', 'label', 'Achat', 'date', '2026-03-01', 'category_id', null,
    'subcategory_id', null, 'account_id', acc, 'payment_method', null, 'payee', null, 'notes', null, 'tags', '[]'::jsonb,
    'attachment_id', null, 'status', 'cleared', 'transfer_id', null, 'counterpart_account_id', null, 'refund_of_id', null,
    'debt_id', null, 'debt_payment_id', null, 'interest_amount', null, 'recurring_rule_id', null, 'recurring_due_date', null,
    'import_batch_id', null)
$$;
create function pg_temp.rule(uid uuid, id uuid, acc uuid) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'user_id', uid, 'created_at', pg_temp.ts(), 'updated_at', pg_temp.ts(), 'kind', 'expense',
    'label', 'Loyer', 'amount', 450000, 'currency', 'MAD', 'account_id', acc, 'category_id', null, 'subcategory_id', null,
    'payee', null, 'frequency', 'monthly', 'custom_interval', null, 'custom_unit', null, 'start_date', '2026-01-01',
    'end_date', null, 'active', true, 'notes', null)
$$;
create function pg_temp.occ(uid uuid, rule uuid, due text) returns jsonb language sql as $$
  select jsonb_build_object('user_id', uid, 'rule_id', rule, 'due_date', due, 'status', 'paid', 'transaction_id', null,
    'closure', null, 'updated_at', pg_temp.ts())
$$;
create function pg_temp.settings(uid uuid, theme text default 'dark') returns jsonb language sql as $$
  select jsonb_build_object('user_id', uid, 'display_name', 'Test', 'base_currency', 'MAD', 'language', 'fr', 'locale', 'fr-MA',
    'time_zone', 'Africa/Casablanca', 'date_format', 'DD/MM/YYYY', 'week_starts_on', 1, 'theme', theme, 'currency_display', 'symbol',
    'privacy_mode', false, 'budget_alert_thresholds', '[50, 75, 90, 100]'::jsonb, 'notify_budgets', true, 'notify_bills', true,
    'notify_debts', true, 'bill_reminder_days', 3, 'onboarded', true, 'demo_mode', false, 'updated_at', pg_temp.ts())
$$;
create function pg_temp.k(id uuid) returns jsonb language sql as $$ select jsonb_build_object('id', id) $$;
-- État d'une ligne vu par l'administrateur des tests (contourne la RLS) : version et suppression.
create function pg_temp.state(tbl text, id uuid) returns jsonb language plpgsql as $$
declare
  r jsonb;
begin
  execute format('select jsonb_build_object(''version'', version, ''deleted'', deleted_at is not null, ''deleted_at'', deleted_at) from public.%I where id = $1', tbl)
    into r using id;
  return r;
end $$;
create function pg_temp.count_rows(tbl text, uid uuid) returns bigint language plpgsql as $$
declare
  n bigint;
begin
  execute format('select count(*) from public.%I where user_id = $1', tbl) into n using uid;
  return n;
end $$;
create function pg_temp.tracked(uid uuid) returns bigint language sql as $$
  select count(*) from private.changesets where user_id = uid
$$;

create temp table cx (label text primary key, v uuid);
insert into cx values ('a', tests.new_user('cs-a')), ('b', tests.new_user('cs-b'));
grant select on cx to authenticated;
create function pg_temp.u(l text) returns uuid language sql as $$ select v from cx where label = l $$;

-- ---------------------------------------------------------------------------
-- 1. Catalogue : fonctions, rôle, privilèges, liste blanche
-- ---------------------------------------------------------------------------
do $$
declare
  f record;
  t record;
  cols text[];
  priv text;
begin
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('apply_changeset', 'resolve_changeset') loop
    perform tests.ok(f.prosecdef, format('%s : SECURITY DEFINER', f.proname));
    perform tests.ok(f.proconfig @> array['search_path=""'], format('%s : search_path vide fixé', f.proname), array_to_string(f.proconfig, ','));
    perform tests.eq(f.owner, 'nexora_writer', format('%s : propriétaire nexora_writer', f.proname));
    perform tests.ok(has_function_privilege('authenticated', f.oid, 'EXECUTE'), format('%s : exécutable par authenticated', f.proname));
    perform tests.ok(not has_function_privilege('anon', f.oid, 'EXECUTE'), format('%s : non exécutable par anon', f.proname));
    perform tests.ok(not exists (select 1 from aclexplode((select proacl from pg_proc where oid = f.oid)) a where a.grantee = 0),
      format('%s : aucun droit PUBLIC', f.proname));
  end loop;
  perform tests.eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname in ('apply_changeset', 'resolve_changeset')), 2::bigint, 'deux fonctions publiques');
  perform tests.ok((select not rolbypassrls and not rolcanlogin and not rolsuper from pg_roles where rolname = 'nexora_writer'),
    'nexora_writer : NOLOGIN, sans BYPASSRLS, non superutilisateur');
  perform tests.ok(not pg_has_role('authenticated', 'nexora_writer', 'USAGE') and not pg_has_role('anon', 'nexora_writer', 'USAGE'),
    'authenticated / anon ne peuvent pas endosser nexora_writer');
  for t in select relid, name from tests.public_tables loop
    perform tests.ok(has_table_privilege('authenticated', t.relid, 'SELECT'), format('%s : authenticated conserve SELECT', t.name));
    foreach priv in array array['INSERT', 'UPDATE'] loop
      perform tests.ok(not has_table_privilege('authenticated', t.relid, priv)
                       and not has_any_column_privilege('authenticated', t.relid, priv),
        format('%s : authenticated n''a plus %s (ni colonne)', t.name, priv));
    end loop;
  end loop;
  for t in select c.oid as relid, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'private' and c.relkind = 'r' loop
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      perform tests.ok(not has_table_privilege('authenticated', t.relid, priv) and not has_table_privilege('anon', t.relid, priv),
        format('private.%s : aucun %s pour authenticated / anon', t.name, priv));
    end loop;
  end loop;
  perform tests.ok(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                               where c.relname = 'meta' and n.nspname in ('public', 'private')), 'aucune table meta côté serveur');
  -- Liste blanche ≡ schéma : 18 tables ; clé = clé primaire ; colonnes = colonnes sans métadonnées serveur.
  perform tests.eq((select count(*) from private.changeset_tables), 18::bigint, 'liste blanche : 18 tables');
  for t in select * from private.changeset_tables loop
    perform tests.eq(t.key_cols, (select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
                                  from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
                                  where i.indrelid = ('public.' || t.sql_table)::regclass and i.indisprimary),
      format('%s : clé de la liste blanche = clé primaire', t.sql_table));
    select array_agg(attname::text order by attname) into cols from pg_attribute
      where attrelid = ('public.' || t.sql_table)::regclass and attnum > 0 and not attisdropped
        and attname not in ('version', 'sync_txid', 'server_updated_at', 'deleted_at')
        and not (t.sql_table = 'profiles' and attname = 'created_at');
    perform tests.eq((select array_agg(c order by c) from unnest(t.write_cols) c), cols,
      format('%s : colonnes écrites = colonnes de la table sans métadonnées serveur', t.sql_table));
  end loop;
  -- Utilisateur de la requête : mêmes sources que auth.uid().
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('a'), 'role', 'authenticated')::text, true);
  perform tests.eq(private.request_uid(), auth.uid(), 'request_uid() = auth.uid() (request.jwt.claims)');
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', pg_temp.u('b')::text, true);
  perform tests.eq(private.request_uid(), auth.uid(), 'request_uid() = auth.uid() (request.jwt.claim.sub)');
  perform set_config('request.jwt.claim.sub', '', true);
  perform tests.ok(private.request_uid() is null, 'request_uid() nul sans revendication');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Fonctionnement nominal et versions
-- ---------------------------------------------------------------------------
create temp table ids (label text primary key, v uuid default gen_random_uuid());
insert into ids (label) values ('acc'), ('acc2'), ('goal'), ('c1'), ('tx'), ('rule'), ('x1'), ('x2'), ('x3');
grant select on ids to authenticated;
create function pg_temp.id(l text) returns uuid language sql as $$ select v from ids where label = l $$;

do $$
declare
  a uuid := pg_temp.u('a');
  r jsonb;
begin
  perform tests.as_user(a);
  -- Création (expectedVersion null) → version 1.
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), null, pg_temp.acc(a, pg_temp.id('acc'))))));
  perform tests.eq(r -> 'ok' ->> 'status', 'applied', 'création : status applied');
  perform tests.eq(r -> 'ok' -> 'versions', jsonb_build_array(jsonb_build_object('table', 'accounts', 'key', pg_temp.k(pg_temp.id('acc')), 'version', 1, 'deleted', false)),
    'création : confirmation (table, clé, version 1, deleted false)');
  -- Modification avec la bonne version → 2.
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 1, pg_temp.acc(a, pg_temp.id('acc'), 'Renommé')))));
  perform tests.eq((r -> 'ok' -> 'versions' -> 0 ->> 'version')::int, 2, 'modification : version 2');
  perform tests.eq((select name from public.accounts where id = pg_temp.id('acc')), 'Renommé', 'modification appliquée');
  -- Version obsolète → conflit, rien écrit.
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 1, pg_temp.acc(a, pg_temp.id('acc'), 'Obsolète')))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'modification obsolète : version_conflict');
  perform tests.eq(r ->> 'state', 'PT409', 'version_conflict : SQLSTATE PT409 (HTTP 409)');
  perform tests.eq(r -> 'detail' -> 'conflicts', jsonb_build_array(jsonb_build_object('table', 'accounts', 'key', pg_temp.k(pg_temp.id('acc')),
    'expectedVersion', 1, 'actualVersion', 2, 'actualDeleted', false)), 'conflit : détail (version attendue, actuelle, état)');
  perform tests.eq((select name from public.accounts where id = pg_temp.id('acc')), 'Renommé', 'conflit : ligne inchangée');
  -- Création d'une clé existante → conflit.
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), null, pg_temp.acc(a, pg_temp.id('acc'))))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'création sur clé existante : version_conflict');
  -- Version attendue supérieure à l'actuelle → conflit.
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 7, pg_temp.acc(a, pg_temp.id('acc'))))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'version attendue future : version_conflict');
  -- Mise à jour d'une clé inconnue avec une version → conflit (actualVersion null).
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('x1')), 1, pg_temp.acc(a, pg_temp.id('x1'))))));
  perform tests.eq(r -> 'detail' -> 'conflicts' -> 0 -> 'actualVersion', 'null'::jsonb, 'modification d''une clé inconnue : conflit, actualVersion null');
end $$;

-- Suppression logique et réactivation.
do $$
declare
  a uuid := pg_temp.u('a');
  r jsonb;
  d1 timestamptz;
begin
  perform tests.as_user(a);
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.del('accounts', pg_temp.k(pg_temp.id('acc')), 1))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'suppression avec version obsolète : version_conflict');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.del('accounts', pg_temp.k(pg_temp.id('x2')), 1))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'suppression d''une clé inexistante : version_conflict');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.del('accounts', pg_temp.k(pg_temp.id('acc')), null))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'suppression avec expectedVersion null : version_conflict');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.del('accounts', pg_temp.k(pg_temp.id('acc')), 2))));
  perform tests.eq(r -> 'ok' -> 'versions', jsonb_build_array(jsonb_build_object('table', 'accounts', 'key', pg_temp.k(pg_temp.id('acc')), 'version', 3, 'deleted', true)),
    'suppression : version 3, deleted true');
  perform tests.as_admin();
  perform tests.ok((pg_temp.state('accounts', pg_temp.id('acc')) ->> 'deleted')::boolean, 'suppression logique : ligne conservée, deleted_at renseigné');
  perform tests.ok((pg_temp.state('accounts', pg_temp.id('acc')) ->> 'deleted_at')::timestamptz <= now(), 'deleted_at généré par PostgreSQL');
  d1 := (pg_temp.state('accounts', pg_temp.id('acc')) ->> 'deleted_at')::timestamptz;
  perform tests.as_user(a);
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.del('accounts', pg_temp.k(pg_temp.id('acc')), 3))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'suppression répétée (déjà supprimée) : version_conflict');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 2, pg_temp.acc(a, pg_temp.id('acc'), 'Réactivé')))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'réactivation obsolète : version_conflict');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 3, pg_temp.acc(a, pg_temp.id('acc'), 'Réactivé')))));
  perform tests.eq(r -> 'ok' -> 'versions' -> 0, jsonb_build_object('table', 'accounts', 'key', pg_temp.k(pg_temp.id('acc')), 'version', 4, 'deleted', false),
    'réactivation : version 4, deleted false');
  perform tests.as_admin();
  perform tests.eq(pg_temp.state('accounts', pg_temp.id('acc')) -> 'deleted_at', 'null'::jsonb, 'réactivation : deleted_at remis à NULL');
  perform tests.eq((select name from public.accounts where id = pg_temp.id('acc')), 'Réactivé', 'réactivation : ligne réécrite');
end $$;

-- Lot multi-tables et multi-opérations ; clés composites.
do $$
declare
  a uuid := pg_temp.u('a');
  r jsonb;
begin
  perform tests.as_user(a);
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(
    pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc2')), null, pg_temp.acc(a, pg_temp.id('acc2'), 'Épargne')),
    pg_temp.put('savings_goals', pg_temp.k(pg_temp.id('goal')), null, pg_temp.goal(a, pg_temp.id('goal'))),
    pg_temp.put('goal_contributions', pg_temp.k(pg_temp.id('c1')), null, pg_temp.contrib(a, pg_temp.id('c1'), pg_temp.id('goal'), 5000)),
    pg_temp.put('transactions', pg_temp.k(pg_temp.id('tx')), null, pg_temp.tx(a, pg_temp.id('tx'), pg_temp.id('acc2'))),
    pg_temp.put('recurring_rules', pg_temp.k(pg_temp.id('rule')), null, pg_temp.rule(a, pg_temp.id('rule'), pg_temp.id('acc2'))),
    pg_temp.put('recurring_occurrences', jsonb_build_object('rule_id', pg_temp.id('rule'), 'due_date', '2026-03-31'), null, pg_temp.occ(a, pg_temp.id('rule'), '2026-03-31')),
    pg_temp.put('notification_states', jsonb_build_object('user_id', a, 'id', 'budget:x:2026-10:90'), null,
      jsonb_build_object('id', 'budget:x:2026-10:90', 'user_id', a, 'read', true, 'dismissed', false, 'updated_at', pg_temp.ts())),
    pg_temp.put('user_settings', jsonb_build_object('user_id', a), null, pg_temp.settings(a)))));
  perform tests.eq(r -> 'ok' ->> 'status', 'applied', 'lot multi-tables (8 opérations, 8 tables) : applied');
  perform tests.eq(jsonb_array_length(r -> 'ok' -> 'versions'), 8, 'confirmation : une entrée par opération');
  perform tests.eq((select array_agg(v ->> 'table' order by ord) from jsonb_array_elements(r -> 'ok' -> 'versions') with ordinality x(v, ord)),
    array['accounts', 'savings_goals', 'goal_contributions', 'transactions', 'recurring_rules', 'recurring_occurrences', 'notification_states', 'user_settings'],
    'confirmation : même ordre que les opérations');
  perform tests.eq(r -> 'ok' -> 'versions' -> 5 -> 'key', jsonb_build_object('rule_id', pg_temp.id('rule'), 'due_date', '2026-03-31'), 'clé composite (rule_id, due_date) renvoyée telle quelle');
  -- Modification de la ligne à clé composite et de user_settings (clé user_id).
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(
    pg_temp.put('recurring_occurrences', jsonb_build_object('rule_id', pg_temp.id('rule'), 'due_date', '2026-03-31'), 1,
      pg_temp.occ(a, pg_temp.id('rule'), '2026-03-31') || '{"closure": "waived"}'),
    pg_temp.put('user_settings', jsonb_build_object('user_id', a), 1, pg_temp.settings(a, 'light')),
    pg_temp.put('notification_states', jsonb_build_object('user_id', a, 'id', 'budget:x:2026-10:90'), 1,
      jsonb_build_object('id', 'budget:x:2026-10:90', 'user_id', a, 'read', true, 'dismissed', true, 'updated_at', pg_temp.ts())))));
  perform tests.eq((select array_agg((v ->> 'version')::int) from jsonb_array_elements(r -> 'ok' -> 'versions') v), array[2, 2, 2], 'clés composites et user_settings : versions 2');
  perform tests.eq((select theme from public.user_settings where user_id = a), 'light', 'user_settings modifiés');
  -- Profil : mise à jour du nom seulement (ligne créée à l'inscription).
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('profiles', pg_temp.k(a), 1, jsonb_build_object('id', a, 'display_name', 'Nouveau nom')))));
  perform tests.eq((r -> 'ok' -> 'versions' -> 0 ->> 'version')::int, 2, 'profil : mise à jour, version 2');
  perform tests.eq((select display_name from public.profiles where id = a), 'Nouveau nom', 'profil : display_name modifié');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('profiles', pg_temp.k(a), null, jsonb_build_object('id', a, 'display_name', 'x')))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'profil : création (null) sur profil existant → version_conflict');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.del('profiles', pg_temp.k(a), 2))));
  perform tests.eq(r ->> 'code', 'invalid_operation', 'profil : suppression interdite');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Atomicité
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := pg_temp.u('a');
  r jsonb;
  before_acc bigint;
  before_tx bigint;
  before_tracked bigint;
begin
  perform tests.as_admin();
  before_acc := pg_temp.count_rows('accounts', a);
  before_tx := pg_temp.count_rows('transactions', a);
  before_tracked := pg_temp.tracked(a);
  perform tests.as_user(a);
  -- Conflit sur l'opération INTERMÉDIAIRE : les créations voisines ne sont pas conservées.
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(
    pg_temp.put('accounts', pg_temp.k(pg_temp.id('x1')), null, pg_temp.acc(a, pg_temp.id('x1'))),
    pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 1, pg_temp.acc(a, pg_temp.id('acc'), 'Obsolète')),
    pg_temp.put('accounts', pg_temp.k(pg_temp.id('x2')), null, pg_temp.acc(a, pg_temp.id('x2'))))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'conflit intermédiaire : version_conflict');
  perform tests.eq(jsonb_array_length(r -> 'detail' -> 'conflicts'), 1, 'conflit intermédiaire : une seule opération en cause');
  -- Échec sur la DERNIÈRE opération (contrainte CHECK : montant nul).
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(
    pg_temp.put('accounts', pg_temp.k(pg_temp.id('x1')), null, pg_temp.acc(a, pg_temp.id('x1'))),
    pg_temp.put('transactions', pg_temp.k(pg_temp.id('x2')), null, pg_temp.tx(a, pg_temp.id('x2'), pg_temp.id('x1'), 0)))));
  perform tests.eq(r ->> 'code', 'invalid_row', 'violation de contrainte (dernière opération) : invalid_row');
  perform tests.eq(r -> 'detail' ->> 'sqlstate', '23514', 'invalid_row : SQLSTATE d''origine 23514 (CHECK) dans le détail');
  perform tests.eq((r -> 'detail' ->> 'op')::int, 1, 'invalid_row : index de l''opération fautive');
  -- Référence pendante (clé étrangère différée) : refusée à la validation, rien conservé.
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(
    pg_temp.put('accounts', pg_temp.k(pg_temp.id('x1')), null, pg_temp.acc(a, pg_temp.id('x1'))),
    pg_temp.put('transactions', pg_temp.k(pg_temp.id('x2')), null, pg_temp.tx(a, pg_temp.id('x2'), gen_random_uuid())))));
  perform tests.eq(r ->> 'state', '23503', 'clé étrangère différée : erreur 23503 à la validation');
  -- Valeur de type invalide (texte dans un montant).
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(
    pg_temp.put('accounts', pg_temp.k(pg_temp.id('x1')), null, pg_temp.acc(a, pg_temp.id('x1'))),
    pg_temp.put('transactions', pg_temp.k(pg_temp.id('x2')), null, pg_temp.tx(a, pg_temp.id('x2'), pg_temp.id('x1')) || '{"amount": "cent"}'))));
  perform tests.eq(r ->> 'code', 'invalid_row', 'type invalide : invalid_row');
  -- Modification d'une colonne immuable (created_at) : refusée par le déclencheur.
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 4,
    pg_temp.acc(a, pg_temp.id('acc'), 'Réactivé') || '{"created_at": "2020-01-01T00:00:00Z"}'))));
  perform tests.eq(r ->> 'code', 'invalid_row', 'colonne immuable modifiée : invalid_row');
  perform tests.eq(r -> 'detail' ->> 'sqlstate', '42501', 'colonne immuable : SQLSTATE d''origine 42501');
  perform tests.as_admin();
  perform tests.eq(pg_temp.count_rows('accounts', a), before_acc, 'atomicité : aucun compte partiel conservé');
  perform tests.eq(pg_temp.count_rows('transactions', a), before_tx, 'atomicité : aucune transaction partielle conservée');
  perform tests.eq(pg_temp.tracked(a), before_tracked, 'atomicité : aucun lot refusé enregistré dans le suivi');
  perform tests.eq((pg_temp.state('accounts', pg_temp.id('acc')) ->> 'version')::int, 4, 'atomicité : version de la ligne existante inchangée');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Idempotence et résolution
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := pg_temp.u('a');
  b uuid := pg_temp.u('b');
  cid uuid := gen_random_uuid();
  lot jsonb;
  r1 jsonb;
  r2 jsonb;
  r jsonb;
begin
  perform tests.as_user(a);
  lot := pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('x3')), null, pg_temp.acc(a, pg_temp.id('x3'), 'Idempotent'))), cid);
  r1 := pg_temp.try(lot);
  perform tests.eq(r1 -> 'ok' ->> 'status', 'applied', 'soumission initiale : applied');
  r2 := pg_temp.try(lot);
  perform tests.eq(r2 -> 'ok' ->> 'status', 'replayed', 'rejeu : replayed');
  perform tests.eq(r2 -> 'ok' -> 'versions', r1 -> 'ok' -> 'versions', 'rejeu : confirmation d''origine');
  perform tests.as_admin();
  perform tests.eq((pg_temp.state('accounts', pg_temp.id('x3')) ->> 'version')::int, 1, 'rejeu : aucune seconde application (version 1)');
  perform tests.as_user(a);
  -- Même contenu, clés JSON dans un autre ordre : même empreinte (jsonb canonique).
  r := pg_temp.try(jsonb_build_object('ops', lot -> 'ops', 'userId', a, 'changesetId', cid, 'protocol', 1));
  perform tests.eq(r -> 'ok' ->> 'status', 'replayed', 'rejeu : ordre des champs indifférent');
  -- Même identifiant, contenu différent → refus.
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('x3')), null, pg_temp.acc(a, pg_temp.id('x3'), 'Falsifié'))), cid));
  perform tests.eq(r ->> 'code', 'changeset_id_reused', 'même identifiant, autre contenu : changeset_id_reused');
  -- Résolution d'un lot appliqué : résultat d'origine.
  r := pg_temp.try_resolve(cid::text);
  perform tests.eq(r -> 'ok' ->> 'status', 'replayed', 'résolution d''un lot appliqué : replayed');
  perform tests.eq(r -> 'ok' -> 'versions', r1 -> 'ok' -> 'versions', 'résolution : confirmation d''origine');
  -- Résolution d'un lot inconnu → abandonné ; ensuite jamais appliqué.
  cid := gen_random_uuid();
  r := pg_temp.try_resolve(cid::text);
  perform tests.eq(r -> 'ok', jsonb_build_object('changesetId', cid, 'status', 'abandoned'), 'résolution d''un lot inconnu : abandoned');
  perform tests.eq(pg_temp.try_resolve(cid::text) -> 'ok' ->> 'status', 'abandoned', 'résolution répétée : toujours abandoned');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('x1')), null, pg_temp.acc(a, pg_temp.id('x1')))), cid));
  perform tests.eq(r ->> 'code', 'changeset_abandoned', 'lot abandonné (valide) soumis ensuite : changeset_abandoned, jamais appliqué');
  perform tests.as_admin();
  perform tests.eq(pg_temp.state('accounts', pg_temp.id('x1')), null::jsonb, 'lot abandonné : aucune ligne écrite');
  perform tests.as_user(a);
  perform tests.eq(pg_temp.try_resolve('pas-un-uuid') ->> 'code', 'invalid_changeset', 'résolution : identifiant invalide refusé');
  -- Périmètre utilisateur : l'identifiant d'un lot de A est inconnu pour B.
  perform tests.as_user(b);
  r := pg_temp.try_resolve((r1 -> 'ok' ->> 'changesetId'));
  perform tests.eq(r -> 'ok' ->> 'status', 'abandoned', 'résolution par B d''un lot de A : inconnu pour B (abandonné pour B seulement)');
  perform tests.as_user(a);
  perform tests.eq(pg_temp.try_resolve(r1 -> 'ok' ->> 'changesetId') -> 'ok' ->> 'status', 'replayed', 'le lot de A reste appliqué pour A');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Sécurité
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := pg_temp.u('a');
  b uuid := pg_temp.u('b');
  r jsonb;
  lot jsonb;
begin
  lot := pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(gen_random_uuid()), null, pg_temp.acc(a, gen_random_uuid()))));
  -- Non authentifié : anon n'a pas le droit d'exécuter ; authenticated sans identité refusé.
  perform tests.as_anon();
  perform tests.throws(format('select public.apply_changeset(%L::jsonb)', lot), 'anon : exécution refusée', '42501');
  perform tests.throws('select public.resolve_changeset(''00000000-0000-4000-8000-000000000000'')', 'anon : résolution refusée', '42501');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
  perform tests.eq(pg_temp.try(lot) ->> 'code', 'unauthorized', 'jeton sans utilisateur : unauthorized');
  perform tests.eq(pg_temp.try(lot) ->> 'state', 'PT403', 'unauthorized : SQLSTATE PT403 (HTTP 403)');
  perform set_config('request.jwt.claims', '{"role": "authenticated", "sub": "pas-un-uuid"}', true);
  perform tests.eq(pg_temp.try(lot) ->> 'code', 'unauthorized', 'identifiant d''utilisateur invalide : unauthorized');
  -- A tente d'écrire pour B.
  perform tests.as_user(a);
  perform tests.eq(pg_temp.try(pg_temp.cs(b, lot -> 'ops')) ->> 'code', 'unauthorized', 'userId du lot ≠ utilisateur authentifié : unauthorized');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('x1')), null, pg_temp.acc(b, pg_temp.id('x1'))))));
  perform tests.eq(r ->> 'code', 'unauthorized', 'ligne attribuée à B : unauthorized');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('profiles', pg_temp.k(b), 1, jsonb_build_object('id', b, 'display_name', 'Piraté')))));
  perform tests.eq(r ->> 'code', 'unauthorized', 'profil de B : unauthorized');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('user_settings', jsonb_build_object('user_id', b), null, pg_temp.settings(b)))));
  perform tests.eq(r ->> 'code', 'unauthorized', 'paramètres de B : unauthorized');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('notification_states', jsonb_build_object('user_id', b, 'id', 'n'), null,
    jsonb_build_object('id', 'n', 'user_id', b, 'read', true, 'dismissed', false, 'updated_at', pg_temp.ts())))));
  perform tests.eq(r ->> 'code', 'unauthorized', 'clé composite (user_id) de B : unauthorized');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.del('notification_states', jsonb_build_object('user_id', b, 'id', 'n'), 1))));
  perform tests.eq(r ->> 'code', 'unauthorized', 'suppression avec une clé (user_id) de B : unauthorized');
  r := pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.del('user_settings', jsonb_build_object('user_id', b), 1))));
  perform tests.eq(r ->> 'code', 'unauthorized', 'suppression des paramètres de B : unauthorized');
  -- Lignes de A invisibles pour B : modification / suppression = clé inconnue (conflit), aucune donnée de A révélée.
  perform tests.as_user(b);
  r := pg_temp.try(pg_temp.cs(b, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 4, pg_temp.acc(b, pg_temp.id('acc'), 'Piraté')))));
  perform tests.eq(r -> 'detail' -> 'conflicts' -> 0 -> 'actualVersion', 'null'::jsonb, 'B modifie la ligne de A : vue comme inexistante (conflit, aucune version révélée)');
  r := pg_temp.try(pg_temp.cs(b, jsonb_build_array(pg_temp.del('accounts', pg_temp.k(pg_temp.id('acc')), 4))));
  perform tests.eq(r ->> 'code', 'version_conflict', 'B supprime la ligne de A : conflit');
  r := pg_temp.try(pg_temp.cs(b, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), null, pg_temp.acc(b, pg_temp.id('acc'))))));
  perform tests.eq(r ->> 'code', 'duplicate_key', 'B crée une ligne avec l''UUID d''une ligne de A : duplicate_key (P7)');
  perform tests.ok(r -> 'detail' ->> 'sqlstate' is null and r -> 'detail' -> 'conflicts' is null, 'duplicate_key : aucun détail sur la ligne de A');
  perform tests.as_admin();
  perform tests.eq((select name from public.accounts where id = pg_temp.id('acc')), 'Réactivé', 'ligne de A intacte');
  -- Tables hors liste blanche, dont meta.
  perform tests.as_user(a);
  foreach r in array array['"meta"', '"auth.users"', '"public.accounts"', '"changesets"', '"Accounts"', '"pg_authid"', '42']::jsonb[] loop
    perform tests.eq(pg_temp.try(pg_temp.cs(a, jsonb_build_array(jsonb_build_object('table', r, 'type', 'put', 'key', '{"id": "x"}'::jsonb,
      'expectedVersion', null, 'row', '{}'::jsonb)))) ->> 'code', 'unsupported_table', format('table %s : unsupported_table', r));
  end loop;
  -- Métadonnées serveur imposées.
  foreach r in array array['{"version": 99}', '{"deleted_at": "2020-01-01T00:00:00Z"}', '{"sync_txid": 1}', '{"server_updated_at": "2020-01-01T00:00:00Z"}']::jsonb[] loop
    perform tests.eq(pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 4, pg_temp.acc(a, pg_temp.id('acc')) || r)))) ->> 'code',
      'invalid_row', format('métadonnée imposée %s : invalid_row', r));
  end loop;
  -- Colonne inconnue, colonne manquante, injection par nom de colonne.
  perform tests.eq(pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 4,
    pg_temp.acc(a, pg_temp.id('acc')) || '{"name\"; drop table public.accounts; --": 1}')))) ->> 'code', 'invalid_row', 'nom de colonne malveillant : invalid_row');
  perform tests.eq(pg_temp.try(pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(pg_temp.id('acc')), 4,
    pg_temp.acc(a, pg_temp.id('acc')) - 'color')))) ->> 'code', 'invalid_row', 'colonne manquante : invalid_row');
  -- Écritures SQL directes : refusées après révocation (lecture conservée).
  perform tests.throws(format('update public.accounts set name = ''Direct'' where id = %L', pg_temp.id('acc')), 'UPDATE direct refusé', '42501');
  perform tests.throws(format('insert into public.accounts select * from public.accounts where id = %L', pg_temp.id('acc')), 'INSERT direct refusé', '42501');
  perform tests.throws(format('update public.profiles set display_name = ''Direct'' where id = %L', a), 'UPDATE direct du profil refusé', '42501');
  perform tests.throws('select * from private.changesets', 'suivi des lots illisible', '42501');
  perform tests.throws('select * from private.changeset_tables', 'liste blanche illisible', '42501');
  -- (SET ROLE dépend de l'utilisateur de SESSION : ici le banc, sous PostgREST « authenticator ».)
  perform tests.ok(not pg_has_role('authenticator', 'nexora_writer', 'MEMBER'), 'authenticator (PostgREST) n''est pas membre de nexora_writer');
  perform tests.eq((select count(*) from public.accounts where id = pg_temp.id('acc')), 1::bigint, 'lecture de ses propres lignes conservée');
  -- Isolation RLS en lecture.
  perform tests.as_user(b);
  perform tests.eq((select count(*) from public.accounts where user_id = a), 0::bigint, 'RLS : B ne lit aucune ligne de A');
end $$;

-- Validation de la forme (codes distincts).
do $$
declare
  a uuid := pg_temp.u('a');
  good jsonb;
  c record;
begin
  perform tests.as_user(a);
  good := pg_temp.put('accounts', pg_temp.k(pg_temp.id('x1')), null, pg_temp.acc(a, pg_temp.id('x1')));
  for c in select * from (values
    ('null', null::jsonb, 'invalid_changeset'),
    ('tableau', '[]'::jsonb, 'invalid_changeset'),
    ('champ inconnu', pg_temp.cs(a, jsonb_build_array(good)) || '{"extra": 1}', 'invalid_changeset'),
    ('champ manquant', pg_temp.cs(a, jsonb_build_array(good)) - 'userId', 'invalid_changeset'),
    ('protocole 2', pg_temp.cs(a, jsonb_build_array(good)) || '{"protocol": 2}', 'unsupported_protocol'),
    ('protocole texte', pg_temp.cs(a, jsonb_build_array(good)) || '{"protocol": "1"}', 'unsupported_protocol'),
    ('changesetId invalide', pg_temp.cs(a, jsonb_build_array(good)) || '{"changesetId": "x"}', 'invalid_changeset'),
    ('ops vide', pg_temp.cs(a, '[]'), 'invalid_changeset'),
    ('ops objet', pg_temp.cs(a, '{}'), 'invalid_changeset'),
    ('doublon de clé', pg_temp.cs(a, jsonb_build_array(good, good)), 'invalid_changeset'),
    ('type inconnu', pg_temp.cs(a, jsonb_build_array(good || '{"type": "upsert"}')), 'invalid_operation'),
    ('champ d''opération inconnu', pg_temp.cs(a, jsonb_build_array(good || '{"extra": 1}')), 'invalid_operation'),
    ('expectedVersion 0', pg_temp.cs(a, jsonb_build_array(good || '{"expectedVersion": 0}')), 'invalid_operation'),
    ('expectedVersion décimale', pg_temp.cs(a, jsonb_build_array(good || '{"expectedVersion": 1.5}')), 'invalid_operation'),
    ('expectedVersion texte', pg_temp.cs(a, jsonb_build_array(good || '{"expectedVersion": "1"}')), 'invalid_operation'),
    ('expectedVersion absente', pg_temp.cs(a, jsonb_build_array(good - 'expectedVersion')), 'invalid_operation'),
    ('suppression avec ligne', pg_temp.cs(a, jsonb_build_array(good || '{"type": "delete"}')), 'invalid_operation'),
    ('clé : colonne en trop', pg_temp.cs(a, jsonb_build_array(good || jsonb_build_object('key', pg_temp.k(pg_temp.id('x1')) || '{"user_id": "x"}'))), 'invalid_key'),
    ('clé : nom faux', pg_temp.cs(a, jsonb_build_array(good || '{"key": {"uuid": "x"}}')), 'invalid_key'),
    ('clé : valeur objet', pg_temp.cs(a, jsonb_build_array(good || '{"key": {"id": {"a": 1}}}')), 'invalid_key'),
    ('clé : UUID invalide', pg_temp.cs(a, jsonb_build_array(pg_temp.del('accounts', '{"id": "pas-un-uuid"}', 1))), 'invalid_key'),
    ('clé ≠ ligne', pg_temp.cs(a, jsonb_build_array(good || jsonb_build_object('key', pg_temp.k(gen_random_uuid())))), 'invalid_key'),
    ('ligne absente', pg_temp.cs(a, jsonb_build_array(good - 'row')), 'invalid_row'),
    ('ligne tableau', pg_temp.cs(a, jsonb_build_array(good || '{"row": []}')), 'invalid_row')
  ) v(label, p, code) loop
    perform tests.eq(pg_temp.try(c.p) ->> 'code', c.code, format('forme : %s → %s', c.label, c.code));
  end loop;
  perform tests.eq(pg_temp.try(pg_temp.cs(a, '[]')) ->> 'state', 'PT400', 'erreurs de forme : SQLSTATE PT400 (HTTP 400)');
  -- Taille maximale (D4-6).
  perform tests.eq(pg_temp.try(pg_temp.cs(a, (select jsonb_agg(pg_temp.del('accounts', pg_temp.k(gen_random_uuid()), 1)) from generate_series(1, 5001)))) ->> 'code',
    'changeset_too_large', 'plus de 5 000 opérations : changeset_too_large');
  perform tests.eq(pg_temp.try(pg_temp.cs(a, jsonb_build_array(good || jsonb_build_object('row', pg_temp.acc(a, pg_temp.id('x1'), repeat('x', 4194304)))))) ->> 'state',
    'PT413', 'plus de 4 Mio : changeset_too_large (HTTP 413)');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Concurrence (deux sessions réelles, dblink)
-- ---------------------------------------------------------------------------
create function pg_temp.session(conn text, uid uuid) returns void language plpgsql as $$
begin
  perform tests.db_connect(conn);
  perform tests.db_exec(conn, 'set role authenticated');
  perform tests.db_value(conn, format('select set_config(''request.jwt.claims'', %L, false)', json_build_object('sub', uid, 'role', 'authenticated')::text));
end $$;
create function pg_temp.remote_try(conn text, p jsonb) returns text language plpgsql as $$
begin
  return tests.db_value(conn, format('select public.apply_changeset(%L::jsonb)::text', p));
exception when others then
  return 'ERR:' || sqlerrm;
end $$;
create function pg_temp.send(conn text, sql text) returns void language plpgsql as $$
begin
  execute format('select %s.dblink_send_query($1, $2)', tests.dblink_schema()) using conn, sql;
end $$;
-- Attend (au plus max_s secondes) qu'une autre session soit bloquée sur un verrou : la
-- seconde requête est alors réellement concurrente de la première (pas de pause arbitraire).
create function pg_temp.wait_blocked(max_s numeric default 10) returns boolean language plpgsql as $$
declare
  t0 timestamptz := clock_timestamp();
begin
  loop
    if exists (select 1 from pg_locks where not granted) then
      return true;
    end if;
    if clock_timestamp() - t0 > make_interval(secs => max_s) then
      return false;
    end if;
    perform pg_sleep(0.02);
  end loop;
end $$;
-- Résultat d'une requête asynchrone attendue au plus max_s secondes ; au-delà, la requête
-- est annulée et 'TIMEOUT' est renvoyé (aucun blocage possible de la suite).
create function pg_temp.await(conn text, max_s numeric) returns text language plpgsql as $$
declare
  t0 timestamptz := clock_timestamp();
  sch text := tests.dblink_schema();
  busy int;
begin
  loop
    execute format('select %s.dblink_is_busy($1)', sch) into busy using conn;
    exit when busy = 0;
    if clock_timestamp() - t0 > make_interval(secs => max_s) then
      execute format('select %s.dblink_cancel_query($1)', sch) using conn;
      perform pg_temp.result(conn);
      return 'TIMEOUT';
    end if;
    perform pg_sleep(0.02);
  end loop;
  return pg_temp.result(conn);
end $$;

-- Statut d'une réponse distante, ou l'erreur reçue (jamais d'exception de conversion).
create function pg_temp.status(r text) returns text language sql as $$
  select case when r is null then 'null' when r like 'ERR:%' then r else r::jsonb ->> 'status' end
$$;
create function pg_temp.result(conn text) returns text language plpgsql as $$
declare
  v text;
  sch text := tests.dblink_schema();
begin
  begin
    execute format('select t.v from %s.dblink_get_result($1) as t(v text)', sch) into v using conn;
  exception when others or query_canceled then -- l'annulation (57014) n'est pas couverte par OTHERS
    v := 'ERR:' || sqlerrm;
  end;
  -- Résultat vide final, obligatoire avant toute réutilisation de la connexion.
  begin
    execute format('select count(*) from %s.dblink_get_result($1) as t(v text)', sch) using conn;
  exception when others then
    null;
  end;
  return v;
end $$;

do $$
declare
  a uuid := pg_temp.u('a');
  v_id uuid := gen_random_uuid();
  lot1 jsonb;
  lot2 jsonb;
  r1 text;
  r2 text;
begin
  perform pg_temp.session('d1', a);
  perform pg_temp.session('d2', a);
  -- Ligne initiale (version 1), vue par les deux appareils.
  perform tests.db_value('d1', format('select public.apply_changeset(%L::jsonb)::text',
    pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(v_id), null, pg_temp.acc(a, v_id, 'Initial'))))));
  lot1 := pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(v_id), 1, pg_temp.acc(a, v_id, 'Appareil 1'))));
  lot2 := pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(v_id), 1, pg_temp.acc(a, v_id, 'Appareil 2'))));
  -- Appareil 1 écrit dans une transaction encore ouverte ; appareil 2 écrit en même temps.
  perform tests.db_exec('d1', 'begin');
  perform tests.db_value('d1', format('select public.apply_changeset(%L::jsonb)::text', lot1));
  perform pg_temp.send('d2', format('select public.apply_changeset(%L::jsonb)::text', lot2));
  perform tests.ok(pg_temp.wait_blocked(), 'la seconde session attend la première (concurrence réelle)');
  perform tests.db_exec('d1', 'commit');
  r2 := pg_temp.result('d2');
  perform tests.ok(r2 like 'ERR:version_conflict%', 'concurrence (même version initiale) : le second appareil reçoit version_conflict', r2);
  perform tests.eq((select name from public.accounts where id = v_id), 'Appareil 1', 'concurrence : l''écriture acceptée n''est pas écrasée');
  perform tests.eq((pg_temp.state('accounts', v_id) ->> 'version')::int, 2, 'concurrence : une seule incrémentation (version 2)');

  -- Même changesetId soumis deux fois en parallèle : une application, un rejeu.
  lot1 := pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(v_id), 2, pg_temp.acc(a, v_id, 'Double envoi'))));
  perform tests.db_exec('d1', 'begin');
  r1 := tests.db_value('d1', format('select public.apply_changeset(%L::jsonb)::text', lot1));
  perform pg_temp.send('d2', format('select public.apply_changeset(%L::jsonb)::text', lot1));
  perform tests.ok(pg_temp.wait_blocked(), 'la seconde session attend la première (concurrence réelle)');
  perform tests.db_exec('d1', 'commit');
  r2 := pg_temp.result('d2');
  perform tests.eq(pg_temp.status(r1), 'applied', 'même lot en parallèle : premier applied');
  perform tests.eq(pg_temp.status(r2), 'replayed', 'même lot en parallèle : second replayed');
  perform tests.ok(r2 not like 'ERR:%' and r2::jsonb -> 'versions' = r1::jsonb -> 'versions', 'même lot en parallèle : même confirmation', r2);
  perform tests.eq((pg_temp.state('accounts', v_id) ->> 'version')::int, 3, 'même lot en parallèle : appliqué une seule fois');

  -- Création concurrente d'une même clé : une seule réussit.
  v_id := gen_random_uuid();
  lot1 := pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(v_id), null, pg_temp.acc(a, v_id, 'C1'))));
  lot2 := pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(v_id), null, pg_temp.acc(a, v_id, 'C2'))));
  perform tests.db_exec('d1', 'begin');
  perform tests.db_value('d1', format('select public.apply_changeset(%L::jsonb)::text', lot1));
  perform pg_temp.send('d2', format('select public.apply_changeset(%L::jsonb)::text', lot2));
  perform tests.ok(pg_temp.wait_blocked(), 'la seconde session attend la première (concurrence réelle)');
  perform tests.db_exec('d1', 'commit');
  r2 := pg_temp.result('d2');
  perform tests.ok(r2 like 'ERR:version_conflict%', 'création concurrente d''une même clé : conflit pour la seconde', r2);
  perform tests.eq((select name from public.accounts where id = v_id), 'C1', 'création concurrente : la première est conservée');

  -- Résolution pendant qu'un lot est en cours : issue non encore déterminée.
  lot1 := pg_temp.cs(a, jsonb_build_array(pg_temp.put('accounts', pg_temp.k(v_id), 1, pg_temp.acc(a, v_id, 'En cours'))));
  perform tests.db_exec('d1', 'begin');
  perform tests.db_value('d1', format('select public.apply_changeset(%L::jsonb)::text', lot1));
  -- Spécification : attente du verrou limitée à 5 s, puis changeset_pending. Attente bornée à
  -- 10 s ici : au-delà, la requête est annulée et l'assertion échoue (jamais de blocage).
  perform pg_temp.send('d2', format('select public.resolve_changeset(%L)::text', lot1 ->> 'changesetId'));
  r2 := pg_temp.await('d2', 10);
  perform tests.ok(r2 like 'ERR:changeset_pending%', 'résolution pendant un lot en cours : changeset_pending (rien modifié)', r2);
  perform tests.db_exec('d1', 'commit');
  r2 := tests.db_value('d2', format('select public.resolve_changeset(%L)::text', lot1 ->> 'changesetId'));
  perform tests.eq(pg_temp.status(r2), 'replayed', 'résolution après validation du lot : replayed');
  perform tests.eq((pg_temp.state('accounts', v_id) ->> 'version')::int, 2, 'résolution : lot appliqué une seule fois');
  perform tests.db_disconnect('d1');
  perform tests.db_disconnect('d2');
end $$;
