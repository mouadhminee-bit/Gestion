-- =============================================================================
-- 06 — Suppression logique : comportement de deleted_at, propagation, restauration
--
-- Règles testées :
--  * supprimer = opération `delete` du protocole (jamais de DELETE) ; l'horodatage est celui
--    du serveur (le client ne peut pas en envoyer) ; version + 1 ; la ligne reste lisible
--    par son propriétaire (tombstone nécessaire à la synchronisation) ;
--  * seule une ligne ACTIVE se supprime (une ligne déjà supprimée → conflit) ;
--  * AUCUNE propagation automatique : les suppressions en cascade sont décidées par
--    RepositoryCore et arrivent comme des suppressions explicites ;
--  * une ligne supprimée reste une cible valide de référence ;
--  * restaurer = réécrire la ligne (`put` avec sa version) ; la version continue ;
--  * les unicités métier ne portent que sur les lignes actives et sont revérifiées à la
--    restauration, sur l'état FINAL du lot.
-- Le comportement du déclencheur lui-même (valeur imposée ignorée, date conservée) est
-- vérifié en administrateur à la fin : c'est le seul rôle qui écrit directement.
-- =============================================================================
\set ON_ERROR_STOP on

create temp table sd (u uuid, ids jsonb);
insert into sd select u, tests.seed(u) from (select tests.new_user('sd') as u) x;
grant select on sd to authenticated;

create function pg_temp.r(tbl regclass, id uuid) returns jsonb language plpgsql as $$
declare
  j jsonb;
begin
  execute format('select to_jsonb(x) from %s x where id = $1', tbl) into j using id;
  return j;
end $$;

do $$
declare
  u uuid := (select sd.u from sd);
  ids jsonb := (select sd.ids from sd);
  acc uuid := (ids ->> 'accounts')::uuid;
  goal uuid := (ids ->> 'savings_goals')::uuid;
  bud uuid := (ids ->> 'budgets')::uuid;
  bud2 constant uuid := '22222222-2222-4222-8222-222222222222';
  asset uuid := (ids ->> 'assets')::uuid;
  j jsonb;
  res jsonb;
  r record;
  v1 bigint;
  t0 timestamptz := clock_timestamp();
begin
  perform tests.as_user(u);

  -- Suppression : horodatage serveur, version + 1, ligne toujours lisible
  j := pg_temp.r('public.savings_goals', goal);
  v1 := (j ->> 'version')::bigint;
  res := tests.cs_try(tests.cs(u, jsonb_build_array(tests.cs_del('public.savings_goals', j, v1))), true);
  perform tests.ok(res -> 'ok' -> 'versions' -> 0 = jsonb_build_object('table', 'savings_goals', 'key', jsonb_build_object('id', goal), 'version', v1 + 1, 'deleted', true),
    'suppression confirmée au client : version + 1, supprimée', left(res::text, 300));
  select * into r from public.savings_goals where id = goal;
  perform tests.ok(r.deleted_at is not null and r.deleted_at <= clock_timestamp() and r.deleted_at > t0 - interval '1 hour',
    'deleted_at horodaté par le serveur');
  perform tests.eq(r.version, v1 + 1, 'suppression : version + 1');
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(tests.cs_del('public.savings_goals', j, v1 + 1))),
    'supprimer une ligne déjà supprimée : conflit (seule une ligne active se supprime)', 'version_conflict');
  perform tests.eq((select deleted_at from public.savings_goals where id = goal), r.deleted_at, 'la ligne supprimée garde sa date');
  perform tests.eq((select count(*) from public.savings_goals where id = goal), 1::bigint, 'ligne supprimée toujours lisible par son propriétaire');

  -- Aucune propagation automatique
  perform tests.eq((select count(*) from public.goal_contributions where goal_id = goal and deleted_at is null), 1::bigint,
    'objectif supprimé : ses contributions ne sont PAS supprimées automatiquement (cascade décidée par le domaine)');

  -- Référence vers une ligne supprimée : valide
  j := pg_temp.r('public.accounts', acc);
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_del('public.accounts', j, (j ->> 'version')::bigint))), 'suppression du compte', true);
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.transactions',
      pg_temp.r('public.transactions', (ids ->> 'transactions')::uuid) || '{"label": "après suppression du compte"}',
      (pg_temp.r('public.transactions', (ids ->> 'transactions')::uuid) ->> 'version')::bigint))),
    'transaction référençant un compte supprimé : toujours valide');
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.recurring_rules', jsonb_build_object('id', gen_random_uuid(), 'user_id', u,
      'kind', 'expense', 'label', 'Abonnement', 'amount', 100, 'currency', 'MAD', 'account_id', acc, 'frequency', 'monthly',
      'start_date', '2026-03-01', 'active', true, 'created_at', '2026-10-31T12:00:00.000Z', 'updated_at', '2026-10-31T12:00:00.000Z')))),
    'nouvelle ligne référençant une ligne supprimée : acceptée (le domaine tolère ces références pendantes)');

  -- Restauration
  select version into v1 from public.accounts where id = acc;
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.accounts', j, v1))), 'réécriture du compte supprimé (restauration)', true);
  select * into r from public.accounts where id = acc;
  perform tests.ok(r.deleted_at is null, 'restauration : deleted_at null');
  perform tests.eq(r.version, v1 + 1, 'restauration : la version continue (jamais réinitialisée)');

  -- Unicité budgets (mois, catégorie) sur les lignes actives
  j := pg_temp.r('public.budgets', bud);
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(tests.cs_put('public.budgets', j || jsonb_build_object('id', gen_random_uuid())))),
    'deux budgets actifs pour le même mois et la même catégorie : refusé', '23P01');
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_del('public.budgets', j, (j ->> 'version')::bigint))), 'suppression du budget', true);
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.budgets', j || jsonb_build_object('id', bud2)))),
    'budget supprimé : un nouveau budget du même mois et de la même catégorie est accepté', true);
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(tests.cs_put('public.budgets', j, (j ->> 'version')::bigint + 1))),
    'restaurer l''ancien budget alors qu''un autre est actif : refusé (unicité revérifiée)', '23P01');
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(
      tests.cs_del('public.budgets', jsonb_build_object('id', bud2), 1),
      tests.cs_put('public.budgets', j, (j ->> 'version')::bigint + 1))),
    'même lot : supprimer le budget actif et restaurer l''ancien → accepté (unicité vérifiée sur l''état final)');
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(
      tests.cs_put('public.budgets', j || jsonb_build_object('id', gen_random_uuid(), 'month', '2032-01', 'category_id', null, 'amount', 1)),
      tests.cs_put('public.budgets', j || jsonb_build_object('id', gen_random_uuid(), 'month', '2032-01', 'category_id', null, 'amount', 2)))),
    'deux budgets globaux actifs pour le même mois : refusé (null traité comme une valeur)', '23P01');

  -- Unicité « un actif actif par compte valorisé »
  j := pg_temp.r('public.assets', asset);
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(tests.cs_put('public.assets', j || jsonb_build_object('id', gen_random_uuid())))),
    'deux actifs actifs sur le même compte : refusé', '23P01');
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(tests.cs_put('public.assets', j || jsonb_build_object('id', gen_random_uuid(), 'archived', true)))),
    'second actif archivé sur le même compte : accepté');

  -- Restauration de sauvegarde (restoreBackup = clearUserData + réécriture des mêmes
  -- identifiants) : par le protocole, l'état final de chaque clé — ici la réécriture de
  -- toutes les catégories et du budget actif dans UN lot.
  perform tests.cs_lives(tests.cs(u, (
      select jsonb_agg(tests.cs_put('public.categories', to_jsonb(c), c.version)) from public.categories c where c.user_id = u)
      || jsonb_build_array(tests.cs_put('public.budgets', pg_temp.r('public.budgets', bud2), 1))),
    'restauration de sauvegarde (réécriture des mêmes lignes) dans un seul lot');
  -- Suppression directe : toujours impossible.
  perform tests.throws(format('update public.accounts set deleted_at = now() where id = %L', acc), 'suppression logique directe refusée (privilège)', '42501');
  perform tests.throws(format('delete from public.accounts where id = %L', acc), 'suppression physique refusée', '42501');
  perform tests.as_admin();
end $$;

-- Déclencheur (défense en profondeur), en administrateur : la valeur de deleted_at n'est
-- qu'un signal, l'horodatage est toujours celui du serveur ; restauration par deleted_at null.
do $$
declare
  u uuid := tests.new_user('sd-admin');
  ids jsonb := tests.seed(u);
  goal uuid := (ids ->> 'savings_goals')::uuid;
  r record;
  d1 timestamptz;
  v1 bigint;
begin
  select version into v1 from public.savings_goals where id = goal;
  update public.savings_goals set deleted_at = '2000-01-01T00:00:00Z' where id = goal;
  select * into r from public.savings_goals where id = goal;
  perform tests.ok(r.deleted_at > '2000-01-01'::timestamptz, 'déclencheur : deleted_at horodaté par le serveur (valeur imposée ignorée)');
  perform tests.eq(r.version, v1 + 1, 'déclencheur : suppression = version + 1');
  d1 := r.deleted_at;
  update public.savings_goals set deleted_at = now() + interval '1 day' where id = goal;
  perform tests.eq((select deleted_at from public.savings_goals where id = goal), d1, 'déclencheur : supprimer une ligne déjà supprimée conserve sa date');
  update public.savings_goals set deleted_at = null where id = goal;
  select * into r from public.savings_goals where id = goal;
  perform tests.ok(r.deleted_at is null and r.version = v1 + 3, 'déclencheur : restauration par deleted_at null, la version continue');
end $$;
