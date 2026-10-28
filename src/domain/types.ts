/**
 * Modèle de données NEXORA.
 *
 * Conventions :
 *  - `id` : identifiant stable (UUID v4 généré côté client).
 *  - `userId` : propriétaire de la donnée (isolation multi-utilisateurs).
 *  - `createdAt` / `updatedAt` : horodatages ISO 8601.
 *  - montants : entiers en unités minimales de la devise (voir money.ts).
 *  - dates métier : "AAAA-MM-JJ" (voir dates.ts).
 *  - archivage plutôt que suppression pour les entités référencées par l'historique.
 */
import type { CurrencyCode } from './money';
import type { DateFormat, ISODate, MonthKey } from './dates';

export type ID = string;

export interface Entity {
  id: ID;
  userId: ID;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Utilisateur & paramètres
// ---------------------------------------------------------------------------

export interface User {
  id: ID;
  displayName: string;
  email?: string;
  createdAt: string;
}

export type ThemeMode = 'dark' | 'light';
export type CurrencyDisplay = 'symbol' | 'code';

export interface UserSettings {
  id: ID; // = userId
  userId: ID;
  displayName: string;
  baseCurrency: CurrencyCode;
  language: 'fr' | 'en';
  locale: string; // ex: fr-MA
  timeZone: string; // ex: Africa/Casablanca
  dateFormat: DateFormat;
  weekStartsOn: 1 | 0; // 1 = lundi
  theme: ThemeMode;
  currencyDisplay: CurrencyDisplay;
  privacyMode: boolean;
  /** Seuils d'alerte budgétaire par défaut, en % (ex: [50, 75, 90, 100]). */
  budgetAlertThresholds: number[];
  notifyBudgets: boolean;
  notifyBills: boolean;
  notifyDebts: boolean;
  /** Nombre de jours d'anticipation pour les échéances à venir. */
  billReminderDays: number;
  onboarded: boolean;
  demoMode: boolean;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Comptes
// ---------------------------------------------------------------------------

export type AccountType = 'bank' | 'cash' | 'savings' | 'investment' | 'ewallet' | 'other';

export interface Account extends Entity {
  name: string;
  type: AccountType;
  currency: CurrencyCode;
  initialBalance: number;
  initialBalanceDate: ISODate;
  archived: boolean;
  /** Inclus dans le « solde total » du dashboard. */
  includeInTotal: boolean;
  color: string;
  description?: string;
  order: number;
}

// ---------------------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------------------

/**
 * - income : revenus
 * - expense : dépenses de consommation
 * - savings : affectations d'épargne / investissement (annotent des transferts,
 *   ne sont JAMAIS comptées comme dépenses de consommation)
 */
export type CategoryKind = 'income' | 'expense' | 'savings';
/** Pour les dépenses : charges fixes ou variables. */
export type ExpenseNature = 'fixed' | 'variable';

export interface Category extends Entity {
  name: string;
  kind: CategoryKind;
  nature?: ExpenseNature;
  parentId: ID | null;
  icon: string;
  color: string;
  archived: boolean;
  order: number;
  /** Clé stable des catégories initiales (ex: "food"), utile aux règles et au jeu de démo. */
  key?: string;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * - expense : dépense de consommation (sortie)
 * - income : revenu (entrée)
 * - transfer : mouvement interne entre deux comptes de l'utilisateur (2 jambes liées)
 * - refund : remboursement REÇU d'une dépense (entrée) — réduit les dépenses de sa catégorie
 * - adjustment : correction de solde justifiée (entrée ou sortie), hors revenus/dépenses
 * - debt : mouvement lié à une dette/créance (emprunt reçu, prêt accordé, remboursement).
 *          Seule la part d'intérêts est comptée en dépense (dette) ou en revenu (créance).
 */
export type TransactionType = 'expense' | 'income' | 'transfer' | 'refund' | 'adjustment' | 'debt';
export type Direction = 'in' | 'out';
export type TransactionStatus = 'cleared' | 'pending';
export type PaymentMethod = 'card' | 'cash' | 'transfer' | 'direct_debit' | 'check' | 'mobile' | 'other';

export interface Transaction extends Entity {
  type: TransactionType;
  direction: Direction;
  /** Montant strictement positif, en unités minimales de `currency`. */
  amount: number;
  /** Devise de la transaction = devise du compte. */
  currency: CurrencyCode;
  label: string;
  date: ISODate;
  categoryId: ID | null;
  subcategoryId: ID | null;
  accountId: ID;
  paymentMethod?: PaymentMethod;
  payee?: string;
  notes?: string;
  tags: string[];
  attachmentId?: ID;
  status: TransactionStatus;
  // Transfert : identifiant commun aux deux jambes + compte de contrepartie
  transferId?: ID;
  counterpartAccountId?: ID;
  // Remboursement reçu : dépense d'origine (facultatif)
  refundOfId?: ID;
  // Dette : engagement concerné + part d'intérêts (≤ amount)
  debtId?: ID;
  debtPaymentId?: ID;
  interestAmount?: number;
  // Paiement récurrent ayant généré / confirmé cette transaction
  recurringRuleId?: ID;
  recurringDueDate?: ISODate;
  // Import CSV
  importBatchId?: ID;
}

export interface Attachment {
  id: ID;
  userId: ID;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface Budget extends Entity {
  month: MonthKey;
  /** null = budget mensuel global */
  categoryId: ID | null;
  amount: number;
  currency: CurrencyCode;
  /** Seuils spécifiques (sinon ceux des paramètres). */
  alertThresholds?: number[];
}

// ---------------------------------------------------------------------------
// Objectifs d'épargne
// ---------------------------------------------------------------------------

export type GoalPriority = 'low' | 'medium' | 'high';
export type GoalStatus = 'active' | 'paused' | 'achieved' | 'archived';

export interface SavingsGoal extends Entity {
  name: string;
  description?: string;
  targetAmount: number;
  currency: CurrencyCode;
  /**
   * Montant constitué saisi manuellement (affectation). Ignoré si `trackLinkedAccount`
   * est vrai : la progression reflète alors le solde du compte associé.
   */
  savedAmount: number;
  targetDate?: ISODate;
  priority: GoalPriority;
  linkedAccountId?: ID;
  trackLinkedAccount: boolean;
  monthlyContribution?: number;
  status: GoalStatus;
  icon: string;
  color: string;
}

export interface GoalContribution {
  id: ID;
  userId: ID;
  goalId: ID;
  date: ISODate;
  amount: number; // peut être négatif (retrait d'affectation)
  note?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Paiements récurrents
// ---------------------------------------------------------------------------

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'custom';
export type CustomUnit = 'day' | 'week' | 'month' | 'year';

export interface RecurringRule extends Entity {
  kind: 'expense' | 'income';
  label: string;
  amount: number;
  currency: CurrencyCode;
  accountId: ID;
  categoryId: ID | null;
  subcategoryId?: ID | null;
  payee?: string;
  frequency: Frequency;
  customInterval?: number;
  customUnit?: CustomUnit;
  startDate: ISODate;
  endDate?: ISODate;
  active: boolean;
  notes?: string;
}

export type OccurrenceStatus = 'paid' | 'skipped';

/** État d'une échéance (seules les échéances traitées sont stockées). */
export interface RecurringOccurrence {
  id: ID; // `${ruleId}:${dueDate}`
  userId: ID;
  ruleId: ID;
  dueDate: ISODate;
  status: OccurrenceStatus;
  transactionId?: ID;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Dettes et créances
// ---------------------------------------------------------------------------

/**
 * - payable : je dois de l'argent (passif) — crédit, dette personnelle, emprunt à un proche
 * - receivable : on me doit de l'argent (actif) — prêt accordé, remboursement attendu
 */
export type DebtDirection = 'payable' | 'receivable';
export type DebtType = 'personal_debt' | 'loan' | 'lent' | 'borrowed' | 'expected_refund' | 'other';
export type DebtStatus = 'active' | 'settled' | 'archived';

export interface Debt extends Entity {
  label: string;
  type: DebtType;
  direction: DebtDirection;
  principal: number;
  currency: CurrencyCode;
  startDate: ISODate;
  dueDate?: ISODate;
  counterparty?: string;
  interestRate?: number; // % annuel (informatif)
  installmentAmount?: number;
  installmentFrequency?: 'monthly' | 'quarterly' | 'annual';
  status: DebtStatus;
  notes?: string;
  /** Transaction ayant matérialisé le décaissement / l'encaissement initial. */
  originTransactionId?: ID;
}

export interface DebtPayment {
  id: ID;
  userId: ID;
  debtId: ID;
  date: ISODate;
  principal: number;
  interest: number;
  accountId?: ID;
  transactionId?: ID;
  note?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Patrimoine
// ---------------------------------------------------------------------------

export type AssetType = 'real_estate' | 'vehicle' | 'investment' | 'valuables' | 'other';

/**
 * Actif hors comptes (immobilier, véhicule...) ou valorisation de marché
 * d'un compte d'investissement (`linkedAccountId`). Dans ce dernier cas, la
 * valeur estimée REMPLACE le solde comptable du compte dans le patrimoine
 * (jamais les deux, pour éviter le double comptage).
 */
export interface Asset extends Entity {
  name: string;
  type: AssetType;
  currency: CurrencyCode;
  linkedAccountId?: ID;
  archived: boolean;
  notes?: string;
}

export interface AssetValuation {
  id: ID;
  userId: ID;
  assetId: ID;
  date: ISODate;
  value: number;
  source: 'manual';
  note?: string;
  createdAt: string;
}

/** Taux : 1 `base` = `rate` `quote`. */
export interface ExchangeRate {
  id: ID;
  userId: ID;
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: number;
  date: ISODate;
  source: 'manual';
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'danger';

/**
 * Les notifications sont calculées à partir des données ; seul leur état (lu /
 * masqué) est persisté, avec une clé déterministe pour éviter les répétitions.
 */
export interface NotificationState {
  id: string; // clé déterministe, ex: budget:<catId>:2026-10:90
  userId: ID;
  read: boolean;
  dismissed: boolean;
  updatedAt: string;
}

export interface ImportBatch {
  id: ID;
  userId: ID;
  fileName: string;
  createdAt: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  accountId: ID;
}

/** Instantané complet des données d'un utilisateur (sauvegarde / calculs). */
export interface DataSnapshot {
  settings: UserSettings;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  budgets: Budget[];
  goals: SavingsGoal[];
  goalContributions: GoalContribution[];
  recurringRules: RecurringRule[];
  occurrences: RecurringOccurrence[];
  debts: Debt[];
  debtPayments: DebtPayment[];
  assets: Asset[];
  valuations: AssetValuation[];
  rates: ExchangeRate[];
  notificationStates: NotificationState[];
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  bank: 'Compte bancaire',
  cash: 'Espèces',
  savings: "Compte d'épargne",
  investment: "Portefeuille d'investissement",
  ewallet: 'Paiement électronique',
  other: 'Autre compte',
};

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  expense: 'Dépense',
  income: 'Revenu',
  transfer: 'Transfert',
  refund: 'Remboursement reçu',
  adjustment: 'Ajustement de solde',
  debt: 'Dette / prêt',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  card: 'Carte bancaire',
  cash: 'Espèces',
  transfer: 'Virement',
  direct_debit: 'Prélèvement',
  check: 'Chèque',
  mobile: 'Paiement mobile',
  other: 'Autre',
};

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: 'Quotidienne',
  weekly: 'Hebdomadaire',
  monthly: 'Mensuelle',
  quarterly: 'Trimestrielle',
  semiannual: 'Semestrielle',
  annual: 'Annuelle',
  custom: 'Personnalisée',
};

export const DEBT_TYPE_LABELS: Record<DebtType, string> = {
  personal_debt: 'Dette personnelle',
  loan: 'Crédit',
  lent: 'Somme prêtée',
  borrowed: 'Somme empruntée',
  expected_refund: 'Remboursement attendu',
  other: 'Autre engagement',
};

export const DEBT_TYPE_DIRECTION: Record<DebtType, DebtDirection> = {
  personal_debt: 'payable',
  loan: 'payable',
  borrowed: 'payable',
  lent: 'receivable',
  expected_refund: 'receivable',
  other: 'payable',
};

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  real_estate: 'Immobilier',
  vehicle: 'Véhicule',
  investment: 'Investissement',
  valuables: 'Objets de valeur',
  other: 'Autre actif',
};
