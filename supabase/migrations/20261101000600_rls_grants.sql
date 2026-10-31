-- =============================================================================
-- NEXORA — Lot 3 / migration 6 : Row Level Security et privilèges
--
-- * RLS ACTIVÉE et FORCÉE sur toutes les tables (le propriétaire y est soumis aussi).
-- * Tables métier : lecture / insertion / mise à jour des seules lignes dont
--   user_id = auth.uid() ; AUCUNE politique ni privilège de suppression physique
--   (suppression logique via deleted_at).
-- * profiles : lecture et mise à jour (display_name uniquement) de son propre profil ;
--   insertion réservée au déclencheur d'inscription.
-- * anon : aucun privilège. Les privilèges accordés par défaut par Supabase aux nouvelles
--   tables (y compris TRUNCATE, qui ignore la RLS) sont révoqués explicitement.
-- * (select auth.uid()) : évalué une seule fois par requête (recommandation Supabase).
-- =============================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'user_settings', 'accounts', 'categories', 'import_batches', 'transactions', 'attachments',
    'budgets', 'savings_goals', 'goal_contributions', 'recurring_rules', 'recurring_occurrences',
    'debts', 'debt_payments', 'assets', 'asset_valuations', 'exchange_rates', 'notification_states'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update on table public.%I to authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))',
      t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_update_own', t);
  end loop;
end
$$;

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
revoke all on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Fonctions internes : jamais exécutables par les clients.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on schema private from anon, authenticated;
