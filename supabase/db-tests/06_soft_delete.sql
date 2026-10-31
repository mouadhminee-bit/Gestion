-- =============================================================================
-- 06 — Suppression logique : comportement de deleted_at, propagation, restauration
--
-- Règles testées :
--  * supprimer = renseigner deleted_at ; l'horodatage est celui du serveur ; une ligne
--    déjà supprimée garde sa date ; version + 1 ; la ligne reste lisible par son
--    propriétaire (tombstone nécessaire à la synchronisation) ;
--  * AUCUNE propagation automatique : les suppressions en cascade sont décidées par
--    RepositoryCore et arrivent comme des suppressions explicites ;
--  * une ligne supprimée reste une cible valide de référence ;
--  * restaurer = deleted_at null (réécriture de la ligne) ; version continue ;
--  * les unicités métier ne portent que sur les lignes actives et sont revérifiées à la
--    restauration.
-- =============================================================================
\set ON_ERROR_STOP on

create temp table sd (u uuid, ids jsonb);
insert into sd select u, tests.seed(u) from (select tests.new_user('sd') as u) x;
grant select on sd to authenticated;

do $$
declare
  u uuid := (select sd.u from sd);
  ids jsonb := (select sd.ids from sd);
  acc uuid := (ids ->> 'accounts')::uuid;
  goal uuid := (ids ->> 'savings_goals')::uuid;
  bud uuid := (ids ->> 'budgets')::uuid;
  asset uuid := (ids ->> 'assets')::uuid;
  r record;
  d1 timestamptz;
  v1 bigint;
  n bigint;
begin
  perform tests.as_user(u);

  -- Suppression : horodatage serveur, version + 1, ligne toujours lisible
  select version into v1 from public.savings_goals where id = goal;
  update public.savings_goals set deleted_at = '2000-01-01T00:00:00Z' where id = goal;
  select * into r from public.savings_goals where id = goal;
  perform tests.ok(r.deleted_at > '2000-01-01'::timestamptz, 'deleted_at horodaté par le serveur (valeur client ignorée)');
  perform tests.eq(r.version, v1 + 1, 'suppression : version + 1');
  d1 := r.deleted_at;
  update public.savings_goals set deleted_at = now() + interval '1 day' where id = goal;
  perform tests.eq((select deleted_at from public.savings_goals where id = goal), d1, 'supprimer une ligne déjà supprimée conserve sa date');
  perform tests.eq((select count(*) from public.savings_goals where id = goal), 1::bigint, 'ligne supprimée toujours lisible par son propriétaire');

  -- Aucune propagation automatique
  perform tests.eq((select count(*) from public.goal_contributions where goal_id = goal and deleted_at is null), 1::bigint,
    'objectif supprimé : ses contributions ne sont PAS supprimées automatiquement (cascade décidée par le domaine)');

  -- Référence vers une ligne supprimée : valide
  update public.accounts set deleted_at = now() where id = acc;
  perform tests.lives(format('update public.transactions set label = ''après suppression du compte'' where account_id = %L', acc),
    'transaction référençant un compte supprimé : toujours valide');
  perform tests.lives(format($f$insert into public.recurring_rules (id, user_id, kind, label, amount, currency, account_id, frequency, start_date, active, created_at, updated_at)
    values (gen_random_uuid(), %L, 'expense', 'Abonnement', 100, 'MAD', %L, 'monthly', '2026-03-01', true, now(), now())$f$, u, acc),
    'nouvelle ligne référençant une ligne supprimée : acceptée (le domaine tolère ces références pendantes)');

  -- Restauration
  select version into v1 from public.accounts where id = acc;
  update public.accounts set deleted_at = null where id = acc;
  select * into r from public.accounts where id = acc;
  perform tests.ok(r.deleted_at is null, 'restauration : deleted_at null');
  perform tests.eq(r.version, v1 + 1, 'restauration : la version continue (jamais réinitialisée)');

  -- Unicité budgets (mois, catégorie) sur les lignes actives
  perform tests.throws(format($f$insert into public.budgets select * from jsonb_populate_record(null::public.budgets,
      (select to_jsonb(b) || jsonb_build_object('id', gen_random_uuid()) from public.budgets b where id = %L))$f$, bud),
    'deux budgets actifs pour le même mois et la même catégorie : refusé', '23P01');
  update public.budgets set deleted_at = now() where id = bud;
  perform tests.lives_keep(format($f$insert into public.budgets select * from jsonb_populate_record(null::public.budgets,
      (select to_jsonb(b) || jsonb_build_object('id', '22222222-2222-4222-8222-222222222222', 'deleted_at', null) from public.budgets b where id = %L))$f$, bud),
    'budget supprimé : un nouveau budget du même mois et de la même catégorie est accepté');
  perform tests.throws(format('update public.budgets set deleted_at = null where id = %L', bud),
    'restaurer l''ancien budget alors qu''un autre est actif : refusé (unicité revérifiée)', '23P01');
  perform tests.throws(format($f$insert into public.budgets (id, user_id, month, category_id, amount, currency, created_at, updated_at) values
      (gen_random_uuid(), %1$L, '2032-01', null, 1, 'MAD', now(), now()), (gen_random_uuid(), %1$L, '2032-01', null, 2, 'MAD', now(), now())$f$, u),
    'deux budgets globaux actifs pour le même mois : refusé (null traité comme une valeur)', '23P01');

  -- Unicité « un actif actif par compte valorisé »
  perform tests.throws(format($f$insert into public.assets select * from jsonb_populate_record(null::public.assets,
      (select to_jsonb(a) || jsonb_build_object('id', gen_random_uuid()) from public.assets a where id = %L))$f$, asset),
    'deux actifs actifs sur le même compte : refusé', '23P01');
  perform tests.lives(format($f$insert into public.assets select * from jsonb_populate_record(null::public.assets,
      (select to_jsonb(a) || jsonb_build_object('id', gen_random_uuid(), 'archived', true) from public.assets a where id = %L))$f$, asset),
    'second actif archivé sur le même compte : accepté');

  -- Séquence d'une restauration de sauvegarde : tout supprimer puis réécrire les mêmes
  -- identifiants, dans une seule transaction (restoreBackup = clearUserData + bulkPut).
  perform tests.lives(format($f$
      update public.categories set deleted_at = now() where user_id = %1$L;
      update public.budgets set deleted_at = now() where user_id = %1$L;
      update public.categories set deleted_at = null where user_id = %1$L;
      update public.budgets set deleted_at = null where id = '22222222-2222-4222-8222-222222222222';
    $f$, u), 'restauration de sauvegarde (suppression puis réécriture des mêmes lignes) dans une transaction');
  perform tests.as_admin();
end $$;
