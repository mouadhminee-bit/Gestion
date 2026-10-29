/**
 * Objectifs d'épargne.
 *
 *  Montant restant = max(0, Cible − Constitué)
 *  Progression     = Constitué ÷ Cible (affichage plafonné à 100 %, valeur réelle conservée)
 *  Contribution mensuelle nécessaire = Montant restant ÷ mois restants (arrondi supérieur)
 *
 * Un objectif est une AFFECTATION de l'argent, pas un actif : il n'est jamais
 * ajouté au patrimoine. S'il suit un compte, la progression reflète le solde
 * de ce compte (déjà compté une seule fois dans le patrimoine).
 */
import type { ISODate } from '../dates';
import { addMonths, monthsBetweenCeil } from '../dates';
import type { SavingsGoal } from '../types';
import { lazyLabels } from '@/i18n/labels';

export type GoalState = 'achieved' | 'overdue' | 'on_track' | 'behind' | 'no_deadline' | 'no_plan';

export interface GoalProgress {
  saved: number;
  remaining: number;
  /** Ratio réel (peut dépasser 1). */
  progress: number | null;
  /** Ratio plafonné à 1 pour l'affichage. */
  progressCapped: number;
  monthsLeft: number | null;
  requiredMonthly: number | null;
  /** Contribution souhaitée − contribution nécessaire (> 0 : marge). */
  contributionGap: number | null;
  /** Date d'atteinte estimée avec la contribution souhaitée. */
  projectedDate: ISODate | null;
  state: GoalState;
}

export function goalSavedAmount(goal: SavingsGoal, linkedAccountBalance?: number): number {
  if (goal.trackLinkedAccount && goal.linkedAccountId && linkedAccountBalance != null) return Math.max(0, linkedAccountBalance);
  return goal.savedAmount;
}

export function computeGoalProgress(goal: SavingsGoal, today: ISODate, linkedAccountBalance?: number): GoalProgress {
  const saved = goalSavedAmount(goal, linkedAccountBalance);
  const remaining = Math.max(0, goal.targetAmount - saved);
  const progress = goal.targetAmount > 0 ? saved / goal.targetAmount : null;
  const progressCapped = progress == null ? 0 : Math.min(1, Math.max(0, progress));
  const achieved = goal.targetAmount > 0 && saved >= goal.targetAmount;

  let monthsLeft: number | null = null;
  let requiredMonthly: number | null = null;
  if (goal.targetDate) {
    monthsLeft = monthsBetweenCeil(today, goal.targetDate);
    if (!achieved && monthsLeft > 0) requiredMonthly = Math.ceil(remaining / monthsLeft);
  }
  const contribution = goal.monthlyContribution ?? 0;
  const contributionGap = requiredMonthly != null && goal.monthlyContribution != null ? contribution - requiredMonthly : null;

  let projectedDate: ISODate | null = null;
  if (achieved) projectedDate = today;
  else if (contribution > 0) projectedDate = addMonths(today, Math.ceil(remaining / contribution));

  let state: GoalState;
  if (achieved) state = 'achieved';
  else if (goal.targetDate && goal.targetDate < today) state = 'overdue';
  else if (!goal.targetDate) state = contribution > 0 ? 'no_deadline' : 'no_plan';
  else if (monthsLeft === 0) state = 'overdue';
  else if (goal.monthlyContribution == null || goal.monthlyContribution === 0) state = 'no_plan';
  else state = contributionGap != null && contributionGap >= 0 ? 'on_track' : 'behind';

  return { saved, remaining, progress, progressCapped, monthsLeft, requiredMonthly, contributionGap, projectedDate, state };
}

export const GOAL_STATE_LABELS: Record<GoalState, string> = lazyLabels('goalState', ['achieved', 'overdue', 'on_track', 'behind', 'no_deadline', 'no_plan']);
