-- =============================================================================
-- 07 — Synchronisation : sync_txid et borne pg_snapshot_xmin
--
-- Sessions réelles et concurrentes pilotées par dblink :
--   s1, s2, s3 : écrivains (transactions explicites, ordre de validation contrôlé) ;
--   pull       : client qui récupère les changements (tests.pull), sans jamais écrire.
-- Le client applique les lignes reçues à un cache modèle (garde la version la plus
-- haute par clé). Critère : après la dernière récupération, le cache est IDENTIQUE à
-- l'état validé du serveur (mêmes clés, mêmes versions, mêmes suppressions), et aucune
-- écriture annulée n'y figure.
--
-- La session principale n'écrit rien pendant les scénarios (sinon sa propre transaction
-- retiendrait la borne) : les assertions sont enregistrées à la fin.
-- =============================================================================
\set ON_ERROR_STOP on

create temp table sy (u uuid, acc uuid);
insert into sy select tests.new_user('sync'), gen_random_uuid();
insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived, include_in_total, color, sort_order, created_at, updated_at)
  select acc, u, 'Compte de base', 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0, now(), now() from sy;

create function pg_temp.connect_all() returns void language plpgsql as $$
declare
  dsn text := (select tests.config.dsn from tests.config);
begin
  perform tests.dblink_connect('s1', dsn);
  perform tests.dblink_connect('s2', dsn);
  perform tests.dblink_connect('s3', dsn);
  perform tests.dblink_connect('pull', dsn);
  -- Les sessions concurrentes agissent avec le rôle administrateur des tests.
  perform tests.dblink_exec(c, format('set role %I', (select admin_role from tests.config)))
    from unnest(array['s1', 's2', 's3', 'pull']) c;
end $$;

create function pg_temp.disconnect_all() returns void language plpgsql as $$
begin
  perform tests.dblink_disconnect('s1');
  perform tests.dblink_disconnect('s2');
  perform tests.dblink_disconnect('s3');
  perform tests.dblink_disconnect('pull');
end $$;

create function pg_temp.x(conn text, sql text) returns void language plpgsql as $$
begin
  perform tests.dblink_exec(conn, sql);
end $$;

-- Récupération depuis la session « pull » : renvoie la borne et les lignes.
create function pg_temp.pull(u uuid, cur xid8, out hi xid8, out rows jsonb) language plpgsql as $$
begin
  select t.hi::xid8, t.rows::jsonb into hi, rows
  from tests.dblink('pull', format('select hi::text, rows::text from tests.pull(%L, %L)', u, cur)) as t(hi text, rows text);
end $$;

-- Applique des lignes reçues au cache modèle : garde la version la plus haute par clé.
create function pg_temp.apply(cache jsonb, rows jsonb) returns jsonb language plpgsql as $$
declare
  e jsonb;
  k text;
  v bigint;
begin
  for e in select * from jsonb_array_elements(rows) loop
    k := (e ->> 'table') || ':' || (e -> 'row' ->> 'id');
    v := (e -> 'row' ->> 'version')::bigint;
    if not cache ? k or (cache -> k ->> 'v')::bigint < v then
      cache := cache || jsonb_build_object(k, jsonb_build_object('v', v, 'd', (e -> 'row' -> 'deleted_at') <> 'null'::jsonb,
        'name', coalesce(e -> 'row' ->> 'name', e -> 'row' ->> 'label')));
    end if;
  end loop;
  return cache;
end $$;

-- État validé du serveur pour l'utilisateur, au format du cache.
create function pg_temp.truth(u uuid) returns jsonb language plpgsql as $$
declare
  r jsonb;
begin
  select t.j::jsonb into r from tests.dblink('pull', format($q$
    select coalesce(jsonb_object_agg(k, jsonb_build_object('v', v, 'd', d, 'name', nm)), '{}')::text from (
      select 'accounts:' || id k, version v, deleted_at is not null d, name nm from public.accounts where user_id = %1$L
      union all
      select 'transactions:' || id, version, deleted_at is not null, label from public.transactions where user_id = %1$L) s
  $q$, u)) as t(j text);
  return r;
end $$;

create function pg_temp.has(rows jsonb, id uuid) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(rows) e where e -> 'row' ->> 'id' = id::text)
$$;

create function pg_temp.ins_account(u uuid, id uuid, name text) returns text language sql as $$
  select format($f$insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived, include_in_total, color, sort_order, created_at, updated_at)
    values (%L, %L, %L, 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0, now(), now())$f$, id, u, name)
$$;

create function pg_temp.ins_tx(u uuid, acc uuid, id uuid, label text) returns text language sql as $$
  select format($f$insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, created_at, updated_at)
    values (%L, %L, 'income', 'in', 100, 'MAD', %L, '2026-03-01', %L, '{}', 'cleared', now(), now())$f$, id, u, label, acc)
$$;

-- ---------------------------------------------------------------------------
-- Scénarios dirigés
-- ---------------------------------------------------------------------------
do $$
declare
  u uuid := (select sy.u from sy);
  res jsonb := '[]';
  cur xid8 := '0';
  p record;
  cache jsonb := '{}';
  a1 uuid := gen_random_uuid(); a2 uuid := gen_random_uuid(); a3 uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
  naive_cursor timestamptz;
  naive_rows jsonb;
  hi_before xid8;
  t1 xid8;
  procedure_ok boolean;
begin
  perform pg_temp.connect_all();
  -- État initial
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;

  -- S1 — deux transactions validées dans l'ordre inverse de leur démarrage
  perform pg_temp.x('s1', 'begin');
  perform pg_temp.x('s1', pg_temp.ins_account(u, a1, 'A1 (s1, démarrée en premier)'));
  select t.v::xid8 into t1 from tests.dblink('s1', 'select pg_current_xact_id()::text') t(v text);
  perform pg_sleep(0.02);
  perform pg_temp.x('s2', 'begin');
  perform pg_temp.x('s2', pg_temp.ins_account(u, a2, 'A2 (s2, validée en premier)'));
  perform pg_temp.x('s2', 'commit');
  select * into p from pg_temp.pull(u, cur);
  res := res || jsonb_build_array(jsonb_build_object('ok', not pg_temp.has(p.rows, a1),
    'name', 'S1 ordre inversé : la ligne de la transaction en cours n''est pas visible'));
  res := res || jsonb_build_array(jsonb_build_object('ok', not pg_temp.has(p.rows, a2) and p.hi <= t1,
    'name', 'S1 ordre inversé : la borne reste ≤ à la transaction en cours ; la ligne validée APRÈS elle est différée'));
  cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  -- Contrôle négatif : curseur naïf sur l'horodatage serveur
  select t.c::timestamptz into naive_cursor from tests.dblink('pull', format(
    'select max(server_updated_at)::text from public.accounts where user_id = %L', u)) t(c text);
  perform pg_temp.x('s1', 'commit');
  select * into p from pg_temp.pull(u, cur);
  res := res || jsonb_build_array(jsonb_build_object('ok', pg_temp.has(p.rows, a1) and pg_temp.has(p.rows, a2),
    'name', 'S1 ordre inversé : après validation, la récupération suivante renvoie A1 et A2 (aucune perte)'));
  cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  select t.r::jsonb into naive_rows from tests.dblink('pull', format(
    $q$select coalesce(jsonb_agg(id), '[]')::text from public.accounts where user_id = %L and server_updated_at > %L$q$, u, naive_cursor)) t(r text);
  res := res || jsonb_build_array(jsonb_build_object('ok', not (naive_rows ? a1::text),
    'name', 'S1 contrôle négatif : un curseur sur l''horodatage aurait PERDU A1 (justifie sync_txid)'));

  -- S1b — s1 commence (BEGIN) en premier mais écrit après la validation de s2
  perform pg_temp.x('s1', 'begin');
  perform pg_temp.x('s1', 'set local application_name = ''s1-ouverte''');
  perform pg_temp.x('s2', 'begin');
  perform pg_temp.x('s2', pg_temp.ins_tx(u, a2, b1, 'B1 (s2)'));
  perform pg_temp.x('s2', 'commit');
  perform pg_temp.x('s1', pg_temp.ins_tx(u, a1, b2, 'B2 (s1, écrite après)'));
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  perform pg_temp.x('s1', 'commit');
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  res := res || jsonb_build_array(jsonb_build_object('ok', cache ? ('transactions:' || b1) and cache ? ('transactions:' || b2),
    'name', 'S1b démarrage ≠ première écriture : B1 et B2 récupérées'));

  -- S2 — transaction annulée
  perform pg_temp.x('s3', 'begin');
  perform pg_temp.x('s3', pg_temp.ins_account(u, a3, 'A3 (annulée)'));
  perform pg_temp.x('s3', format('update public.accounts set name = ''modif annulée'' where id = %L', a1));
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  hi_before := p.hi;
  perform pg_temp.x('s3', 'rollback');
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  res := res || jsonb_build_array(jsonb_build_object('ok', not (cache ? ('accounts:' || a3)),
    'name', 'S2 annulation : la ligne insérée par la transaction annulée n''apparaît jamais'));
  res := res || jsonb_build_array(jsonb_build_object('ok', cache -> ('accounts:' || a1) ->> 'name' <> 'modif annulée',
    'name', 'S2 annulation : la modification annulée n''apparaît jamais'));
  res := res || jsonb_build_array(jsonb_build_object('ok', p.hi > hi_before,
    'name', 'S2 annulation : le curseur avance après l''annulation (pas de blocage)'));

  -- S3 — modifications successives d'une même ligne
  perform pg_temp.x('s1', format('update public.accounts set name = ''v2'' where id = %L', a1));
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  perform pg_temp.x('s2', format('update public.accounts set name = ''v3'' where id = %L', a1));
  perform pg_temp.x('s1', 'begin');
  perform pg_temp.x('s1', format('update public.accounts set name = ''v4'' where id = %L', a1));
  perform pg_temp.x('s1', format('update public.accounts set name = ''v5'' where id = %L', a1));
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  res := res || jsonb_build_array(jsonb_build_object('ok', cache -> ('accounts:' || a1) ->> 'name' = 'v3',
    'name', 'S3 modifications successives : pendant la transaction en cours, le client a la dernière version VALIDÉE (v3)'));
  perform pg_temp.x('s1', 'commit');
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  res := res || jsonb_build_array(jsonb_build_object('ok', cache -> ('accounts:' || a1) ->> 'name' = 'v5'
      and (cache -> ('accounts:' || a1) ->> 'v')::int = (pg_temp.truth(u) -> ('accounts:' || a1) ->> 'v')::int,
    'name', 'S3 modifications successives : état final v5 et version identique au serveur'));

  -- S4 — suppression logique
  perform pg_temp.x('s2', format('update public.accounts set deleted_at = now() where id = %L', a2));
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  res := res || jsonb_build_array(jsonb_build_object('ok', (cache -> ('accounts:' || a2) ->> 'd')::boolean,
    'name', 'S4 suppression logique : la suppression est récupérée (tombstone)'));
  perform pg_temp.x('s2', format('update public.accounts set deleted_at = null where id = %L', a2));
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi;
  res := res || jsonb_build_array(jsonb_build_object('ok', not (cache -> ('accounts:' || a2) ->> 'd')::boolean,
    'name', 'S4 restauration : la réactivation est récupérée'));

  -- S5 — récupération idempotente : rejouer depuis 0 donne le même cache
  select * into p from pg_temp.pull(u, '0');
  res := res || jsonb_build_array(jsonb_build_object('ok', pg_temp.apply('{}', p.rows) = pg_temp.truth(u),
    'name', 'S5 récupération complète depuis 0 = état du serveur'));
  res := res || jsonb_build_array(jsonb_build_object('ok', cache = pg_temp.truth(u),
    'name', 'S5 cache incrémental = état du serveur après actualisations successives du curseur'));

  perform pg_temp.disconnect_all();
  -- Enregistrement des assertions (la session principale écrit seulement maintenant)
  insert into tests.results (file, name, ok, detail)
    select current_setting('tests.file', true), e ->> 'name', coalesce((e ->> 'ok')::boolean, false), null from jsonb_array_elements(res) e;
end $$;

-- ---------------------------------------------------------------------------
-- S6 — entrelacements pseudo-aléatoires (3 écrivains, validations / annulations,
-- récupérations à tout moment), reproductibles (graine fixe)
-- ---------------------------------------------------------------------------
do $$
declare
  u uuid := (select sy.u from sy);
  base_acc uuid := (select sy.acc from sy);
  sessions text[] := array['s1', 's2', 's3'];
  open_tx boolean[] := array[false, false, false];
  pool uuid[];
  s int;
  step int;
  cur xid8 := '0';
  cache jsonb := '{}';
  p record;
  pulls int := 0;
  commits int := 0;
  rollbacks int := 0;
  writes int := 0;
  missing int;
  ok boolean;
begin
  perform setseed(0.4242);
  perform pg_temp.connect_all();
  select array_agg(id) into pool from public.accounts where user_id = u;
  for step in 1..300 loop
    s := 1 + floor(random() * 3)::int;
    if not open_tx[s] then
      perform pg_temp.x(sessions[s], 'begin');
      open_tx[s] := true;
    end if;
    case floor(random() * 4)::int
      when 0 then
        perform pg_temp.x(sessions[s], pg_temp.ins_tx(u, base_acc, gen_random_uuid(), 'tx ' || step));
        writes := writes + 1;
      when 1 then
        -- écriture sur une ligne partagée : verrou de ligne → on écrit d'abord sur une ligne propre à la session
        perform pg_temp.x(sessions[s], format('update public.accounts set name = %L where id = %L', 'v' || step, pool[s]));
        writes := writes + 1;
      when 2 then
        perform pg_temp.x(sessions[s], format('update public.accounts set deleted_at = case when deleted_at is null then now() end where id = %L', pool[s]));
        writes := writes + 1;
      else
        if random() < 0.8 then
          perform pg_temp.x(sessions[s], 'commit'); commits := commits + 1;
        else
          perform pg_temp.x(sessions[s], 'rollback'); rollbacks := rollbacks + 1;
        end if;
        open_tx[s] := false;
    end case;
    if random() < 0.5 then
      select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi; pulls := pulls + 1;
    end if;
  end loop;
  for s in 1..3 loop
    if open_tx[s] then perform pg_temp.x(sessions[s], 'commit'); commits := commits + 1; end if;
  end loop;
  select * into p from pg_temp.pull(u, cur); cache := pg_temp.apply(cache, p.rows); cur := p.hi; pulls := pulls + 1;
  ok := cache = pg_temp.truth(u);
  select count(*) into missing from jsonb_object_keys(pg_temp.truth(u)) k where not cache ? k;
  perform pg_temp.disconnect_all();
  insert into tests.results (file, name, ok, detail) values (current_setting('tests.file', true),
    format('S6 entrelacements aléatoires : cache = serveur (%s écritures, %s validations, %s annulations, %s récupérations)', writes, commits, rollbacks, pulls),
    coalesce(ok and missing = 0, false), format('lignes manquantes : %s', missing));
end $$;

-- ---------------------------------------------------------------------------
-- La récupération respecte la RLS lorsqu'elle est faite par l'utilisateur lui-même
-- ---------------------------------------------------------------------------
do $$
declare
  u uuid := (select sy.u from sy);
  other uuid := tests.new_user('sync-other');
  p record;
begin
  perform tests.seed(other);
  perform tests.as_user(u);
  select * into p from tests.pull(other, '0');
  perform tests.eq(jsonb_array_length(p.rows), 0, 'récupération sous l''identité de A pour l''utilisateur B : aucune ligne (RLS)');
  perform tests.as_admin();
end $$;
