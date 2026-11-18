-- =============================================================================
-- 05 — Clés étrangères différées : ordre des écritures indifférent, cohérence à la
-- validation, références circulaires
--
-- Chaque cas est UN lot (public.apply_changeset) : c'est la forme réelle des opérations
-- composées de l'application (« une opération métier = un lot », migration 8). Les
-- contraintes différées sont vérifiées à la validation du lot.
-- =============================================================================
\set ON_ERROR_STOP on

create temp table rel (u uuid);
insert into rel select tests.new_user('rel');
grant select on rel to authenticated;

do $$
declare
  u uuid := (select rel.u from rel);
  ts constant text := '2026-10-31T12:00:00.000Z';
  acc uuid := gen_random_uuid();
  debt uuid := gen_random_uuid();
  tx uuid := gen_random_uuid();
  pay uuid := gen_random_uuid();
  ptx uuid := gen_random_uuid();
  o_acc jsonb;
  o_tx_debt jsonb;
  o_debt jsonb;
  o_debt_plain jsonb;
  o_pay jsonb;
  o_ptx jsonb;
  common jsonb;
begin
  common := jsonb_build_object('user_id', u, 'created_at', ts, 'updated_at', ts);
  o_acc := tests.cs_put('public.accounts', common || jsonb_build_object('id', acc, 'name', 'Banque', 'type', 'bank', 'currency', 'MAD',
    'initial_balance', 0, 'initial_balance_date', '2026-03-01', 'archived', false, 'include_in_total', true, 'color', '#fff', 'sort_order', 0));
  -- Transaction d'origine d'une dette (référence la dette) et dette (référence la transaction).
  o_tx_debt := tests.cs_put('public.transactions', common || jsonb_build_object('id', tx, 'type', 'debt', 'direction', 'in', 'amount', 1000,
    'currency', 'MAD', 'label', 'Emprunt', 'date', '2026-03-01', 'account_id', acc, 'tags', '[]'::jsonb, 'status', 'cleared',
    'debt_id', debt, 'interest_amount', 0));
  o_debt := tests.cs_put('public.debts', common || jsonb_build_object('id', debt, 'label', 'Prêt', 'type', 'loan', 'direction', 'payable',
    'principal', 1000, 'currency', 'MAD', 'start_date', '2026-03-01', 'status', 'active', 'origin_transaction_id', tx));
  o_debt_plain := jsonb_set(o_debt, '{row,origin_transaction_id}', 'null');
  -- Paiement (référence sa transaction) et transaction (référence le paiement).
  o_pay := tests.cs_put('public.debt_payments', jsonb_build_object('id', pay, 'user_id', u, 'debt_id', debt, 'date', '2026-03-05',
    'principal', 100, 'interest', 10, 'account_id', acc, 'transaction_id', ptx, 'created_at', ts));
  o_ptx := tests.cs_put('public.transactions', common || jsonb_build_object('id', ptx, 'type', 'debt', 'direction', 'out', 'amount', 110,
    'currency', 'MAD', 'label', 'Remboursement', 'date', '2026-03-05', 'account_id', acc, 'tags', '[]'::jsonb, 'status', 'cleared',
    'debt_id', debt, 'debt_payment_id', pay, 'interest_amount', 10));

  perform tests.as_user(u);
  -- createDebt avec décaissement : la dette et sa transaction d'origine se référencent.
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(o_acc, o_tx_debt, o_debt)),
    'dette ↔ transaction d''origine : transaction écrite avant la dette');
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(o_acc, o_debt, o_tx_debt)),
    'dette ↔ transaction d''origine : dette écrite avant la transaction');
  -- addDebtPayment : paiement ↔ transaction, dans les deux ordres, après la dette.
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(o_acc, o_debt_plain, o_pay, o_ptx)),
    'paiement ↔ transaction : paiement écrit avant la transaction');
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(o_acc, o_debt_plain, o_ptx, o_pay)),
    'paiement ↔ transaction : transaction écrite avant le paiement');

  -- Référence pendante : refusée à la validation.
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(o_acc, o_tx_debt)),
    'référence vers une dette inexistante : refusée à la validation', '23503');
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(jsonb_set(o_tx_debt, '{row,debt_id}', 'null'))),
    'transaction sur un compte inexistant : refusée', '23503');
  -- Deux lots séparés : chaque lot est une transaction, le premier est donc refusé seul.
  perform tests.cs_throws(tests.cs(u, jsonb_build_array(o_tx_debt)),
    'dette ↔ transaction en deux lots séparés : le premier est refusé (un lot = une transaction)', '23503');
  perform tests.eq((select count(*) from public.transactions where user_id = u), 0::bigint, 'aucune écriture partielle après les lots refusés');

  -- Remboursement qui référence la dépense d'origine, écrit avant elle.
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(o_acc,
      tests.cs_put('public.transactions', common || jsonb_build_object('id', gen_random_uuid(), 'type', 'refund', 'direction', 'in', 'amount', 100,
        'currency', 'MAD', 'label', 'Rbt', 'date', '2026-03-02', 'account_id', acc, 'tags', '[]'::jsonb, 'status', 'cleared', 'refund_of_id', tx)),
      tests.cs_put('public.transactions', common || jsonb_build_object('id', tx, 'type', 'expense', 'direction', 'out', 'amount', 100,
        'currency', 'MAD', 'label', 'Achat', 'date', '2026-03-01', 'account_id', acc, 'tags', '[]'::jsonb, 'status', 'cleared')))),
    'remboursement écrit avant la dépense qu''il référence');

  -- Pièce jointe : attachment_id sans clé étrangère (restauration sans pièces jointes).
  perform tests.cs_lives(tests.cs(u, jsonb_build_array(o_acc,
      tests.cs_put('public.transactions', common || jsonb_build_object('id', gen_random_uuid(), 'type', 'income', 'direction', 'in', 'amount', 100,
        'currency', 'MAD', 'label', 'X', 'date', '2026-03-01', 'account_id', acc, 'tags', '[]'::jsonb, 'status', 'cleared',
        'attachment_id', gen_random_uuid())))),
    'transaction restaurée avec un attachmentId sans pièce jointe : acceptée (comme le domaine)');
  perform tests.as_admin();
end $$;
