-- =============================================================================
-- 04 — Compatibilité avec le domaine : AUCUNE contrainte plus stricte que lui
--
-- Chaque cas part d'une ligne valide de l'utilisateur, modifie un champ et l'insère
-- (copie, nouvelle clé) ou la met à jour (user_settings, debts).
--   'ok'    : donnée acceptée par le domaine actuel → DOIT être acceptée ;
--   SQLSTATE : donnée exclue par les types / règles du domaine → DOIT être refusée.
-- =============================================================================
\set ON_ERROR_STOP on

create temp table cases (n serial, tbl text, mode text, patch jsonb, expect text, label text);
insert into cases (tbl, mode, patch, expect, label) values
  -- ---------- acceptés (dont des cas que le brouillon schema.sql aurait rejetés) ----------
  ('transactions', 'copy', jsonb_build_object('label', repeat('x', 500)), 'ok', 'libellé de 500 caractères (libellé automatique d''un transfert non borné)'),
  ('transactions', 'copy', jsonb_build_object('notes', repeat('n', 5000)), 'ok', 'notes de 5 000 caractères (notes d''un paiement de dette non validées)'),
  ('transactions', 'copy', '{"label": ""}', 'ok', 'libellé vide'),
  ('transactions', 'copy', '{"amount": 100000000000000}', 'ok', 'montant = MAX_AMOUNT (10^14)'),
  ('transactions', 'copy', '{"tags": ["une-etiquette-de-plus-de-quarante-caracteres-tres-longue"]}', 'ok', 'étiquette longue'),
  ('transactions', 'copy', '{"type": "refund", "direction": "in"}', 'ok', 'remboursement (entrée)'),
  ('transactions', 'copy', '{"type": "income", "direction": "in", "category_id": null, "subcategory_id": null}', 'ok', 'revenu sans catégorie'),
  ('transactions', 'copy', '{"type": "adjustment", "direction": "out", "notes": "Correction", "category_id": null, "subcategory_id": null}', 'ok', 'ajustement justifié (sortie)'),
  ('transactions', 'copy', '{"type": "adjustment", "direction": "in", "notes": "Correction"}', 'ok', 'ajustement justifié (entrée)'),
  ('transactions', 'copy', '{"type": "debt", "direction": "in", "interest_amount": 0}', 'ok', 'mouvement de dette entrant, intérêts nuls'),
  ('transactions', 'copy', '{"type": "transfer", "direction": "out", "transfer_id": "11111111-1111-4111-8111-111111111111"}', 'ok', 'jambe de transfert vers l''autre compte'),
  ('transactions', 'copy', '{"payment_method": null, "payee": null, "notes": null, "status": "pending"}', 'ok', 'opération en attente, champs facultatifs absents'),
  ('accounts', 'copy', jsonb_build_object('name', repeat('C', 200)), 'ok', 'nom de compte de 200 caractères'),
  ('accounts', 'copy', '{"initial_balance": -9007199254740991}', 'ok', 'solde initial négatif (entier sûr minimal)'),
  ('accounts', 'copy', '{"initial_balance": 9007199254740991}', 'ok', 'solde initial = Number.MAX_SAFE_INTEGER'),
  ('accounts', 'copy', '{"type": "ewallet", "currency": "XOF", "description": "Portefeuille"}', 'ok', 'portefeuille électronique en XOF'),
  ('categories', 'copy', '{"kind": "income", "nature": null, "parent_id": null, "key": null}', 'ok', 'catégorie de revenu sans nature'),
  ('categories', 'copy', '{"kind": "savings", "nature": "fixed"}', 'ok', 'catégorie d''épargne avec nature (non interdit par le domaine)'),
  ('budgets', 'copy', '{"amount": 0, "category_id": null, "month": "2031-01", "alert_thresholds": [12.5, 150]}', 'ok', 'budget global nul, seuils décimaux et > 100'),
  ('savings_goals', 'copy', '{"saved_amount": 0, "monthly_contribution": null, "target_date": null, "linked_account_id": null}', 'ok', 'objectif minimal'),
  ('savings_goals', 'copy', '{"saved_amount": 500000, "status": "achieved"}', 'ok', 'objectif dépassé (constitué > cible)'),
  ('goal_contributions', 'copy', '{"amount": -50}', 'ok', 'retrait d''affectation (montant négatif)'),
  ('recurring_rules', 'copy', '{"frequency": "custom", "custom_interval": 1.5, "custom_unit": "week"}', 'ok', 'intervalle personnalisé non entier (seul « ≥ 1 » est validé)'),
  ('recurring_rules', 'copy', '{"kind": "income", "end_date": "2026-03-03"}', 'ok', 'fin = début'),
  ('recurring_occurrences', 'copy', '{"status": "paid", "closure": "waived", "transaction_id": null}', 'ok', 'échéance clôturée (reliquat abandonné)'),
  ('recurring_occurrences', 'copy', '{"status": "skipped", "closure": null}', 'ok', 'échéance ignorée'),
  ('debts', 'update', '{"principal": 0}', 'ok', 'dette : principal ramené à 0 (updateDebt l''autorise si rien n''est remboursé au-delà)'),
  ('debts', 'update', '{"label": ""}', 'ok', 'dette : libellé vidé (updateDebt ne valide pas le libellé)'),
  ('debts', 'copy', '{"interest_rate": 3.14159265358979, "installment_frequency": "quarterly", "type": "lent", "direction": "receivable"}', 'ok', 'créance avec taux décimal'),
  ('debt_payments', 'copy', '{"principal": 0, "interest": 100}', 'ok', 'paiement d''intérêts seuls'),
  ('assets', 'copy', '{"type": "valuables", "linked_account_id": null}', 'ok', 'actif non lié'),
  ('asset_valuations', 'copy', '{"value": 0}', 'ok', 'valorisation nulle'),
  ('exchange_rates', 'copy', '{}', 'ok', 'taux en double (même paire, même date : saveRate l''accepte)'),
  ('exchange_rates', 'copy', '{"rate": 1e-12}', 'ok', 'taux très petit'),
  ('exchange_rates', 'copy', '{"rate": 1e12}', 'ok', 'taux très grand'),
  ('attachments', 'copy', '{"mime_type": "application/pdf", "size": 5242880}', 'ok', 'PDF de 5 Mo exactement'),
  ('import_batches', 'copy', '{"row_count": 0, "imported_count": 0, "skipped_count": 0}', 'ok', 'lot d''import vide'),
  ('notification_states', 'copy', '{"read": false, "dismissed": true}', 'ok', 'notification masquée'),
  ('user_settings', 'update', '{"bill_reminder_days": 7.5, "budget_alert_thresholds": [33.3, 120]}', 'ok', 'réglages numériques non entiers (updateSettings ne valide pas)'),
  ('user_settings', 'update', '{"bill_reminder_days": 0, "budget_alert_thresholds": []}', 'ok', 'réglages hors bornes de l''interface (non validés par le repository)'),
  ('user_settings', 'update', '{"language": "vi", "locale": "vi-VN", "time_zone": "Asia/Dubai", "date_format": "YYYY-MM-DD", "week_starts_on": 0, "theme": "light", "currency_display": "code"}', 'ok', 'réglages régionaux variés'),
  -- ---------- refusés (exclus par les types ou les règles du domaine) ----------
  ('transactions', 'copy', '{"amount": 0}', '23514', 'montant nul'),
  ('transactions', 'copy', '{"amount": -1}', '23514', 'montant négatif'),
  ('transactions', 'copy', '{"type": "gift"}', '23514', 'type inconnu'),
  ('transactions', 'copy', '{"direction": "in"}', '23514', 'dépense entrante'),
  ('transactions', 'copy', '{"type": "income", "direction": "out"}', '23514', 'revenu sortant'),
  ('transactions', 'copy', '{"type": "transfer", "transfer_id": null}', '23514', 'transfert sans identifiant commun'),
  ('transactions', 'copy', '{"type": "transfer", "transfer_id": "11111111-1111-4111-8111-111111111111", "counterpart_account_id": null}', '23514', 'transfert sans contrepartie'),
  ('transactions', 'copy', '{"type": "adjustment", "notes": "   "}', '23514', 'ajustement non justifié'),
  ('transactions', 'copy', '{"interest_amount": 20000}', '23514', 'intérêts > montant'),
  ('transactions', 'copy', '{"interest_amount": -1}', '23514', 'intérêts négatifs'),
  ('transactions', 'copy', '{"status": "void"}', '23514', 'statut inconnu'),
  ('transactions', 'copy', '{"payment_method": "bitcoin"}', '23514', 'moyen de paiement inconnu'),
  ('transactions', 'copy', '{"currency": "mad"}', '23514', 'devise en minuscules'),
  ('transactions', 'copy', '{"amount": 1.5}', '22P02', 'montant non entier (unités minimales)'),
  ('accounts', 'copy', '{"name": "   "}', '23514', 'nom de compte vide'),
  ('accounts', 'copy', '{"type": "crypto"}', '23514', 'type de compte inconnu'),
  ('categories', 'copy', '{"kind": "transfer"}', '23514', 'type de catégorie inconnu'),
  ('categories', 'copy', '{"nature": "mixed"}', '23514', 'nature inconnue'),
  ('categories', 'copy', '{"name": ""}', '23514', 'catégorie sans nom'),
  ('budgets', 'copy', '{"month": "2026-3"}', '23514', 'mois mal formé'),
  ('budgets', 'copy', '{"amount": -1}', '23514', 'budget négatif'),
  ('savings_goals', 'copy', '{"target_amount": 0}', '23514', 'cible nulle'),
  ('savings_goals', 'copy', '{"saved_amount": -1}', '23514', 'constitué négatif'),
  ('savings_goals', 'copy', '{"priority": "urgent"}', '23514', 'priorité inconnue'),
  ('savings_goals', 'copy', '{"status": "done"}', '23514', 'statut d''objectif inconnu'),
  ('goal_contributions', 'copy', '{"amount": 0}', '23514', 'contribution nulle'),
  ('recurring_rules', 'copy', '{"amount": 0}', '23514', 'échéance de montant nul'),
  ('recurring_rules', 'copy', '{"label": "  "}', '23514', 'règle sans libellé'),
  ('recurring_rules', 'copy', '{"end_date": "2026-03-02"}', '23514', 'fin avant début'),
  ('recurring_rules', 'copy', '{"frequency": "custom", "custom_interval": null}', '23514', 'fréquence personnalisée sans intervalle'),
  ('recurring_rules', 'copy', '{"frequency": "custom", "custom_interval": 0.5}', '23514', 'intervalle < 1'),
  ('recurring_rules', 'copy', '{"frequency": "hourly"}', '23514', 'fréquence inconnue'),
  ('recurring_occurrences', 'copy', '{"status": "partial"}', '23514', 'statut d''échéance non stocké'),
  ('recurring_occurrences', 'copy', '{"closure": "cancelled"}', '23514', 'clôture inconnue'),
  ('debts', 'copy', '{"principal": -1}', '23514', 'principal négatif'),
  ('debts', 'copy', '{"type": "mortgage"}', '23514', 'type de dette inconnu'),
  ('debts', 'copy', '{"direction": "both"}', '23514', 'sens de dette inconnu'),
  ('debts', 'copy', '{"status": "paid"}', '23514', 'statut de dette inconnu'),
  ('debts', 'copy', '{"installment_frequency": "weekly"}', '23514', 'périodicité d''échéance inconnue'),
  ('debt_payments', 'copy', '{"principal": -1}', '23514', 'principal remboursé négatif'),
  ('debt_payments', 'copy', '{"interest": -1}', '23514', 'intérêts négatifs'),
  ('debt_payments', 'copy', '{"principal": 0, "interest": 0}', '23514', 'paiement nul'),
  ('assets', 'copy', '{"name": ""}', '23514', 'actif sans nom'),
  ('assets', 'copy', '{"type": "crypto"}', '23514', 'type d''actif inconnu'),
  ('asset_valuations', 'copy', '{"value": -1}', '23514', 'valorisation négative'),
  ('asset_valuations', 'copy', '{"source": "api"}', '23514', 'source non manuelle'),
  ('exchange_rates', 'copy', '{"rate": 0}', '23514', 'taux nul'),
  ('exchange_rates', 'copy', '{"rate": -1}', '23514', 'taux négatif'),
  ('exchange_rates', 'copy', '{"rate": "Infinity"}', '23514', 'taux infini'),
  ('exchange_rates', 'copy', '{"rate": "NaN"}', '23514', 'taux NaN'),
  ('exchange_rates', 'copy', '{"quote": "EUR"}', '23514', 'base = cotée'),
  ('attachments', 'copy', '{"mime_type": "application/x-msdownload"}', '23514', 'format de pièce jointe refusé'),
  ('attachments', 'copy', '{"size": 5242881}', '23514', 'pièce jointe > 5 Mo'),
  ('user_settings', 'update', '{"theme": "blue"}', '23514', 'thème inconnu'),
  ('user_settings', 'update', '{"week_starts_on": 2}', '23514', 'premier jour de semaine invalide'),
  ('user_settings', 'update', '{"date_format": "DD-MM-YYYY"}', '23514', 'format de date inconnu'),
  ('user_settings', 'update', '{"currency_display": "name"}', '23514', 'affichage de devise inconnu'),
  ('user_settings', 'update', '{"base_currency": "Dirham"}', '23514', 'devise principale mal formée');

do $$
declare
  u uuid := tests.new_user('cons');
  ids jsonb := tests.seed(u);
  c record;
  base jsonb;
  stmt text;
  label text;
begin
  for c in select * from cases order by n loop
    -- ligne de référence : pour transactions, la dépense (pas la ligne de dette)
    execute format('select to_jsonb(x) from public.%I x where user_id = $1 %s limit 1', c.tbl,
      case when c.tbl = 'transactions' then 'and type = ''expense''' else '' end) into base using u;
    if c.mode = 'copy' then
      stmt := format('insert into public.%I select * from jsonb_populate_record(null::public.%I, %L)', c.tbl, c.tbl,
        tests.with_new_pk(format('public.%I', c.tbl)::regclass, base) || c.patch);
    else
      stmt := format('update public.%I x set %s where %s', c.tbl,
        (select string_agg(format('%I = (jsonb_populate_record(null::public.%I, %L)).%I', k, c.tbl, c.patch, k), ', ')
         from jsonb_object_keys(c.patch) k),
        tests.where_pk(format('public.%I', c.tbl)::regclass, base));
    end if;
    label := format('%s — %s', c.tbl, c.label);
    perform tests.as_user(u);
    if c.expect = 'ok' then
      perform tests.lives(stmt, 'ACCEPTÉ : ' || label);
    else
      perform tests.throws(stmt, 'REFUSÉ : ' || label, c.expect);
    end if;
    perform tests.as_admin();
  end loop;
end $$;

-- Restitution exacte des nombres JavaScript (double precision)
do $$
declare
  u uuid := tests.new_user('float');
  ids jsonb := tests.seed(u);
  r double precision;
begin
  update public.exchange_rates set rate = 0.30000000000000004 where id = (ids ->> 'exchange_rates')::uuid;
  select rate into r from public.exchange_rates where id = (ids ->> 'exchange_rates')::uuid;
  perform tests.eq(r::text, '0.30000000000000004', 'taux 0.1 + 0.2 restitué exactement (aucun arrondi décimal)');
  update public.debts set interest_rate = 4.123456789012345 where id = (ids ->> 'debts')::uuid;
  perform tests.eq((select interest_rate::text from public.debts where id = (ids ->> 'debts')::uuid), '4.123456789012345', 'taux d''intérêt restitué exactement');
end $$;
