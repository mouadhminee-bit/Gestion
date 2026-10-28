/**
 * Budgets mensuels.
 *
 *  Montant restant      = Budget prévu − Dépenses éligibles
 *  Taux de consommation = Dépenses éligibles ÷ Budget prévu   (non affiché si budget nul)
 *  Écart budgétaire     = Dépenses éligibles − Budget prévu   (> 0 : dépassement)
 *  Écart en %           = Écart ÷ Budget prévu
 *
 * Dépenses éligibles = dépenses de consommation nettes des remboursements reçus
 * de la catégorie (sous-catégories incluses), voir ledger.ts.
 *
 * Budget disponible (dashboard) = Budget global du mois − Dépenses de consommation
 * du mois (toutes catégories). Sans budget global, le budget de référence est la
 * somme des budgets des catégories de premier niveau.
 * Ce n'est PAS un solde bancaire : c'est l'enveloppe de dépenses restante.
 */
import type { ISODate, MonthKey } from '../dates';
import { daysInMonth, diffDays, monthEnd, monthStart } from '../dates';
import { roundHalfAwayFromZero, safeRatio } from '../money';
import type { Budget, Category, ID } from '../types';
import type { PeriodSummary } from './ledger';

export const DEFAULT_THRESHOLDS = [50, 75, 90, 100];

export type BudgetStatus = 'ok' | 'warning' | 'danger' | 'over' | 'none';

export interface BudgetLine {
  budget: Budget;
  category: Category | null;
  planned: number;
  spent: number;
  remaining: number;
  /** null si budget nul. */
  consumption: number | null;
  variance: number;
  variancePct: number | null;
  /** Projection de fin de mois (null pour un mois futur). */
  projected: number | null;
  /** Plus haut seuil atteint (en %), null si aucun. */
  thresholdReached: number | null;
  status: BudgetStatus;
}

export interface MonthTiming {
  /** Jours écoulés dans le mois (0 si mois futur, nb de jours si mois passé). */
  elapsed: number;
  total: number;
  isCurrent: boolean;
  isPast: boolean;
  isFuture: boolean;
}

export function monthTiming(month: MonthKey, today: ISODate): MonthTiming {
  const [y, m] = month.split('-').map(Number);
  const total = daysInMonth(y, m);
  const start = monthStart(month);
  const end = monthEnd(month);
  if (today > end) return { elapsed: total, total, isCurrent: false, isPast: true, isFuture: false };
  if (today < start) return { elapsed: 0, total, isCurrent: false, isPast: false, isFuture: true };
  return { elapsed: diffDays(today, start) + 1, total, isCurrent: true, isPast: false, isFuture: false };
}

/**
 * Projection linéaire de fin de mois pour une dépense variable :
 * dépensé ÷ jours écoulés × jours du mois. Pour un mois passé : le réalisé.
 * `committed` ajoute des montants connus à venir (échéances récurrentes non payées).
 */
export function projectMonthEnd(spent: number, timing: MonthTiming, nature: 'fixed' | 'variable' | undefined, committed = 0): number | null {
  if (timing.isFuture) return null;
  if (timing.isPast) return spent;
  if (nature === 'fixed') return spent + committed;
  const pace = timing.elapsed > 0 ? roundHalfAwayFromZero((spent / timing.elapsed) * timing.total) : spent;
  return Math.max(pace, spent + committed);
}

export function reachedThreshold(consumption: number | null, thresholds: number[]): number | null {
  if (consumption == null) return null;
  const pct = consumption * 100;
  let reached: number | null = null;
  for (const t of [...thresholds].sort((a, b) => a - b)) if (pct >= t) reached = t;
  return reached;
}

export function statusFor(spent: number, planned: number, threshold: number | null): BudgetStatus {
  if (planned <= 0) return spent > 0 ? 'over' : 'none';
  if (spent > planned) return 'over';
  if (threshold != null && threshold >= 90) return 'danger';
  if (threshold != null && threshold >= 75) return 'warning';
  return 'ok';
}

export function computeBudgetLine(
  budget: Budget,
  category: Category | null,
  spent: number,
  timing: MonthTiming,
  thresholds: number[],
  committed = 0,
): BudgetLine {
  const planned = budget.amount;
  const consumption = safeRatio(spent, planned);
  const variance = spent - planned;
  const threshold = reachedThreshold(consumption, budget.alertThresholds ?? thresholds);
  return {
    budget,
    category,
    planned,
    spent,
    remaining: planned - spent,
    consumption,
    variance,
    variancePct: safeRatio(variance, planned),
    projected: projectMonthEnd(spent, timing, category?.nature, committed),
    thresholdReached: threshold,
    status: statusFor(spent, planned, threshold),
  };
}

/** Dépenses éligibles d'un budget (catégorie de 1er niveau ou sous-catégorie). */
export function spentForBudget(summary: PeriodSummary, budget: Budget, categories: Map<ID, Category>): number {
  if (budget.categoryId == null) return summary.expenses;
  const cat = categories.get(budget.categoryId);
  if (cat?.parentId) return summary.expensesBySubcategory.get(budget.categoryId)?.amount ?? 0;
  return summary.expensesByCategory.get(budget.categoryId)?.amount ?? 0;
}

export interface MonthBudgetOverview {
  lines: BudgetLine[];
  global: BudgetLine | null;
  /** Budget de référence (global, sinon somme des catégories de 1er niveau). */
  reference: number;
  referenceSource: 'global' | 'categories' | 'none';
  /** Budget disponible = référence − dépenses du mois. null si aucun budget. */
  available: number | null;
  /** Dépenses dans des catégories sans budget. */
  unbudgetedSpent: number;
}

export function monthBudgetOverview(
  budgets: Budget[],
  month: MonthKey,
  summary: PeriodSummary,
  categories: Map<ID, Category>,
  today: ISODate,
  thresholds: number[] = DEFAULT_THRESHOLDS,
  committedByCategory: Map<ID | null, number> = new Map(),
): MonthBudgetOverview {
  const timing = monthTiming(month, today);
  const monthBudgets = budgets.filter((b) => b.month === month);
  let global: BudgetLine | null = null;
  const lines: BudgetLine[] = [];
  for (const b of monthBudgets) {
    const cat = b.categoryId ? categories.get(b.categoryId) ?? null : null;
    const spent = spentForBudget(summary, b, categories);
    const committed = b.categoryId ? committedByCategory.get(b.categoryId) ?? 0 : sumMap(committedByCategory);
    const line = computeBudgetLine(b, cat, spent, timing, thresholds, committed);
    if (b.categoryId == null) global = line;
    else lines.push(line);
  }
  const topLines = lines.filter((l) => !l.category?.parentId);
  const categoriesTotal = topLines.reduce((acc, l) => acc + l.planned, 0);
  const budgetedTop = new Set(topLines.map((l) => l.budget.categoryId));
  let unbudgetedSpent = 0;
  for (const [catId, v] of summary.expensesByCategory) if (!budgetedTop.has(catId)) unbudgetedSpent += v.amount;

  let reference = 0;
  let referenceSource: MonthBudgetOverview['referenceSource'] = 'none';
  if (global) {
    reference = global.planned;
    referenceSource = 'global';
  } else if (topLines.length) {
    reference = categoriesTotal;
    referenceSource = 'categories';
  }
  return {
    lines: lines.sort((a, b) => (b.consumption ?? 0) - (a.consumption ?? 0)),
    global,
    reference,
    referenceSource,
    available: referenceSource === 'none' ? null : reference - summary.expenses,
    unbudgetedSpent,
  };
}

function sumMap(m: Map<unknown, number>): number {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
}
