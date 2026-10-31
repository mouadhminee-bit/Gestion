-- =============================================================================
-- Outillage de test (base éphémère uniquement) : assertions, changement d'identité,
-- jeu de données complet par utilisateur, fonction de récupération de référence.
-- Rien de ce fichier n'appartient au schéma NEXORA.
-- =============================================================================
\set ON_ERROR_STOP on

create schema tests;
create extension if not exists dblink schema tests;
grant usage on schema tests to anon, authenticated;

-- dsn : connexion des sessions concurrentes (dblink) ; admin_role : rôle « administrateur »
-- des tests (postgres en local ; sur Supabase, service_role si postgres ne contourne pas la RLS).
create table tests.config (dsn text not null, admin_role text not null);
insert into tests.config values (:'dsn', :'admin_role');

create table tests.results (
  n bigserial primary key,
  file text,
  name text not null,
  ok boolean not null,
  detail text
);
grant select, insert on tests.results to anon, authenticated;
grant usage on sequence tests.results_n_seq to anon, authenticated;

create function tests.ok(cond boolean, name text, detail text default null) returns void
language plpgsql as $$
begin
  insert into tests.results (file, name, ok, detail)
  values (current_setting('tests.file', true), name, coalesce(cond, false), detail);
end $$;

create function tests.eq(actual anyelement, expected anyelement, name text) returns void
language plpgsql as $$
begin
  perform tests.ok(actual is not distinct from expected, name,
    format('obtenu=%s attendu=%s', actual, expected));
end $$;

-- L'instruction doit échouer (avec le SQLSTATE attendu s'il est donné). Les contraintes
-- différées sont vérifiées immédiatement (set constraints all immediate).
create function tests.throws(sql text, name text, expected_state text default null) returns void
language plpgsql as $$
begin
  begin
    execute sql;
    set constraints all immediate;
    raise exception using errcode = 'P0099', message = 'NO_ERROR';
  exception when others then
    if sqlstate = 'P0099' then
      perform tests.ok(false, name, 'aucune erreur levée');
    else
      perform tests.ok(expected_state is null or sqlstate = expected_state, name, sqlstate || ' ' || sqlerrm);
    end if;
  end;
end $$;

-- L'instruction doit réussir, contraintes différées comprises ; ses effets sont annulés.
create function tests.lives(sql text, name text) returns void
language plpgsql as $$
begin
  begin
    execute sql;
    set constraints all immediate;
    raise exception using errcode = 'P0098', message = 'ROLLBACK_OK';
  exception when others then
    perform tests.ok(sqlstate = 'P0098', name, case when sqlstate = 'P0098' then null else sqlstate || ' ' || sqlerrm end);
  end;
end $$;

-- L'instruction doit réussir ; ses effets sont CONSERVÉS.
create function tests.lives_keep(sql text, name text) returns void
language plpgsql as $$
begin
  begin
    execute sql;
    set constraints all immediate;
    set constraints all deferred;
    perform tests.ok(true, name);
  exception when others then
    perform tests.ok(false, name, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- Nombre de lignes affectées par une instruction.
create function tests.affected(sql text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end $$;

-- Changements d'identité (comme PostgREST : rôle + revendications JWT).
create function tests.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function tests.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

create function tests.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', (select admin_role from tests.config), true);
  perform set_config('request.jwt.claims', '', true);
end $$;

grant execute on all functions in schema tests to anon, authenticated;

-- Utilisateur FICTIF (@example.test). Créé par l'utilisateur de session (auth.users n'est pas
-- accessible aux rôles applicatifs), puis le rôle courant est rétabli.
create function tests.new_user(label text default 'test') returns uuid
language plpgsql as $$
declare
  uid uuid := gen_random_uuid();
  prev text := current_setting('role');
begin
  perform set_config('role', session_user, true);
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  values (uid, label || '-' || uid || '@example.test', jsonb_build_object('display_name', label), 'authenticated', 'authenticated');
  perform set_config('role', prev, true);
  return uid;
end $$;

-- Jeu de données complet d'un utilisateur : une ligne dans CHAQUE table, toutes les
-- références renseignées vers ses propres lignes. Exécuté en administrateur.
-- Renvoie les identifiants créés.
create function tests.seed(uid uuid) returns jsonb
language plpgsql as $$
declare
  ts constant timestamptz := '2026-10-31T12:00:00.000Z';
  acc uuid := gen_random_uuid(); acc2 uuid := gen_random_uuid();
  cat uuid := gen_random_uuid(); sub uuid := gen_random_uuid();
  imp uuid := gen_random_uuid(); tx uuid := gen_random_uuid(); att uuid := gen_random_uuid();
  bud uuid := gen_random_uuid(); goal uuid := gen_random_uuid(); contrib uuid := gen_random_uuid();
  rule uuid := gen_random_uuid(); debt uuid := gen_random_uuid(); pay uuid := gen_random_uuid();
  debt_tx uuid := gen_random_uuid(); asset uuid := gen_random_uuid(); val uuid := gen_random_uuid();
  rate uuid := gen_random_uuid();
begin
  insert into public.user_settings (user_id, display_name, base_currency, language, locale, time_zone, date_format,
    week_starts_on, theme, currency_display, privacy_mode, budget_alert_thresholds, notify_budgets, notify_bills,
    notify_debts, bill_reminder_days, onboarded, demo_mode, updated_at)
  values (uid, 'Test', 'MAD', 'fr', 'fr-MA', 'Africa/Casablanca', 'DD/MM/YYYY', 1, 'dark', 'symbol', false,
    '{50,75,90,100}', true, true, true, 7, true, false, ts);
  insert into public.accounts values
    (acc, uid, 'Banque', 'bank', 'MAD', 500000, '2026-03-01', false, true, '#fff', null, 0, ts, ts),
    (acc2, uid, 'Épargne', 'savings', 'MAD', 0, '2026-03-01', false, true, '#fff', null, 1, ts, ts);
  insert into public.categories values
    (cat, uid, 'food', 'Alimentation', 'expense', 'variable', null, 'X', '#000', false, 0, ts, ts),
    (sub, uid, null, 'Marché', 'expense', 'variable', cat, 'X', '#000', false, 1, ts, ts);
  insert into public.import_batches values (imp, uid, 'releve.csv', acc, 1, 1, 0, ts);
  insert into public.recurring_rules values
    (rule, uid, 'expense', 'Loyer', 280000, 'MAD', acc, cat, sub, null, 'monthly', null, null, '2026-03-03', null, true, null, ts, ts);
  insert into public.debts values
    (debt, uid, 'Crédit', 'loan', 'payable', 1000000, 'MAD', '2026-03-01', null, null, 4.5, null, null, 'active', null, debt_tx, ts, ts);
  insert into public.debt_payments values (pay, uid, debt, '2026-03-15', 100000, 5000, acc, debt_tx, null, ts);
  insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, category_id, subcategory_id,
      account_id, tags, attachment_id, status, refund_of_id, recurring_rule_id, recurring_due_date, import_batch_id,
      counterpart_account_id, created_at, updated_at)
    values (tx, uid, 'expense', 'out', 10000, 'MAD', 'Test', '2026-03-10', cat, sub, acc, '{}', att, 'cleared', null,
      rule, '2026-03-03', imp, acc2, ts, ts);
  update public.transactions set refund_of_id = tx where id = tx;
  insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status,
      debt_id, debt_payment_id, interest_amount, created_at, updated_at)
    values (debt_tx, uid, 'debt', 'out', 105000, 'MAD', 'Remboursement', '2026-03-15', acc, '{}', 'cleared',
      debt, pay, 5000, ts, ts);
  insert into public.attachments values (att, uid, 'recu.png', 'image/png', 3, ts);
  insert into public.budgets values (bud, uid, '2026-03', cat, 160000, 'MAD', null, ts, ts);
  insert into public.savings_goals values
    (goal, uid, 'Voyage', null, 100000, 'MAD', 0, null, 'medium', acc2, false, null, 'active', 'X', '#fff', ts, ts);
  insert into public.goal_contributions values (contrib, uid, goal, '2026-03-10', 100, null, ts);
  insert into public.recurring_occurrences values (uid, rule, '2026-03-03', 'paid', tx, null, ts);
  insert into public.assets values (asset, uid, 'Portefeuille', 'investment', 'MAD', acc2, false, null, ts, ts);
  insert into public.asset_valuations values (val, uid, asset, '2026-03-01', 70000, 'manual', null, ts);
  insert into public.exchange_rates values (rate, uid, 'EUR', 'MAD', 10.86, '2026-03-01', 'manual', ts);
  insert into public.notification_states values (uid, 'budget:x:2026-03:90', true, false, ts);
  set constraints all immediate;
  set constraints all deferred;
  return jsonb_build_object('accounts', acc, 'accounts2', acc2, 'categories', cat, 'subcategory', sub,
    'import_batches', imp, 'transactions', tx, 'debt_tx', debt_tx, 'attachments', att, 'budgets', bud,
    'savings_goals', goal, 'goal_contributions', contrib, 'recurring_rules', rule, 'debts', debt,
    'debt_payments', pay, 'assets', asset, 'asset_valuations', val, 'exchange_rates', rate);
end $$;

-- Colonnes de la clé primaire d'une table.
create function tests.pk_cols(rel regclass) returns text[] language sql as $$
  select array_agg(a.attname::text order by k.ord)
  from pg_index i cross join unnest(i.indkey) with ordinality k(attnum, ord)
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
  where i.indrelid = rel and i.indisprimary
$$;

-- Clause « where » ciblant exactement une ligne (par sa clé primaire).
create function tests.where_pk(rel regclass, r jsonb) returns text language sql as $$
  select string_agg(format('%I = %L', c, r ->> c), ' and ') from unnest(tests.pk_cols(rel)) c
$$;

-- Copie d'une ligne avec une nouvelle clé primaire (et d'éventuels remplacements).
create function tests.with_new_pk(rel regclass, r jsonb) returns jsonb language plpgsql as $$
declare
  c text;
  typ text;
  out_row jsonb := r;
begin
  foreach c in array tests.pk_cols(rel) loop
    if c = 'user_id' then continue; end if;
    -- recurring_occurrences : rule_id est aussi une référence ; seule l'échéance change.
    if rel = 'public.recurring_occurrences'::regclass and c = 'rule_id' then continue; end if;
    select format_type(atttypid, atttypmod) into typ from pg_attribute where attrelid = rel and attname = c;
    out_row := jsonb_set(out_row, array[c], case typ
      when 'uuid' then to_jsonb(gen_random_uuid())
      when 'date' then to_jsonb('2099-12-31'::date)
      else to_jsonb('copie-' || gen_random_uuid()) end);
  end loop;
  -- Unicités métier différées : la copie ne doit pas entrer en conflit.
  if rel = 'public.budgets'::regclass then out_row := jsonb_set(out_row, '{month}', '"2099-01"'); end if;
  if rel = 'public.assets'::regclass then out_row := jsonb_set(out_row, '{archived}', 'true'); end if;
  return out_row;
end $$;

grant execute on all functions in schema tests to anon, authenticated;

-- Suppression d'un utilisateur fictif (auth.users : utilisateur de session uniquement).
create function tests.delete_user(uid uuid) returns void
language plpgsql as $$
declare
  prev text := current_setting('role');
begin
  perform set_config('role', session_user, true);
  delete from auth.users where id = uid;
  perform set_config('role', prev, true);
end $$;

-- Tables NEXORA portant user_id (référentiel des tests génériques).
create view tests.user_tables as
  select c.oid as relid, c.relname::text as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped);

-- Toutes les tables du schéma public.
create view tests.public_tables as
  select c.oid as relid, c.relname::text as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p');

-- Récupération de référence (prototype du Lot 5, NON livré dans le schéma) :
-- 1) borne haute = plus ancienne transaction encore en cours (pg_snapshot_xmin), calculée
--    AVANT la lecture ; 2) lignes telles que curseur <= sync_txid < borne.
-- Toute transaction d'identifiant < borne est terminée : sa visibilité ne peut plus changer.
create function tests.pull(uid uuid, cursor_in xid8, out hi xid8, out rows jsonb)
language plpgsql as $$
declare
  t record;
  part jsonb;
begin
  hi := pg_snapshot_xmin(pg_current_snapshot());
  rows := '[]'::jsonb;
  for t in select name from tests.user_tables order by name loop
    execute format(
      'select coalesce(jsonb_agg(jsonb_build_object(''table'', %L, ''row'', to_jsonb(x))), ''[]''::jsonb)
         from public.%I x where x.user_id = $1 and x.sync_txid >= $2 and x.sync_txid < $3',
      t.name, t.name)
    into part using uid, cursor_in, hi;
    rows := rows || part;
  end loop;
end $$;

grant select on all tables in schema tests to anon, authenticated;

-- Rôle administrateur alternatif (Supabase, si postgres ne contourne pas la RLS forcée).
grant usage on schema tests to service_role;
grant all on all tables in schema tests to service_role;
grant all on all sequences in schema tests to service_role;
grant execute on all functions in schema tests to service_role;
