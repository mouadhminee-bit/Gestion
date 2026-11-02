/**
 * Contrat public des repositories NEXORA.
 *
 * Signatures reprises À L'IDENTIQUE des 54 méthodes publiques de `LocalRepository`
 * (avant extraction de `RepositoryCore`). L'interface ne dépend d'aucun mécanisme de
 * stockage : l'UI et les modules ne connaissent que `NexoraRepository`.
 *
 * Toute évolution de ce contrat doit être reflétée dans `REPOSITORY_METHODS` (vérifié
 * par `src/data/contract.test.ts`).
 */
import type {
  Account,
  Asset,
  Attachment,
  Category,
  DataSnapshot,
  Debt,
  DebtPayment,
  ID,
  ImportBatch,
  RecurringRule,
  SavingsGoal,
  Transaction,
  UserSettings,
} from '@/domain/types';
import type { TransactionDraft } from '@/domain/validation';
import type { MonthKey } from '@/domain/dates';
import type { BackupFile } from './backup/format';

/** Données d'une nouvelle entité : le repository fixe `id` (sauf s'il est fourni), `userId` et les horodatages. */
export type NewEntity<T> = Omit<T, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { id?: ID };

/** Fichier de sauvegarde JSON (commun à tous les modes de stockage ; voir `backup/format.ts`). */
export type { BackupFile };

export interface NexoraRepository {
  readonly userId: ID;

  // Initialisation, paramètres, instantané (4)
  ensureUser(displayName?: string): Promise<UserSettings>;
  getSettings(): Promise<UserSettings | undefined>;
  updateSettings(patch: Partial<UserSettings>): Promise<void>;
  snapshot(): Promise<DataSnapshot | null>;

  // Comptes (4)
  createAccount(input: NewEntity<Account>): Promise<Account>;
  updateAccount(id: ID, patch: Partial<Account>): Promise<void>;
  archiveAccount(id: ID, archived?: boolean): Promise<void>;
  deleteAccount(id: ID): Promise<void>;

  // Catégories (5)
  createCategory(input: NewEntity<Category>): Promise<Category>;
  updateCategory(id: ID, patch: Partial<Category>): Promise<void>;
  categoryUsage(id: ID): Promise<number>;
  deleteCategory(id: ID): Promise<void>;
  reorderCategories(orderedIds: ID[]): Promise<void>;

  // Transactions, pièces jointes, import (9)
  createTransaction(d: TransactionDraft, extra?: Partial<Transaction>): Promise<Transaction[]>;
  getTransactionGroup(id: ID): Promise<Transaction[]>;
  updateTransaction(id: ID, d: TransactionDraft): Promise<Transaction[]>;
  deleteTransactions(ids: ID[]): Promise<number>;
  recategorize(ids: ID[], categoryId: ID): Promise<void>;
  addAttachment(transactionId: ID, file: File): Promise<void>;
  getAttachment(id: ID): Promise<Attachment | undefined>;
  removeAttachment(transactionId: ID): Promise<void>;
  importTransactions(batch: Omit<ImportBatch, 'id' | 'userId' | 'createdAt'>, drafts: TransactionDraft[]): Promise<ImportBatch>;

  // Budgets (3)
  setBudget(month: MonthKey, categoryId: ID | null, amount: number, currency: string, options?: { alertThresholds?: number[]; applyToFollowingMonths?: number }): Promise<void>;
  deleteBudget(id: ID): Promise<void>;
  copyBudgets(from: MonthKey, to: MonthKey, overwrite?: boolean): Promise<number>;

  // Objectifs (3)
  saveGoal(input: NewEntity<SavingsGoal> & { id?: ID }): Promise<SavingsGoal>;
  deleteGoal(id: ID): Promise<void>;
  addGoalContribution(goalId: ID, amount: number, date: string, note?: string): Promise<void>;

  // Récurrences (9)
  saveRecurringRule(input: NewEntity<RecurringRule> & { id?: ID }): Promise<RecurringRule>;
  deleteRecurringRule(id: ID): Promise<void>;
  markOccurrencePaid(ruleId: ID, dueDate: string, confirm: { date: string; amount: number; accountId: ID; label?: string }): Promise<Transaction>;
  linkOccurrence(ruleId: ID, dueDate: string, transactionIds: ID | ID[]): Promise<void>;
  unlinkTransaction(transactionId: ID): Promise<void>;
  settleOccurrence(ruleId: ID, dueDate: string): Promise<void>;
  reopenOccurrence(ruleId: ID, dueDate: string): Promise<void>;
  skipOccurrence(ruleId: ID, dueDate: string): Promise<void>;
  resetOccurrence(ruleId: ID, dueDate: string, deleteTransaction: boolean): Promise<void>;

  // Dettes et créances (5)
  createDebt(input: NewEntity<Debt>, origin?: { accountId: ID; date: string }): Promise<Debt>;
  updateDebt(id: ID, patch: Partial<Debt>): Promise<void>;
  deleteDebt(id: ID): Promise<void>;
  addDebtPayment(debtId: ID, p: { date: string; principal: number; interest: number; accountId?: ID; note?: string }): Promise<DebtPayment>;
  deleteDebtPayment(paymentId: ID): Promise<void>;

  // Patrimoine et taux de change (6)
  saveAsset(input: NewEntity<Asset> & { id?: ID }, initialValuation?: { date: string; value: number }): Promise<Asset>;
  deleteAsset(id: ID): Promise<void>;
  addValuation(assetId: ID, date: string, value: number, note?: string): Promise<void>;
  deleteValuation(id: ID): Promise<void>;
  saveRate(base: string, quote: string, rate: number, date: string): Promise<void>;
  deleteRate(id: ID): Promise<void>;

  // Notifications (1)
  setNotificationState(ids: string[], patch: { read?: boolean; dismissed?: boolean }): Promise<void>;

  // Sauvegarde, restauration, réinitialisation (5)
  exportBackup(): Promise<BackupFile>;
  /**
   * Remplace toutes les données de l'utilisateur par celles du fichier (tout format pris
   * en charge). Le fichier est migré et validé intégralement AVANT toute écriture ;
   * l'application est atomique et vérifiée. Lève `BackupValidationError` si refusé.
   */
  restoreBackup(file: unknown): Promise<void>;
  replaceWithSnapshot(s: DataSnapshot): Promise<void>;
  resetToEmpty(keep?: Partial<UserSettings>): Promise<void>;
  clearUserData(): Promise<void>;
}

/** Les 54 méthodes du contrat (ordre de déclaration). */
export const REPOSITORY_METHODS = [
  'ensureUser', 'getSettings', 'updateSettings', 'snapshot',
  'createAccount', 'updateAccount', 'archiveAccount', 'deleteAccount',
  'createCategory', 'updateCategory', 'categoryUsage', 'deleteCategory', 'reorderCategories',
  'createTransaction', 'getTransactionGroup', 'updateTransaction', 'deleteTransactions', 'recategorize',
  'addAttachment', 'getAttachment', 'removeAttachment', 'importTransactions',
  'setBudget', 'deleteBudget', 'copyBudgets',
  'saveGoal', 'deleteGoal', 'addGoalContribution',
  'saveRecurringRule', 'deleteRecurringRule', 'markOccurrencePaid', 'linkOccurrence', 'unlinkTransaction',
  'settleOccurrence', 'reopenOccurrence', 'skipOccurrence', 'resetOccurrence',
  'createDebt', 'updateDebt', 'deleteDebt', 'addDebtPayment', 'deleteDebtPayment',
  'saveAsset', 'deleteAsset', 'addValuation', 'deleteValuation', 'saveRate', 'deleteRate',
  'setNotificationState',
  'exportBackup', 'restoreBackup', 'replaceWithSnapshot', 'resetToEmpty', 'clearUserData',
] as const satisfies readonly (keyof NexoraRepository)[];

/** Vérification de type : chaque clé de méthode du contrat figure dans `REPOSITORY_METHODS`. */
type ContractMethod = Exclude<keyof NexoraRepository, 'userId'>;
type Missing = Exclude<ContractMethod, (typeof REPOSITORY_METHODS)[number]>;
export const _allMethodsListed: [Missing] extends [never] ? true : Missing = true;
