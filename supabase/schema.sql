-- =============================================================================
-- NEXORA — schéma PostgreSQL / Supabase (mode cloud PRÉPARÉ, non activé)
--
-- Ce fichier décrit la cible cloud. L'application livrée fonctionne en mode local
-- (IndexedDB). Pour activer le cloud, il faut implémenter un `SupabaseRepository`
-- respectant l'interface de `src/data/repository.ts` (voir docs/ARCHITECTURE.md).
--
-- Principes :
--  * chaque table porte `user_id` = auth.uid() ; Row Level Security activée partout ;
--  * montants en BIGINT (unités minimales), jamais de NUMERIC flottant côté client ;
--  * dates métier en DATE, horodatages en TIMESTAMPTZ ;
--  * contraintes CHECK = validations côté serveur (le client n'est pas une barrière).
-- =============================================================================

create extension if not exists "pgcrypto";

-- Profils / paramètres -------------------------------------------------------
create table if not exists user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  base_currency char(3) not null default 'MAD',
  language text not null default 'fr',
  locale text not null default 'fr-MA',
  time_zone text not null default 'Africa/Casablanca',
  date_format text not null default 'DD/MM/YYYY',
  week_starts_on smallint not null default 1 check (week_starts_on in (0, 1)),
  theme text not null default 'dark' check (theme in ('dark', 'light')),
  currency_display text not null default 'symbol',
  privacy_mode boolean not null default false,
  budget_alert_thresholds smallint[] not null default '{50,75,90,100}',
  notify_budgets boolean not null default true,
  notify_bills boolean not null default true,
  notify_debts boolean not null default true,
  bill_reminder_days smallint not null default 7 check (bill_reminder_days between 1 and 60),
  onboarded boolean not null default false,
  demo_mode boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  type text not null check (type in ('bank', 'cash', 'savings', 'investment', 'ewallet', 'other')),
  currency char(3) not null,
  initial_balance bigint not null default 0,
  initial_balance_date date not null,
  archived boolean not null default false,
  include_in_total boolean not null default true,
  color text not null default '#5271FF',
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key text,
  name text not null,
  kind text not null check (kind in ('income', 'expense', 'savings')),
  nature text check (nature in ('fixed', 'variable')),
  parent_id uuid references categories (id) on delete restrict,
  icon text not null default 'CircleDot',
  color text not null default '#94A3B8',
  archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('expense', 'income', 'transfer', 'refund', 'adjustment', 'debt')),
  direction text not null check (direction in ('in', 'out')),
  amount bigint not null check (amount > 0),
  currency char(3) not null,
  label text not null default '' check (length(label) <= 140),
  date date not null,
  category_id uuid references categories (id) on delete restrict,
  subcategory_id uuid references categories (id) on delete restrict,
  account_id uuid not null references accounts (id) on delete restrict,
  payment_method text,
  payee text,
  notes text check (length(notes) <= 2000),
  tags text[] not null default '{}',
  attachment_path text,              -- objet Supabase Storage (bucket privé)
  status text not null default 'cleared' check (status in ('cleared', 'pending')),
  transfer_id uuid,                  -- commun aux deux jambes d'un transfert
  counterpart_account_id uuid references accounts (id) on delete restrict,
  refund_of_id uuid references transactions (id) on delete set null,
  debt_id uuid,
  debt_payment_id uuid,
  interest_amount bigint check (interest_amount is null or (interest_amount >= 0 and interest_amount <= amount)),
  recurring_rule_id uuid,
  recurring_due_date date,
  import_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- cohérence type ↔ sens
  check ((type = 'expense' and direction = 'out') or (type in ('income', 'refund') and direction = 'in') or type in ('transfer', 'adjustment', 'debt')),
  check (type <> 'transfer' or (transfer_id is not null and counterpart_account_id is not null and counterpart_account_id <> account_id)),
  check (type <> 'adjustment' or (notes is not null and length(trim(notes)) > 0))
);
create index if not exists transactions_user_date on transactions (user_id, date desc);
create index if not exists transactions_transfer on transactions (transfer_id);

create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  month char(7) not null check (month ~ '^\d{4}-\d{2}$'),
  category_id uuid references categories (id) on delete restrict,
  amount bigint not null check (amount >= 0),
  currency char(3) not null,
  alert_thresholds smallint[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (user_id, month, category_id)
);

create table if not exists savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  target_amount bigint not null check (target_amount > 0),
  currency char(3) not null,
  saved_amount bigint not null default 0 check (saved_amount >= 0),
  target_date date,
  priority text not null default 'medium',
  linked_account_id uuid references accounts (id) on delete set null,
  track_linked_account boolean not null default false,
  monthly_contribution bigint check (monthly_contribution is null or monthly_contribution >= 0),
  status text not null default 'active',
  icon text not null default 'Target',
  color text not null default '#41E7F5',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists goal_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null references savings_goals (id) on delete cascade,
  date date not null,
  amount bigint not null check (amount <> 0),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists recurring_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('expense', 'income')),
  label text not null,
  amount bigint not null check (amount > 0),
  currency char(3) not null,
  account_id uuid not null references accounts (id) on delete restrict,
  category_id uuid references categories (id) on delete restrict,
  subcategory_id uuid references categories (id) on delete restrict,
  payee text,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'annual', 'custom')),
  custom_interval int check (custom_interval is null or custom_interval >= 1),
  custom_unit text check (custom_unit in ('day', 'week', 'month', 'year')),
  start_date date not null,
  end_date date check (end_date is null or end_date >= start_date),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists recurring_occurrences (
  user_id uuid not null references auth.users (id) on delete cascade,
  rule_id uuid not null references recurring_rules (id) on delete cascade,
  due_date date not null,
  status text not null check (status in ('paid', 'skipped')),
  transaction_id uuid references transactions (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (rule_id, due_date)
);

create table if not exists debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null,
  type text not null,
  direction text not null check (direction in ('payable', 'receivable')),
  principal bigint not null check (principal > 0),
  currency char(3) not null,
  start_date date not null,
  due_date date,
  counterparty text,
  interest_rate numeric(6, 3),
  installment_amount bigint,
  installment_frequency text,
  status text not null default 'active',
  notes text,
  origin_transaction_id uuid references transactions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists debt_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  debt_id uuid not null references debts (id) on delete cascade,
  date date not null,
  principal bigint not null check (principal >= 0),
  interest bigint not null default 0 check (interest >= 0),
  account_id uuid references accounts (id) on delete restrict,
  transaction_id uuid references transactions (id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  check (principal + interest > 0)
);

create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  type text not null,
  currency char(3) not null,
  linked_account_id uuid references accounts (id) on delete set null,
  archived boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Un compte ne peut être valorisé que par un seul actif actif (évite le double comptage).
create unique index if not exists assets_one_per_account on assets (linked_account_id) where linked_account_id is not null and not archived;

create table if not exists asset_valuations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  asset_id uuid not null references assets (id) on delete cascade,
  date date not null,
  value bigint not null check (value >= 0),
  source text not null default 'manual',
  note text,
  created_at timestamptz not null default now()
);

create table if not exists exchange_rates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  base char(3) not null,
  quote char(3) not null,
  rate numeric(20, 10) not null check (rate > 0),
  date date not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  check (base <> quote)
);

create table if not exists notification_states (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  read boolean not null default false,
  dismissed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_name text not null,
  account_id uuid references accounts (id) on delete set null,
  row_count int not null,
  imported_count int not null,
  skipped_count int not null,
  created_at timestamptz not null default now()
);

-- Row Level Security : chaque utilisateur n'accède qu'à ses propres lignes. -------
do $$
declare t text;
begin
  foreach t in array array[
    'user_settings', 'accounts', 'categories', 'transactions', 'budgets', 'savings_goals',
    'goal_contributions', 'recurring_rules', 'recurring_occurrences', 'debts', 'debt_payments',
    'assets', 'asset_valuations', 'exchange_rates', 'notification_states', 'import_batches'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists owner_all on %I', t);
    execute format(
      'create policy owner_all on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t
    );
  end loop;
end $$;

-- Les références croisées doivent aussi appartenir au même utilisateur (une ligne à moi
-- ne peut pas pointer vers le compte d'un autre). Exemple pour les transactions :
create or replace function enforce_same_owner_transaction() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from accounts a where a.id = new.account_id and a.user_id = new.user_id) then
    raise exception 'Compte invalide';
  end if;
  if new.counterpart_account_id is not null and not exists (select 1 from accounts a where a.id = new.counterpart_account_id and a.user_id = new.user_id) then
    raise exception 'Compte de contrepartie invalide';
  end if;
  if new.category_id is not null and not exists (select 1 from categories c where c.id = new.category_id and c.user_id = new.user_id) then
    raise exception 'Catégorie invalide';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists transactions_same_owner on transactions;
create trigger transactions_same_owner before insert or update on transactions
  for each row execute function enforce_same_owner_transaction();

-- Les justificatifs vont dans un bucket Storage PRIVÉ, chemin « <user_id>/<transaction_id>/<fichier> »,
-- avec une politique Storage limitant l'accès au préfixe auth.uid().
