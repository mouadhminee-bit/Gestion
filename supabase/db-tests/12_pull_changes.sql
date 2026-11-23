-- =============================================================================
-- 12 — Récupération des changements : public.pull_changes (migration 9, V4.1 / M9)
--
--  P1 catalogue : signature exacte, SECURITY INVOKER, STABLE, search_path vide, propriétaire
--     nexora_writer, exécution par authenticated SEULEMENT ;
--  P2 accès : anon refusé, authenticated sans utilisateur refusé (PT403) ;
--  P3 paramètres invalides refusés (PT400 invalid_pull) ;
--  P4 couverture : les 18 tables, clés SQL, xid8 en texte, nombre de lignes = lecture directe
--     sous la RLS (lignes supprimées comprises) ;
--  P5 isolation entre deux utilisateurs (RLS) ;
--  P6 suppression logique et réactivation récupérées ;
--  P7 pagination au-delà de 1 000 lignes : pages ≤ limite, ordre strict (sync_txid, table,
--     clé), aucune ligne en double ni manquante, borne constante ;
--  P8 modification et insertion PENDANT la pagination : rien n'est perdu (récupération
--     suivante), le cache modèle (version la plus haute par clé) = état du serveur ;
--  P9 lecture seule : aucune version ni sync_txid modifié par les récupérations.
--
-- Les écritures concurrentes passent par une session dblink « w » (rôle administrateur des
-- tests, validation immédiate). Dans les scénarios P6 à P9, la session principale n'écrit
-- rien avant la fin (sa propre transaction retiendrait la borne) : les assertions sont
-- collectées puis enregistrées à la fin (même principe que 07_sync).
-- =============================================================================
\set ON_ERROR_STOP on

create temp table pc (a uuid, b uuid, acc uuid);
insert into pc (a, b) select tests.new_user('pull-a'), tests.new_user('pull-b');
select tests.seed(a) from pc;
select tests.seed(b) from pc;
update pc set acc = (select id from public.accounts where user_id = pc.a order by sort_order limit 1);

-- Récupération complète (toutes les pages) sous l'identité courante.
create function pg_temp.pull_all(cur text, lim int, out bound text, out rows jsonb, out pages int, out sizes int[]) language plpgsql as $$
declare
  j jsonb;
  after jsonb := null;
begin
  rows := '[]'::jsonb; pages := 0; sizes := '{}'; bound := null;
  loop
    j := public.pull_changes(cur, bound, after, lim);
    if bound is not null and j ->> 'bound' <> bound then raise exception 'borne modifiée en cours de pagination'; end if;
    bound := j ->> 'bound';
    rows := rows || (j -> 'rows');
    pages := pages + 1;
    sizes := sizes || jsonb_array_length(j -> 'rows');
    after := j -> 'next';
    exit when after is null or after = 'null'::jsonb;
  end loop;
end $$;

-- Même chose sous l'identité de u, puis retour au rôle administrateur (dblink accessible).
create function pg_temp.pull_as(u uuid, cur text, lim int, out bound text, out rows jsonb, out pages int, out sizes int[]) language plpgsql as $$
begin
  perform tests.as_user(u);
  select * into bound, rows, pages, sizes from pg_temp.pull_all(cur, lim);
  perform tests.as_admin();
end $$;

-- Une page sous l'identité de u.
create function pg_temp.page_as(u uuid, cur text, bound text, after jsonb, lim int) returns jsonb language plpgsql as $$
declare
  j jsonb;
begin
  perform tests.as_user(u);
  j := public.pull_changes(cur, bound, after, lim);
  perform tests.as_admin();
  return j;
end $$;

-- Clé de tri textuelle d'un élément renvoyé (même définition que la fonction).
create function pg_temp.k(e jsonb) returns text language sql immutable as $$
  select case e ->> 'table'
    when 'user_settings' then e -> 'key' ->> 'user_id'
    when 'recurring_occurrences' then (e -> 'key' ->> 'rule_id') || '|' || (e -> 'key' ->> 'due_date')
    else e -> 'key' ->> 'id' end
$$;

-- Les éléments sont-ils dans l'ordre strict (sync_txid, table, clé) en collation « C » ?
create function pg_temp.ordered(rows jsonb) returns boolean language sql as $$
  select coalesce(bool_and(ok), true) from (
    select (prev_s, prev_t collate "C", prev_k collate "C") < (s, t collate "C", k collate "C") as ok from (
      select (e -> 'row' ->> 'sync_txid')::xid8 s, e ->> 'table' t, pg_temp.k(e) k,
             lag((e -> 'row' ->> 'sync_txid')::xid8) over w prev_s, lag(e ->> 'table') over w prev_t, lag(pg_temp.k(e)) over w prev_k
        from jsonb_array_elements(rows) with ordinality x(e, i) window w as (order by i)) z
    where prev_s is not null) y
$$;

-- Cache modèle : version la plus haute par (table, clé).
create function pg_temp.apply(cache jsonb, rows jsonb) returns jsonb language plpgsql as $$
declare
  e jsonb; k text; v bigint;
begin
  for e in select * from jsonb_array_elements(rows) loop
    k := (e ->> 'table') || ':' || pg_temp.k(e);
    v := (e -> 'row' ->> 'version')::bigint;
    if not cache ? k or (cache -> k ->> 'v')::bigint < v then
      cache := cache || jsonb_build_object(k, jsonb_build_object('v', v, 'd', (e -> 'row' -> 'deleted_at') <> 'null'::jsonb));
    end if;
  end loop;
  return cache;
end $$;

-- État validé du serveur pour un utilisateur (18 tables, lignes supprimées comprises), lu par
-- la session « w » (administrateur), au format du cache modèle.
create function pg_temp.truth(u uuid) returns jsonb language plpgsql as $$
begin
  return tests.db_value('w', format($q$
    select coalesce(jsonb_object_agg(k, jsonb_build_object('v', v, 'd', d)), '{}')::text from (
      select 'profiles:' || id k, version v, deleted_at is not null d from public.profiles where id = %1$L
      union all select 'user_settings:' || user_id, version, deleted_at is not null from public.user_settings where user_id = %1$L
      union all select 'recurring_occurrences:' || rule_id || '|' || due_date, version, deleted_at is not null from public.recurring_occurrences where user_id = %1$L
      union all select 'notification_states:' || id, version, deleted_at is not null from public.notification_states where user_id = %1$L
      %2$s) s
  $q$, u, (select string_agg(format('union all select %L || '':'' || id, version, deleted_at is not null from public.%I where user_id = %L', t, t, u), ' ')
             from unnest(array['accounts', 'categories', 'import_batches', 'transactions', 'attachments', 'budgets', 'savings_goals',
                               'goal_contributions', 'recurring_rules', 'debts', 'debt_payments', 'assets', 'asset_valuations', 'exchange_rates']) t)))::jsonb;
end $$;

-- ---------------------------------------------------------------------------
-- P1 — catalogue
-- ---------------------------------------------------------------------------
do $$
declare
  f record;
begin
  select p.oid, p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) owner, p.prorettype::regtype::text rt,
         pg_get_function_identity_arguments(p.oid) args, p.proacl
    into f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pull_changes';
  perform tests.eq(f.args, 'p_cursor text, p_bound text, p_after jsonb, p_limit integer', 'pull_changes : signature exacte');
  perform tests.eq(f.rt, 'jsonb', 'pull_changes : renvoie jsonb');
  perform tests.ok(not f.prosecdef, 'pull_changes : SECURITY INVOKER (droits de l''appelant, RLS appliquée)');
  perform tests.eq(f.provolatile::text, 's', 'pull_changes : STABLE (lecture seule)');
  perform tests.ok(f.proconfig @> array['search_path=""'], 'pull_changes : search_path vide fixé', array_to_string(f.proconfig, ','));
  perform tests.eq(f.owner, 'nexora_writer', 'pull_changes : propriétaire nexora_writer');
  perform tests.ok(has_function_privilege('authenticated', f.oid, 'EXECUTE'), 'pull_changes : exécutable par authenticated');
  perform tests.ok(not has_function_privilege('anon', f.oid, 'EXECUTE'), 'pull_changes : non exécutable par anon');
  perform tests.ok(not has_function_privilege('service_role', f.oid, 'EXECUTE'), 'pull_changes : non exécutable par service_role');
  perform tests.ok(not exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0), 'pull_changes : aucun droit PUBLIC', f.proacl::text);
  perform tests.ok(position('private.' in (select prosrc from pg_proc where oid = f.oid)) = 0
               and position('insert ' in lower((select prosrc from pg_proc where oid = f.oid))) = 0
               and position('update ' in lower((select prosrc from pg_proc where oid = f.oid))) = 0,
    'pull_changes : corps sans accès au schéma private ni écriture (insert / update)');
end $$;

-- ---------------------------------------------------------------------------
-- P2 — accès
-- ---------------------------------------------------------------------------
do $$
begin
  perform tests.as_anon();
  perform tests.throws($s$select public.pull_changes('0')$s$, 'anon : exécution refusée', '42501');
  perform tests.as_admin();
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform tests.throws($s$select public.pull_changes('0')$s$, 'authenticated sans utilisateur (sub absent) : refus PT403', 'PT403');
  perform tests.as_admin();
end $$;

-- ---------------------------------------------------------------------------
-- P3 — paramètres invalides (PT400 invalid_pull), sous l'identité de A
-- ---------------------------------------------------------------------------
do $$
declare
  j jsonb;
  b text;
begin
  perform tests.as_user((select a from pc));
  j := public.pull_changes('0');
  b := j ->> 'bound';
  perform tests.ok(b ~ '^[0-9]+$', 'borne renvoyée en texte décimal (xid8)', b);
  perform tests.throws($s$select public.pull_changes(null)$s$, 'p_cursor nul : refusé', 'PT400');
  perform tests.throws($s$select public.pull_changes('-1')$s$, 'p_cursor négatif : refusé', 'PT400');
  perform tests.throws($s$select public.pull_changes('12a')$s$, 'p_cursor non numérique : refusé', 'PT400');
  perform tests.throws($s$select public.pull_changes('123456789012345678901')$s$, 'p_cursor de plus de 20 chiffres : refusé', 'PT400');
  perform tests.throws($s$select public.pull_changes('0', 'x')$s$, 'p_bound non numérique : refusé', 'PT400');
  perform tests.throws(format('select public.pull_changes(%L, %L)', '0', ((b::numeric) + 1000000)::text), 'p_bound postérieure à la borne sûre : refusée', 'PT400');
  perform tests.throws(format('select public.pull_changes(%L, %L)', ((b::numeric) + 1)::text, b), 'p_cursor supérieur à la borne : refusé', 'PT400');
  perform tests.throws($s$select public.pull_changes('0', null, '{"txid": "1", "table": "accounts", "key": "x"}')$s$, 'p_after sans p_bound : refusé', 'PT400');
  perform tests.throws(format('select public.pull_changes(%L, %L, %L)', '0', b, '[1]'), 'p_after non objet : refusé', 'PT400');
  perform tests.throws(format('select public.pull_changes(%L, %L, %L)', '0', b, '{"txid": "1", "table": "accounts", "key": "x", "y": 1}'), 'p_after avec un champ inconnu : refusé', 'PT400');
  perform tests.throws(format('select public.pull_changes(%L, %L, %L)', '0', b, '{"txid": 1, "table": "accounts", "key": "x"}'), 'p_after.txid non textuel : refusé', 'PT400');
  perform tests.throws(format('select public.pull_changes(%L, %L, %L)', '0', b, jsonb_build_object('txid', b, 'table', 'accounts', 'key', 'x')), 'p_after hors de l''intervalle : refusé', 'PT400');
  perform tests.throws($s$select public.pull_changes('0', null, null, 0)$s$, 'p_limit = 0 : refusé', 'PT400');
  perform tests.throws($s$select public.pull_changes('0', null, null, 1001)$s$, 'p_limit = 1001 : refusé', 'PT400');
  perform tests.throws($s$select public.pull_changes('0', null, null, null)$s$, 'p_limit nul : refusé', 'PT400');
  perform tests.as_admin();
end $$;

-- ---------------------------------------------------------------------------
-- P4 — couverture des 18 tables, sous l'identité de A
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := (select pc.a from pc);
  p record;
  t text;
  n_fn bigint;
  n_direct bigint;
  mismatch text := '';
begin
  perform tests.as_user(a);
  select * into p from pg_temp.pull_all('0', 1000);
  perform tests.eq((select count(distinct e ->> 'table') from jsonb_array_elements(p.rows) e), 18::bigint, 'récupération complète : les 18 tables sont couvertes');
  perform tests.ok((select bool_and(coalesce(e -> 'row' ->> 'user_id', e -> 'row' ->> 'id') = a::text) from jsonb_array_elements(p.rows) e),
    'récupération complète : toutes les lignes appartiennent à l''utilisateur');
  perform tests.ok((select bool_and(jsonb_typeof(e -> 'row' -> 'sync_txid') = 'string' and (e -> 'row' ->> 'sync_txid')::xid8 < p.bound::xid8)
                      from jsonb_array_elements(p.rows) e),
    'sync_txid transmis en texte, toujours < borne');
  perform tests.ok((select bool_and(e -> 'row' ? 'version' and e -> 'row' ? 'deleted_at' and e -> 'row' ? 'server_updated_at') from jsonb_array_elements(p.rows) e),
    'chaque ligne porte ses métadonnées serveur (version, deleted_at, server_updated_at)');
  perform tests.ok(
    (select bool_and(case e ->> 'table'
        when 'profiles' then (select array_agg(k order by k) from jsonb_object_keys(e -> 'key') k) = '{id}'
        when 'user_settings' then (select array_agg(k order by k) from jsonb_object_keys(e -> 'key') k) = '{user_id}'
        when 'recurring_occurrences' then (select array_agg(k order by k) from jsonb_object_keys(e -> 'key') k) = '{due_date,rule_id}'
        when 'notification_states' then (select array_agg(k order by k) from jsonb_object_keys(e -> 'key') k) = '{id,user_id}'
        else (select array_agg(k order by k) from jsonb_object_keys(e -> 'key') k) = '{id}' end) from jsonb_array_elements(p.rows) e),
    'clé SQL de chaque ligne conforme à la liste blanche de la migration 8');
  perform tests.ok(pg_temp.ordered(p.rows), 'ordre strict (sync_txid, table, clé)');
  for t in select name from tests.public_tables order by name loop
    n_fn := (select count(*) from jsonb_array_elements(p.rows) e where e ->> 'table' = t);
    execute format('select count(*) from public.%I', t) into n_direct; -- sous la RLS de A
    if n_fn <> n_direct then mismatch := mismatch || format('%s : %s ≠ %s ; ', t, n_fn, n_direct); end if;
  end loop;
  perform tests.ok(mismatch = '', 'récupération complète = lecture directe sous la RLS, table par table (lignes supprimées comprises)', nullif(mismatch, ''));
  perform tests.as_admin();
end $$;

-- ---------------------------------------------------------------------------
-- P5 — isolation entre utilisateurs
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := (select pc.a from pc);
  b uuid := (select pc.b from pc);
  pa record;
  pb record;
begin
  perform tests.as_user(a);
  select * into pa from pg_temp.pull_all('0', 1000);
  perform tests.as_user(b);
  select * into pb from pg_temp.pull_all('0', 1000);
  perform tests.as_admin();
  perform tests.ok(jsonb_array_length(pb.rows) > 0 and jsonb_array_length(pa.rows) > 0, 'isolation : A et B récupèrent chacun leurs propres lignes');
  perform tests.eq((select count(*) from jsonb_array_elements(pa.rows) e where coalesce(e -> 'row' ->> 'user_id', e -> 'row' ->> 'id') = b::text), 0::bigint,
    'isolation : aucune ligne de B dans la récupération de A');
  perform tests.eq((select count(*) from jsonb_array_elements(pb.rows) e where coalesce(e -> 'row' ->> 'user_id', e -> 'row' ->> 'id') = a::text), 0::bigint,
    'isolation : aucune ligne de A dans la récupération de B');
end $$;

-- ---------------------------------------------------------------------------
-- P6 à P9 — scénarios avec écritures concurrentes (session « w »)
-- ---------------------------------------------------------------------------
select tests.db_connect('w');
select tests.db_exec('w', format('set role %I', (select admin_role from tests.config)));

do $$
declare
  a uuid := (select pc.a from pc);
  acc uuid := (select pc.acc from pc);
  res jsonb := '[]';
  p record;
  p0 record;
  cache jsonb;
  cur text;
  bound text;
  j jsonb;
  after jsonb;
  seen jsonb := '[]';
  n_pages int := 0;
  sizes int[] := '{}';
  victim_late text;
  victim_early text;
  inserted_id uuid := gen_random_uuid();
  late_v_before bigint;
  versions_before text;
  versions_after text;
  total_new bigint;
begin
  -- Point de départ : cache modèle complet et curseur.
  select * into p0 from pg_temp.pull_as(a, '0', 1000);
  cache := pg_temp.apply('{}', p0.rows);
  cur := p0.bound;

  -- P6 : suppression logique puis réactivation d'un compte.
  perform tests.db_exec('w', format('update public.accounts set deleted_at = now() where id = %L', acc));
  select * into p from pg_temp.pull_as(a, cur, 1000);
  res := res || jsonb_build_object('ok', exists (select 1 from jsonb_array_elements(p.rows) e
            where e ->> 'table' = 'accounts' and e -> 'key' ->> 'id' = acc::text and e -> 'row' ->> 'deleted_at' is not null),
    'name', 'suppression logique : la ligne supprimée est récupérée (deleted_at renseigné)');
  cache := pg_temp.apply(cache, p.rows); cur := p.bound;
  perform tests.db_exec('w', format('update public.accounts set deleted_at = null where id = %L', acc));
  select * into p from pg_temp.pull_as(a, cur, 1000);
  res := res || jsonb_build_object('ok', exists (select 1 from jsonb_array_elements(p.rows) e
            where e ->> 'table' = 'accounts' and e -> 'key' ->> 'id' = acc::text and e -> 'row' -> 'deleted_at' = 'null'::jsonb),
    'name', 'réactivation : la ligne réactivée est récupérée');
  cache := pg_temp.apply(cache, p.rows); cur := p.bound;

  -- P7 : 2 500 lignes en deux transactions (1 500 dans la même transaction : même sync_txid).
  perform tests.db_exec('w', format($i$insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, created_at, updated_at)
    select gen_random_uuid(), %L, 'income', 'in', 100, 'MAD', 'P7-' || g, '2026-03-01', %L, '{}', 'cleared', now(), now() from generate_series(1, 1500) g$i$, a, acc));
  perform tests.db_exec('w', format($i$insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, created_at, updated_at)
    select gen_random_uuid(), %L, 'income', 'in', 100, 'MAD', 'P7b-' || g, '2026-03-01', %L, '{}', 'cleared', now(), now() from generate_series(1, 1000) g$i$, a, acc));
  select * into p from pg_temp.pull_as(a, cur, 1000);
  total_new := (select count(*) from jsonb_array_elements(p.rows) e where e -> 'row' ->> 'label' like 'P7%');
  res := res || jsonb_build_object('ok', total_new = 2500, 'name', 'pagination : les 2 500 lignes nouvelles sont récupérées', 'detail', format('%s lignes', total_new));
  res := res || jsonb_build_object('ok', p.pages = 3 and (select bool_and(s <= 1000) from unnest(p.sizes) s), 'name', 'pagination : 3 pages de 1 000 lignes au plus',
    'detail', array_to_string(p.sizes, ','));
  res := res || jsonb_build_object('ok', (select count(*) = count(distinct (e ->> 'table') || ':' || pg_temp.k(e)) from jsonb_array_elements(p.rows) e),
    'name', 'pagination : aucune ligne en double entre les pages');
  res := res || jsonb_build_object('ok', pg_temp.ordered(p.rows), 'name', 'pagination : ordre strict (sync_txid, table, clé) d''une page à l''autre, y compris à sync_txid égal');
  cache := pg_temp.apply(cache, p.rows); cur := p.bound;

  -- P8 : modification et insertion PENDANT la pagination (pages de 1 000, borne fixe).
  perform tests.db_exec('w', format($u$update public.transactions set label = label || '+' where user_id = %L and label like 'P7%%'$u$, a));
  j := pg_temp.page_as(a, cur, null, null, 1000);
  bound := j ->> 'bound';
  seen := j -> 'rows';
  after := j -> 'next';
  n_pages := 1;
  victim_early := (select e -> 'key' ->> 'id' from jsonb_array_elements(seen) e where e ->> 'table' = 'transactions' limit 1);
  -- Une ligne non encore renvoyée (située après la première page) :
  victim_late := tests.db_value('w', format($q$select id::text from public.transactions where user_id = %L and label like 'P7%%'
                   and id::text not in (select jsonb_array_elements(%L::jsonb) -> 'key' ->> 'id') order by sync_txid desc, id desc limit 1$q$, a, seen::text));
  late_v_before := tests.db_value('w', format('select version from public.transactions where id = %L', victim_late))::bigint;
  perform tests.db_exec('w', format('update public.transactions set label = label || ''!'' where id in (%L, %L)', victim_early, victim_late));
  perform tests.db_exec('w', format($i$insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, created_at, updated_at)
    values (%L, %L, 'income', 'in', 100, 'MAD', 'P8-nouvelle', '2026-03-01', %L, '{}', 'cleared', now(), now())$i$, inserted_id, a, acc));
  while after is not null and after <> 'null'::jsonb loop
    j := pg_temp.page_as(a, cur, bound, after, 1000);
    seen := seen || (j -> 'rows');
    after := j -> 'next';
    n_pages := n_pages + 1;
  end loop;
  res := res || jsonb_build_object('ok', not exists (select 1 from jsonb_array_elements(seen) e where e -> 'key' ->> 'id' = inserted_id::text),
    'name', 'pendant la pagination : une ligne insérée n''apparaît pas dans l''intervalle en cours (sync_txid ≥ borne)');
  res := res || jsonb_build_object('ok', not exists (select 1 from jsonb_array_elements(seen) e where e -> 'key' ->> 'id' = victim_late),
    'name', 'pendant la pagination : une ligne modifiée avant d''être renvoyée sort de l''intervalle en cours');
  cache := pg_temp.apply(cache, seen); cur := bound;
  select * into p from pg_temp.pull_as(a, cur, 1000);
  res := res || jsonb_build_object('ok',
      exists (select 1 from jsonb_array_elements(p.rows) e where e -> 'key' ->> 'id' = inserted_id::text)
      and exists (select 1 from jsonb_array_elements(p.rows) e where e -> 'key' ->> 'id' = victim_late and (e -> 'row' ->> 'version')::bigint > late_v_before)
      and exists (select 1 from jsonb_array_elements(p.rows) e where e -> 'key' ->> 'id' = victim_early),
    'name', 'récupération suivante : ligne insérée, ligne modifiée en cours de pagination et ligne déjà renvoyée puis modifiée, chacune dans sa dernière version');
  cache := pg_temp.apply(cache, p.rows); cur := p.bound;
  res := res || jsonb_build_object('ok', cache = pg_temp.truth(a), 'name', 'aucune perte : cache modèle (version la plus haute par clé) = état validé du serveur, 18 tables');

  -- P9 : lecture seule.
  versions_before := tests.db_value('w', format('select md5(string_agg(id::text || version || sync_txid::text, '','' order by id)) from public.transactions where user_id = %L', a));
  select * into p from pg_temp.pull_as(a, '0', 1000);
  select * into p from pg_temp.pull_as(a, cur, 7);
  versions_after := tests.db_value('w', format('select md5(string_agg(id::text || version || sync_txid::text, '','' order by id)) from public.transactions where user_id = %L', a));
  res := res || jsonb_build_object('ok', versions_before = versions_after, 'name', 'lecture seule : aucune version ni sync_txid modifié par les récupérations');
  res := res || jsonb_build_object('ok', jsonb_array_length(p.rows) = 0 and p.pages = 1, 'name', 'récupération sans changement : aucune ligne, une seule page, next nul');

  perform tests.ok((e ->> 'ok')::boolean, e ->> 'name', e ->> 'detail') from jsonb_array_elements(res) e;
end $$;

select tests.db_disconnect('w');
