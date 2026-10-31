-- =============================================================================
-- NEXORA — Lot 3 / migration 3 : tables métier
--
-- Une colonne par champ TypeScript (matrice : docs/LOT3_SCHEMA.md) + 4 métadonnées
-- serveur (version, sync_txid, server_updated_at, deleted_at).
--
-- Règle : AUCUNE contrainte plus stricte que le domaine. Un CHECK ne traduit que
--   (a) une union de valeurs du type TypeScript, ou
--   (b) une règle que RepositoryCore garantit sur la VALEUR FINALE écrite.
-- Écartés volontairement (non garantis par le domaine) : longueur des libellés et des
-- notes, longueur des noms de compte, bornes des réglages numériques, unicité des taux.
--
-- Les relations (clés étrangères composites différées), unicités et index sont posés
-- par la migration 4 ; les déclencheurs par la migration 5 ; la RLS par la migration 6.
-- =============================================================================

-- Account
create table public.accounts (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (btrim(name) <> ''),                      -- assertAccount
  type text not null check (type in ('bank', 'cash', 'savings', 'investment', 'ewallet', 'other')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  initial_balance bigint not null,                                    -- entier sûr (assertAccount)
  initial_balance_date date not null,
  archived boolean not null,
  include_in_total boolean not null,
  color text not null,
  description text,
  sort_order integer not null,                                        -- Account.order
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Category
create table public.categories (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  key text,
  name text not null check (btrim(name) <> ''),                      -- createCategory / updateCategory
  kind text not null check (kind in ('income', 'expense', 'savings')),
  nature text check (nature in ('fixed', 'variable')),
  parent_id uuid,
  icon text not null,
  color text not null,
  archived boolean not null,
  sort_order integer not null,                                        -- Category.order
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ImportBatch
create table public.import_batches (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  file_name text not null,
  account_id uuid not null,
  row_count integer not null,
  imported_count integer not null,
  skipped_count integer not null,
  created_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Transaction
create table public.transactions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('expense', 'income', 'transfer', 'refund', 'adjustment', 'debt')),
  direction text not null check (direction in ('in', 'out')),
  amount bigint not null check (amount > 0),                          -- validation + dettes (principal > 0, principal+intérêts > 0)
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  label text not null,
  date date not null,
  category_id uuid,
  subcategory_id uuid,
  account_id uuid not null,
  payment_method text check (payment_method in ('card', 'cash', 'transfer', 'direct_debit', 'check', 'mobile', 'other')),
  payee text,
  notes text,
  tags text[] not null,
  attachment_id uuid,                                                 -- volontairement sans clé étrangère (restauration)
  status text not null check (status in ('cleared', 'pending')),
  transfer_id uuid,
  counterpart_account_id uuid,
  refund_of_id uuid,
  debt_id uuid,
  debt_payment_id uuid,
  interest_amount bigint,
  recurring_rule_id uuid,
  recurring_due_date date,
  import_batch_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- buildFromDraft : dépense = sortie ; revenu et remboursement = entrée
  constraint transactions_type_direction check (
    (type = 'expense' and direction = 'out')
    or (type in ('income', 'refund') and direction = 'in')
    or type in ('transfer', 'adjustment', 'debt')
  ),
  -- validateTransactionDraft : transfert vers un autre compte, deux jambes liées
  constraint transactions_transfer check (
    type <> 'transfer' or (transfer_id is not null and counterpart_account_id is not null and counterpart_account_id <> account_id)
  ),
  -- validateTransactionDraft : un ajustement est justifié
  constraint transactions_adjustment_notes check (type <> 'adjustment' or btrim(coalesce(notes, '')) <> ''),
  -- validateDebtPayment : intérêts entiers ≥ 0, montant = principal + intérêts
  constraint transactions_interest check (interest_amount is null or (interest_amount >= 0 and interest_amount <= amount))
);

-- Attachment { id, userId, name, mimeType, size, blob, createdAt } — le fichier (blob)
-- ira dans Supabase Storage au Lot 7 (chemin dérivable : <user_id>/<id>).
create table public.attachments (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  mime_type text not null check (mime_type ~ '^(image/(png|jpeg|webp|gif)|application/pdf)$'), -- addAttachment
  size integer not null check (size >= 0 and size <= 5242880),                                  -- addAttachment : 5 Mo
  created_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Budget
create table public.budgets (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  month char(7) not null check (month ~ '^\d{4}-\d{2}$'),
  category_id uuid,                                                   -- null = budget global
  amount bigint not null check (amount >= 0),                         -- setBudget
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  alert_thresholds double precision[],
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- SavingsGoal
create table public.savings_goals (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (btrim(name) <> ''),                      -- saveGoal
  description text,
  target_amount bigint not null check (target_amount > 0),            -- saveGoal
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  saved_amount bigint not null check (saved_amount >= 0),             -- saveGoal, addGoalContribution
  target_date date,
  priority text not null check (priority in ('low', 'medium', 'high')),
  linked_account_id uuid,
  track_linked_account boolean not null,
  monthly_contribution bigint,
  status text not null check (status in ('active', 'paused', 'achieved', 'archived')),
  icon text not null,
  color text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- GoalContribution
create table public.goal_contributions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null,
  date date not null,
  amount bigint not null check (amount <> 0),                         -- addGoalContribution
  note text,
  created_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- RecurringRule
create table public.recurring_rules (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('expense', 'income')),
  label text not null check (btrim(label) <> ''),                    -- saveRecurringRule
  amount bigint not null check (amount > 0),                          -- saveRecurringRule
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  account_id uuid not null,
  category_id uuid,
  subcategory_id uuid,
  payee text,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'annual', 'custom')),
  custom_interval double precision,                                   -- seulement « ≥ 1 » si custom : pas forcément entier
  custom_unit text check (custom_unit in ('day', 'week', 'month', 'year')),
  start_date date not null,
  end_date date,
  active boolean not null,
  notes text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint recurring_rules_dates check (end_date is null or end_date >= start_date),              -- saveRecurringRule
  constraint recurring_rules_custom check (frequency <> 'custom' or coalesce(custom_interval, 0) >= 1) -- saveRecurringRule (null refusé)
);

-- RecurringOccurrence { id = "<ruleId>:<dueDate>" (dérivé), userId, ruleId, dueDate, status,
--   transactionId?, closure?, updatedAt }
create table public.recurring_occurrences (
  user_id uuid not null references auth.users (id) on delete cascade,
  rule_id uuid not null,
  due_date date not null,
  status text not null check (status in ('paid', 'skipped')),
  transaction_id uuid,
  closure text check (closure in ('waived')),
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (rule_id, due_date)
);

-- Debt
create table public.debts (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null,                                                -- updateDebt ne valide pas le libellé
  type text not null check (type in ('personal_debt', 'loan', 'lent', 'borrowed', 'expected_refund', 'other')),
  direction text not null check (direction in ('payable', 'receivable')),
  principal bigint not null check (principal >= 0),                   -- createDebt > 0 ; updateDebt ≥ remboursé (≥ 0)
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  start_date date not null,
  due_date date,
  counterparty text,
  interest_rate double precision,
  installment_amount bigint,
  installment_frequency text check (installment_frequency in ('monthly', 'quarterly', 'annual')),
  status text not null check (status in ('active', 'settled', 'archived')),
  notes text,
  origin_transaction_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- DebtPayment
create table public.debt_payments (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  debt_id uuid not null,
  date date not null,
  principal bigint not null check (principal >= 0),                   -- validateDebtPayment
  interest bigint not null check (interest >= 0),                     -- validateDebtPayment
  account_id uuid,
  transaction_id uuid,
  note text,
  created_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint debt_payments_nonzero check (principal + interest > 0)   -- validateDebtPayment
);

-- Asset
create table public.assets (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (btrim(name) <> ''),                      -- saveAsset
  type text not null check (type in ('real_estate', 'vehicle', 'investment', 'valuables', 'other')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  linked_account_id uuid,
  archived boolean not null,
  notes text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- AssetValuation
create table public.asset_valuations (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  asset_id uuid not null,
  date date not null,
  value bigint not null check (value >= 0),                           -- addValuation
  source text not null check (source = 'manual'),
  note text,
  created_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ExchangeRate (1 base = rate quote) — doublons autorisés comme dans saveRate
create table public.exchange_rates (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  base text not null check (base ~ '^[A-Z]{3}$'),
  quote text not null check (quote ~ '^[A-Z]{3}$'),
  rate double precision not null check (rate > 0 and rate < 'Infinity'::double precision), -- saveRate
  date date not null,
  source text not null check (source = 'manual'),
  created_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint exchange_rates_distinct check (base <> quote)            -- saveRate
);

-- NotificationState { id (clé déterministe), userId, read, dismissed, updatedAt }
create table public.notification_states (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  read boolean not null,
  dismissed boolean not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  sync_txid xid8 not null default pg_current_xact_id(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, id)
);
