/** Exports CSV (séparateur « ; », BOM UTF-8 : ouverture directe dans Excel). */
import type { Account, Budget, Category, DataSnapshot, Transaction } from '@/domain/types';
import { TRANSACTION_TYPE_LABELS, ACCOUNT_TYPE_LABELS, PAYMENT_METHOD_LABELS } from '@/domain/types';
import { toPlainString } from '@/domain/money';
import { downloadText, toCSV } from '@/domain/csv';
import { accountBalance } from '@/domain/calc/ledger';

export function transactionsCSV(list: Transaction[], categories: Map<string, Category>, accounts: Map<string, Account>): string {
  const header = ['Date', 'Type', 'Libellé', 'Montant', 'Devise', 'Sens', 'Catégorie', 'Sous-catégorie', 'Compte', 'Compte de contrepartie', 'Bénéficiaire', 'Mode de paiement', 'Étiquettes', 'Statut', 'Notes', 'Identifiant'];
  const rows = list.map((t) => [
    t.date,
    TRANSACTION_TYPE_LABELS[t.type],
    t.label,
    toPlainString(t.direction === 'in' ? t.amount : -t.amount, t.currency, ','),
    t.currency,
    t.direction === 'in' ? 'Entrée' : 'Sortie',
    t.categoryId ? categories.get(t.categoryId)?.name ?? '' : '',
    t.subcategoryId ? categories.get(t.subcategoryId)?.name ?? '' : '',
    accounts.get(t.accountId)?.name ?? '',
    t.counterpartAccountId ? accounts.get(t.counterpartAccountId)?.name ?? '' : '',
    t.payee ?? '',
    t.paymentMethod ? PAYMENT_METHOD_LABELS[t.paymentMethod] : '',
    t.tags.join(', '),
    t.status === 'pending' ? 'En attente' : 'Effectuée',
    t.notes ?? '',
    t.id,
  ]);
  return toCSV([header, ...rows]);
}

export function accountsCSV(data: DataSnapshot, asOf: string): string {
  const header = ['Nom', 'Type', 'Devise', 'Solde initial', 'Date du solde initial', 'Solde au ' + asOf, 'Statut', 'Inclus dans le total'];
  return toCSV([
    header,
    ...data.accounts.map((a) => [a.name, ACCOUNT_TYPE_LABELS[a.type], a.currency, toPlainString(a.initialBalance, a.currency, ','), a.initialBalanceDate, toPlainString(accountBalance(a, data.transactions, asOf), a.currency, ','), a.archived ? 'Archivé' : 'Actif', a.includeInTotal ? 'Oui' : 'Non']),
  ]);
}

export function budgetsCSV(budgets: Budget[], categories: Map<string, Category>): string {
  return toCSV([
    ['Mois', 'Catégorie', 'Montant', 'Devise'],
    ...[...budgets].sort((a, b) => a.month.localeCompare(b.month)).map((b) => [b.month, b.categoryId ? categories.get(b.categoryId)?.name ?? '' : 'Budget global', toPlainString(b.amount, b.currency, ','), b.currency]),
  ]);
}

export function download(name: string, csv: string) {
  downloadText(name, csv);
}
