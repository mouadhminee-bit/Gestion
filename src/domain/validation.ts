/**
 * Validation des saisies. Les mêmes règles sont appliquées par l'interface ET par la
 * couche d'accès aux données (repository) avant toute écriture.
 */
import { isValidISODate } from './dates';
import { t } from '@/i18n/core';
import type { Account, Category, Direction, ID, PaymentMethod, TransactionStatus } from './types';

export const MAX_AMOUNT = 1_000_000_000_000_00; // 1 000 milliards (unités minimales à 2 décimales)

export type EditableTransactionType = 'expense' | 'income' | 'transfer' | 'refund' | 'adjustment';

export interface TransactionDraft {
  type: EditableTransactionType;
  amount: number | null;
  /** Pour un ajustement : sens de la correction. */
  direction?: Direction;
  label: string;
  date: string;
  categoryId: ID | null;
  subcategoryId: ID | null;
  accountId: ID | null;
  /** Transfert : compte destination. */
  toAccountId?: ID | null;
  /** Transfert entre devises différentes : montant crédité (devise du compte destination). */
  toAmount?: number | null;
  paymentMethod?: PaymentMethod;
  payee?: string;
  notes?: string;
  tags: string[];
  status: TransactionStatus;
  refundOfId?: ID;
}

export type ValidationErrors = Partial<Record<keyof TransactionDraft | 'form', string>>;

export interface ValidationContext {
  accounts: Map<ID, Account>;
  categories: Map<ID, Category>;
  /** Références déjà utilisées par la transaction modifiée (autorisées même archivées). */
  existing?: { accountIds: ID[]; categoryIds: ID[] };
}

export function isValidAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_AMOUNT;
}

function expectedCategoryKind(type: EditableTransactionType): Category['kind'] | null {
  switch (type) {
    case 'expense':
    case 'refund':
      return 'expense';
    case 'income':
      return 'income';
    case 'transfer':
      return 'savings';
    default:
      return null;
  }
}

export function validateTransactionDraft(d: TransactionDraft, ctx: ValidationContext): ValidationErrors {
  const e: ValidationErrors = {};
  const allowedAccount = (id: ID) => ctx.existing?.accountIds.includes(id);
  const allowedCategory = (id: ID) => ctx.existing?.categoryIds.includes(id);

  if (d.amount == null || Number.isNaN(d.amount)) e.amount = t('err.enterAmount');
  else if (!Number.isSafeInteger(d.amount)) e.amount = t('err.invalidAmount');
  else if (d.amount <= 0) e.amount = t('err.amountPositive');
  else if (d.amount > MAX_AMOUNT) e.amount = t('err.amountTooHigh');

  if (!isValidISODate(d.date)) e.date = t('err.invalidDate');

  const account = d.accountId ? ctx.accounts.get(d.accountId) : undefined;
  if (!d.accountId) e.accountId = t('err.chooseAccount');
  else if (!account) e.accountId = t('err.accountMissing');
  else if (account.archived && !allowedAccount(account.id)) e.accountId = t('err.accountArchived');

  if (d.type === 'transfer') {
    const to = d.toAccountId ? ctx.accounts.get(d.toAccountId) : undefined;
    if (!d.toAccountId) e.toAccountId = t('err.chooseDestination');
    else if (!to) e.toAccountId = t('err.accountMissing');
    else if (d.toAccountId === d.accountId) e.toAccountId = t('err.sameAccounts');
    else if (to.archived && !allowedAccount(to.id)) e.toAccountId = t('err.accountArchived');
    else if (account && to.currency !== account.currency && !isValidAmount(d.toAmount)) {
      e.toAmount = t('err.creditedAmount', { currency: to.currency });
    }
  }

  if (d.type === 'adjustment') {
    if (!d.direction) e.direction = t('err.direction');
    if (!d.notes?.trim()) e.notes = t('err.justification');
  }

  const kind = expectedCategoryKind(d.type);
  if (d.categoryId) {
    const cat = ctx.categories.get(d.categoryId);
    if (!cat) e.categoryId = t('err.categoryMissing');
    else if (kind == null) e.categoryId = t('err.noCategoryForType');
    else if (cat.kind !== kind) e.categoryId = t('err.categoryNotAllowed');
    else if (cat.parentId) e.categoryId = t('err.choosePrimaryCategory');
    else if (cat.archived && !allowedCategory(cat.id)) e.categoryId = t('err.categoryArchived');
  } else if (d.type === 'expense' || d.type === 'income') {
    e.categoryId = t('err.chooseCategory');
  }
  if (d.subcategoryId) {
    const sub = ctx.categories.get(d.subcategoryId);
    if (!sub || sub.parentId !== d.categoryId) e.subcategoryId = t('err.subcategoryMismatch');
    else if (sub.archived && !allowedCategory(sub.id)) e.subcategoryId = t('err.subcategoryArchived');
  }
  if (d.label.length > 140) e.label = t('err.labelTooLong');
  if ((d.notes ?? '').length > 2000) e.notes = t('err.notesTooLong');
  if (d.tags.some((t) => t.length > 40)) e.tags = t('err.tagTooLong');
  return e;
}

export function hasErrors(e: object): boolean {
  return Object.values(e).some(Boolean);
}
