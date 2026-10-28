/**
 * Base locale IndexedDB (Dexie).
 *
 * Migrations : chaque évolution du schéma ajoute un `db.version(n)` avec, si besoin,
 * une fonction `.upgrade()` qui transforme les données existantes. Les versions
 * précédentes ne doivent jamais être modifiées une fois publiées.
 *
 * Toutes les tables (sauf `meta`) sont indexées par `userId` : chaque requête du
 * repository est filtrée sur l'utilisateur courant.
 */
import Dexie, { type Table } from 'dexie';
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

export class NexoraDB extends Dexie {
  meta!: Table<MetaRecord, string>;
  users!: Table<User, string>;
  settings!: Table<UserSettings, string>;
  accounts!: Table<Account, string>;
  categories!: Table<Category, string>;
  transactions!: Table<Transaction, string>;
  attachments!: Table<Attachment, string>;
  budgets!: Table<Budget, string>;
  goals!: Table<SavingsGoal, string>;
  goalContributions!: Table<GoalContribution, string>;
  recurringRules!: Table<RecurringRule, string>;
  occurrences!: Table<RecurringOccurrence, string>;
  debts!: Table<Debt, string>;
  debtPayments!: Table<DebtPayment, string>;
  assets!: Table<Asset, string>;
  valuations!: Table<AssetValuation, string>;
  rates!: Table<ExchangeRate, string>;
  notificationStates!: Table<NotificationState, [string, string]>;
  importBatches!: Table<ImportBatch, string>;

  constructor(name = 'nexora') {
    super(name);
    this.version(1).stores({
      meta: 'key',
      users: 'id',
      settings: 'id, userId',
      accounts: 'id, userId',
      categories: 'id, userId',
      transactions: 'id, userId, [userId+date], accountId, transferId',
      attachments: 'id, userId',
      budgets: 'id, userId, [userId+month]',
      goals: 'id, userId',
      goalContributions: 'id, userId, goalId',
      recurringRules: 'id, userId',
      occurrences: 'id, userId, ruleId',
      debts: 'id, userId',
      debtPayments: 'id, userId, debtId',
      assets: 'id, userId',
      valuations: 'id, userId, assetId',
      rates: 'id, userId',
      notificationStates: '[userId+id], userId',
      importBatches: 'id, userId',
    });
  }
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

let instance: NexoraDB | null = null;

export function getDB(): NexoraDB {
  if (!instance) instance = new NexoraDB();
  return instance;
}

/** Pour les tests : remplace l'instance courante. */
export function setDB(db: NexoraDB | null) {
  instance = db;
}
