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
 * Catégories budgétées = budgets de 1er niveau + budgets de sous-catégorie dont la
 * catégorie parente n'a pas de budget (une dépense n'est jamais comptée deux fois).
 *
 *  Consommation des budgets = Dépenses des catégories budgétées ÷ Σ budgets de ces catégories
 *  Hors budget              = Dépenses totales − Dépenses des catégories budgétées
 *                             (catégories sans budget, opérations sans catégorie)
 *  Dépenses totales         = indicateur distinct (summarizePeriod), inchangé
 *
 * Budget global (saisi manuellement) = enveloppe couvrant TOUTES les dépenses du mois :
 * sa consommation est Dépenses totales ÷ Budget global.
 *
 * Budget disponible (dashboard) = Budget global − Dépenses totales s'il existe ;
 * sinon Σ budgets des catégories − Dépenses des catégories budgétées.
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

/** Jours écoulés minimum avant d'extrapoler le rythme du mois (sinon : minimum connu). */
export const MIN_PACE_DAYS = 10;

/** Le rythme du mois est-il exploitable pour projeter une dépense variable ? */
export function paceReliable(timing: MonthTiming): boolean {
  return !timing.isCurrent || timing.elapsed >= MIN_PACE_DAYS;
}

/**
 * Projection de fin de mois d'une ligne de budget. Mois passé : le réalisé ; mois futur :
 * null. Mois en cours : charge fixe = réalisé + échéances connues (`committed`) ; dépense
 * variable = rythme du mois (dépensé ÷ jours écoulés × jours du mois) dès MIN_PACE_DAYS
 * jours écoulés, sinon seulement le minimum connu (réalisé + échéances), jamais le reste
 * du budget supposé dépensé. `atypical` : part de `spent` jugée atypique (voir forecast),
 * ajoutée telle quelle sans extrapolation.
 */
export function projectMonthEnd(spent: number, timing: MonthTiming, nature: 'fixed' | 'variable' | undefined, committed = 0, atypical = 0): number | null {
  if (timing.isFuture) return null;
  if (timing.isPast) return spent;
  if (nature === 'fixed' || !paceReliable(timing)) return spent + committed;
  // Les dépenses atypiques (isolées, sans équivalent dans l'historique) sont comptées une fois, jamais extrapolées.
  const habitual = Math.max(0, spent - atypical);
  const pace = timing.elapsed > 0 ? roundHalfAwayFromZero((habitual / timing.elapsed) * timing.total) + (spent - habitual) : spent;
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
  atypical = 0,
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
    projected: projectMonthEnd(spent, timing, category?.nature, committed, atypical),
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

/**
 * Règle unique des catégories budgétées : budget de 1er niveau, ou budget de sous-catégorie
 * dont la catégorie parente n'a pas de budget ce mois-ci.
 */
export function isCountedCategoryBudget(b: Budget, budgetedIds: Set<ID | null>, categories: Map<ID, Category>): boolean {
  if (b.categoryId == null) return false;
  const parentId = categories.get(b.categoryId)?.parentId;
  return !parentId || !budgetedIds.has(parentId);
}

/** Périmètre budgétaire d'un mois, partagé par Budgets, Prévisions et le simulateur. */
export interface BudgetScope {
  /** 'global' : budget global saisi (toutes les dépenses) ; 'categories' : catégories budgétées. */
  basis: 'global' | 'categories';
  reference: number;
  /** Catégories de 1er niveau budgétées. */
  topIds: ID[];
  /** Sous-catégories budgétées sans budget parent, avec leur parent. */
  subs: { id: ID; parentId: ID }[];
}

export function budgetScope(budgets: Budget[], month: MonthKey, categories: Map<ID, Category>): BudgetScope | null {
  const monthBudgets = budgets.filter((b) => b.month === month);
  const ids = new Set(monthBudgets.map((b) => b.categoryId));
  const counted = monthBudgets.filter((b) => isCountedCategoryBudget(b, ids, categories));
  const global = monthBudgets.find((b) => b.categoryId == null);
  const topIds: ID[] = [];
  const subs: BudgetScope['subs'] = [];
  for (const b of counted) {
    const parentId = categories.get(b.categoryId!)?.parentId;
    if (parentId) subs.push({ id: b.categoryId!, parentId });
    else topIds.push(b.categoryId!);
  }
  if (global) return { basis: 'global', reference: global.amount, topIds, subs };
  if (!counted.length) return null;
  return { basis: 'categories', reference: counted.reduce((a, b) => a + b.amount, 0), topIds, subs };
}

/** Agrégat des catégories budgétées (sans double comptage parent / sous-catégorie). */
export interface BudgetedCategoriesTotal {
  planned: number;
  spent: number;
  remaining: number;
  /** spent ÷ planned ; null si aucun budget de catégorie (ou somme nulle). */
  consumption: number | null;
  /** Σ projections de fin de mois des lignes (null pour un mois futur). */
  projected: number | null;
  /**
   * false : moins de MIN_PACE_DAYS jours écoulés avec des catégories variables — `projected`
   * n'est alors qu'un minimum (réalisé + échéances connues), pas une estimation complète.
   */
  projectionComplete: boolean;
}

export interface MonthBudgetOverview {
  lines: BudgetLine[];
  global: BudgetLine | null;
  /** Catégories budgétées ; null s'il n'y a aucun budget de catégorie. */
  categories: BudgetedCategoriesTotal | null;
  /** Budget de référence (global, sinon somme des catégories budgétées). */
  reference: number;
  referenceSource: 'global' | 'categories' | 'none';
  /** Dépenses comparées à la référence : totales (global) ou des catégories budgétées. */
  referenceSpent: number;
  /** Budget disponible = référence − referenceSpent. null si aucun budget. */
  available: number | null;
  /** Dépenses totales du mois (toutes catégories). */
  totalSpent: number;
  /** Dépenses hors budget = totales − catégories budgétées. */
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
  atypicalByCategory: Map<ID | null, number> = new Map(),
): MonthBudgetOverview {
  const timing = monthTiming(month, today);
  const monthBudgets = budgets.filter((b) => b.month === month);
  let global: BudgetLine | null = null;
  const lines: BudgetLine[] = [];
  for (const b of monthBudgets) {
    const cat = b.categoryId ? categories.get(b.categoryId) ?? null : null;
    const spent = spentForBudget(summary, b, categories);
    const committed = b.categoryId ? committedByCategory.get(b.categoryId) ?? 0 : sumMap(committedByCategory);
    const atypical = b.categoryId ? atypicalByCategory.get(b.categoryId) ?? 0 : 0;
    const line = computeBudgetLine(b, cat, spent, timing, thresholds, committed, atypical);
    if (b.categoryId == null) global = line;
    else lines.push(line);
  }
  const budgetedIds = new Set(lines.map((l) => l.budget.categoryId));
  const counted = lines.filter((l) => isCountedCategoryBudget(l.budget, budgetedIds, categories));
  const categoriesTotal: BudgetedCategoriesTotal | null = counted.length
    ? (() => {
        const planned = counted.reduce((a, l) => a + l.planned, 0);
        const spent = counted.reduce((a, l) => a + l.spent, 0);
        return {
          planned,
          spent,
          remaining: planned - spent,
          consumption: safeRatio(spent, planned),
          projected: timing.isFuture ? null : counted.reduce((a, l) => a + (l.projected ?? l.spent), 0),
          projectionComplete: paceReliable(timing) || counted.every((l) => l.category?.nature === 'fixed'),
        };
      })()
    : null;
  const totalSpent = summary.expenses;

  let reference = 0;
  let referenceSpent = 0;
  let referenceSource: MonthBudgetOverview['referenceSource'] = 'none';
  if (global) {
    reference = global.planned;
    referenceSpent = totalSpent;
    referenceSource = 'global';
  } else if (categoriesTotal) {
    reference = categoriesTotal.planned;
    referenceSpent = categoriesTotal.spent;
    referenceSource = 'categories';
  }
  return {
    lines: lines.sort((a, b) => (b.consumption ?? 0) - (a.consumption ?? 0)),
    global,
    categories: categoriesTotal,
    reference,
    referenceSource,
    referenceSpent,
    available: referenceSource === 'none' ? null : reference - referenceSpent,
    totalSpent,
    unbudgetedSpent: totalSpent - (categoriesTotal?.spent ?? 0),
  };
}

function sumMap(m: Map<unknown, number>): number {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
}
