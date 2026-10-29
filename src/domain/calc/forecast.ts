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
 *  2. « budget » : reste des budgets des catégories variables (max(0, budget − dépensé)).
 *  3. « insufficient » : données insuffisantes, aucune projection variable.
 *
 * Les échéances déjà payées sont des transactions réelles : elles sont dans le solde
 * actuel et ne sont pas recomptées (voir recurring.listOccurrences / matching).
 */
import type { ISODate, MonthKey } from '../dates';
import { addDays, diffDays, monthEnd, monthKey, monthPeriod, maxDate } from '../dates';
import { roundHalfAwayFromZero } from '../money';
import type { DataSnapshot, ID } from '../types';
import type { LedgerContext, PeriodSummary } from './ledger';
import { accountsInScope, summarizePeriod, topCategoryId, totalBalance } from './ledger';
import type { OccurrenceView } from './recurring';
import { listOccurrences, pendingOccurrences } from './recurring';
import { monthBudgetOverview } from './budgets';
import { t } from '@/i18n/core';

export type VariableMethod = 'history' | 'budget' | 'insufficient';

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
  projectedIncome: number;
  projectedExpenses: number;
  projectedSavings: number;
  projectedEndBalance: number;
  /** Budget de référence et dépassement projeté (null si aucun budget). */
  budgetReference: number | null;
  projectedBudgetOverrun: number | null;
  /** Dépenses récurrentes attendues par catégorie de 1er niveau. */
  committedByCategory: Map<ID | null, number>;
  assumptions: string[];
  summary: PeriodSummary;
}

export const HISTORY_WINDOW_DAYS = 90;
export const MIN_HISTORY_DAYS = 30;
export const MIN_HISTORY_TRANSACTIONS = 10;

export interface VariableAverage {
  dailyAverage: number | null;
  days: number;
  count: number;
}

/** Moyenne quotidienne des dépenses variables observées avant `today` (exclu). */
export function variableDailyAverage(ctx: LedgerContext, data: Pick<DataSnapshot, 'transactions'>, today: ISODate): VariableAverage {
  const windowEnd = addDays(today, -1);
  const variable = data.transactions.filter((t) => {
    if (t.type !== 'expense' && t.type !== 'refund') return false;
    if (t.recurringRuleId) return false;
    const top = topCategoryId(ctx, t.categoryId);
    return !(top && ctx.categories.get(top)?.nature === 'fixed');
  });
  const firstDate = variable.reduce<ISODate | null>((min, t) => (min == null || t.date < min ? t.date : min), null);
  if (!firstDate || firstDate > windowEnd) return { dailyAverage: null, days: 0, count: 0 };
  const windowStart = maxDate(addDays(today, -HISTORY_WINDOW_DAYS), firstDate);
  const days = diffDays(windowEnd, windowStart) + 1;
  let total = 0;
  let count = 0;
  for (const t of variable) {
    if (t.date < windowStart || t.date > windowEnd) continue;
    const v = ctx.convert(t.amount, t.currency, t.date);
    if (v == null) continue;
    total += t.type === 'expense' ? v : -v;
    if (t.type === 'expense') count += 1;
  }
  if (days < MIN_HISTORY_DAYS || count < MIN_HISTORY_TRANSACTIONS) return { dailyAverage: null, days, count };
  return { dailyAverage: Math.max(0, total / days), days, count };
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

  const occ = listOccurrences(data.recurringRules, data.occurrences, data.transactions, period, today);
  const pending = pendingOccurrences(occ);
  let expectedIncome = 0;
  let expectedExpenses = 0;
  let expectedIncomeOutOfScope = 0;
  let expectedExpensesOutOfScope = 0;
  const committedByCategory = new Map<ID | null, number>();
  for (const o of pending) {
    const v = ctx.convert(o.rule.amount, o.rule.currency, o.dueDate) ?? 0;
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
  const avg = variableDailyAverage(ctx, data, today);
  let variableMethod: VariableMethod = 'insufficient';
  let variableProjected = 0;
  if (avg.dailyAverage != null) {
    variableMethod = 'history';
    variableProjected = roundHalfAwayFromZero(avg.dailyAverage * remainingDays);
    assumptions.push(
      t('forecast.assume.history', { days: avg.days, count: avg.count, remaining: remainingDays }),
    );
  } else {
    const overview = monthBudgetOverview(data.budgets, month, summary, ctx.categories, today);
    const variableLines = overview.lines.filter((l) => l.category && !l.category.parentId && l.category.nature !== 'fixed');
    if (variableLines.length) {
      variableMethod = 'budget';
      variableProjected = variableLines.reduce((acc, l) => acc + Math.max(0, l.remaining), 0);
      assumptions.push(
        t('forecast.assume.budget', { days: avg.days, count: avg.count }),
      );
    } else {
      assumptions.push(
        t('forecast.assume.insufficient', { minDays: MIN_HISTORY_DAYS, minCount: MIN_HISTORY_TRANSACTIONS }),
      );
    }
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

  const overview = monthBudgetOverview(data.budgets, month, summary, ctx.categories, today);
  const budgetReference = overview.referenceSource === 'none' ? null : overview.reference;

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
    projectedIncome,
    projectedExpenses,
    projectedSavings: projectedIncome - projectedExpenses,
    projectedEndBalance,
    budgetReference,
    projectedBudgetOverrun: budgetReference == null ? null : projectedExpenses - budgetReference,
    committedByCategory,
    assumptions,
    summary,
  };
}
