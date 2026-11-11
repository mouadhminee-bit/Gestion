/**
 * Decision Lab — exécution d'une simulation (étape E5.4) : situation initiale + décision validée +
 * horizon réel → moteur E3 → snapshot E4.
 *
 * Aucun calcul financier ici : `createSnapshot` exécute le moteur et fige hypothèses et résultats ;
 * `simulateDecision` fournit le détail mensuel (flux, actif, dette) pour l'affichage. Le snapshot
 * affiché est exactement celui qui sera enregistré (aucun recalcul entre l'écran et le stockage).
 *
 * L'horizon est celui saisi par l'utilisateur, validé par le moteur (1 à 480 mois) et transmis tel
 * quel : un scénario qui échoue sur son horizon réel est refusé (erreur bloquante), jamais validé
 * sur un autre horizon.
 */
import type { MonthKey } from '@/domain/dates';
import { addMonthsToKey } from '@/domain/dates';
import { DecisionInputError, simulateDecision, validateDecision, type DecisionInput, type DecisionResult, type InitialSituation } from '@/domain/calc/decision';
import { parseMonths } from './decisionDraft';
import { createSnapshot, MAX_NAME_LENGTH, type DecisionSnapshot } from './snapshot';

/** Identifiant de l'unique variante d'une simulation simple (le comparateur en aura plusieurs). */
export const SINGLE_VARIANT_ID = 'decision';

export type RunField = 'name' | 'horizon' | 'situation' | 'form';
/** Erreurs bloquantes : codes de l'interface (`required`, `invalid`, `tooLong`) ou du moteur. */
export type RunErrors = Partial<Record<RunField, string>>;

export interface SimulationRun {
  /** Hypothèses et résultats figés (contrat E4), prêts à être enregistrés tels quels. */
  snapshot: DecisionSnapshot;
  /** Détail mensuel du moteur pour la même simulation (non stocké). */
  live: DecisionResult;
}
export type RunResult = ({ ok: true } & SimulationRun) | { ok: false; errors: RunErrors };

export interface RunInput {
  name: string;
  /** Durée saisie, en mois (texte du champ). */
  horizonText: string;
  situation: InitialSituation | null;
  decision: DecisionInput;
  /** Mois calendaire du mois 0 (le mois en cours). */
  startMonth: MonthKey;
  /** Injectables pour des tests déterministes. */
  id?: string;
  createdAt?: string;
}

export function runSimulation(input: RunInput): RunResult {
  const errors: RunErrors = {};
  if (!input.name.trim()) errors.name = 'required';
  else if (input.name.length > MAX_NAME_LENGTH) errors.name = 'tooLong';
  if (!input.situation) errors.situation = 'required';

  let horizon: number | null = null;
  if (!input.horizonText.trim()) errors.horizon = 'required';
  else {
    horizon = parseMonths(input.horizonText);
    if (horizon === null) errors.horizon = 'invalid';
    else {
      // Bornes de l'horizon et validité de la décision : règles du moteur, sur l'horizon réel.
      for (const i of validateDecision(input.decision, { horizonMonths: horizon, startMonth: input.startMonth })) {
        if (i.field === 'horizonMonths') errors.horizon ??= i.code;
        else errors.form ??= i.code;
      }
    }
  }
  if (Object.keys(errors).length || horizon === null || !input.situation) return { ok: false, errors };

  const options = { horizonMonths: horizon, startMonth: input.startMonth };
  try {
    const snapshot = createSnapshot({
      name: input.name,
      situation: input.situation,
      horizonMonths: horizon,
      startMonth: input.startMonth,
      variants: [{ id: SINGLE_VARIANT_ID, decision: input.decision }],
      ...(input.id ? { id: input.id } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return { ok: true, snapshot, live: simulateDecision(input.decision, options) };
  } catch (e) {
    if (!(e instanceof DecisionInputError)) throw e;
    for (const i of e.issues) {
      if (i.field.startsWith('situation')) errors.situation ??= 'invalid';
      else if (i.field === 'name') errors.name ??= i.code;
      else if (i.field.endsWith('horizonMonths')) errors.horizon ??= i.code;
      else errors.form ??= i.code; // resultOutOfRange, notAmortizable…
    }
    return { ok: false, errors };
  }
}

// ------------------------------------------------------------------ lecture d'un snapshot

export interface TrajectoryRow {
  month: number;
  monthKey: MonthKey | null;
  refCash: number;
  cash: number;
  cashDelta: number;
  refNetWorth: number;
  netWorth: number;
  netWorthDelta: number;
}

/**
 * Séries mensuelles d'une variante, lues dans le snapshot. « Avec la décision » = référence + écart :
 * c'est la définition même de l'écart stocké (`projectDecision`, `validateSnapshot`), pas un calcul
 * financier. Aucune valeur n'est interpolée : une ligne par mois calculé par le moteur.
 */
export function trajectoryRows(snapshot: DecisionSnapshot, variant = 0): TrajectoryRow[] {
  const { reference, variants } = snapshot.results;
  const v = variants[variant];
  const start = snapshot.hypotheses.startMonth;
  return reference.cash.map((refCash, m) => ({
    month: m,
    monthKey: start ? addMonthsToKey(start, m) : null,
    refCash,
    cash: refCash + v.cashDelta[m],
    cashDelta: v.cashDelta[m],
    refNetWorth: reference.netWorth[m],
    netWorth: reference.netWorth[m] + v.netWorthDelta[m],
    netWorthDelta: v.netWorthDelta[m],
  }));
}

export type NoticeLevel = 'warning' | 'info';
export interface SimulationNotice {
  level: NoticeLevel;
  code: 'negativeCash' | 'goalNotReached' | 'goalAfterHorizon' | 'goalLate' | 'loanBeyondHorizon' | 'loanEarlyPayoff';
  vars: Record<string, number>;
}

/**
 * Avertissements et notes d'une variante, tirés uniquement des résultats du moteur figés dans le
 * snapshot. `warning` : point d'attention (trésorerie négative, cible non atteinte) ; `info` :
 * précision de lecture. Aucun de ces messages n'est bloquant.
 */
export function simulationNotices(snapshot: DecisionSnapshot, variant = 0): SimulationNotice[] {
  const v = snapshot.results.variants[variant];
  const horizon = snapshot.hypotheses.horizonMonths;
  const out: SimulationNotice[] = [];
  if (v.firstNegativeCashMonth !== null) out.push({ level: 'warning', code: 'negativeCash', vars: { month: v.firstNegativeCashMonth } });
  const d = v.details;
  if (d.kind === 'goal') {
    if (d.reachedMonth === null) out.push({ level: 'warning', code: 'goalNotReached', vars: {} });
    else if (d.reachedMonth > horizon) out.push({ level: 'warning', code: 'goalAfterHorizon', vars: { month: d.reachedMonth } });
    if (d.reachedByDeadline === false && d.deadlineMonths !== null) out.push({ level: 'warning', code: 'goalLate', vars: { deadline: d.deadlineMonths } });
  }
  if (d.kind === 'purchase' && d.loan) {
    if (d.loan.actualMonths > horizon) out.push({ level: 'info', code: 'loanBeyondHorizon', vars: { months: d.loan.actualMonths } });
    if (d.loan.earlyPayoffMonth !== null) out.push({ level: 'info', code: 'loanEarlyPayoff', vars: { month: d.loan.earlyPayoffMonth } });
  }
  return out;
}
