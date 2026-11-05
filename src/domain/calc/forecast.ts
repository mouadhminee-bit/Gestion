/**
 * Prévisions de fin de mois — méthode explicable, jamais présentée comme certaine.
 *
 * Solde estimé fin de mois =
 *     Solde actuel (comptes du périmètre)
 *   + Revenus récurrents attendus   (échéances non payées du mois, en retard incluses)
 *   − Dépenses récurrentes attendues (idem)
 *   − Dépenses variables projetées
 *
 * Dépenses variables projetées (par ordre de priorité) :
 *  1. « history » : moyenne quotidienne observée des dépenses variables (hors charges
 *     fixes et hors transactions issues d'un paiement récurrent) sur les 90 derniers
 *     jours, × jours restants. Requiert ≥ 30 jours d'historique et ≥ 10 dépenses.
 *  2. « month » : historique insuffisant — rythme observé ce mois-ci (dépenses variables
 *     du mois ÷ jours écoulés × jours restants), dès MIN_PACE_DAYS jours écoulés et
 *     MIN_MONTH_TRANSACTIONS dépenses variables.
 *  3. « insufficient » : aucune dépense variable projetée. La projection n'est alors qu'un
 *     MINIMUM (réalisé + échéances connues) : `projectionStatus = 'minimum'`. Le reste des
 *     budgets n'est jamais projeté comme une dépense certaine.
 * Le dernier jour du mois, il ne reste rien à projeter : la projection est complète.
 *
 * Statut 'no-data' : aucune donnée de dépense (aucune dépense ni remboursement ce mois-ci ou
 * dans la fenêtre historique, aucune échéance de dépense attendue). Il n'y a alors ni minimum
 * engagé ni rythme à projeter : la projection n'est ni complète ni minimum. Ce statut repose
 * sur l'existence des opérations, jamais sur le montant (une dépense compensée par un
 * remboursement reste une donnée). Les montants projetés ne changent pas.
 *
 * Les échéances déjà payées sont des transactions réelles : elles sont dans le solde
 * actuel et ne sont pas recomptées (voir recurring.listOccurrences / matching).
 */
import type { ISODate, MonthKey } from '../dates';
import { addDays, diffDays, monthEnd, monthKey, monthPeriod, maxDate } from '../dates';
import { formatMoney, roundHalfAwayFromZero } from '../money';
import type { DataSnapshot, ID } from '../types';
import type { LedgerContext, PeriodSummary } from './ledger';
import { accountsInScope, flowOf, summarizePeriod, topCategoryId, totalBalance } from './ledger';
import type { OccurrenceView } from './recurring';
import { listOccurrences, pendingOccurrences } from './recurring';
import type { BudgetScope } from './budgets';
import { budgetScope, MIN_PACE_DAYS, monthBudgetOverview } from './budgets';
import { t } from '@/i18n/core';

export type VariableMethod = 'history' | 'month' | 'insufficient';
/**
 * 'complete' : rien ne manque (rythme exploitable, ou plus aucun jour à projeter).
 * 'minimum'  : des dépenses existent mais le rythme n'est pas exploitable — réalisé + échéances connues.
 * 'no-data'  : aucune donnée de dépense — aucune projection de dépenses possible.
 */
export type ProjectionStatus = 'complete' | 'minimum' | 'no-data';

export interface MonthForecast {
  month: MonthKey;
  today: ISODate;
  remainingDays: number;
  currentBalance: number;
  recordedIncome: number;
  recordedExpenses: number;
  expectedRecurringIncome: number;
  expectedRecurringExpenses: number;
  pending: OccurrenceView[];
  variableMethod: VariableMethod;
  variableDailyAverage: number | null;
  variableHistoryDays: number;
  variableProjected: number;
  /** Méthode « month » : jours écoulés et dépenses variables observés ce mois-ci. */
  variableMonthDays: number;
  variableMonthCount: number;
  /** Dépenses atypiques exclues du rythme retenu (comptées dans le réalisé, non extrapolées). */
  atypical: AtypicalExpense[];
  /** Dépenses atypiques du mois en cours (non extrapolées dans les lignes de budget). */
  monthAtypical: AtypicalExpense[];
  /** Montant atypique du mois par catégorie (1er niveau et sous-catégorie), pour les lignes de budget. */
  atypicalByCategory: Map<ID | null, number>;
  /**
   * 'minimum' : dépenses variables non projetées faute de données (réalisé + échéances connues).
   * 'no-data' : aucune donnée de dépense (voir `ProjectionStatus`).
   */
  projectionStatus: ProjectionStatus;
  projectedIncome: number;
  projectedExpenses: number;
  projectedSavings: number;
  projectedEndBalance: number;
  /** Budget de référence et dépassement projeté (null si aucun budget). */
  budgetReference: number | null;
  /**
   * Base de comparaison au budget : 'global' = dépenses totales projetées vs budget global ;
   * 'categories' = Σ projections des catégories budgétées vs Σ de leurs budgets (hors budget exclu).
   */
  budgetBasis: 'global' | 'categories' | null;
  /** Dépenses projetées sur cette base. */
  budgetProjectedSpent: number | null;
  /** Périmètre budgétaire du mois (même règle que Budgets), pour le simulateur. */
  budgetScope: BudgetScope | null;
  projectedBudgetOverrun: number | null;
  /** Statut de `budgetProjectedSpent` (même base que le budget ; 'no-data' suit `projectionStatus`). */
  budgetProjectionStatus: ProjectionStatus | null;
  /** Dépenses hors budget enregistrées ce mois-ci (exclues de la base « catégories »). */
  unbudgetedRecorded: number;
  /** Dépenses récurrentes attendues par catégorie de 1er niveau. */
  committedByCategory: Map<ID | null, number>;
  assumptions: string[];
  summary: PeriodSummary;
}

export const HISTORY_WINDOW_DAYS = 90;
export const MIN_HISTORY_DAYS = 30;
export const MIN_HISTORY_TRANSACTIONS = 10;
export const MIN_MONTH_TRANSACTIONS = 3;

/** Facteur au-delà duquel une dépense est hors norme par rapport à la médiane observée. */
export const ATYPICAL_FACTOR = 3;
/** Recherche d'une dépense comparable (même catégorie) avant la fenêtre observée. */
export const COMPARABLE_LOOKBACK_DAYS = 180;
/** Part du montant à partir de laquelle une dépense passée est jugée comparable. */
export const COMPARABLE_SHARE = 0.5;

export interface AtypicalExpense {
  id: ID;
  /** Devise de base. */
  amount: number;
  categoryId: ID | null;
  subcategoryId: ID | null;
}

export interface VariableAverage {
  dailyAverage: number | null;
  days: number;
  /** Dépenses habituelles prises en compte (hors atypiques). */
  count: number;
  /** Dépenses atypiques exclues du rythme : comptées dans le réalisé, jamais extrapolées. */
  atypical: AtypicalExpense[];
}

/**
 * Dépenses variables : hors charges fixes et hors charges récurrentes identifiées (paiements
 * associés à une échéance, ou détectés par le rapprochement : `recurringIds`).
 */
function variableTransactions(ctx: LedgerContext, transactions: DataSnapshot['transactions'], recurringIds: Set<ID>) {
  return transactions.filter((t) => {
    if (t.type !== 'expense' && t.type !== 'refund') return false;
    if (t.recurringRuleId || recurringIds.has(t.id)) return false;
    const top = topCategoryId(ctx, t.categoryId);
    return !(top && ctx.categories.get(top)?.nature === 'fixed');
  });
}

const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Rythme des dépenses variables sur [from, to], dépenses atypiques exclues.
 * Atypique = montant > ATYPICAL_FACTOR × médiane des AUTRES dépenses variables de la fenêtre
 * (au moins 2 points de comparaison) ET opération isolée : aucune dépense comparable (même
 * catégorie de 1er niveau, ≥ COMPARABLE_SHARE du montant) dans la fenêtre ni dans les
 * COMPARABLE_LOOKBACK_DAYS jours qui la précèdent. Une dépense habituelle n'est jamais atypique.
 * Le rythme n'est exploitable qu'avec `minDays` jours et `minCount` dépenses habituelles.
 */
function variablePace(ctx: LedgerContext, transactions: DataSnapshot['transactions'], recurringIds: Set<ID>, from: ISODate, to: ISODate, minDays: number, minCount: number): VariableAverage {
  const variable = variableTransactions(ctx, transactions, recurringIds);
  const lookback = addDays(from, -COMPARABLE_LOOKBACK_DAYS);
  const days = to < from ? 0 : diffDays(to, from) + 1;
  const inWindow = variable
    .filter((t) => t.date >= from && t.date <= to)
    .map((t) => ({ t, v: ctx.convert(t.amount, t.currency, t.date) }))
    .filter((x): x is { t: (typeof variable)[number]; v: number } => x.v != null);
  const expenses = inWindow.filter((x) => x.t.type === 'expense');
  const atypical: AtypicalExpense[] = [];
  for (const e of expenses) {
    const others = expenses.filter((o) => o !== e).map((o) => o.v);
    if (others.length < 2 || e.v <= ATYPICAL_FACTOR * median(others)) continue;
    const top = topCategoryId(ctx, e.t.categoryId);
    const comparable = variable.some((o) => {
      if (o.id === e.t.id || o.type !== 'expense' || o.date < lookback || o.date > to) return false;
      if (topCategoryId(ctx, o.categoryId) !== top) return false;
      const ov = ctx.convert(o.amount, o.currency, o.date);
      return ov != null && ov >= COMPARABLE_SHARE * e.v;
    });
    if (!comparable) atypical.push({ id: e.t.id, amount: e.v, categoryId: e.t.categoryId, subcategoryId: e.t.subcategoryId });
  }
  const excluded = new Set(atypical.map((x) => x.id));
  let total = 0;
  let count = 0;
  for (const { t, v } of inWindow) {
    if (excluded.has(t.id)) continue;
    total += t.type === 'expense' ? v : -v;
    if (t.type === 'expense') count += 1;
  }
  if (days < minDays || count < minCount) return { dailyAverage: null, days, count, atypical };
  return { dailyAverage: Math.max(0, total / days), days, count, atypical };
}

/**
 * Rythme du mois en cours : dépenses variables habituelles du 1er au jour inclus ÷ jours écoulés.
 * Non exploitable (null) avant MIN_PACE_DAYS jours écoulés ou MIN_MONTH_TRANSACTIONS dépenses.
 */
export function monthVariablePace(ctx: LedgerContext, data: Pick<DataSnapshot, 'transactions'>, today: ISODate, recurringIds: Set<ID> = new Set()): VariableAverage {
  const month = monthKey(today);
  return variablePace(ctx, data.transactions, recurringIds, monthPeriod(month).start, today, MIN_PACE_DAYS, MIN_MONTH_TRANSACTIONS);
}

/** Moyenne quotidienne des dépenses variables habituelles observées avant `today` (exclu). */
export function variableDailyAverage(ctx: LedgerContext, data: Pick<DataSnapshot, 'transactions'>, today: ISODate, recurringIds: Set<ID> = new Set()): VariableAverage {
  const windowEnd = addDays(today, -1);
  const firstDate = variableTransactions(ctx, data.transactions, recurringIds).reduce<ISODate | null>((min, t) => (min == null || t.date < min ? t.date : min), null);
  if (!firstDate || firstDate > windowEnd) return { dailyAverage: null, days: 0, count: 0, atypical: [] };
  const windowStart = maxDate(addDays(today, -HISTORY_WINDOW_DAYS), firstDate);
  return variablePace(ctx, data.transactions, recurringIds, windowStart, windowEnd, MIN_HISTORY_DAYS, MIN_HISTORY_TRANSACTIONS);
}

/**
 * Existe-t-il au moins une donnée de dépense exploitable par la projection ?
 *  - une dépense ou un remboursement (y compris intérêts de dette) dans le mois, ou dans la
 *    fenêtre historique [historyStart, today] ;
 *  - une échéance de dépense attendue (non payée) ce mois-ci.
 * Fondé sur l'existence des opérations, pas sur leur montant : une dépense compensée par un
 * remboursement (net nul) reste une donnée.
 */
export function hasExpenseData(
  transactions: DataSnapshot['transactions'],
  period: { start: ISODate; end: ISODate },
  historyStart: ISODate,
  today: ISODate,
  pending: OccurrenceView[],
): boolean {
  if (pending.some((o) => o.rule.kind === 'expense')) return true;
  return transactions.some((t) => {
    const kind = flowOf(t).kind;
    if (kind !== 'expense' && kind !== 'refund') return false;
    return (t.date >= period.start && t.date <= period.end) || (t.date >= historyStart && t.date <= today);
  });
}

export function forecastMonth(ctx: LedgerContext, data: DataSnapshot, today: ISODate): MonthForecast {
  const month = monthKey(today);
  const period = monthPeriod(month);
  const end = monthEnd(month);
  const remainingDays = Math.max(0, diffDays(end, today));
  const scope = accountsInScope(data.accounts);
  const current = totalBalance(ctx, scope, data.transactions, today);
  const summary = summarizePeriod(ctx, data.transactions, period);
  const scopeIds = new Set(scope.map((a) => a.id));

  const occ = listOccurrences(data.recurringRules, data.occurrences, data.transactions, period, today, { convert: ctx.convert });
  const pending = pendingOccurrences(occ);
  let expectedIncome = 0;
  let expectedExpenses = 0;
  let expectedIncomeOutOfScope = 0;
  let expectedExpensesOutOfScope = 0;
  const committedByCategory = new Map<ID | null, number>();
  for (const o of pending) {
    // Paiement partiel : seul le reliquat reste attendu (la partie payée est déjà dans le réel).
    const v = ctx.convert(o.remaining, o.rule.currency, o.dueDate) ?? 0;
    const inScope = scopeIds.has(o.rule.accountId);
    if (o.rule.kind === 'income') {
      expectedIncome += v;
      if (!inScope) expectedIncomeOutOfScope += v;
    } else {
      expectedExpenses += v;
      if (!inScope) expectedExpensesOutOfScope += v;
      const top = topCategoryId(ctx, o.rule.categoryId);
      committedByCategory.set(top, (committedByCategory.get(top) ?? 0) + v);
    }
  }

  const assumptions: string[] = [];
  // Charges récurrentes identifiées par le rapprochement (fenêtre historique incluse) : hors rythme variable.
  const recurringIds = new Set(
    listOccurrences(data.recurringRules, data.occurrences, data.transactions, { start: addDays(today, -HISTORY_WINDOW_DAYS - 5), end }, today, { convert: ctx.convert })
      .flatMap((o) => (o.status === 'matched' && o.transactionId ? [o.transactionId] : [])),
  );
  const avg = variableDailyAverage(ctx, data, today, recurringIds);
  // Rythme du mois : toujours évalué, ses dépenses atypiques servent aussi aux lignes de budget.
  const monthPace = monthVariablePace(ctx, data, today, recurringIds);
  let variableMethod: VariableMethod = 'insufficient';
  let variableProjected = 0;
  if (avg.dailyAverage != null) {
    variableMethod = 'history';
    variableProjected = roundHalfAwayFromZero(avg.dailyAverage * remainingDays);
    assumptions.push(
      t('forecast.assume.history', { days: avg.days, count: avg.count, remaining: remainingDays }),
    );
  } else {
    if (monthPace.dailyAverage != null) {
      variableMethod = 'month';
      variableProjected = roundHalfAwayFromZero(monthPace.dailyAverage * remainingDays);
      assumptions.push(t('forecast.assume.month', { days: avg.days, count: avg.count, elapsed: monthPace.days, monthCount: monthPace.count, remaining: remainingDays }));
    } else {
      assumptions.push(t('forecast.assume.insufficient', { minDays: MIN_HISTORY_DAYS, minCount: MIN_HISTORY_TRANSACTIONS, minMonthDays: MIN_PACE_DAYS }));
    }
  }
  const atypical = variableMethod === 'history' ? avg.atypical : monthPace.atypical;
  if (atypical.length) {
    assumptions.push(t('forecast.assume.atypical', { count: atypical.length, amount: formatMoney(atypical.reduce((a, x) => a + x.amount, 0), data.settings.baseCurrency, { locale: data.settings.locale }) }));
  }
  const atypicalByCategory = new Map<ID | null, number>();
  for (const x of monthPace.atypical) {
    const top = topCategoryId(ctx, x.categoryId);
    atypicalByCategory.set(top, (atypicalByCategory.get(top) ?? 0) + x.amount);
    if (x.subcategoryId) atypicalByCategory.set(x.subcategoryId, (atypicalByCategory.get(x.subcategoryId) ?? 0) + x.amount);
  }
  if (pending.length) {
    assumptions.push(
      t('forecast.assume.pending', { count: pending.length }),
    );
  } else {
    assumptions.push(t('forecast.assume.noPending'));
  }
  if (Object.keys(current.unconverted).length) {
    assumptions.push(t('forecast.assume.unconverted'));
  }

  const projectedIncome = summary.income + expectedIncome;
  const projectedExpenses = summary.expenses + expectedExpenses + variableProjected;
  const projectedEndBalance =
    current.total + (expectedIncome - expectedIncomeOutOfScope) - (expectedExpenses - expectedExpensesOutOfScope) - variableProjected;

  const overview = monthBudgetOverview(data.budgets, month, summary, ctx.categories, today, undefined, committedByCategory, atypicalByCategory);
  const budgetBasis = overview.referenceSource === 'none' ? null : overview.referenceSource;
  const budgetReference = budgetBasis ? overview.reference : null;
  const budgetProjectedSpent = budgetBasis === 'global' ? projectedExpenses : budgetBasis === 'categories' ? overview.categories!.projected : null;
  // Aucune donnée de dépense : ni minimum engagé ni rythme, quel que soit le jour.
  // Sinon : rien à projeter le dernier jour ; sans méthode exploitable, la projection est un minimum.
  const noData = !hasExpenseData(data.transactions, period, addDays(today, -HISTORY_WINDOW_DAYS), today, pending);
  const projectionStatus: ProjectionStatus = noData ? 'no-data' : remainingDays === 0 || variableMethod !== 'insufficient' ? 'complete' : 'minimum';
  const budgetProjectionStatus: ProjectionStatus | null =
    budgetBasis == null ? null : noData ? 'no-data' : budgetBasis === 'global' ? projectionStatus : overview.categories!.projectionComplete ? 'complete' : 'minimum';

  return {
    month,
    today,
    remainingDays,
    currentBalance: current.total,
    recordedIncome: summary.income,
    recordedExpenses: summary.expenses,
    expectedRecurringIncome: expectedIncome,
    expectedRecurringExpenses: expectedExpenses,
    pending,
    variableMethod,
    variableDailyAverage: avg.dailyAverage,
    variableHistoryDays: avg.days,
    variableProjected,
    variableMonthDays: monthPace.days,
    atypical,
    monthAtypical: monthPace.atypical,
    atypicalByCategory,
    variableMonthCount: monthPace.count,
    projectionStatus,
    projectedIncome,
    projectedExpenses,
    projectedSavings: projectedIncome - projectedExpenses,
    projectedEndBalance,
    budgetReference,
    budgetBasis,
    budgetProjectedSpent,
    budgetScope: budgetScope(data.budgets, month, ctx.categories),
    projectedBudgetOverrun: budgetReference == null || budgetProjectedSpent == null ? null : budgetProjectedSpent - budgetReference,
    budgetProjectionStatus,
    unbudgetedRecorded: overview.unbudgetedSpent,
    committedByCategory,
    assumptions,
    summary,
  };
}
