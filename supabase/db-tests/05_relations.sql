-- =============================================================================
-- 05 — Clés étrangères différées : ordre des écritures indifférent, cohérence à la
-- validation, références circulaires
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
begin
  perform tests.as_user(u);
  -- createDebt avec décaissement : la dette et sa transaction d'origine se référencent.
  -- Ordre 1 : la transaction AVANT la dette (référence vers une dette pas encore créée).
  perform tests.lives(format($f$
    insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived, include_in_total, color, sort_order, created_at, updated_at)
      values (%1$L, %2$L, 'Banque', 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0, %3$L, %3$L);
    insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, debt_id, interest_amount, created_at, updated_at)
      values (%4$L, %2$L, 'debt', 'in', 1000, 'MAD', 'Emprunt', '2026-03-01', %1$L, '{}', 'cleared', %5$L, 0, %3$L, %3$L);
    insert into public.debts (id, user_id, label, type, direction, principal, currency, start_date, status, origin_transaction_id, created_at, updated_at)
      values (%5$L, %2$L, 'Prêt', 'loan', 'payable', 1000, 'MAD', '2026-03-01', 'active', %4$L, %3$L, %3$L);
    $f$, acc, u, ts, tx, debt), 'dette ↔ transaction d''origine : transaction écrite avant la dette');
  -- Ordre 2 : la dette AVANT la transaction.
  perform tests.lives(format($f$
    insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived, include_in_total, color, sort_order, created_at, updated_at)
      values (%1$L, %2$L, 'Banque', 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0, %3$L, %3$L);
    insert into public.debts (id, user_id, label, type, direction, principal, currency, start_date, status, origin_transaction_id, created_at, updated_at)
      values (%5$L, %2$L, 'Prêt', 'loan', 'payable', 1000, 'MAD', '2026-03-01', 'active', %4$L, %3$L, %3$L);
    insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, debt_id, interest_amount, created_at, updated_at)
      values (%4$L, %2$L, 'debt', 'in', 1000, 'MAD', 'Emprunt', '2026-03-01', %1$L, '{}', 'cleared', %5$L, 0, %3$L, %3$L);
    $f$, acc, u, ts, tx, debt), 'dette ↔ transaction d''origine : dette écrite avant la transaction');
  -- addDebtPayment : paiement ↔ transaction, dans les deux ordres, après la dette.
  perform tests.lives(format($f$
    insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived, include_in_total, color, sort_order, created_at, updated_at)
      values (%1$L, %2$L, 'Banque', 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0, %3$L, %3$L);
    insert into public.debts (id, user_id, label, type, direction, principal, currency, start_date, status, created_at, updated_at)
      values (%4$L, %2$L, 'Prêt', 'loan', 'payable', 1000, 'MAD', '2026-03-01', 'active', %3$L, %3$L);
    insert into public.debt_payments (id, user_id, debt_id, date, principal, interest, account_id, transaction_id, created_at)
      values (%5$L, %2$L, %4$L, '2026-03-05', 100, 10, %1$L, %6$L, %3$L);
    insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, debt_id, debt_payment_id, interest_amount, created_at, updated_at)
      values (%6$L, %2$L, 'debt', 'out', 110, 'MAD', 'Remboursement', '2026-03-05', %1$L, '{}', 'cleared', %4$L, %5$L, 10, %3$L, %3$L);
    $f$, acc, u, ts, debt, pay, ptx), 'paiement ↔ transaction : paiement écrit avant la transaction');

  -- Référence pendante : refusée à la validation.
  perform tests.throws(format($f$
    insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived, include_in_total, color, sort_order, created_at, updated_at)
      values (%1$L, %2$L, 'Banque', 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0, %3$L, %3$L);
    insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, debt_id, interest_amount, created_at, updated_at)
      values (%4$L, %2$L, 'debt', 'in', 1000, 'MAD', 'Emprunt', '2026-03-01', %1$L, '{}', 'cleared', gen_random_uuid(), 0, %3$L, %3$L);
    $f$, acc, u, ts, tx), 'référence vers une dette inexistante : refusée à la validation', '23503');
  perform tests.throws(format($f$
    insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, created_at, updated_at)
      values (%1$L, %2$L, 'income', 'in', 1000, 'MAD', 'X', '2026-03-01', gen_random_uuid(), '{}', 'cleared', %3$L, %3$L);
    $f$, tx, u, ts), 'transaction sur un compte inexistant : refusée', '23503');

  -- Remboursement qui référence la dépense d'origine, écrit avant elle.
  perform tests.lives(format($f$
    insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived, include_in_total, color, sort_order, created_at, updated_at)
      values (%1$L, %2$L, 'Banque', 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0, %3$L, %3$L);
    insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, refund_of_id, created_at, updated_at)
      values (gen_random_uuid(), %2$L, 'refund', 'in', 100, 'MAD', 'Rbt', '2026-03-02', %1$L, '{}', 'cleared', %4$L, %3$L, %3$L);
    insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, created_at, updated_at)
      values (%4$L, %2$L, 'expense', 'out', 100, 'MAD', 'Achat', '2026-03-01', %1$L, '{}', 'cleared', %3$L, %3$L);
    $f$, acc, u, ts, tx), 'remboursement écrit avant la dépense qu''il référence');

  -- Pièce jointe : attachment_id sans clé étrangère (restauration sans pièces jointes).
  perform tests.lives(format($f$
    insert into public.accounts (id, user_id, name, type, currency, initial_balance, initial_balance_date, archived, include_in_total, color, sort_order, created_at, updated_at)
      values (%1$L, %2$L, 'Banque', 'bank', 'MAD', 0, '2026-03-01', false, true, '#fff', 0, %3$L, %3$L);
    insert into public.transactions (id, user_id, type, direction, amount, currency, label, date, account_id, tags, status, attachment_id, created_at, updated_at)
      values (gen_random_uuid(), %2$L, 'income', 'in', 100, 'MAD', 'X', '2026-03-01', %1$L, '{}', 'cleared', gen_random_uuid(), %3$L, %3$L);
    $f$, acc, u, ts), 'transaction restaurée avec un attachmentId sans pièce jointe : acceptée (comme le domaine)');
  perform tests.as_admin();
end $$;
