/**
 * Validation des saisies. Les mêmes règles sont appliquées par l'interface ET par la
 * couche d'accès aux données (repository) avant toute écriture.
 */
import { isValidISODate } from './dates';
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

  if (d.amount == null || Number.isNaN(d.amount)) e.amount = 'Saisissez un montant.';
  else if (!Number.isSafeInteger(d.amount)) e.amount = 'Montant invalide.';
  else if (d.amount <= 0) e.amount = 'Le montant doit être supérieur à zéro.';
  else if (d.amount > MAX_AMOUNT) e.amount = 'Montant trop élevé.';

  if (!isValidISODate(d.date)) e.date = 'Date invalide.';

  const account = d.accountId ? ctx.accounts.get(d.accountId) : undefined;
  if (!d.accountId) e.accountId = 'Choisissez un compte.';
  else if (!account) e.accountId = "Ce compte n'existe pas.";
  else if (account.archived && !allowedAccount(account.id)) e.accountId = 'Ce compte est archivé.';

  if (d.type === 'transfer') {
    const to = d.toAccountId ? ctx.accounts.get(d.toAccountId) : undefined;
    if (!d.toAccountId) e.toAccountId = 'Choisissez le compte destination.';
    else if (!to) e.toAccountId = "Ce compte n'existe pas.";
    else if (d.toAccountId === d.accountId) e.toAccountId = 'Les comptes source et destination doivent être différents.';
    else if (to.archived && !allowedAccount(to.id)) e.toAccountId = 'Ce compte est archivé.';
    else if (account && to.currency !== account.currency && !isValidAmount(d.toAmount)) {
      e.toAmount = `Indiquez le montant crédité en ${to.currency} (devises différentes).`;
    }
  }

  if (d.type === 'adjustment') {
    if (!d.direction) e.direction = 'Indiquez le sens de la correction.';
    if (!d.notes?.trim()) e.notes = 'Une justification est obligatoire pour un ajustement.';
  }

  const kind = expectedCategoryKind(d.type);
  if (d.categoryId) {
    const cat = ctx.categories.get(d.categoryId);
    if (!cat) e.categoryId = "Cette catégorie n'existe pas.";
    else if (kind == null) e.categoryId = "Ce type d'opération ne prend pas de catégorie.";
    else if (cat.kind !== kind) e.categoryId = "Cette catégorie n'est pas autorisée pour ce type d'opération.";
    else if (cat.parentId) e.categoryId = 'Choisissez une catégorie principale.';
    else if (cat.archived && !allowedCategory(cat.id)) e.categoryId = 'Cette catégorie est archivée.';
  } else if (d.type === 'expense' || d.type === 'income') {
    e.categoryId = 'Choisissez une catégorie.';
  }
  if (d.subcategoryId) {
    const sub = ctx.categories.get(d.subcategoryId);
    if (!sub || sub.parentId !== d.categoryId) e.subcategoryId = 'Sous-catégorie incohérente avec la catégorie.';
    else if (sub.archived && !allowedCategory(sub.id)) e.subcategoryId = 'Cette sous-catégorie est archivée.';
  }
  if (d.label.length > 140) e.label = 'Libellé trop long (140 caractères max).';
  if ((d.notes ?? '').length > 2000) e.notes = 'Notes trop longues.';
  if (d.tags.some((t) => t.length > 40)) e.tags = 'Étiquette trop longue (40 caractères max).';
  return e;
}

export function hasErrors(e: object): boolean {
  return Object.values(e).some(Boolean);
}
