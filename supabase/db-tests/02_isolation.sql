-- =============================================================================
-- 02 — Matrice d'isolation entre utilisateurs (générée depuis le catalogue)
--
-- Pour CHAQUE table portant user_id : lecture, modification, suppression, TRUNCATE,
-- insertion au nom d'autrui, changement de propriétaire, upsert sur la clé d'autrui.
-- Pour CHAQUE clé étrangère composite : impossible de référencer la ligne d'autrui
-- (contrôle positif : sa propre ligne est acceptée).
-- Rôle anon : aucun accès.
-- =============================================================================
\set ON_ERROR_STOP on

create temp table iso (a uuid, b uuid);
insert into iso select tests.new_user('iso-a'), tests.new_user('iso-b');
select tests.seed(a), tests.seed(b) from iso;
-- Une seconde ligne pour B dans chaque table « liste », pour vérifier que B voit les siennes.
grant select on iso to authenticated, anon;

do $$
declare
  ua uuid := (select a from iso);
  ub uuid := (select b from iso);
  t record;
  row_a jsonb;
  row_b jsonb;
  before_a jsonb;
  after_a jsonb;
  n bigint;
  nb bigint;
  pkc text[];
  ins text;
begin
  for t in select * from tests.user_tables order by name loop
    perform tests.as_admin();
    execute format('select to_jsonb(x) from public.%I x where user_id = $1 limit 1', t.name) into row_a using ua;
    execute format('select to_jsonb(x) from public.%I x where user_id = $1 limit 1', t.name) into row_b using ub;
    execute format('select count(*) from public.%I where user_id = $1', t.name) into nb using ub;
    execute format('select jsonb_agg(to_jsonb(x) order by x) from public.%I x where user_id = $1', t.name) into before_a using ua;
    pkc := tests.pk_cols(t.relid);
    ins := format('insert into public.%I select * from jsonb_populate_record(null::public.%I, %%L)', t.name, t.name);

    perform tests.as_user(ub);
    -- Lecture
    execute format('select count(*) from public.%I where user_id = $1', t.name) into n using ua;
    perform tests.eq(n, 0::bigint, format('%s : B ne lit aucune ligne de A', t.name));
    execute format('select count(*) from public.%I', t.name) into n;
    perform tests.eq(n, nb, format('%s : B voit exactement ses propres lignes', t.name));
    -- Modification
    perform tests.eq(tests.affected(format('update public.%I set deleted_at = now() where user_id = %L', t.name, ua)), 0::bigint,
      format('%s : B ne modifie aucune ligne de A', t.name));
    -- Suppression physique et TRUNCATE
    perform tests.throws(format('delete from public.%I where user_id = %L', t.name, ua), format('%s : DELETE refusé à B', t.name), '42501');
    perform tests.throws(format('delete from public.%I where user_id = %L', t.name, ub), format('%s : DELETE refusé même sur ses lignes', t.name), '42501');
    perform tests.throws(format('truncate public.%I', t.name), format('%s : TRUNCATE refusé', t.name), '42501');
    -- Insertion au nom de A (copie d'une ligne de A, nouvelle clé)
    perform tests.throws(format(ins, tests.with_new_pk(t.relid, row_a)), format('%s : B ne peut pas insérer au nom de A', t.name), '42501');
    -- Contrôle positif : B insère une copie de sa propre ligne (sauf table à une ligne par utilisateur)
    if t.name <> 'user_settings' then
      perform tests.lives(format(ins, tests.with_new_pk(t.relid, row_b)), format('%s : B insère sa propre ligne (contrôle positif)', t.name));
    end if;
    -- Changement de propriétaire de sa propre ligne
    perform tests.throws(format('update public.%I set user_id = %L where %s', t.name, ua, tests.where_pk(t.relid, row_b)),
      format('%s : B ne peut pas transférer sa ligne à A (user_id immuable)', t.name), '42501');
    -- Upsert sur la clé primaire d'une ligne de A (ne doit jamais l'écraser)
    if not ('user_id' = any (pkc)) then
      perform tests.throws(
        format('insert into public.%I select * from jsonb_populate_record(null::public.%I, %L) on conflict (%s) do update set deleted_at = now()',
          t.name, t.name, jsonb_set(row_a, '{user_id}', to_jsonb(ub)), array_to_string(pkc, ', ')),
        format('%s : upsert de B sur la clé d''une ligne de A refusé', t.name), '42501');
    end if;

    perform tests.as_admin();
    execute format('select jsonb_agg(to_jsonb(x) order by x) from public.%I x where user_id = $1', t.name) into after_a using ua;
    perform tests.ok(after_a = before_a, format('%s : lignes de A strictement inchangées après les tentatives de B', t.name));
  end loop;
end $$;

-- Matrice des références : pour chaque clé étrangère composite, B ne peut pas pointer vers
-- la ligne de A ; il peut pointer vers la sienne.
do $$
declare
  ua uuid := (select a from iso);
  ub uuid := (select b from iso);
  k record;
  row_b jsonb;
  parent_a uuid;
  parent_b uuid;
  stmt text;
begin
  for k in
    select c.conname, c.conrelid::regclass as child, rc.relname::text as child_name, c.confrelid::regclass as parent,
           (select attname::text from pg_attribute where attrelid = c.conrelid
              and attnum = c.conkey[array_length(c.conkey, 1)]) as col
    from pg_constraint c join pg_class rc on rc.oid = c.conrelid join pg_namespace s on s.oid = rc.relnamespace
    where s.nspname = 'public' and c.contype = 'f' and c.confrelid <> 'auth.users'::regclass
    order by c.conname
  loop
    perform tests.as_admin();
    execute format('select to_jsonb(x) from %s x where user_id = $1 and %I is not null limit 1', k.child, k.col) into row_b using ub;
    execute format('select id from %s where user_id = $1 limit 1', k.parent) into parent_a using ua;
    execute format('select id from %s where user_id = $1 limit 1', k.parent) into parent_b using ub;
    perform tests.ok(row_b is not null and parent_a is not null and parent_b is not null, format('%s : jeu de données présent', k.conname));

    perform tests.as_user(ub);
    if k.child_name = 'recurring_occurrences' and k.col = 'rule_id' then
      -- rule_id fait partie de la clé (immuable) : test par insertion.
      stmt := format('insert into public.recurring_occurrences select * from jsonb_populate_record(null::public.recurring_occurrences, %L)',
        jsonb_set(jsonb_set(row_b, '{rule_id}', to_jsonb(parent_a)), '{due_date}', '"2099-12-31"'));
      perform tests.throws(stmt, format('%s : B ne peut pas référencer la ligne de A', k.conname), '23503');
      stmt := format('insert into public.recurring_occurrences select * from jsonb_populate_record(null::public.recurring_occurrences, %L)',
        jsonb_set(jsonb_set(row_b, '{rule_id}', to_jsonb(parent_b)), '{due_date}', '"2099-12-31"'));
      perform tests.lives(stmt, format('%s : B référence sa propre ligne (contrôle positif)', k.conname));
    else
      perform tests.throws(format('update %s set %I = %L where %s', k.child, k.col, parent_a, tests.where_pk(k.child, row_b)),
        format('%s : B ne peut pas référencer la ligne de A', k.conname), '23503');
      perform tests.lives(format('update %s set %I = %L where %s', k.child, k.col, parent_b, tests.where_pk(k.child, row_b)),
        format('%s : B référence sa propre ligne (contrôle positif)', k.conname));
    end if;
  end loop;
  perform tests.as_admin();
end $$;

-- Rôle anonyme : aucun accès, à aucune table.
do $$
declare
  t record;
begin
  for t in select * from tests.public_tables order by name loop
    perform tests.as_anon();
    perform tests.throws(format('select count(*) from public.%I', t.name), format('%s : anon ne peut pas lire', t.name), '42501');
    perform tests.throws(format('update public.%I set deleted_at = now()', t.name), format('%s : anon ne peut pas modifier', t.name), '42501');
    perform tests.as_admin();
  end loop;
end $$;

-- Un utilisateur authentifié sans revendication « sub » ne voit rien.
do $$
declare
  n bigint;
begin
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.transactions;
  perform tests.eq(n, 0::bigint, 'authenticated sans identifiant (auth.uid() null) : aucune ligne visible');
  perform tests.as_admin();
end $$;

-- Existence d'un identifiant d'autrui : une insertion qui réutilise l'UUID d'une ligne de A
-- échoue par collision de clé primaire (23505). Fuite limitée à l'existence d'un UUID
-- aléatoire (non devinable) ; documentée dans le rapport.
do $$
declare
  ua uuid := (select a from iso);
  ub uuid := (select b from iso);
  r jsonb;
begin
  select to_jsonb(x) into r from public.accounts x where user_id = ua limit 1;
  perform tests.as_user(ub);
  perform tests.throws(format('insert into public.accounts select * from jsonb_populate_record(null::public.accounts, %L)',
    jsonb_set(r, '{user_id}', to_jsonb(ub))), 'accounts : réutiliser l''UUID d''une ligne de A → collision 23505 (sans accès aux données)', '23505');
  perform tests.as_admin();
end $$;
