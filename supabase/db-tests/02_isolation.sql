-- =============================================================================
-- 02 — Matrice d'isolation entre utilisateurs (générée depuis le catalogue)
--
-- État final (migration 8, D4-1) : `authenticated` LIT ses lignes et n'écrit QUE par
-- public.apply_changeset. Pour CHAQUE table portant user_id :
--  * lecture : B ne voit que ses lignes ;
--  * écritures directes (UPDATE, INSERT, DELETE, TRUNCATE) : refusées par privilège, même
--    sur ses propres lignes ;
--  * par le protocole : B ne peut ni modifier, ni supprimer, ni écraser une ligne de A, ni
--    écrire au nom de A, ni lui transférer une ligne ; les lignes de A restent strictement
--    inchangées (contrôle positif : B écrit sa propre ligne).
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
  r jsonb;
  va bigint;
  vb bigint;
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
    -- Écritures directes : refusées par privilège (D4-1), sur les lignes de A comme sur les siennes
    perform tests.throws(format('update public.%I set deleted_at = now() where user_id = %L', t.name, ua),
      format('%s : UPDATE direct refusé à B sur les lignes de A', t.name), '42501');
    perform tests.throws(format('update public.%I set deleted_at = now() where user_id = %L', t.name, ub),
      format('%s : UPDATE direct refusé même sur ses lignes', t.name), '42501');
    perform tests.throws(format(ins, tests.with_new_pk(t.relid, row_b)), format('%s : INSERT direct refusé même pour sa propre ligne', t.name), '42501');
    -- Suppression physique et TRUNCATE
    perform tests.throws(format('delete from public.%I where user_id = %L', t.name, ua), format('%s : DELETE refusé à B', t.name), '42501');
    perform tests.throws(format('delete from public.%I where user_id = %L', t.name, ub), format('%s : DELETE refusé même sur ses lignes', t.name), '42501');
    perform tests.throws(format('truncate public.%I', t.name), format('%s : TRUNCATE refusé', t.name), '42501');

    -- Par le protocole (seule voie d'écriture) -----------------------------------------
    va := (row_a ->> 'version')::bigint;
    vb := (row_b ->> 'version')::bigint;
    if 'user_id' = any (pkc) then
      -- La clé porte l'utilisateur : viser la ligne de A, c'est se déclarer A.
      perform tests.cs_throws(tests.cs(ub, jsonb_build_array(tests.cs_put(t.relid, row_a, va))),
        format('%s : B ne modifie pas la ligne de A (protocole)', t.name), 'unauthorized');
      perform tests.cs_throws(tests.cs(ub, jsonb_build_array(tests.cs_del(t.relid, row_a, va))),
        format('%s : B ne supprime pas la ligne de A (protocole)', t.name), 'unauthorized');
    else
      -- Même clé, ligne déclarée au nom de B : la ligne de A est INVISIBLE (vue comme inexistante).
      -- (keep = true : une tentative qui réussirait à tort resterait écrite et serait détectée
      -- par la comparaison avant / après des lignes de A, en fin de boucle.)
      r := tests.cs_try(tests.cs(ub, jsonb_build_array(tests.cs_put(t.relid, jsonb_set(row_a, '{user_id}', to_jsonb(ub)), va))), true);
      perform tests.ok(r ->> 'code' = 'version_conflict' and r -> 'detail' -> 'conflicts' -> 0 -> 'actualVersion' = 'null'::jsonb,
        format('%s : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)', t.name), left(r::text, 300));
      r := tests.cs_try(tests.cs(ub, jsonb_build_array(tests.cs_del(t.relid, row_a, va))), true);
      perform tests.ok(r ->> 'code' = 'version_conflict' and r -> 'detail' -> 'conflicts' -> 0 -> 'actualVersion' = 'null'::jsonb,
        format('%s : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)', t.name), left(r::text, 300));
      -- Création sur la clé d'une ligne de A (ne doit jamais l'écraser)
      r := tests.cs_try(tests.cs(ub, jsonb_build_array(tests.cs_put(t.relid, jsonb_set(row_a, '{user_id}', to_jsonb(ub)), null))), true);
      perform tests.ok(r ->> 'code' = 'duplicate_key' and r -> 'detail' ->> 'sqlstate' is null and r -> 'detail' -> 'conflicts' is null,
        format('%s : B ne crée pas de ligne sur la clé d''une ligne de A (duplicate_key, aucun détail)', t.name), left(r::text, 300));
    end if;
    -- Écriture au nom de A (copie d'une ligne de A, nouvelle clé)
    perform tests.cs_throws(tests.cs(ub, jsonb_build_array(tests.cs_put(t.relid, tests.with_new_pk(t.relid, row_a), null))),
      format('%s : B ne peut pas écrire au nom de A', t.name), 'unauthorized');
    -- Lot annoncé au nom de A par B
    perform tests.cs_throws(tests.cs(ua, jsonb_build_array(tests.cs_put(t.relid, row_a, va))),
      format('%s : B ne peut pas soumettre un lot au nom de A', t.name), 'unauthorized');
    -- Changement de propriétaire de sa propre ligne
    perform tests.cs_throws(tests.cs(ub, jsonb_build_array(tests.cs_put(t.relid, jsonb_set(row_b, '{user_id}', to_jsonb(ua)), vb))),
      format('%s : B ne peut pas transférer sa ligne à A', t.name), 'unauthorized');
    -- Contrôles positifs : B écrit ses propres lignes
    perform tests.cs_lives(tests.cs(ub, jsonb_build_array(tests.cs_put(t.relid, row_b, vb))),
      format('%s : B modifie sa propre ligne (contrôle positif)', t.name));
    if t.name <> 'user_settings' then
      perform tests.cs_lives(tests.cs(ub, jsonb_build_array(tests.cs_put(t.relid, tests.with_new_pk(t.relid, row_b), null))),
        format('%s : B crée sa propre ligne (contrôle positif)', t.name));
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
      -- rule_id fait partie de la clé (immuable) : test par création.
      perform tests.cs_throws(tests.cs(ub, jsonb_build_array(tests.cs_put(k.child,
          jsonb_set(jsonb_set(row_b, '{rule_id}', to_jsonb(parent_a)), '{due_date}', '"2099-12-31"'), null))),
        format('%s : B ne peut pas référencer la ligne de A', k.conname), '23503');
      perform tests.cs_lives(tests.cs(ub, jsonb_build_array(tests.cs_put(k.child,
          jsonb_set(jsonb_set(row_b, '{rule_id}', to_jsonb(parent_b)), '{due_date}', '"2099-12-31"'), null))),
        format('%s : B référence sa propre ligne (contrôle positif)', k.conname));
    else
      perform tests.cs_throws(tests.cs(ub, jsonb_build_array(tests.cs_put(k.child,
          jsonb_set(row_b, array[k.col], to_jsonb(parent_a)), (row_b ->> 'version')::bigint))),
        format('%s : B ne peut pas référencer la ligne de A', k.conname), '23503');
      perform tests.cs_lives(tests.cs(ub, jsonb_build_array(tests.cs_put(k.child,
          jsonb_set(row_b, array[k.col], to_jsonb(parent_b)), (row_b ->> 'version')::bigint))),
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
  -- … ni au protocole d'écriture.
  perform tests.as_anon();
  perform tests.throws('select public.apply_changeset(''{}''::jsonb)', 'anon ne peut pas appeler apply_changeset', '42501');
  perform tests.throws('select public.resolve_changeset(''00000000-0000-4000-8000-000000000000'')', 'anon ne peut pas appeler resolve_changeset', '42501');
  perform tests.as_admin();
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
  perform tests.cs_throws(tests.cs((select a from iso), jsonb_build_array(
      tests.cs_del('public.accounts', (select to_jsonb(x) from public.accounts x limit 1), 1))),
    'authenticated sans identifiant : aucune écriture par le protocole', 'unauthorized');
  perform tests.as_admin();
end $$;

-- Existence d'un identifiant d'autrui (P7) : depuis D4-1, une insertion directe est refusée par
-- privilège (plus aucune sonde possible par cette voie) ; par le protocole, réutiliser l'UUID
-- d'une ligne de A donne duplicate_key (vérifié table par table ci-dessus), sans aucun détail.
-- Fuite limitée à l'existence d'un UUID aléatoire (non devinable).
do $$
declare
  ua uuid := (select a from iso);
  ub uuid := (select b from iso);
  r jsonb;
begin
  select to_jsonb(x) into r from public.accounts x where user_id = ua limit 1;
  perform tests.as_user(ub);
  perform tests.throws(format('insert into public.accounts select * from jsonb_populate_record(null::public.accounts, %L)',
    jsonb_set(r, '{user_id}', to_jsonb(ub))), 'accounts : insertion directe avec l''UUID d''une ligne de A → refus de privilège (42501)', '42501');
  perform tests.as_admin();
end $$;
