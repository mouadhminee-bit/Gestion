/**
 * Decision Lab — comparateur multi-variantes (étape E5.5) : exécution et lecture d'une comparaison.
 *
 * Une comparaison = une situation initiale commune, un horizon commun, un seul type de décision et
 * 2 à 4 variantes, chacune avec ses propres hypothèses et son nom. Elle est exécutée par le moteur E3
 * (`compareDecisions`, via `createSnapshot` du contrat E4) : même référence sans décision, mêmes
 * mois, mêmes unités pour toutes les variantes. Le snapshot affiché est exactement celui qui sera
 * enregistré.
 *
 * Aucun calcul financier ici. Les indicateurs sont lus dans les résultats figés du moteur ; l'écart
 * d'une variante est une simple soustraction de deux sorties du moteur, avec une règle de signe
 * unique et explicite : écart = valeur de la variante − valeur de la variante A (la première).
 * Un écart positif signifie seulement « valeur plus élevée que A » : il ne qualifie pas la variante.
 *
 * Règles propres à la comparaison (le moteur ne les impose pas toutes) :
 *  - toutes les variantes ont le même type de décision (code `mixedKinds`) ;
 *  - chaque variante a un nom non vide, de 80 caractères au plus, distinct des autres ;
 *  - chaque variante est validée par le moteur sur l'horizon réel, indépendamment des autres.
 * Un objectif d'épargne peut mélanger les méthodes (délai fixé, versement fixé) d'une variante à
 * l'autre : c'est le même type de décision.
 */
import type { MonthKey } from '@/domain/dates';
import {
  DecisionInputError,
  MAX_VARIANTS,
  MIN_VARIANTS,
  simulateDecision,
  validateDecision,
  type DecisionInput,
  type DecisionResult,
  type InitialSituation,
} from '@/domain/calc/decision';
import { parseMonths, type DecisionKind } from './decisionDraft';
import { trajectoryRows } from './simulationRun';
import { createSnapshot, MAX_LABEL_LENGTH, MAX_NAME_LENGTH, type DecisionSnapshot, type SnapshotVariantResult } from './snapshot';

/** Identifiants des variantes dans le snapshot, par position : la première (A) sert de base aux écarts. */
export const VARIANT_IDS = ['A', 'B', 'C', 'D'] as const;

export interface ComparisonVariantInput {
  /** Nom de la variante saisi par l'utilisateur. */
  label: string;
  /** Entrée validée par le formulaire ; null tant que la variante n'est pas validée. */
  decision: DecisionInput | null;
}

export interface ComparisonInput {
  name: string;
  /** Durée commune saisie, en mois (texte du champ). */
  horizonText: string;
  situation: InitialSituation | null;
  variants: ComparisonVariantInput[];
  /** Mois calendaire du mois 0 (le mois en cours). */
  startMonth: MonthKey;
  /** Injectables pour des tests déterministes. */
  id?: string;
  createdAt?: string;
}

export interface VariantErrors {
  label?: string;
  decision?: string;
}
/**
 * Erreurs bloquantes. `form` : erreur commune (`variantCount`, `mixedKinds`…) ; `variants[k]` :
 * erreurs propres à la variante de rang k (codes de l'interface ou du moteur).
 */
export interface ComparisonErrors {
  name?: string;
  horizon?: string;
  situation?: string;
  form?: string;
  variants?: Record<number, VariantErrors>;
}

export interface ComparisonRun {
  /** Hypothèses et résultats figés (contrat E4), prêts à être enregistrés tels quels. */
  snapshot: DecisionSnapshot;
  /** Détail mensuel du moteur pour chaque variante (non stocké), dans l'ordre des variantes. */
  live: DecisionResult[];
}
export type ComparisonResult = ({ ok: true } & ComparisonRun) | { ok: false; errors: ComparisonErrors };

/** Contrôle du nom d'une variante, indépendant du moteur (`labels` : noms de toutes les variantes). */
export function labelError(labels: string[], k: number): string | undefined {
  const l = labels[k].trim();
  if (!l) return 'required';
  if (labels[k].length > MAX_LABEL_LENGTH) return 'tooLong';
  if (labels.some((o, j) => j !== k && o.trim().toLocaleLowerCase() === l.toLocaleLowerCase())) return 'duplicate';
  return undefined;
}

export function runComparison(input: ComparisonInput): ComparisonResult {
  const errors: ComparisonErrors = {};
  const vErr: Record<number, VariantErrors> = {};
  const setV = (k: number, field: keyof VariantErrors, code: string) => {
    vErr[k] ??= {};
    vErr[k][field] ??= code;
  };

  if (!input.name.trim()) errors.name = 'required';
  else if (input.name.length > MAX_NAME_LENGTH) errors.name = 'tooLong';
  if (!input.situation) errors.situation = 'required';

  const variants = input.variants;
  if (variants.length < MIN_VARIANTS || variants.length > MAX_VARIANTS) errors.form = 'variantCount';
  const labels = variants.map((v) => v.label);
  variants.forEach((v, k) => {
    const le = labelError(labels, k);
    if (le) setV(k, 'label', le);
    if (!v.decision) setV(k, 'decision', 'notValidated');
  });
  const kinds = new Set(variants.filter((v) => v.decision).map((v) => v.decision!.kind));
  if (kinds.size > 1) errors.form ??= 'mixedKinds';

  let horizon: number | null = null;
  if (!input.horizonText.trim()) errors.horizon = 'required';
  else {
    horizon = parseMonths(input.horizonText);
    if (horizon === null) errors.horizon = 'invalid';
    else {
      // Chaque variante est validée par le moteur sur l'horizon réel, indépendamment des autres.
      variants.forEach((v, k) => {
        if (!v.decision) return;
        for (const i of validateDecision(v.decision, { horizonMonths: horizon!, startMonth: input.startMonth })) {
          if (i.field === 'horizonMonths') errors.horizon ??= i.code;
          else setV(k, 'decision', i.code);
        }
      });
    }
  }
  if (Object.keys(vErr).length) errors.variants = vErr;
  if (Object.keys(errors).length || horizon === null || !input.situation) return { ok: false, errors };

  const decisions = variants.map((v) => v.decision!);
  const options = { horizonMonths: horizon, startMonth: input.startMonth };
  // Chaque variante est d'abord exécutée seule : une erreur du moteur sur l'horizon réel (montants
  // hors bornes…) est ainsi attribuée à la variante concernée. Ces résultats sont le détail mensuel.
  const live: DecisionResult[] = [];
  decisions.forEach((d, k) => {
    try {
      live.push(simulateDecision(d, options));
    } catch (e) {
      if (!(e instanceof DecisionInputError)) throw e;
      for (const i of e.issues) setV(k, 'decision', i.code);
    }
  });
  if (Object.keys(vErr).length) return { ok: false, errors: { ...errors, variants: vErr } };
  try {
    const snapshot = createSnapshot({
      name: input.name,
      situation: input.situation,
      horizonMonths: horizon,
      startMonth: input.startMonth,
      variants: decisions.map((decision, k) => ({ id: VARIANT_IDS[k], label: variants[k].label.trim(), decision })),
      ...(input.id ? { id: input.id } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return { ok: true, snapshot, live };
  } catch (e) {
    if (!(e instanceof DecisionInputError)) throw e;
    for (const i of e.issues) {
      const m = /^variants\[(\d+)\]\.(.+)$/.exec(i.field);
      if (m) {
        if (m[2] === 'label') setV(Number(m[1]), 'label', i.code);
        else setV(Number(m[1]), 'decision', i.code); // resultOutOfRange, notAmortizable…
      } else if (i.field.startsWith('situation')) errors.situation ??= 'invalid';
      else if (i.field === 'name') errors.name ??= i.code;
      else if (i.field.endsWith('horizonMonths')) errors.horizon ??= i.code;
      else errors.form ??= i.code;
    }
    if (Object.keys(vErr).length) errors.variants = vErr;
    return { ok: false, errors };
  }
}

// ------------------------------------------------------------------ lecture d'une comparaison

/** Nom affiché d'une variante enregistrée. */
export function variantLabel(snapshot: DecisionSnapshot, k: number): string {
  const v = snapshot.hypotheses.variants[k];
  return v.label ?? v.id;
}

/**
 * Écart « variante − A » entre deux sorties du moteur. null si l'une des valeurs est absente (pas de
 * crédit, cible non atteinte…) ou si l'écart sortirait des entiers exacts (jamais d'arrondi caché).
 */
export function differenceFromA(value: number | null, a: number | null): number | null {
  if (value === null || a === null) return null;
  const d = value - a;
  return Number.isSafeInteger(d) ? d : null;
}

export type IndicatorUnit = 'money' | 'month' | 'count';
export type IndicatorKey =
  | 'endCash'
  | 'endCashDelta'
  | 'endNetWorth'
  | 'endNetWorthDelta'
  | 'lowestCash'
  | 'lowestCashMonth'
  | 'firstNegativeCashMonth'
  | 'loanInstallment'
  | 'loanLastInstallment'
  | 'loanMonths'
  | 'loanInterest'
  | 'loanPaid'
  | 'goalContribution'
  | 'goalReachedMonth'
  | 'goalContributed'
  | 'goalInterest'
  | 'goalShortfall'
  | 'goalFinal'
  | 'invFinal'
  | 'invContributions'
  | 'invInterest';

export interface Indicator {
  key: IndicatorKey;
  unit: IndicatorUnit;
  /** Valeur par variante (null : sans objet pour cette variante). */
  values: (number | null)[];
  /** Écart « variante − A » par variante ; toujours null pour A. */
  differences: (number | null)[];
}

type Reader = (v: SnapshotVariantResult) => number | null;
const COMMON: [IndicatorKey, IndicatorUnit, Reader][] = [
  ['endCash', 'money', (v) => v.endOfHorizon.cash],
  ['endCashDelta', 'money', (v) => v.endOfHorizon.cashDelta],
  ['endNetWorth', 'money', (v) => v.endOfHorizon.netWorth],
  ['endNetWorthDelta', 'money', (v) => v.endOfHorizon.netWorthDelta],
  ['lowestCash', 'money', (v) => v.lowestCash.value],
  ['lowestCashMonth', 'month', (v) => v.lowestCash.month],
  ['firstNegativeCashMonth', 'month', (v) => v.firstNegativeCashMonth],
];
const loan = (f: (l: NonNullable<Extract<SnapshotVariantResult['details'], { kind: 'purchase' }>['loan']>) => number): Reader => (v) =>
  v.details.kind === 'purchase' && v.details.loan ? f(v.details.loan) : null;
const goal = (f: (g: Extract<SnapshotVariantResult['details'], { kind: 'goal' }>) => number | null): Reader => (v) => (v.details.kind === 'goal' ? f(v.details) : null);
const inv = (f: (g: Extract<SnapshotVariantResult['details'], { kind: 'investment' }>) => number): Reader => (v) => (v.details.kind === 'investment' ? f(v.details) : null);
const SPECIFIC: Record<DecisionKind, [IndicatorKey, IndicatorUnit, Reader][]> = {
  purchase: [
    ['loanInstallment', 'money', loan((l) => l.installment)],
    ['loanLastInstallment', 'money', loan((l) => l.lastInstallment)],
    ['loanMonths', 'count', loan((l) => l.actualMonths)],
    ['loanInterest', 'money', loan((l) => l.totalInterest)],
    ['loanPaid', 'money', loan((l) => l.totalPaid)],
  ],
  recurring: [],
  goal: [
    ['goalContribution', 'money', goal((g) => g.monthlyContribution)],
    ['goalReachedMonth', 'month', goal((g) => g.reachedMonth)],
    ['goalContributed', 'money', goal((g) => g.totalContributed)],
    ['goalInterest', 'money', goal((g) => g.totalInterest)],
    ['goalShortfall', 'money', goal((g) => g.shortfallAtDeadline)],
    ['goalFinal', 'money', goal((g) => g.finalBalance)],
  ],
  investment: [
    ['invFinal', 'money', inv((d) => d.finalBalance)],
    ['invContributions', 'money', inv((d) => d.totalContributions)],
    ['invInterest', 'money', inv((d) => d.totalInterest)],
  ],
};

/**
 * Indicateurs comparés, lus dans les résultats figés : les indicateurs communs puis ceux du type de
 * décision. Un indicateur propre au type n'est retenu que si le moteur le fournit pour au moins une
 * variante (ex. crédit : au moins une variante financée).
 */
export function comparisonIndicators(snapshot: DecisionSnapshot): Indicator[] {
  const results = snapshot.results.variants;
  const kind = snapshot.hypotheses.variants[0].decision.kind;
  const out: Indicator[] = [];
  for (const [key, unit, read] of [...COMMON, ...SPECIFIC[kind]]) {
    const values = results.map(read);
    if (!COMMON.some((c) => c[0] === key) && values.every((x) => x === null)) continue;
    out.push({ key, unit, values, differences: values.map((x, k) => (k === 0 ? null : differenceFromA(x, values[0]))) });
  }
  return out;
}

export interface ComparisonRow {
  month: number;
  monthKey: MonthKey | null;
  refCash: number;
  refNetWorth: number;
  /** Par variante, dans l'ordre : référence + écart stocké (définition de l'écart, pas un calcul). */
  cash: number[];
  netWorth: number[];
}

/** Séries mensuelles de toutes les variantes : une ligne par mois calculé, sans interpolation. */
export function comparisonRows(snapshot: DecisionSnapshot): ComparisonRow[] {
  const all = snapshot.results.variants.map((_, k) => trajectoryRows(snapshot, k));
  return all[0].map((r, m) => ({
    month: r.month,
    monthKey: r.monthKey,
    refCash: r.refCash,
    refNetWorth: r.refNetWorth,
    cash: all.map((rows) => rows[m].cash),
    netWorth: all.map((rows) => rows[m].netWorth),
  }));
}
