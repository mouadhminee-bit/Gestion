/**
 * Schéma de validation des sauvegardes : champs essentiels de chaque table et relations.
 *
 * Les types reprennent ceux du domaine (`domain/types.ts`) et du schéma serveur
 * (`cloud/mapping.ts`) : montants en unités mineures entières, dates ISO `AAAA-MM-JJ`,
 * énumérations fermées. Seuls les champs ESSENTIELS sont contrôlés ; les champs libres
 * facultatifs (notes, description…) doivent seulement avoir le bon type s'ils sont présents.
 *
 * Relations :
 *  - `error` : intégrité garantie par l'application (suppression refusée ou en cascade) —
 *    une référence absente signale un fichier corrompu ou modifié : restauration refusée ;
 *  - `warning` : lien historique qui peut légitimement viser une ligne supprimée
 *    (ex. `deleteAccount` ne contrôle que les transactions) : signalé, non bloquant,
 *    la donnée est restaurée telle quelle (jamais réécrite).
 */
import type { BackupTableName } from './format';

export type FieldType =
  | 'id'
  | 'string'
  | 'money'
  | 'int'
  | 'number'
  | 'bool'
  | 'date'
  | 'month'
  | 'currency'
  | 'timestamp'
  | 'stringArray'
  | 'numberArray'
  | { enum: readonly (string | number)[] };

export type Presence = 'required' | 'optional' | 'nullable' | 'optionalNullable';

export interface FieldSpec {
  type: FieldType;
  presence: Presence;
}

const req = (type: FieldType): FieldSpec => ({ type, presence: 'required' });
const opt = (type: FieldType): FieldSpec => ({ type, presence: 'optional' });
const nul = (type: FieldType): FieldSpec => ({ type, presence: 'nullable' });
const optNul = (type: FieldType): FieldSpec => ({ type, presence: 'optionalNullable' });
const oneOf = (...values: (string | number)[]): FieldType => ({ enum: values });

const ENTITY = { createdAt: opt('timestamp'), updatedAt: opt('timestamp') };

export const SETTINGS_FIELDS: Record<string, FieldSpec> = {
  displayName: req('string'),
  baseCurrency: req('currency'),
  language: req('string'), // contrôlé contre la liste des langues (validate.ts)
  locale: req('string'),
  timeZone: req('string'),
  dateFormat: req(oneOf('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD')),
  weekStartsOn: req(oneOf(0, 1)),
  theme: req(oneOf('dark', 'light')),
  currencyDisplay: req(oneOf('symbol', 'code')),
  privacyMode: req('bool'),
  budgetAlertThresholds: req('numberArray'),
  notifyBudgets: req('bool'),
  notifyBills: req('bool'),
  notifyDebts: req('bool'),
  billReminderDays: req('number'),
  onboarded: req('bool'),
  demoMode: req('bool'),
  updatedAt: opt('timestamp'),
};

export const TABLE_FIELDS: Record<Exclude<BackupTableName, 'settings'>, Record<string, FieldSpec>> = {
  accounts: {
    ...ENTITY,
    name: req('string'),
    type: req(oneOf('bank', 'cash', 'savings', 'investment', 'ewallet', 'other')),
    currency: req('currency'),
    initialBalance: req('money'),
    initialBalanceDate: req('date'),
    archived: req('bool'),
    includeInTotal: req('bool'),
    color: req('string'),
    description: opt('string'),
    order: req('number'),
  },
  categories: {
    ...ENTITY,
    name: req('string'),
    kind: req(oneOf('income', 'expense', 'savings')),
    nature: opt(oneOf('fixed', 'variable')),
    parentId: nul('id'),
    icon: req('string'),
    color: req('string'),
    archived: req('bool'),
    order: req('number'),
    key: opt('string'),
  },
  transactions: {
    ...ENTITY,
    type: req(oneOf('expense', 'income', 'transfer', 'refund', 'adjustment', 'debt')),
    direction: req(oneOf('in', 'out')),
    amount: req('money'),
    currency: req('currency'),
    label: req('string'),
    date: req('date'),
    categoryId: nul('id'),
    subcategoryId: nul('id'),
    accountId: req('id'),
    paymentMethod: opt(oneOf('card', 'cash', 'transfer', 'direct_debit', 'check', 'mobile', 'other')),
    payee: opt('string'),
    notes: opt('string'),
    tags: req('stringArray'),
    attachmentId: opt('id'),
    status: req(oneOf('cleared', 'pending')),
    transferId: opt('id'),
    counterpartAccountId: opt('id'),
    refundOfId: opt('id'),
    debtId: opt('id'),
    debtPaymentId: opt('id'),
    interestAmount: opt('money'),
    recurringRuleId: opt('id'),
    recurringDueDate: opt('date'),
    importBatchId: opt('id'),
  },
  budgets: {
    ...ENTITY,
    month: req('month'),
    categoryId: nul('id'),
    amount: req('money'),
    currency: req('currency'),
    alertThresholds: opt('numberArray'),
  },
  goals: {
    ...ENTITY,
    name: req('string'),
    description: opt('string'),
    targetAmount: req('money'),
    currency: req('currency'),
    savedAmount: req('money'),
    targetDate: opt('date'),
    priority: req(oneOf('low', 'medium', 'high')),
    linkedAccountId: opt('id'),
    trackLinkedAccount: req('bool'),
    monthlyContribution: opt('money'),
    status: req(oneOf('active', 'paused', 'achieved', 'archived')),
    icon: req('string'),
    color: req('string'),
  },
  goalContributions: {
    createdAt: opt('timestamp'),
    goalId: req('id'),
    date: req('date'),
    amount: req('money'),
    note: opt('string'),
  },
  recurringRules: {
    ...ENTITY,
    kind: req(oneOf('expense', 'income')),
    label: req('string'),
    amount: req('money'),
    currency: req('currency'),
    accountId: req('id'),
    categoryId: nul('id'),
    subcategoryId: optNul('id'),
    payee: opt('string'),
    frequency: req(oneOf('daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'annual', 'custom')),
    customInterval: opt('number'),
    customUnit: opt(oneOf('day', 'week', 'month', 'year')),
    startDate: req('date'),
    endDate: opt('date'),
    active: req('bool'),
    notes: opt('string'),
  },
  occurrences: {
    updatedAt: opt('timestamp'),
    ruleId: req('id'),
    dueDate: req('date'),
    status: req(oneOf('paid', 'skipped')),
    transactionId: opt('id'),
    closure: opt(oneOf('waived')),
  },
  debts: {
    ...ENTITY,
    label: req('string'),
    type: req(oneOf('personal_debt', 'loan', 'lent', 'borrowed', 'expected_refund', 'other')),
    direction: req(oneOf('payable', 'receivable')),
    principal: req('money'),
    currency: req('currency'),
    startDate: req('date'),
    dueDate: opt('date'),
    counterparty: opt('string'),
    interestRate: opt('number'),
    installmentAmount: opt('money'),
    installmentFrequency: opt(oneOf('monthly', 'quarterly', 'annual')),
    status: req(oneOf('active', 'settled', 'archived')),
    notes: opt('string'),
    originTransactionId: opt('id'),
  },
  debtPayments: {
    createdAt: opt('timestamp'),
    debtId: req('id'),
    date: req('date'),
    principal: req('money'),
    interest: req('money'),
    accountId: opt('id'),
    transactionId: opt('id'),
    note: opt('string'),
  },
  assets: {
    ...ENTITY,
    name: req('string'),
    type: req(oneOf('real_estate', 'vehicle', 'investment', 'valuables', 'other')),
    currency: req('currency'),
    linkedAccountId: opt('id'),
    archived: req('bool'),
    notes: opt('string'),
  },
  valuations: {
    createdAt: opt('timestamp'),
    assetId: req('id'),
    date: req('date'),
    value: req('money'),
    source: req(oneOf('manual')),
    note: opt('string'),
  },
  rates: {
    createdAt: opt('timestamp'),
    base: req('currency'),
    quote: req('currency'),
    rate: req('number'),
    date: req('date'),
    source: req(oneOf('manual')),
  },
  notificationStates: {
    updatedAt: opt('timestamp'),
    read: req('bool'),
    dismissed: req('bool'),
  },
  importBatches: {
    createdAt: opt('timestamp'),
    fileName: req('string'),
    rowCount: req('int'),
    importedCount: req('int'),
    skippedCount: req('int'),
    accountId: req('id'),
  },
  attachments: {
    createdAt: opt('timestamp'),
    name: req('string'),
    mimeType: req('string'),
    size: req('int'),
    data: nul('string'), // base64 ; `null` = fichier non disponible à l'export
  },
};

export type RelationSeverity = 'error' | 'warning';

export interface RelationSpec {
  table: BackupTableName;
  field: string;
  target: BackupTableName;
  severity: RelationSeverity;
}

const rel = (table: BackupTableName, field: string, target: BackupTableName, severity: RelationSeverity): RelationSpec => ({ table, field, target, severity });

export const RELATIONS: readonly RelationSpec[] = [
  // Intégrité garantie par l'application : bloquant.
  rel('categories', 'parentId', 'categories', 'error'),
  rel('transactions', 'accountId', 'accounts', 'error'),
  rel('transactions', 'counterpartAccountId', 'accounts', 'error'),
  rel('transactions', 'categoryId', 'categories', 'error'),
  rel('transactions', 'subcategoryId', 'categories', 'error'),
  rel('budgets', 'categoryId', 'categories', 'error'),
  rel('recurringRules', 'categoryId', 'categories', 'error'),
  rel('goalContributions', 'goalId', 'goals', 'error'),
  rel('occurrences', 'ruleId', 'recurringRules', 'error'),
  rel('debtPayments', 'debtId', 'debts', 'error'),
  rel('valuations', 'assetId', 'assets', 'error'),
  // Liens historiques pouvant viser une ligne supprimée : signalés, non bloquants.
  rel('recurringRules', 'accountId', 'accounts', 'warning'),
  rel('recurringRules', 'subcategoryId', 'categories', 'warning'),
  rel('transactions', 'refundOfId', 'transactions', 'warning'),
  rel('transactions', 'debtId', 'debts', 'warning'),
  rel('transactions', 'debtPaymentId', 'debtPayments', 'warning'),
  rel('transactions', 'recurringRuleId', 'recurringRules', 'warning'),
  rel('transactions', 'importBatchId', 'importBatches', 'warning'),
  rel('transactions', 'attachmentId', 'attachments', 'warning'),
  rel('occurrences', 'transactionId', 'transactions', 'warning'),
  rel('debts', 'originTransactionId', 'transactions', 'warning'),
  rel('debtPayments', 'accountId', 'accounts', 'warning'),
  rel('debtPayments', 'transactionId', 'transactions', 'warning'),
  rel('goals', 'linkedAccountId', 'accounts', 'warning'),
  rel('assets', 'linkedAccountId', 'accounts', 'warning'),
  rel('importBatches', 'accountId', 'accounts', 'warning'),
];
