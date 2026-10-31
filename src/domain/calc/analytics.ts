/**
 * Analyses complémentaires (commerçants, dépenses exceptionnelles, séries mensuelles).
 * S'appuie exclusivement sur ledger.summarizePeriod / flowOf pour rester cohérent.
 */
import type { ISODate, MonthKey, Period } from '../dates';
import { addDays, inPeriod, monthKey, monthPeriod, monthRange, periodDays } from '../dates';
import type { DataSnapshot, ID, RecurringRule, Transaction } from '../types';
import type { LedgerContext, PeriodSummary, TransactionFilter } from './ledger';
import { matchesFilter, summarizePeriod, topCategoryId } from './ledger';
import type { OccurrenceView } from './recurring';
import { listOccurrences, monthlyEquivalent } from './recurring';

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

/**
 * Mois de la période couverts par le suivi : du mois de la première opération enregistrée
 * (ou du début de la période) jusqu'au mois en cours (ou à la fin de la période). Au moins 1.
 * Les mois antérieurs au début du suivi ne sont pas des mois « sans dépense » : les compter
 * diluerait la moyenne (vue Année avec des données depuis octobre : 10 mois au lieu de 1).
 */
export function trackedMonths(transactions: Transaction[], period: Period, today: ISODate): number {
  const first = transactions.reduce<ISODate | null>((min, t) => (min == null || t.date < min ? t.date : min), null);
  const from = first && first > period.start ? first : period.start;
  const to = period.end < today ? period.end : today;
  return to < from ? 1 : monthRange(monthKey(from), monthKey(to)).length;
}

/**
 * Charges récurrentes : trois lectures qui ne se mélangent jamais.
 *  - Composition : équivalent mensuel ÷ total des charges récurrentes (engagements).
 *  - Dépenses réelles : décaissements CONFIRMÉS (opérations associées à une échéance), datés
 *    dans la période, ÷ dépenses enregistrées de la période. Chaque opération est déjà dans
 *    ces dépenses : rien n'est compté deux fois. Les détections non confirmées et les
 *    échéances prévues sont présentées à part.
 *  - Revenus : équivalent mensuel ÷ revenus réellement perçus par mois suivi.
 * Un décaissement est rattaché au mois de sa date réelle, pas à celui de l'échéance qu'il solde.
 */
export interface RecurringChargeRow {
  rule: RecurringRule;
  /** Équivalent mensuel, devise de base. */
  monthly: number;
  composition: number | null;
  incomeShare: number | null;
  /** Échéances tombant dans la période. */
  occurrences: OccurrenceView[];
  /** Montant prévu des échéances de la période (hors ignorées). */
  committed: number;
  /** Décaissements confirmés datés dans la période. */
  paid: number;
  /** Opérations détectées, non confirmées, datées dans la période. */
  detected: number;
  /** Reste à payer sur les échéances de la période (à venir, en retard, reliquats). */
  remaining: number;
  /** paid ÷ dépenses enregistrées. */
  paidShare: number | null;
}

export interface RecurringChargesReport {
  rows: RecurringChargeRow[];
  monthlyTotal: number;
  /** Dépenses enregistrées de la période (filtres de la page appliqués). */
  expenses: number;
  /** Revenus perçus par mois suivi ; null sans revenu enregistré. */
  monthlyIncome: number | null;
  committed: number;
  paid: number;
  detected: number;
  remaining: number;
  paidShare: number | null;
  detectedShare: number | null;
  /** Échéances de la période ÷ dépenses enregistrées (peut dépasser 100 %). */
  coverage: number | null;
  incomeShare: number | null;
}

const ratio = (a: number, b: number | null): number | null => (b && b > 0 ? a / b : null);

export function recurringChargesReport(
  ctx: LedgerContext,
  data: Pick<DataSnapshot, 'recurringRules' | 'occurrences' | 'transactions'>,
  period: Period,
  today: ISODate,
  filter?: TransactionFilter,
): RecurringChargesReport {
  // Une règle suit les filtres compte / catégorie de la page (elle n'a ni type ni étiquette).
  const ruleFilter = filter && { accountIds: filter.accountIds, categoryIds: filter.categoryIds };
  const rules = data.recurringRules.filter(
    (r) => r.active && r.kind === 'expense' && matchesFilter(ctx, { type: 'expense', accountId: r.accountId, categoryId: r.categoryId, subcategoryId: r.subcategoryId ?? null, tags: [] } as unknown as Transaction, ruleFilter),
  );
  const toBase = (amount: number, currency: string, date: ISODate) => ctx.convert(amount, currency, date) ?? 0;
  const expenses = summarizePeriod(ctx, data.transactions, period, filter).expenses;
  const income = summarizePeriod(ctx, data.transactions, period).income;
  const monthlyIncome = income > 0 ? income / trackedMonths(data.transactions, period, today) : null;
  const opts = { convert: ctx.convert };
  const occ = listOccurrences(rules, data.occurrences, data.transactions, period, today, opts);
  // Détections : fenêtre élargie de la tolérance de rapprochement (±5 jours), opérations datées dans la période.
  const wide = listOccurrences(rules, data.occurrences, data.transactions, { start: addDays(period.start, -5), end: addDays(period.end, 5) }, today, opts);
  const txById = new Map(data.transactions.map((t) => [t.id, t]));
  const counts = (t: Transaction | undefined): t is Transaction => !!t && t.type === 'expense' && inPeriod(t.date, period) && matchesFilter(ctx, t, filter);

  const monthlyOf = new Map(rules.map((r) => [r.id, toBase(monthlyEquivalent(r), r.currency, today)]));
  const monthlyTotal = [...monthlyOf.values()].reduce((a, v) => a + v, 0);
  const rows = rules
    .map((rule): RecurringChargeRow => {
      const monthly = monthlyOf.get(rule.id)!;
      const occurrences = occ.filter((o) => o.rule.id === rule.id);
      const committed = occurrences.reduce((a, o) => a + (o.status === 'skipped' ? 0 : toBase(o.expected, rule.currency, o.dueDate)), 0);
      const remaining = occurrences.reduce((a, o) => a + toBase(o.remaining, rule.currency, o.dueDate), 0);
      const paid = data.transactions.filter((t) => t.recurringRuleId === rule.id && counts(t)).reduce((a, t) => a + toBase(t.amount, t.currency, t.date), 0);
      const detected = [...new Set(wide.filter((o) => o.rule.id === rule.id && o.status === 'matched').map((o) => o.transactionId!))]
        .map((id) => txById.get(id))
        .filter(counts)
        .reduce((a, t) => a + toBase(t.amount, t.currency, t.date), 0);
      return { rule, monthly, composition: ratio(monthly, monthlyTotal), incomeShare: ratio(monthly, monthlyIncome), occurrences, committed, paid, detected, remaining, paidShare: ratio(paid, expenses) };
    })
    .sort((a, b) => b.monthly - a.monthly);
  const sum = (k: 'committed' | 'paid' | 'detected' | 'remaining') => rows.reduce((a, r) => a + r[k], 0);
  const [committed, paid, detected, remaining] = [sum('committed'), sum('paid'), sum('detected'), sum('remaining')];
  return {
    rows,
    monthlyTotal,
    expenses,
    monthlyIncome,
    committed,
    paid,
    detected,
    remaining,
    paidShare: ratio(paid, expenses),
    detectedShare: ratio(detected, expenses),
    coverage: ratio(committed, expenses),
    incomeShare: ratio(monthlyTotal, monthlyIncome),
  };
}
