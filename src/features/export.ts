/** Exports CSV (séparateur « ; », BOM UTF-8 : ouverture directe dans Excel). */
import type { Account, Budget, Category, DataSnapshot, Transaction } from '@/domain/types';
import { TRANSACTION_TYPE_LABELS, ACCOUNT_TYPE_LABELS, PAYMENT_METHOD_LABELS } from '@/domain/types';
import { toPlainString } from '@/domain/money';
import { downloadText, toCSV } from '@/domain/csv';
import { accountBalance } from '@/domain/calc/ledger';
import { t, t as tr } from '@/i18n/core';

export function transactionsCSV(list: Transaction[], categories: Map<string, Category>, accounts: Map<string, Account>): string {
  const header = [t('csv.date'), t('csv.type'), t('csv.label'), t('csv.amount'), t('csv.currency'), t('csv.direction'), t('csv.category'), t('csv.subcategory'), t('csv.account'), t('csv.counterpart'), t('csv.payee'), t('csv.paymentMethod'), t('csv.tags'), t('csv.status'), t('csv.notes'), t('csv.id')];
  const rows = list.map((t) => [
    t.date,
    TRANSACTION_TYPE_LABELS[t.type],
    t.label,
    toPlainString(t.direction === 'in' ? t.amount : -t.amount, t.currency, ','),
    t.currency,
    t.direction === 'in' ? tr('csv.in') : tr('csv.out'),
    t.categoryId ? categories.get(t.categoryId)?.name ?? '' : '',
    t.subcategoryId ? categories.get(t.subcategoryId)?.name ?? '' : '',
    accounts.get(t.accountId)?.name ?? '',
    t.counterpartAccountId ? accounts.get(t.counterpartAccountId)?.name ?? '' : '',
    t.payee ?? '',
    t.paymentMethod ? PAYMENT_METHOD_LABELS[t.paymentMethod] : '',
    t.tags.join(', '),
    t.status === 'pending' ? tr('csv.pending') : tr('csv.cleared'),
    t.notes ?? '',
    t.id,
  ]);
  return toCSV([header, ...rows]);
}

export function accountsCSV(data: DataSnapshot, asOf: string): string {
  const header = [t('csv.name'), t('csv.type'), t('csv.currency'), t('csv.initialBalance'), t('csv.initialDate'), t('csv.balanceAt', { date: asOf }), t('csv.status'), t('csv.includeInTotal')];
  return toCSV([
    header,
    ...data.accounts.map((a) => [a.name, ACCOUNT_TYPE_LABELS[a.type], a.currency, toPlainString(a.initialBalance, a.currency, ','), a.initialBalanceDate, toPlainString(accountBalance(a, data.transactions, asOf), a.currency, ','), a.archived ? t('csv.archived') : t('csv.active'), a.includeInTotal ? t('csv.yes') : t('csv.no')]),
  ]);
}

export function budgetsCSV(budgets: Budget[], categories: Map<string, Category>): string {
  return toCSV([
    [t('csv.month'), t('csv.category'), t('csv.amount'), t('csv.currency')],
    ...[...budgets].sort((a, b) => a.month.localeCompare(b.month)).map((b) => [b.month, b.categoryId ? categories.get(b.categoryId)?.name ?? '' : t('csv.globalBudget'), toPlainString(b.amount, b.currency, ','), b.currency]),
  ]);
}

export function download(name: string, csv: string) {
  downloadText(name, csv);
}
