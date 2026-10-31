-- =============================================================================
-- NEXORA — Lot 3 / migration 4 : relations, unicités, index
--
-- Isolation déclarative : toute référence entre tables utilisateur est une clé
-- étrangère COMPOSITE (user_id, x_id) → parent (user_id, id). PostgreSQL ignore la RLS
-- lors de la vérification d'une clé étrangère : une clé simple (x_id) permettrait de
-- référencer — donc de sonder — la ligne d'un autre utilisateur.
--
-- Toutes les clés sont DEFERRABLE INITIALLY DEFERRED : vérifiées à la validation de la
-- transaction, ce qui rend indifférent l'ordre des écritures d'un lot (références
-- circulaires dette ↔ transaction, paiement ↔ transaction, transaction ↔ remboursement).
-- ON DELETE NO ACTION : aucune suppression physique côté client (suppression logique) ;
-- la suppression d'un compte supprime toutes ses lignes dans la même instruction.
--
-- Exception : transactions.attachment_id n'a PAS de clé étrangère (le domaine conserve
-- attachmentId après restauration alors que les pièces jointes ne sont pas sauvegardées).
-- =============================================================================

-- Cibles des clés composites
alter table public.accounts            add constraint accounts_user_id_id_key            unique (user_id, id);
alter table public.categories          add constraint categories_user_id_id_key          unique (user_id, id);
alter table public.import_batches      add constraint import_batches_user_id_id_key      unique (user_id, id);
alter table public.transactions        add constraint transactions_user_id_id_key        unique (user_id, id);
alter table public.attachments         add constraint attachments_user_id_id_key         unique (user_id, id);
alter table public.budgets             add constraint budgets_user_id_id_key             unique (user_id, id);
alter table public.savings_goals       add constraint savings_goals_user_id_id_key       unique (user_id, id);
alter table public.goal_contributions  add constraint goal_contributions_user_id_id_key  unique (user_id, id);
alter table public.recurring_rules     add constraint recurring_rules_user_id_id_key     unique (user_id, id);
alter table public.debts               add constraint debts_user_id_id_key               unique (user_id, id);
alter table public.debt_payments       add constraint debt_payments_user_id_id_key       unique (user_id, id);
alter table public.assets              add constraint assets_user_id_id_key              unique (user_id, id);
alter table public.asset_valuations    add constraint asset_valuations_user_id_id_key    unique (user_id, id);
alter table public.exchange_rates      add constraint exchange_rates_user_id_id_key      unique (user_id, id);
alter table public.recurring_occurrences add constraint recurring_occurrences_user_rule_due_key unique (user_id, rule_id, due_date);

-- Clés étrangères composites (différées)
alter table public.categories add constraint categories_parent_fk
  foreign key (user_id, parent_id) references public.categories (user_id, id) deferrable initially deferred;

alter table public.import_batches add constraint import_batches_account_fk
  foreign key (user_id, account_id) references public.accounts (user_id, id) deferrable initially deferred;

alter table public.transactions
  add constraint transactions_account_fk             foreign key (user_id, account_id)             references public.accounts (user_id, id)        deferrable initially deferred,
  add constraint transactions_counterpart_account_fk foreign key (user_id, counterpart_account_id) references public.accounts (user_id, id)        deferrable initially deferred,
  add constraint transactions_category_fk            foreign key (user_id, category_id)            references public.categories (user_id, id)      deferrable initially deferred,
  add constraint transactions_subcategory_fk         foreign key (user_id, subcategory_id)         references public.categories (user_id, id)      deferrable initially deferred,
  add constraint transactions_refund_of_fk           foreign key (user_id, refund_of_id)           references public.transactions (user_id, id)    deferrable initially deferred,
  add constraint transactions_debt_fk                foreign key (user_id, debt_id)                references public.debts (user_id, id)           deferrable initially deferred,
  add constraint transactions_debt_payment_fk        foreign key (user_id, debt_payment_id)        references public.debt_payments (user_id, id)   deferrable initially deferred,
  add constraint transactions_recurring_rule_fk      foreign key (user_id, recurring_rule_id)      references public.recurring_rules (user_id, id) deferrable initially deferred,
  add constraint transactions_import_batch_fk        foreign key (user_id, import_batch_id)        references public.import_batches (user_id, id)  deferrable initially deferred;

alter table public.budgets add constraint budgets_category_fk
  foreign key (user_id, category_id) references public.categories (user_id, id) deferrable initially deferred;

alter table public.savings_goals add constraint savings_goals_linked_account_fk
  foreign key (user_id, linked_account_id) references public.accounts (user_id, id) deferrable initially deferred;

alter table public.goal_contributions add constraint goal_contributions_goal_fk
  foreign key (user_id, goal_id) references public.savings_goals (user_id, id) deferrable initially deferred;

alter table public.recurring_rules
  add constraint recurring_rules_account_fk     foreign key (user_id, account_id)     references public.accounts (user_id, id)   deferrable initially deferred,
  add constraint recurring_rules_category_fk    foreign key (user_id, category_id)    references public.categories (user_id, id) deferrable initially deferred,
  add constraint recurring_rules_subcategory_fk foreign key (user_id, subcategory_id) references public.categories (user_id, id) deferrable initially deferred;

alter table public.recurring_occurrences
  add constraint recurring_occurrences_rule_fk        foreign key (user_id, rule_id)        references public.recurring_rules (user_id, id) deferrable initially deferred,
  add constraint recurring_occurrences_transaction_fk foreign key (user_id, transaction_id) references public.transactions (user_id, id)    deferrable initially deferred;

alter table public.debts add constraint debts_origin_transaction_fk
  foreign key (user_id, origin_transaction_id) references public.transactions (user_id, id) deferrable initially deferred;

alter table public.debt_payments
  add constraint debt_payments_debt_fk        foreign key (user_id, debt_id)        references public.debts (user_id, id)        deferrable initially deferred,
  add constraint debt_payments_account_fk     foreign key (user_id, account_id)     references public.accounts (user_id, id)     deferrable initially deferred,
  add constraint debt_payments_transaction_fk foreign key (user_id, transaction_id) references public.transactions (user_id, id) deferrable initially deferred;

alter table public.assets add constraint assets_linked_account_fk
  foreign key (user_id, linked_account_id) references public.accounts (user_id, id) deferrable initially deferred;

alter table public.asset_valuations add constraint asset_valuations_asset_fk
  foreign key (user_id, asset_id) references public.assets (user_id, id) deferrable initially deferred;

-- Unicités sur les lignes ACTIVES, différées (contraintes d'exclusion : un index unique
-- partiel ne peut pas être différé).
-- setBudget / copyBudgets : un seul budget par (mois, catégorie), budget global compris.
alter table public.budgets add constraint budgets_one_per_month_category
  exclude using btree (user_id with =, month with =, (coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =)
  where (deleted_at is null)
  deferrable initially deferred;

-- saveAsset : un compte n'est valorisé que par un seul actif actif (pas de double comptage).
alter table public.assets add constraint assets_one_per_linked_account
  exclude using btree (user_id with =, linked_account_id with =)
  where (linked_account_id is not null and not archived and deleted_at is null)
  deferrable initially deferred;

-- Récupération des changements (Lot 5) : curseur par utilisateur.
create index profiles_sync_idx              on public.profiles (id, sync_txid);
create index user_settings_sync_idx         on public.user_settings (user_id, sync_txid);
create index accounts_sync_idx              on public.accounts (user_id, sync_txid);
create index categories_sync_idx            on public.categories (user_id, sync_txid);
create index import_batches_sync_idx        on public.import_batches (user_id, sync_txid);
create index transactions_sync_idx          on public.transactions (user_id, sync_txid);
create index attachments_sync_idx           on public.attachments (user_id, sync_txid);
create index budgets_sync_idx               on public.budgets (user_id, sync_txid);
create index savings_goals_sync_idx         on public.savings_goals (user_id, sync_txid);
create index goal_contributions_sync_idx    on public.goal_contributions (user_id, sync_txid);
create index recurring_rules_sync_idx       on public.recurring_rules (user_id, sync_txid);
create index recurring_occurrences_sync_idx on public.recurring_occurrences (user_id, sync_txid);
create index debts_sync_idx                 on public.debts (user_id, sync_txid);
create index debt_payments_sync_idx         on public.debt_payments (user_id, sync_txid);
create index assets_sync_idx                on public.assets (user_id, sync_txid);
create index asset_valuations_sync_idx      on public.asset_valuations (user_id, sync_txid);
create index exchange_rates_sync_idx        on public.exchange_rates (user_id, sync_txid);
create index notification_states_sync_idx   on public.notification_states (user_id, sync_txid);

-- Requêtes métier courantes
create index transactions_user_date_idx on public.transactions (user_id, date desc);
create index budgets_user_month_idx     on public.budgets (user_id, month);

-- Index des clés étrangères (suppression en cascade, jointures)
create index categories_parent_idx               on public.categories (user_id, parent_id);
create index import_batches_account_idx          on public.import_batches (user_id, account_id);
create index transactions_account_idx            on public.transactions (user_id, account_id);
create index transactions_counterpart_idx        on public.transactions (user_id, counterpart_account_id);
create index transactions_category_idx           on public.transactions (user_id, category_id);
create index transactions_subcategory_idx        on public.transactions (user_id, subcategory_id);
create index transactions_refund_of_idx          on public.transactions (user_id, refund_of_id);
create index transactions_debt_idx               on public.transactions (user_id, debt_id);
create index transactions_debt_payment_idx       on public.transactions (user_id, debt_payment_id);
create index transactions_recurring_idx          on public.transactions (user_id, recurring_rule_id, recurring_due_date);
create index transactions_import_batch_idx       on public.transactions (user_id, import_batch_id);
create index transactions_transfer_idx           on public.transactions (user_id, transfer_id);
create index budgets_category_idx                on public.budgets (user_id, category_id);
create index savings_goals_linked_account_idx    on public.savings_goals (user_id, linked_account_id);
create index goal_contributions_goal_idx         on public.goal_contributions (user_id, goal_id);
create index recurring_rules_account_idx         on public.recurring_rules (user_id, account_id);
create index recurring_rules_category_idx        on public.recurring_rules (user_id, category_id);
create index recurring_rules_subcategory_idx     on public.recurring_rules (user_id, subcategory_id);
create index recurring_occurrences_transaction_idx on public.recurring_occurrences (user_id, transaction_id);
create index debts_origin_transaction_idx        on public.debts (user_id, origin_transaction_id);
create index debt_payments_debt_idx              on public.debt_payments (user_id, debt_id);
create index debt_payments_account_idx           on public.debt_payments (user_id, account_id);
create index debt_payments_transaction_idx       on public.debt_payments (user_id, transaction_id);
create index assets_linked_account_idx           on public.assets (user_id, linked_account_id);
create index asset_valuations_asset_idx          on public.asset_valuations (user_id, asset_id);
