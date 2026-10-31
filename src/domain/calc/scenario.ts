/**
 * Simulateur de scénarios — calcul pur, ne modifie jamais les données réelles.
 *
 * Base de référence : moyenne mensuelle des revenus et dépenses (par catégorie)
 * sur les N derniers mois COMPLETS (3 par défaut). Le scénario applique ensuite
 * des variations explicites et compare :
 *   - revenus / dépenses / épargne mensuels et taux d'épargne,
 *   - disponible sur budget, même règle que le module Budgets : budget global saisi
 *     − dépenses totales ; sinon Σ budgets des catégories budgétées − dépenses de ces
 *     seules catégories (les dépenses hors budget, dont une nouvelle charge sans
 *     catégorie, n'y entrent pas),
 *   - solde estimé de fin de mois (prévision actuelle + effet du scénario sur
 *     les jours restants + achat ponctuel),
 *   - délai d'atteinte de chaque objectif actif.
 */
import type { ISODate, MonthKey } from '../dates';
import { addMonthsToKey, monthKey, monthPeriod } from '../dates';
import { percentOf, roundHalfAwayFromZero } from '../money';
import type { DataSnapshot, ID, SavingsGoal } from '../types';
import type { BudgetScope } from './budgets';
import type { LedgerContext } from './ledger';
import { summarizePeriod } from './ledger';
import { computeGoalProgress } from './goals';

export interface ScenarioInput {
  incomeChangePct: number; // ex: 10 pour +10 %
  incomeChangeAmount: number; // unités minimales, ± par mois
  rentIncrease: number; // par mois
  newRecurringExpense: number; // par mois
  oneOffPurchase: number; // une fois
  categoryReductions: { categoryId: ID; pct: number }[];
  extraSavings: number; // contribution mensuelle supplémentaire aux objectifs
}

export const EMPTY_SCENARIO: ScenarioInput = {
  incomeChangePct: 0,
  incomeChangeAmount: 0,
  rentIncrease: 0,
  newRecurringExpense: 0,
  oneOffPurchase: 0,
  categoryReductions: [],
  extraSavings: 0,
};

export interface Baseline {
  months: MonthKey[];
  income: number;
  expenses: number;
  byCategory: Map<ID | null, number>;
  /** Moyenne mensuelle par sous-catégorie (budgets de sous-catégorie). */
  bySubcategory: Map<ID, number>;
  /** Nombre de mois réellement disposant de données. */
  monthsWithData: number;
}

export function computeBaseline(ctx: LedgerContext, data: Pick<DataSnapshot, 'transactions'>, today: ISODate, n = 3): Baseline {
  const current = monthKey(today);
  const months: MonthKey[] = [];
  for (let i = n; i >= 1; i--) months.push(addMonthsToKey(current, -i));
  let income = 0;
  let expenses = 0;
  let monthsWithData = 0;
  const byCategory = new Map<ID | null, number>();
  const bySubcategory = new Map<ID, number>();
  for (const m of months) {
    const s = summarizePeriod(ctx, data.transactions, monthPeriod(m));
    if (s.income === 0 && s.expenses === 0) continue;
    monthsWithData += 1;
    income += s.income;
    expenses += s.expenses;
    for (const [k, v] of s.expensesByCategory) byCategory.set(k, (byCategory.get(k) ?? 0) + v.amount);
    for (const [k, v] of s.expensesBySubcategory) bySubcategory.set(k, (bySubcategory.get(k) ?? 0) + v.amount);
  }
  const div = Math.max(1, monthsWithData);
  for (const [k, v] of byCategory) byCategory.set(k, roundHalfAwayFromZero(v / div));
  for (const [k, v] of bySubcategory) bySubcategory.set(k, roundHalfAwayFromZero(v / div));
  return {
    months,
    income: roundHalfAwayFromZero(income / div),
    expenses: roundHalfAwayFromZero(expenses / div),
    byCategory,
    bySubcategory,
    monthsWithData,
  };
}

export interface GoalImpact {
  goal: SavingsGoal;
  remaining: number;
  baselineMonths: number | null;
  scenarioMonths: number | null;
}

export interface ScenarioResult {
  baseline: { income: number; expenses: number; savings: number; savingsRate: number | null };
  scenario: { income: number; expenses: number; savings: number; savingsRate: number | null };
  deltaSavings: number;
  categoryDeltas: { categoryId: ID; baseline: number; scenario: number }[];
  /** Base du disponible sur budget (null sans budget ce mois-ci). */
  budgetBasis: BudgetScope['basis'] | null;
  budgetRemainingBaseline: number | null;
  budgetRemainingScenario: number | null;
  endOfMonthBaseline: number;
  endOfMonthScenario: number;
  goals: GoalImpact[];
  sufficientData: boolean;
}

function monthsToReach(remaining: number, monthly: number): number | null {
  if (remaining <= 0) return 0;
  if (monthly <= 0) return null;
  return Math.ceil(remaining / monthly);
}

export function simulateScenario(params: {
  baseline: Baseline;
  input: ScenarioInput;
  budget: BudgetScope | null;
  projectedEndBalance: number;
  remainingDays: number;
  daysInMonth: number;
  goals: SavingsGoal[];
  goalSaved: (goal: SavingsGoal) => number;
  today: ISODate;
  rentCategoryId?: ID | null;
}): ScenarioResult {
  const { baseline, input } = params;
  const income = baseline.income + percentOf(baseline.income, input.incomeChangePct) + input.incomeChangeAmount;
  const categoryDeltas: ScenarioResult['categoryDeltas'] = [];
  let reduction = 0;
  for (const r of input.categoryReductions) {
    const base = baseline.byCategory.get(r.categoryId) ?? 0;
    const cut = percentOf(base, r.pct);
    reduction += cut;
    categoryDeltas.push({ categoryId: r.categoryId, baseline: base, scenario: base - cut });
  }
  if (params.rentCategoryId && input.rentIncrease) {
    const base = baseline.byCategory.get(params.rentCategoryId) ?? 0;
    categoryDeltas.push({ categoryId: params.rentCategoryId, baseline: base, scenario: base + input.rentIncrease });
  }
  const expenses = baseline.expenses - reduction + input.rentIncrease + input.newRecurringExpense;

  // Dépenses imputées aux budgets : totales (budget global) ou des seules catégories budgétées.
  const scope = params.budget;
  const pctOf = (categoryId: ID) => input.categoryReductions.filter((r) => r.categoryId === categoryId).reduce((a, r) => a + r.pct, 0);
  const budgetedSpend = (scenario: boolean): number => {
    if (!scope) return 0;
    if (scope.basis === 'global') return scenario ? expenses : baseline.expenses;
    let total = 0;
    for (const id of scope.topIds) {
      const base = baseline.byCategory.get(id) ?? 0;
      total += scenario ? base - input.categoryReductions.filter((r) => r.categoryId === id).reduce((a, r) => a + percentOf(base, r.pct), 0) + (id === params.rentCategoryId ? input.rentIncrease : 0) : base;
    }
    // Sous-catégorie budgétée seule : elle suit la réduction appliquée à sa catégorie parente.
    for (const sub of scope.subs) {
      const base = baseline.bySubcategory.get(sub.id) ?? 0;
      total += scenario ? base - percentOf(base, Math.min(100, pctOf(sub.parentId))) : base;
    }
    return total;
  };
  const baseSavings = baseline.income - baseline.expenses;
  const scenSavings = income - expenses;
  const deltaSavings = scenSavings - baseSavings;

  // Effet sur la fin du mois en cours : variation mensuelle au prorata des jours restants, + achat ponctuel.
  const prorata = params.daysInMonth > 0 ? params.remainingDays / params.daysInMonth : 0;
  const endOfMonthScenario = params.projectedEndBalance + roundHalfAwayFromZero(deltaSavings * prorata) - input.oneOffPurchase;

  // Objectifs : contributions prévues, réduites proportionnellement si l'épargne ne suffit pas ;
  // la contribution supplémentaire va à l'objectif le plus prioritaire.
  const active = params.goals.filter((g) => g.status === 'active');
  const prioRank = { high: 0, medium: 1, low: 2 } as const;
  const ordered = [...active].sort((a, b) => prioRank[a.priority] - prioRank[b.priority]);
  const planned = ordered.reduce((acc, g) => acc + (g.monthlyContribution ?? 0), 0);
  const scale = (savings: number) => (planned > 0 ? Math.min(1, Math.max(0, savings) / planned) : 0);
  const baseScale = scale(baseSavings);
  const scenScale = scale(scenSavings - input.extraSavings);
  const goals: GoalImpact[] = ordered.map((g, idx) => {
    const progress = computeGoalProgress({ ...g, savedAmount: params.goalSaved(g), trackLinkedAccount: false }, params.today);
    const remaining = progress.remaining;
    const baseMonthly = roundHalfAwayFromZero((g.monthlyContribution ?? 0) * baseScale);
    let scenMonthly = roundHalfAwayFromZero((g.monthlyContribution ?? 0) * scenScale);
    if (idx === 0) scenMonthly += input.extraSavings;
    return {
      goal: g,
      remaining,
      baselineMonths: monthsToReach(remaining, baseMonthly),
      scenarioMonths: monthsToReach(remaining, scenMonthly),
    };
  });

  return {
    baseline: { income: baseline.income, expenses: baseline.expenses, savings: baseSavings, savingsRate: baseline.income > 0 ? baseSavings / baseline.income : null },
    scenario: { income, expenses, savings: scenSavings, savingsRate: income > 0 ? scenSavings / income : null },
    deltaSavings,
    categoryDeltas,
    budgetBasis: scope?.basis ?? null,
    budgetRemainingBaseline: scope ? scope.reference - budgetedSpend(false) : null,
    budgetRemainingScenario: scope ? scope.reference - budgetedSpend(true) : null,
    endOfMonthBaseline: params.projectedEndBalance,
    endOfMonthScenario,
    goals,
    sufficientData: baseline.monthsWithData > 0,
  };
}
