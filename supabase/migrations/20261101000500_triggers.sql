-- =============================================================================
-- NEXORA — Lot 3 / migration 5 : déclencheurs
--
-- 1. Métadonnées serveur (private.tg_sync_metadata) sur toutes les tables, avec la liste
--    des colonnes immuables de chaque table (identifiants, propriétaire, création).
-- 2. Création du profil à l'inscription (private.handle_new_user).
--    Les paramètres (user_settings) et les catégories initiales NE sont PAS créés ici :
--    `ensureUser` les crée ensemble côté client (catégories dans la langue de
--    l'utilisateur) ; un user_settings pré-créé ferait croire au domaine que l'espace est
--    déjà initialisé, et les catégories initiales ne seraient jamais créées.
-- =============================================================================

create trigger profiles_sync before insert or update on public.profiles
  for each row execute function private.tg_sync_metadata('id', 'created_at');
create trigger user_settings_sync before insert or update on public.user_settings
  for each row execute function private.tg_sync_metadata('user_id');

create trigger accounts_sync before insert or update on public.accounts
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger categories_sync before insert or update on public.categories
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger import_batches_sync before insert or update on public.import_batches
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger transactions_sync before insert or update on public.transactions
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger attachments_sync before insert or update on public.attachments
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger budgets_sync before insert or update on public.budgets
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger savings_goals_sync before insert or update on public.savings_goals
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger goal_contributions_sync before insert or update on public.goal_contributions
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger recurring_rules_sync before insert or update on public.recurring_rules
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger recurring_occurrences_sync before insert or update on public.recurring_occurrences
  for each row execute function private.tg_sync_metadata('user_id', 'rule_id', 'due_date');
create trigger debts_sync before insert or update on public.debts
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger debt_payments_sync before insert or update on public.debt_payments
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger assets_sync before insert or update on public.assets
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger asset_valuations_sync before insert or update on public.asset_valuations
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger exchange_rates_sync before insert or update on public.exchange_rates
  for each row execute function private.tg_sync_metadata('id', 'user_id', 'created_at');
create trigger notification_states_sync before insert or update on public.notification_states
  for each row execute function private.tg_sync_metadata('user_id', 'id');

-- Profil créé à l'inscription. SECURITY DEFINER (l'utilisateur n'a pas le droit
-- d'insérer dans profiles), search_path vide et noms entièrement qualifiés.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, created_at)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''), coalesce(new.created_at, now()));
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
