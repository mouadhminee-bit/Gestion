/**
 * Noms et constantes des tables NEXORA, indépendants du moteur de stockage.
 * (Extraits de `db.ts`, qui les ré-exporte : le schéma Dexie n'est pas modifié.)
 */
import type {
  Account,
  Asset,
  AssetValuation,
  Attachment,
  Budget,
  Category,
  Debt,
  DebtPayment,
  ExchangeRate,
  GoalContribution,
  ImportBatch,
  NotificationState,
  RecurringOccurrence,
  RecurringRule,
  SavingsGoal,
  Transaction,
  User,
  UserSettings,
} from '@/domain/types';

export interface MetaRecord {
  key: string;
  value: unknown;
}

export const SCHEMA_VERSION = 1;

/** Tables contenant des données utilisateur (ordre utilisé pour les sauvegardes). */
export const USER_TABLES = [
  'settings',
  'accounts',
  'categories',
  'transactions',
  'budgets',
  'goals',
  'goalContributions',
  'recurringRules',
  'occurrences',
  'debts',
  'debtPayments',
  'assets',
  'valuations',
  'rates',
  'notificationStates',
  'importBatches',
] as const;

export type UserTableName = (typeof USER_TABLES)[number];

/** Type des lignes de chaque table. */
export interface TableRows {
  meta: MetaRecord;
  users: User;
  settings: UserSettings;
  accounts: Account;
  categories: Category;
  transactions: Transaction;
  attachments: Attachment;
  budgets: Budget;
  goals: SavingsGoal;
  goalContributions: GoalContribution;
  recurringRules: RecurringRule;
  occurrences: RecurringOccurrence;
  debts: Debt;
  debtPayments: DebtPayment;
  assets: Asset;
  valuations: AssetValuation;
  rates: ExchangeRate;
  notificationStates: NotificationState;
  importBatches: ImportBatch;
}

export type TableName = keyof TableRows;

/** Toutes les tables, dans l'ordre de déclaration du schéma Dexie. */
export const ALL_TABLES: readonly TableName[] = [
  'meta',
  'users',
  'settings',
  'accounts',
  'categories',
  'transactions',
  'attachments',
  'budgets',
  'goals',
  'goalContributions',
  'recurringRules',
  'occurrences',
  'debts',
  'debtPayments',
  'assets',
  'valuations',
  'rates',
  'notificationStates',
  'importBatches',
];

/**
 * Clé primaire de chaque table (identique au schéma Dexie v1 de `db.ts`).
 * Une clé composée est une liste de champs (ex. `[userId+id]`).
 */
export const PRIMARY_KEYS: Readonly<Record<TableName, string | readonly string[]>> = {
  meta: 'key',
  users: 'id',
  settings: 'id',
  accounts: 'id',
  categories: 'id',
  transactions: 'id',
  attachments: 'id',
  budgets: 'id',
  goals: 'id',
  goalContributions: 'id',
  recurringRules: 'id',
  occurrences: 'id',
  debts: 'id',
  debtPayments: 'id',
  assets: 'id',
  valuations: 'id',
  rates: 'id',
  notificationStates: ['userId', 'id'],
  importBatches: 'id',
};
