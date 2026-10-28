/**
 * Analyses complémentaires (commerçants, dépenses exceptionnelles, séries mensuelles).
 * S'appuie exclusivement sur ledger.summarizePeriod / flowOf pour rester cohérent.
 */
import type { ISODate, MonthKey, Period } from '../dates';
import { inPeriod, monthPeriod, periodDays } from '../dates';
import type { ID, Transaction } from '../types';
import type { LedgerContext, PeriodSummary, TransactionFilter } from './ledger';
import { matchesFilter, summarizePeriod, topCategoryId } from './ledger';

export interface MonthlyPoint {
  month: MonthKey;
  income: number;
  expenses: number;
  netSavings: number;
  savingsRate: number | null;
  fixed: number;
  variable: number;
  transactionCount: number;
}

export function monthlySeries(ctx: LedgerContext, transactions: Transaction[], months: MonthKey[], filter?: TransactionFilter): MonthlyPoint[] {
  return months.map((m) => {
    const s = summarizePeriod(ctx, transactions, monthPeriod(m), filter);
    return {
      month: m,
      income: s.income,
      expenses: s.expenses,
      netSavings: s.netSavings,
      savingsRate: s.savingsRate,
      fixed: s.fixedExpenses,
      variable: s.variableExpenses,
      transactionCount: s.transactionCount,
    };
  });
}

export function normalizePayee(t: Transaction): string {
  return (t.payee?.trim() || t.label.trim()).replace(/\s+/g, ' ');
}

export interface PayeeAmount {
  payee: string;
  amount: number;
  count: number;
}

/** Dépenses nettes par commerçant / bénéficiaire (devise de base). */
export function expensesByPayee(ctx: LedgerContext, transactions: Transaction[], period: Period, filter?: TransactionFilter): PayeeAmount[] {
  const map = new Map<string, PayeeAmount>();
  for (const t of transactions) {
    if ((t.type !== 'expense' && t.type !== 'refund') || !inPeriod(t.date, period) || !matchesFilter(ctx, t, filter)) continue;
    const v = ctx.convert(t.amount, t.currency, t.date);
    if (v == null) continue;
    const key = normalizePayee(t);
    const k = key.toLowerCase();
    const cur = map.get(k) ?? { payee: key, amount: 0, count: 0 };
    cur.amount += t.type === 'expense' ? v : -v;
    cur.count += 1;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * Dépenses exceptionnelles : dépense ponctuelle (hors paiement récurrent) au moins
 * 3 fois supérieure à la médiane des dépenses de sa catégorie sur l'historique
 * fourni, et d'au moins 500 unités de devise de base (seuil `minAmount`).
 */
export function exceptionalExpenses(
  ctx: LedgerContext,
  transactions: Transaction[],
  period: Period,
  minAmount: number,
  filter?: TransactionFilter,
): { transaction: Transaction; value: number; median: number }[] {
  const byCat = new Map<ID | null, number[]>();
  const values = new Map<ID, number>();
  for (const t of transactions) {
    if (t.type !== 'expense' || t.recurringRuleId) continue;
    const v = ctx.convert(t.amount, t.currency, t.date);
    if (v == null) continue;
    values.set(t.id, v);
    const top = topCategoryId(ctx, t.categoryId);
    const list = byCat.get(top) ?? [];
    list.push(v);
    byCat.set(top, list);
  }
  const medians = new Map<ID | null, number>();
  for (const [k, list] of byCat) {
    const sorted = [...list].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medians.set(k, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
  }
  const out: { transaction: Transaction; value: number; median: number }[] = [];
  for (const t of transactions) {
    if (t.type !== 'expense' || t.recurringRuleId || !inPeriod(t.date, period) || !matchesFilter(ctx, t, filter)) continue;
    const v = values.get(t.id);
    const top = topCategoryId(ctx, t.categoryId);
    const list = byCat.get(top) ?? [];
    const median = medians.get(top) ?? 0;
    if (v == null || list.length < 4 || v < minAmount) continue;
    if (v >= median * 3) out.push({ transaction: t, value: v, median });
  }
  return out.sort((a, b) => b.value - a.value);
}

export interface PeriodComparison {
  current: PeriodSummary;
  previous: PeriodSummary;
  incomeChange: number | null;
  expensesChange: number | null;
  savingsChange: number;
}

export function relativeChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return (current - previous) / Math.abs(previous);
}

export function comparePeriods(ctx: LedgerContext, transactions: Transaction[], current: Period, previous: Period, filter?: TransactionFilter): PeriodComparison {
  const c = summarizePeriod(ctx, transactions, current, filter);
  const p = summarizePeriod(ctx, transactions, previous, filter);
  return {
    current: c,
    previous: p,
    incomeChange: relativeChange(c.income, p.income),
    expensesChange: relativeChange(c.expenses, p.expenses),
    savingsChange: c.netSavings - p.netSavings,
  };
}

/** Moyenne quotidienne des dépenses sur une période (bornée à aujourd'hui). */
export function dailyAverage(expenses: number, period: Period, today: ISODate): number | null {
  const end = period.end < today ? period.end : today;
  if (end < period.start) return null;
  const days = periodDays({ start: period.start, end });
  return days > 0 ? expenses / days : null;
}
