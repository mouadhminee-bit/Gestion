--
-- PostgreSQL database dump
--

\restrict VZSKYGWH9qKm9QdoCD2ZMYrvd9mwnFL2VfKhYIncCa7SXPyfiHj7Ttag4mbJvD4

-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: private; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA private;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  insert into public.profiles (id, display_name, created_at)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''), coalesce(new.created_at, now()));
  return new;
end;
$$;


--
-- Name: tg_sync_metadata(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.tg_sync_metadata() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  col text;
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    -- Insertion d'une ligne déjà supprimée (rare) : horodatage serveur.
    if new.deleted_at is not null then
      new.deleted_at := now();
    end if;
  else
    foreach col in array tg_argv loop
      if (to_jsonb(new) -> col) is distinct from (to_jsonb(old) -> col) then
        raise exception 'NEXORA: la colonne % de % est immuable', col, tg_table_name
          using errcode = '42501';
      end if;
    end loop;
    new.version := old.version + 1;
    if new.deleted_at is not null then
      -- Suppression : horodatage serveur ; une ligne déjà supprimée garde sa date.
      new.deleted_at := coalesce(old.deleted_at, now());
    end if;
    -- new.deleted_at null = restauration (réactivation) de la ligne.
  end if;
  new.sync_txid := pg_current_xact_id();
  new.server_updated_at := now();
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    currency text NOT NULL,
    initial_balance bigint NOT NULL,
    initial_balance_date date NOT NULL,
    archived boolean NOT NULL,
    include_in_total boolean NOT NULL,
    color text NOT NULL,
    description text,
    sort_order integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT accounts_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT accounts_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT accounts_type_check CHECK ((type = ANY (ARRAY['bank'::text, 'cash'::text, 'savings'::text, 'investment'::text, 'ewallet'::text, 'other'::text])))
);

ALTER TABLE ONLY public.accounts FORCE ROW LEVEL SECURITY;


--
-- Name: asset_valuations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_valuations (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    date date NOT NULL,
    value bigint NOT NULL,
    source text NOT NULL,
    note text,
    created_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT asset_valuations_source_check CHECK ((source = 'manual'::text)),
    CONSTRAINT asset_valuations_value_check CHECK ((value >= 0))
);

ALTER TABLE ONLY public.asset_valuations FORCE ROW LEVEL SECURITY;


--
-- Name: assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assets (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    currency text NOT NULL,
    linked_account_id uuid,
    archived boolean NOT NULL,
    notes text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT assets_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT assets_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT assets_type_check CHECK ((type = ANY (ARRAY['real_estate'::text, 'vehicle'::text, 'investment'::text, 'valuables'::text, 'other'::text])))
);

ALTER TABLE ONLY public.assets FORCE ROW LEVEL SECURITY;


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    mime_type text NOT NULL,
    size integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT attachments_mime_type_check CHECK ((mime_type ~ '^(image/(png|jpeg|webp|gif)|application/pdf)$'::text)),
    CONSTRAINT attachments_size_check CHECK (((size >= 0) AND (size <= 5242880)))
);

ALTER TABLE ONLY public.attachments FORCE ROW LEVEL SECURITY;


--
-- Name: budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budgets (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    month character(7) NOT NULL,
    category_id uuid,
    amount bigint NOT NULL,
    currency text NOT NULL,
    alert_thresholds double precision[],
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT budgets_amount_check CHECK ((amount >= 0)),
    CONSTRAINT budgets_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT budgets_month_check CHECK ((month ~ '^\d{4}-\d{2}$'::text))
);

ALTER TABLE ONLY public.budgets FORCE ROW LEVEL SECURITY;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    key text,
    name text NOT NULL,
    kind text NOT NULL,
    nature text,
    parent_id uuid,
    icon text NOT NULL,
    color text NOT NULL,
    archived boolean NOT NULL,
    sort_order integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT categories_kind_check CHECK ((kind = ANY (ARRAY['income'::text, 'expense'::text, 'savings'::text]))),
    CONSTRAINT categories_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT categories_nature_check CHECK ((nature = ANY (ARRAY['fixed'::text, 'variable'::text])))
);

ALTER TABLE ONLY public.categories FORCE ROW LEVEL SECURITY;


--
-- Name: debt_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debt_payments (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    debt_id uuid NOT NULL,
    date date NOT NULL,
    principal bigint NOT NULL,
    interest bigint NOT NULL,
    account_id uuid,
    transaction_id uuid,
    note text,
    created_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT debt_payments_interest_check CHECK ((interest >= 0)),
    CONSTRAINT debt_payments_nonzero CHECK (((principal + interest) > 0)),
    CONSTRAINT debt_payments_principal_check CHECK ((principal >= 0))
);

ALTER TABLE ONLY public.debt_payments FORCE ROW LEVEL SECURITY;


--
-- Name: debts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    label text NOT NULL,
    type text NOT NULL,
    direction text NOT NULL,
    principal bigint NOT NULL,
    currency text NOT NULL,
    start_date date NOT NULL,
    due_date date,
    counterparty text,
    interest_rate double precision,
    installment_amount bigint,
    installment_frequency text,
    status text NOT NULL,
    notes text,
    origin_transaction_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT debts_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT debts_direction_check CHECK ((direction = ANY (ARRAY['payable'::text, 'receivable'::text]))),
    CONSTRAINT debts_installment_frequency_check CHECK ((installment_frequency = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'annual'::text]))),
    CONSTRAINT debts_principal_check CHECK ((principal >= 0)),
    CONSTRAINT debts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'settled'::text, 'archived'::text]))),
    CONSTRAINT debts_type_check CHECK ((type = ANY (ARRAY['personal_debt'::text, 'loan'::text, 'lent'::text, 'borrowed'::text, 'expected_refund'::text, 'other'::text])))
);

ALTER TABLE ONLY public.debts FORCE ROW LEVEL SECURITY;


--
-- Name: exchange_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exchange_rates (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    base text NOT NULL,
    quote text NOT NULL,
    rate double precision NOT NULL,
    date date NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT exchange_rates_base_check CHECK ((base ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT exchange_rates_distinct CHECK ((base <> quote)),
    CONSTRAINT exchange_rates_quote_check CHECK ((quote ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT exchange_rates_rate_check CHECK (((rate > (0)::double precision) AND (rate < 'Infinity'::double precision))),
    CONSTRAINT exchange_rates_source_check CHECK ((source = 'manual'::text))
);

ALTER TABLE ONLY public.exchange_rates FORCE ROW LEVEL SECURITY;


--
-- Name: goal_contributions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goal_contributions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    goal_id uuid NOT NULL,
    date date NOT NULL,
    amount bigint NOT NULL,
    note text,
    created_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT goal_contributions_amount_check CHECK ((amount <> 0))
);

ALTER TABLE ONLY public.goal_contributions FORCE ROW LEVEL SECURITY;


--
-- Name: import_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_batches (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    file_name text NOT NULL,
    account_id uuid NOT NULL,
    row_count integer NOT NULL,
    imported_count integer NOT NULL,
    skipped_count integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.import_batches FORCE ROW LEVEL SECURITY;


--
-- Name: notification_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_states (
    user_id uuid NOT NULL,
    id text NOT NULL,
    read boolean NOT NULL,
    dismissed boolean NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.notification_states FORCE ROW LEVEL SECURITY;


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.profiles FORCE ROW LEVEL SECURITY;


--
-- Name: recurring_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_occurrences (
    user_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    due_date date NOT NULL,
    status text NOT NULL,
    transaction_id uuid,
    closure text,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT recurring_occurrences_closure_check CHECK ((closure = 'waived'::text)),
    CONSTRAINT recurring_occurrences_status_check CHECK ((status = ANY (ARRAY['paid'::text, 'skipped'::text])))
);

ALTER TABLE ONLY public.recurring_occurrences FORCE ROW LEVEL SECURITY;


--
-- Name: recurring_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_rules (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    amount bigint NOT NULL,
    currency text NOT NULL,
    account_id uuid NOT NULL,
    category_id uuid,
    subcategory_id uuid,
    payee text,
    frequency text NOT NULL,
    custom_interval double precision,
    custom_unit text,
    start_date date NOT NULL,
    end_date date,
    active boolean NOT NULL,
    notes text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT recurring_rules_amount_check CHECK ((amount > 0)),
    CONSTRAINT recurring_rules_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT recurring_rules_custom CHECK (((frequency <> 'custom'::text) OR (COALESCE(custom_interval, (0)::double precision) >= (1)::double precision))),
    CONSTRAINT recurring_rules_custom_unit_check CHECK ((custom_unit = ANY (ARRAY['day'::text, 'week'::text, 'month'::text, 'year'::text]))),
    CONSTRAINT recurring_rules_dates CHECK (((end_date IS NULL) OR (end_date >= start_date))),
    CONSTRAINT recurring_rules_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'quarterly'::text, 'semiannual'::text, 'annual'::text, 'custom'::text]))),
    CONSTRAINT recurring_rules_kind_check CHECK ((kind = ANY (ARRAY['expense'::text, 'income'::text]))),
    CONSTRAINT recurring_rules_label_check CHECK ((btrim(label) <> ''::text))
);

ALTER TABLE ONLY public.recurring_rules FORCE ROW LEVEL SECURITY;


--
-- Name: savings_goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.savings_goals (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    target_amount bigint NOT NULL,
    currency text NOT NULL,
    saved_amount bigint NOT NULL,
    target_date date,
    priority text NOT NULL,
    linked_account_id uuid,
    track_linked_account boolean NOT NULL,
    monthly_contribution bigint,
    status text NOT NULL,
    icon text NOT NULL,
    color text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT savings_goals_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT savings_goals_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT savings_goals_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT savings_goals_saved_amount_check CHECK ((saved_amount >= 0)),
    CONSTRAINT savings_goals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'achieved'::text, 'archived'::text]))),
    CONSTRAINT savings_goals_target_amount_check CHECK ((target_amount > 0))
);

ALTER TABLE ONLY public.savings_goals FORCE ROW LEVEL SECURITY;


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    direction text NOT NULL,
    amount bigint NOT NULL,
    currency text NOT NULL,
    label text NOT NULL,
    date date NOT NULL,
    category_id uuid,
    subcategory_id uuid,
    account_id uuid NOT NULL,
    payment_method text,
    payee text,
    notes text,
    tags text[] NOT NULL,
    attachment_id uuid,
    status text NOT NULL,
    transfer_id uuid,
    counterpart_account_id uuid,
    refund_of_id uuid,
    debt_id uuid,
    debt_payment_id uuid,
    interest_amount bigint,
    recurring_rule_id uuid,
    recurring_due_date date,
    import_batch_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT transactions_adjustment_notes CHECK (((type <> 'adjustment'::text) OR (btrim(COALESCE(notes, ''::text)) <> ''::text))),
    CONSTRAINT transactions_amount_check CHECK ((amount > 0)),
    CONSTRAINT transactions_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT transactions_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text]))),
    CONSTRAINT transactions_interest CHECK (((interest_amount IS NULL) OR ((interest_amount >= 0) AND (interest_amount <= amount)))),
    CONSTRAINT transactions_payment_method_check CHECK ((payment_method = ANY (ARRAY['card'::text, 'cash'::text, 'transfer'::text, 'direct_debit'::text, 'check'::text, 'mobile'::text, 'other'::text]))),
    CONSTRAINT transactions_status_check CHECK ((status = ANY (ARRAY['cleared'::text, 'pending'::text]))),
    CONSTRAINT transactions_transfer CHECK (((type <> 'transfer'::text) OR ((transfer_id IS NOT NULL) AND (counterpart_account_id IS NOT NULL) AND (counterpart_account_id <> account_id)))),
    CONSTRAINT transactions_type_check CHECK ((type = ANY (ARRAY['expense'::text, 'income'::text, 'transfer'::text, 'refund'::text, 'adjustment'::text, 'debt'::text]))),
    CONSTRAINT transactions_type_direction CHECK ((((type = 'expense'::text) AND (direction = 'out'::text)) OR ((type = ANY (ARRAY['income'::text, 'refund'::text])) AND (direction = 'in'::text)) OR (type = ANY (ARRAY['transfer'::text, 'adjustment'::text, 'debt'::text]))))
);

ALTER TABLE ONLY public.transactions FORCE ROW LEVEL SECURITY;


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_settings (
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    base_currency text NOT NULL,
    language text NOT NULL,
    locale text NOT NULL,
    time_zone text NOT NULL,
    date_format text NOT NULL,
    week_starts_on smallint NOT NULL,
    theme text NOT NULL,
    currency_display text NOT NULL,
    privacy_mode boolean NOT NULL,
    budget_alert_thresholds double precision[] NOT NULL,
    notify_budgets boolean NOT NULL,
    notify_bills boolean NOT NULL,
    notify_debts boolean NOT NULL,
    bill_reminder_days double precision NOT NULL,
    onboarded boolean NOT NULL,
    demo_mode boolean NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    sync_txid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    server_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT user_settings_base_currency_check CHECK ((base_currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT user_settings_currency_display_check CHECK ((currency_display = ANY (ARRAY['symbol'::text, 'code'::text]))),
    CONSTRAINT user_settings_date_format_check CHECK ((date_format = ANY (ARRAY['DD/MM/YYYY'::text, 'MM/DD/YYYY'::text, 'YYYY-MM-DD'::text]))),
    CONSTRAINT user_settings_theme_check CHECK ((theme = ANY (ARRAY['dark'::text, 'light'::text]))),
    CONSTRAINT user_settings_week_starts_on_check CHECK ((week_starts_on = ANY (ARRAY[0, 1])))
);

ALTER TABLE ONLY public.user_settings FORCE ROW LEVEL SECURITY;


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_id_key UNIQUE (user_id, id);


--
-- Name: asset_valuations asset_valuations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_valuations
    ADD CONSTRAINT asset_valuations_pkey PRIMARY KEY (id);


--
-- Name: asset_valuations asset_valuations_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_valuations
    ADD CONSTRAINT asset_valuations_user_id_id_key UNIQUE (user_id, id);


--
-- Name: assets assets_one_per_linked_account; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_one_per_linked_account EXCLUDE USING btree (user_id WITH =, linked_account_id WITH =) WHERE (((linked_account_id IS NOT NULL) AND (NOT archived) AND (deleted_at IS NULL))) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: assets assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (id);


--
-- Name: assets assets_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_user_id_id_key UNIQUE (user_id, id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_user_id_id_key UNIQUE (user_id, id);


--
-- Name: budgets budgets_one_per_month_category; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_one_per_month_category EXCLUDE USING btree (user_id WITH =, month WITH =, COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =) WHERE ((deleted_at IS NULL)) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: budgets budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_pkey PRIMARY KEY (id);


--
-- Name: budgets budgets_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_user_id_id_key UNIQUE (user_id, id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_user_id_id_key UNIQUE (user_id, id);


--
-- Name: debt_payments debt_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debt_payments
    ADD CONSTRAINT debt_payments_pkey PRIMARY KEY (id);


--
-- Name: debt_payments debt_payments_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debt_payments
    ADD CONSTRAINT debt_payments_user_id_id_key UNIQUE (user_id, id);


--
-- Name: debts debts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debts
    ADD CONSTRAINT debts_pkey PRIMARY KEY (id);


--
-- Name: debts debts_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debts
    ADD CONSTRAINT debts_user_id_id_key UNIQUE (user_id, id);


--
-- Name: exchange_rates exchange_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_pkey PRIMARY KEY (id);


--
-- Name: exchange_rates exchange_rates_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_user_id_id_key UNIQUE (user_id, id);


--
-- Name: goal_contributions goal_contributions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_contributions
    ADD CONSTRAINT goal_contributions_pkey PRIMARY KEY (id);


--
-- Name: goal_contributions goal_contributions_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_contributions
    ADD CONSTRAINT goal_contributions_user_id_id_key UNIQUE (user_id, id);


--
-- Name: import_batches import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);


--
-- Name: import_batches import_batches_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_user_id_id_key UNIQUE (user_id, id);


--
-- Name: notification_states notification_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_states
    ADD CONSTRAINT notification_states_pkey PRIMARY KEY (user_id, id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: recurring_occurrences recurring_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_pkey PRIMARY KEY (rule_id, due_date);


--
-- Name: recurring_occurrences recurring_occurrences_user_rule_due_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_user_rule_due_key UNIQUE (user_id, rule_id, due_date);


--
-- Name: recurring_rules recurring_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_rules
    ADD CONSTRAINT recurring_rules_pkey PRIMARY KEY (id);


--
-- Name: recurring_rules recurring_rules_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_rules
    ADD CONSTRAINT recurring_rules_user_id_id_key UNIQUE (user_id, id);


--
-- Name: savings_goals savings_goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_goals
    ADD CONSTRAINT savings_goals_pkey PRIMARY KEY (id);


--
-- Name: savings_goals savings_goals_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_goals
    ADD CONSTRAINT savings_goals_user_id_id_key UNIQUE (user_id, id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_user_id_id_key UNIQUE (user_id, id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id);


--
-- Name: accounts_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_sync_idx ON public.accounts USING btree (user_id, sync_txid);


--
-- Name: asset_valuations_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_valuations_asset_idx ON public.asset_valuations USING btree (user_id, asset_id);


--
-- Name: asset_valuations_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_valuations_sync_idx ON public.asset_valuations USING btree (user_id, sync_txid);


--
-- Name: assets_linked_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_linked_account_idx ON public.assets USING btree (user_id, linked_account_id);


--
-- Name: assets_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_sync_idx ON public.assets USING btree (user_id, sync_txid);


--
-- Name: attachments_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_sync_idx ON public.attachments USING btree (user_id, sync_txid);


--
-- Name: budgets_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budgets_category_idx ON public.budgets USING btree (user_id, category_id);


--
-- Name: budgets_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budgets_sync_idx ON public.budgets USING btree (user_id, sync_txid);


--
-- Name: budgets_user_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budgets_user_month_idx ON public.budgets USING btree (user_id, month);


--
-- Name: categories_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_parent_idx ON public.categories USING btree (user_id, parent_id);


--
-- Name: categories_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_sync_idx ON public.categories USING btree (user_id, sync_txid);


--
-- Name: debt_payments_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debt_payments_account_idx ON public.debt_payments USING btree (user_id, account_id);


--
-- Name: debt_payments_debt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debt_payments_debt_idx ON public.debt_payments USING btree (user_id, debt_id);


--
-- Name: debt_payments_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debt_payments_sync_idx ON public.debt_payments USING btree (user_id, sync_txid);


--
-- Name: debt_payments_transaction_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debt_payments_transaction_idx ON public.debt_payments USING btree (user_id, transaction_id);


--
-- Name: debts_origin_transaction_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debts_origin_transaction_idx ON public.debts USING btree (user_id, origin_transaction_id);


--
-- Name: debts_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debts_sync_idx ON public.debts USING btree (user_id, sync_txid);


--
-- Name: exchange_rates_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX exchange_rates_sync_idx ON public.exchange_rates USING btree (user_id, sync_txid);


--
-- Name: goal_contributions_goal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goal_contributions_goal_idx ON public.goal_contributions USING btree (user_id, goal_id);


--
-- Name: goal_contributions_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goal_contributions_sync_idx ON public.goal_contributions USING btree (user_id, sync_txid);


--
-- Name: import_batches_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_batches_account_idx ON public.import_batches USING btree (user_id, account_id);


--
-- Name: import_batches_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_batches_sync_idx ON public.import_batches USING btree (user_id, sync_txid);


--
-- Name: notification_states_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_states_sync_idx ON public.notification_states USING btree (user_id, sync_txid);


--
-- Name: profiles_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_sync_idx ON public.profiles USING btree (id, sync_txid);


--
-- Name: recurring_occurrences_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_occurrences_sync_idx ON public.recurring_occurrences USING btree (user_id, sync_txid);


--
-- Name: recurring_occurrences_transaction_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_occurrences_transaction_idx ON public.recurring_occurrences USING btree (user_id, transaction_id);


--
-- Name: recurring_rules_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_rules_account_idx ON public.recurring_rules USING btree (user_id, account_id);


--
-- Name: recurring_rules_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_rules_category_idx ON public.recurring_rules USING btree (user_id, category_id);


--
-- Name: recurring_rules_subcategory_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_rules_subcategory_idx ON public.recurring_rules USING btree (user_id, subcategory_id);


--
-- Name: recurring_rules_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_rules_sync_idx ON public.recurring_rules USING btree (user_id, sync_txid);


--
-- Name: savings_goals_linked_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX savings_goals_linked_account_idx ON public.savings_goals USING btree (user_id, linked_account_id);


--
-- Name: savings_goals_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX savings_goals_sync_idx ON public.savings_goals USING btree (user_id, sync_txid);


--
-- Name: transactions_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_account_idx ON public.transactions USING btree (user_id, account_id);


--
-- Name: transactions_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_category_idx ON public.transactions USING btree (user_id, category_id);


--
-- Name: transactions_counterpart_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_counterpart_idx ON public.transactions USING btree (user_id, counterpart_account_id);


--
-- Name: transactions_debt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_debt_idx ON public.transactions USING btree (user_id, debt_id);


--
-- Name: transactions_debt_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_debt_payment_idx ON public.transactions USING btree (user_id, debt_payment_id);


--
-- Name: transactions_import_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_import_batch_idx ON public.transactions USING btree (user_id, import_batch_id);


--
-- Name: transactions_recurring_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_recurring_idx ON public.transactions USING btree (user_id, recurring_rule_id, recurring_due_date);


--
-- Name: transactions_refund_of_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_refund_of_idx ON public.transactions USING btree (user_id, refund_of_id);


--
-- Name: transactions_subcategory_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_subcategory_idx ON public.transactions USING btree (user_id, subcategory_id);


--
-- Name: transactions_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_sync_idx ON public.transactions USING btree (user_id, sync_txid);


--
-- Name: transactions_transfer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_transfer_idx ON public.transactions USING btree (user_id, transfer_id);


--
-- Name: transactions_user_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_user_date_idx ON public.transactions USING btree (user_id, date DESC);


--
-- Name: user_settings_sync_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_settings_sync_idx ON public.user_settings USING btree (user_id, sync_txid);


--
-- Name: accounts accounts_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_sync BEFORE INSERT OR UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: asset_valuations asset_valuations_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_valuations_sync BEFORE INSERT OR UPDATE ON public.asset_valuations FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: assets assets_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assets_sync BEFORE INSERT OR UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: attachments attachments_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attachments_sync BEFORE INSERT OR UPDATE ON public.attachments FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: budgets budgets_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER budgets_sync BEFORE INSERT OR UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: categories categories_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_sync BEFORE INSERT OR UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: debt_payments debt_payments_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER debt_payments_sync BEFORE INSERT OR UPDATE ON public.debt_payments FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: debts debts_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER debts_sync BEFORE INSERT OR UPDATE ON public.debts FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: exchange_rates exchange_rates_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER exchange_rates_sync BEFORE INSERT OR UPDATE ON public.exchange_rates FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: goal_contributions goal_contributions_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER goal_contributions_sync BEFORE INSERT OR UPDATE ON public.goal_contributions FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: import_batches import_batches_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER import_batches_sync BEFORE INSERT OR UPDATE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: notification_states notification_states_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notification_states_sync BEFORE INSERT OR UPDATE ON public.notification_states FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('user_id', 'id');


--
-- Name: profiles profiles_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_sync BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'created_at');


--
-- Name: recurring_occurrences recurring_occurrences_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recurring_occurrences_sync BEFORE INSERT OR UPDATE ON public.recurring_occurrences FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('user_id', 'rule_id', 'due_date');


--
-- Name: recurring_rules recurring_rules_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recurring_rules_sync BEFORE INSERT OR UPDATE ON public.recurring_rules FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: savings_goals savings_goals_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER savings_goals_sync BEFORE INSERT OR UPDATE ON public.savings_goals FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: transactions transactions_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transactions_sync BEFORE INSERT OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('id', 'user_id', 'created_at');


--
-- Name: user_settings user_settings_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_settings_sync BEFORE INSERT OR UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION private.tg_sync_metadata('user_id');


--
-- Name: accounts accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: asset_valuations asset_valuations_asset_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_valuations
    ADD CONSTRAINT asset_valuations_asset_fk FOREIGN KEY (user_id, asset_id) REFERENCES public.assets(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: asset_valuations asset_valuations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_valuations
    ADD CONSTRAINT asset_valuations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: assets assets_linked_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_linked_account_fk FOREIGN KEY (user_id, linked_account_id) REFERENCES public.accounts(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: assets assets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: attachments attachments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: budgets budgets_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_category_fk FOREIGN KEY (user_id, category_id) REFERENCES public.categories(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: budgets budgets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: categories categories_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_fk FOREIGN KEY (user_id, parent_id) REFERENCES public.categories(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: categories categories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: debt_payments debt_payments_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debt_payments
    ADD CONSTRAINT debt_payments_account_fk FOREIGN KEY (user_id, account_id) REFERENCES public.accounts(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: debt_payments debt_payments_debt_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debt_payments
    ADD CONSTRAINT debt_payments_debt_fk FOREIGN KEY (user_id, debt_id) REFERENCES public.debts(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: debt_payments debt_payments_transaction_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debt_payments
    ADD CONSTRAINT debt_payments_transaction_fk FOREIGN KEY (user_id, transaction_id) REFERENCES public.transactions(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: debt_payments debt_payments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debt_payments
    ADD CONSTRAINT debt_payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: debts debts_origin_transaction_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debts
    ADD CONSTRAINT debts_origin_transaction_fk FOREIGN KEY (user_id, origin_transaction_id) REFERENCES public.transactions(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: debts debts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debts
    ADD CONSTRAINT debts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: exchange_rates exchange_rates_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: goal_contributions goal_contributions_goal_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_contributions
    ADD CONSTRAINT goal_contributions_goal_fk FOREIGN KEY (user_id, goal_id) REFERENCES public.savings_goals(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: goal_contributions goal_contributions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_contributions
    ADD CONSTRAINT goal_contributions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: import_batches import_batches_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_account_fk FOREIGN KEY (user_id, account_id) REFERENCES public.accounts(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: import_batches import_batches_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notification_states notification_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_states
    ADD CONSTRAINT notification_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: recurring_occurrences recurring_occurrences_rule_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_rule_fk FOREIGN KEY (user_id, rule_id) REFERENCES public.recurring_rules(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: recurring_occurrences recurring_occurrences_transaction_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_transaction_fk FOREIGN KEY (user_id, transaction_id) REFERENCES public.transactions(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: recurring_occurrences recurring_occurrences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: recurring_rules recurring_rules_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_rules
    ADD CONSTRAINT recurring_rules_account_fk FOREIGN KEY (user_id, account_id) REFERENCES public.accounts(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: recurring_rules recurring_rules_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_rules
    ADD CONSTRAINT recurring_rules_category_fk FOREIGN KEY (user_id, category_id) REFERENCES public.categories(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: recurring_rules recurring_rules_subcategory_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_rules
    ADD CONSTRAINT recurring_rules_subcategory_fk FOREIGN KEY (user_id, subcategory_id) REFERENCES public.categories(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: recurring_rules recurring_rules_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_rules
    ADD CONSTRAINT recurring_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: savings_goals savings_goals_linked_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_goals
    ADD CONSTRAINT savings_goals_linked_account_fk FOREIGN KEY (user_id, linked_account_id) REFERENCES public.accounts(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: savings_goals savings_goals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_goals
    ADD CONSTRAINT savings_goals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_account_fk FOREIGN KEY (user_id, account_id) REFERENCES public.accounts(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transactions transactions_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_category_fk FOREIGN KEY (user_id, category_id) REFERENCES public.categories(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transactions transactions_counterpart_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_counterpart_account_fk FOREIGN KEY (user_id, counterpart_account_id) REFERENCES public.accounts(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transactions transactions_debt_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_debt_fk FOREIGN KEY (user_id, debt_id) REFERENCES public.debts(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transactions transactions_debt_payment_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_debt_payment_fk FOREIGN KEY (user_id, debt_payment_id) REFERENCES public.debt_payments(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transactions transactions_import_batch_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_import_batch_fk FOREIGN KEY (user_id, import_batch_id) REFERENCES public.import_batches(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transactions transactions_recurring_rule_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_recurring_rule_fk FOREIGN KEY (user_id, recurring_rule_id) REFERENCES public.recurring_rules(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transactions transactions_refund_of_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_refund_of_fk FOREIGN KEY (user_id, refund_of_id) REFERENCES public.transactions(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transactions transactions_subcategory_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_subcategory_fk FOREIGN KEY (user_id, subcategory_id) REFERENCES public.categories(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transactions transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_settings user_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts accounts_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_insert_own ON public.accounts FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: accounts accounts_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_select_own ON public.accounts FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: accounts accounts_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_update_own ON public.accounts FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: asset_valuations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asset_valuations ENABLE ROW LEVEL SECURITY;

--
-- Name: asset_valuations asset_valuations_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY asset_valuations_insert_own ON public.asset_valuations FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: asset_valuations asset_valuations_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY asset_valuations_select_own ON public.asset_valuations FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: asset_valuations asset_valuations_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY asset_valuations_update_own ON public.asset_valuations FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

--
-- Name: assets assets_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assets_insert_own ON public.assets FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: assets assets_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assets_select_own ON public.assets FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: assets assets_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assets_update_own ON public.assets FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: attachments attachments_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attachments_insert_own ON public.attachments FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: attachments attachments_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attachments_select_own ON public.attachments FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: attachments attachments_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attachments_update_own ON public.attachments FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: budgets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;

--
-- Name: budgets budgets_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY budgets_insert_own ON public.budgets FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: budgets budgets_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY budgets_select_own ON public.budgets FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: budgets budgets_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY budgets_update_own ON public.budgets FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

--
-- Name: categories categories_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_insert_own ON public.categories FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: categories categories_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_select_own ON public.categories FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: categories categories_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_update_own ON public.categories FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: debt_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.debt_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: debt_payments debt_payments_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY debt_payments_insert_own ON public.debt_payments FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: debt_payments debt_payments_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY debt_payments_select_own ON public.debt_payments FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: debt_payments debt_payments_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY debt_payments_update_own ON public.debt_payments FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: debts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.debts ENABLE ROW LEVEL SECURITY;

--
-- Name: debts debts_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY debts_insert_own ON public.debts FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: debts debts_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY debts_select_own ON public.debts FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: debts debts_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY debts_update_own ON public.debts FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: exchange_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: exchange_rates exchange_rates_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY exchange_rates_insert_own ON public.exchange_rates FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: exchange_rates exchange_rates_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY exchange_rates_select_own ON public.exchange_rates FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: exchange_rates exchange_rates_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY exchange_rates_update_own ON public.exchange_rates FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: goal_contributions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.goal_contributions ENABLE ROW LEVEL SECURITY;

--
-- Name: goal_contributions goal_contributions_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goal_contributions_insert_own ON public.goal_contributions FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: goal_contributions goal_contributions_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goal_contributions_select_own ON public.goal_contributions FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: goal_contributions goal_contributions_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goal_contributions_update_own ON public.goal_contributions FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: import_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: import_batches import_batches_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_batches_insert_own ON public.import_batches FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: import_batches import_batches_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_batches_select_own ON public.import_batches FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: import_batches import_batches_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_batches_update_own ON public.import_batches FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notification_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_states ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_states notification_states_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_states_insert_own ON public.notification_states FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notification_states notification_states_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_states_select_own ON public.notification_states FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notification_states notification_states_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_states_update_own ON public.notification_states FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_own ON public.profiles FOR SELECT TO authenticated USING ((id = ( SELECT auth.uid() AS uid)));


--
-- Name: profiles profiles_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated USING ((id = ( SELECT auth.uid() AS uid))) WITH CHECK ((id = ( SELECT auth.uid() AS uid)));


--
-- Name: recurring_occurrences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recurring_occurrences ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_occurrences recurring_occurrences_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_occurrences_insert_own ON public.recurring_occurrences FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: recurring_occurrences recurring_occurrences_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_occurrences_select_own ON public.recurring_occurrences FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: recurring_occurrences recurring_occurrences_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_occurrences_update_own ON public.recurring_occurrences FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: recurring_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recurring_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_rules recurring_rules_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_rules_insert_own ON public.recurring_rules FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: recurring_rules recurring_rules_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_rules_select_own ON public.recurring_rules FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: recurring_rules recurring_rules_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_rules_update_own ON public.recurring_rules FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: savings_goals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.savings_goals ENABLE ROW LEVEL SECURITY;

--
-- Name: savings_goals savings_goals_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY savings_goals_insert_own ON public.savings_goals FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: savings_goals savings_goals_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY savings_goals_select_own ON public.savings_goals FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: savings_goals savings_goals_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY savings_goals_update_own ON public.savings_goals FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: transactions transactions_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_insert_own ON public.transactions FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: transactions transactions_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_select_own ON public.transactions FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: transactions transactions_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_update_own ON public.transactions FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: user_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: user_settings user_settings_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_settings_insert_own ON public.user_settings FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: user_settings user_settings_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_settings_select_own ON public.user_settings FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: user_settings user_settings_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_settings_update_own ON public.user_settings FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- PostgreSQL database dump complete
--

\unrestrict VZSKYGWH9qKm9QdoCD2ZMYrvd9mwnFL2VfKhYIncCa7SXPyfiHj7Ttag4mbJvD4

