-- =============================================================================
-- NEXORA — Lot 3 / migration 2 : profils et paramètres
--
-- Correspondance TypeScript : `User` → profiles, `UserSettings` → user_settings
-- (matrice complète : docs/LOT3_SCHEMA.md). Les contraintes CHECK ne reprennent que
-- les valeurs imposées par les types du domaine ; `updateSettings` ne validant pas les
-- valeurs numériques, aucune borne n'est ajoutée sur celles-ci.
-- =============================================================================

-- User { id, displayName, email?, createdAt } — email : lu dans auth.users (non dupliqué).
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  -- métadonnées serveur
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- UserSettings { id (= userId), userId, displayName, baseCurrency, language, locale, timeZone,
--   dateFormat, weekStartsOn, theme, currencyDisplay, privacyMode, budgetAlertThresholds,
--   notifyBudgets, notifyBills, notifyDebts, billReminderDays, onboarded, demoMode, updatedAt }
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  language text not null,
  locale text not null,
  time_zone text not null,
  date_format text not null check (date_format in ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD')),
  week_starts_on smallint not null check (week_starts_on in (0, 1)),
  theme text not null check (theme in ('dark', 'light')),
  currency_display text not null check (currency_display in ('symbol', 'code')),
  privacy_mode boolean not null,
  budget_alert_thresholds double precision[] not null,
  notify_budgets boolean not null,
  notify_bills boolean not null,
  notify_debts boolean not null,
  bill_reminder_days double precision not null,
  onboarded boolean not null,
  demo_mode boolean not null,
  updated_at timestamptz not null,
  -- métadonnées serveur
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
