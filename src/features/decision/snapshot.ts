/**
 * Decision Lab — snapshot d'une simulation : hypothèses et résultats FIGÉS.
 *
 * Un snapshot est autonome : il ne référence aucun identifiant de compte, de transaction, de budget
 * ou d'objectif. Il est créé par `createSnapshot` (qui exécute le moteur pur de `domain/calc/decision`)
 * puis n'est plus jamais recalculé : relire un snapshot ne relance pas le moteur. Un recalcul est
 * une NOUVELLE simulation (nouvel identifiant), l'ancienne reste intacte.
 *
 * Résultats stockés sous forme compacte : synthèses, détails par type de décision et séries
 * mensuelles d'écart de trésorerie et de patrimoine. Les échéanciers détaillés (crédit, placement,
 * objectif) ne sont pas stockés : 50 simulations de 480 mois dépasseraient le quota de
 * `sessionStorage` ; ils se re-dérivent des hypothèses avec la même version du moteur.
 *
 * `validateSnapshot` contrôle strictement une valeur inconnue (lecture du stockage, écriture) :
 * structure exacte, types, entiers sûrs, dates, types de décision (via `validateDecision`), tailles
 * des séries et cohérence interne des résultats. Elle ne lève jamais d'exception.
 */
import type { MonthKey } from '@/domain/dates';
import {
  compareDecisions,
  DECISION_ENGINE_VERSION,
  DecisionInputError,
  goalHorizonTotalsFromImpact,
  MAX_HORIZON_MONTHS,
  MAX_VARIANTS,
  projectDecision,
  referenceTrajectory,
  simulateDecision,
  validateDecision,
  type DecisionInput,
  type DecisionResult,
  type DecisionSummary,
  type InitialSituation,
  type TrajectoryPoint,
} from '@/domain/calc/decision';
import { newId, nowISO } from '@/lib/id';

export const MAX_NAME_LENGTH = 120;
export const MAX_LABEL_LENGTH = 80;

export interface SnapshotVariantInput {
  id: string;
  label?: string;
  decision: DecisionInput;
}

export interface SnapshotHypotheses {
  situation: InitialSituation;
  horizonMonths: number;
  /** Mois calendaire du mois 0 (null : non renseigné). */
  startMonth: MonthKey | null;
  variants: SnapshotVariantInput[];
}

export type SnapshotDetails =
  | { kind: 'purchase'; loan: { installment: number; lastInstallment: number; totalInterest: number; totalPaid: number; months: number; actualMonths: number; earlyPayoffMonth: number | null } | null }
  | { kind: 'recurring' }
  | {
      kind: 'goal';
      mode: 'effort' | 'contribution';
      monthlyContribution: number;
      reachedMonth: number | null;
      lastContribution: number;
      /** Échéancier jusqu'à l'atteinte (ou 480 mois) : période propre à l'objectif. */
      totalContributed: number;
      totalInterest: number;
      /** Versements nécessaires pour atteindre la cible (null : non atteinte). */
      contributionsToReach: number | null;
      /** Versements et intérêts du mois 1 à la fin de l'horizon simulé. */
      contributedToHorizon: number;
      interestToHorizon: number;
      balanceAtReach: number | null;
      deadlineMonths: number | null;
      reachedByDeadline: boolean | null;
      balanceAtDeadline: number | null;
      shortfallAtDeadline: number | null;
      finalBalance: number;
      interestAfterReach: number;
    }
  | { kind: 'investment'; finalBalance: number; totalContributions: number; totalInterest: number };

export interface SnapshotVariantResult {
  id: string;
  summary: DecisionSummary;
  endOfHorizon: { cash: number; netWorth: number; cashDelta: number; netWorthDelta: number };
  lowestCash: { month: number; value: number };
  firstNegativeCashMonth: number | null;
  /** Écarts par rapport à la référence, mois 0 à l'horizon. */
  cashDelta: number[];
  netWorthDelta: number[];
  details: SnapshotDetails;
}

export interface SnapshotResults {
  /** Référence sans décision, mois 0 à l'horizon. */
  reference: { cash: number[]; netWorth: number[] };
  variants: SnapshotVariantResult[];
}

export interface DecisionSnapshot {
  id: string;
  name: string;
  /** Date de création, ISO 8601 UTC (`AAAA-MM-JJTHH:MM:SS.sssZ`). */
  createdAt: string;
  /** Version du moteur ayant produit les résultats. */
  engineVersion: number;
  hypotheses: SnapshotHypotheses;
  results: SnapshotResults;
}

// ------------------------------------------------------------------ création

function detailsOf(r: DecisionResult): SnapshotDetails {
  switch (r.kind) {
    case 'purchase': {
      const l = r.loan;
      return {
        kind: 'purchase',
        loan: l ? { installment: l.installment, lastInstallment: l.lastInstallment, totalInterest: l.totalInterest, totalPaid: l.totalPaid, months: l.months, actualMonths: l.actualMonths, earlyPayoffMonth: l.earlyPayoffMonth } : null,
      };
    }
    case 'recurring':
      return { kind: 'recurring' };
    case 'goal': {
      const g = r.goal!;
      return {
        kind: 'goal',
        mode: g.mode,
        monthlyContribution: g.monthlyContribution,
        reachedMonth: g.reachedMonth,
        lastContribution: g.lastContribution,
        totalContributed: g.totalContributed,
        totalInterest: g.totalInterest,
        contributionsToReach: g.contributionsToReach,
        contributedToHorizon: g.contributedToHorizon,
        interestToHorizon: g.interestToHorizon,
        balanceAtReach: g.balanceAtReach,
        deadlineMonths: g.deadlineMonths,
        reachedByDeadline: g.reachedByDeadline,
        balanceAtDeadline: g.balanceAtDeadline,
        shortfallAtDeadline: g.shortfallAtDeadline,
        finalBalance: g.finalBalance,
        interestAfterReach: g.interestAfterReach,
      };
    }
    case 'investment': {
      const last = r.savings![r.savings!.length - 1];
      return { kind: 'investment', finalBalance: last.closingBalance, totalContributions: last.cumulativeContributions, totalInterest: last.cumulativeInterest };
    }
  }
}

function variantResult(id: string, result: DecisionResult, trajectory: TrajectoryPoint[]): SnapshotVariantResult {
  const end = trajectory[trajectory.length - 1];
  let low = trajectory[0];
  for (const p of trajectory) if (p.withDecision.cash < low.withDecision.cash) low = p;
  const neg = trajectory.find((p) => p.withDecision.cash < 0);
  return {
    id,
    summary: { ...result.summary },
    endOfHorizon: { cash: end.withDecision.cash, netWorth: end.withDecision.netWorth, cashDelta: end.delta.cash, netWorthDelta: end.delta.netWorth },
    lowestCash: { month: low.month, value: low.withDecision.cash },
    firstNegativeCashMonth: neg ? neg.month : null,
    cashDelta: trajectory.map((p) => p.delta.cash),
    netWorthDelta: trajectory.map((p) => p.delta.netWorth),
    details: detailsOf(result),
  };
}

export interface CreateSnapshotInput {
  name: string;
  situation: InitialSituation;
  horizonMonths: number;
  startMonth?: MonthKey | null;
  /** 1 à 4 variantes (2 à 4 : comparaison contre la même référence). */
  variants: SnapshotVariantInput[];
  /** Injectables pour des tests déterministes. */
  id?: string;
  createdAt?: string;
}

/**
 * Exécute le moteur et fige hypothèses et résultats dans un nouveau snapshot (nouvel identifiant).
 * Les entrées ne sont pas modifiées ; le snapshot n'en partage aucune référence.
 * Lève `DecisionInputError` si les hypothèses sont invalides.
 */
export function createSnapshot(input: CreateSnapshotInput): DecisionSnapshot {
  const issues: { field: string; code: string }[] = [];
  if (typeof input.name !== 'string' || !input.name.trim()) issues.push({ field: 'name', code: 'required' });
  else if (input.name.length > MAX_NAME_LENGTH) issues.push({ field: 'name', code: 'tooLong' });
  if (!Array.isArray(input.variants) || input.variants.length < 1 || input.variants.length > MAX_VARIANTS) issues.push({ field: 'variants', code: 'variantCount' });
  else {
    input.variants.forEach((v, k) => {
      if (v.label !== undefined && (typeof v.label !== 'string' || v.label.length > MAX_LABEL_LENGTH)) issues.push({ field: `variants[${k}].label`, code: 'tooLong' });
    });
  }
  if (issues.length) throw new DecisionInputError(issues);

  const options = { horizonMonths: input.horizonMonths, ...(input.startMonth ? { startMonth: input.startMonth } : {}) };
  const situation: InitialSituation = { cash: input.situation.cash, netWorth: input.situation.netWorth, monthlySavings: input.situation.monthlySavings };
  let reference: { cash: number; netWorth: number }[];
  let variants: SnapshotVariantResult[];
  if (input.variants.length === 1) {
    const v = input.variants[0];
    if (typeof v.id !== 'string' || !v.id) throw new DecisionInputError([{ field: 'variants[0].id', code: 'required' }]);
    const ref = referenceTrajectory(situation, options);
    const result = simulateDecision(v.decision, options);
    reference = ref;
    variants = [variantResult(v.id, result, projectDecision(ref, result))];
  } else {
    const cmp = compareDecisions(situation, input.variants, options);
    reference = cmp.reference;
    variants = cmp.variants.map((v) => variantResult(v.id, v.result, v.trajectory));
  }
  const snapshot: DecisionSnapshot = {
    id: input.id ?? newId(),
    name: input.name,
    createdAt: input.createdAt ?? nowISO(),
    engineVersion: DECISION_ENGINE_VERSION,
    hypotheses: {
      situation,
      horizonMonths: input.horizonMonths,
      startMonth: input.startMonth ?? null,
      // Copie profonde : le snapshot ne partage aucune référence avec les entrées.
      variants: JSON.parse(JSON.stringify(input.variants.map((v) => ({ id: v.id, ...(v.label !== undefined ? { label: v.label } : {}), decision: v.decision })))) as SnapshotVariantInput[],
    },
    results: { reference: { cash: reference.map((p) => p.cash), netWorth: reference.map((p) => p.netWorth) }, variants },
  };
  const check = validateSnapshot(snapshot);
  if (!check.ok) throw new Error(`snapshot incohérent : ${check.errors.join(' ; ')}`);
  return check.value;
}

// ------------------------------------------------------------------ validation stricte

export type SnapshotValidation = { ok: true; value: DecisionSnapshot } | { ok: false; errors: string[] };

const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

class Checker {
  errors: string[] = [];
  fail(path: string, why: string): false {
    this.errors.push(`${path} : ${why}`);
    return false;
  }
  /** Objet aux clés exactement attendues (aucune clé manquante hors `optional`, aucune clé inconnue). */
  shape(v: unknown, path: string, required: string[], optional: string[] = []): v is Record<string, unknown> {
    if (!isObject(v)) return this.fail(path, 'objet attendu');
    let ok = true;
    for (const k of required) if (!(k in v)) ok = this.fail(`${path}.${k}`, 'champ manquant');
    for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) ok = this.fail(`${path}.${k}`, 'champ inconnu');
    return ok;
  }
  int(v: unknown, path: string, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): v is number {
    if (!isInt(v)) return this.fail(path, 'entier attendu');
    if (v < min || v > max) return this.fail(path, 'valeur hors bornes');
    return true;
  }
  intOrNull(v: unknown, path: string, min?: number, max?: number): boolean {
    return v === null || this.int(v, path, min, max);
  }
  text(v: unknown, path: string, max: number): v is string {
    if (typeof v !== 'string' || !v.trim()) return this.fail(path, 'texte non vide attendu');
    if (v.length > max) return this.fail(path, 'texte trop long');
    return true;
  }
  series(v: unknown, path: string, length: number): v is number[] {
    if (!Array.isArray(v)) return this.fail(path, 'série attendue');
    if (v.length !== length) return this.fail(path, `série de ${length} valeurs attendue`);
    if (!v.every(isInt)) return this.fail(path, 'valeurs entières attendues');
    return true;
  }
}

const SUMMARY_KEYS = ['finalCumulativeCash', 'finalNetWorthImpact', 'finalAssets', 'finalLiabilities', 'lowestCumulativeCash', 'lowestCumulativeCashMonth'];
const LOAN_KEYS = ['installment', 'lastInstallment', 'totalInterest', 'totalPaid', 'months', 'actualMonths', 'earlyPayoffMonth'];
const DECISION_KEYS: Record<DecisionInput['kind'], string[]> = {
  purchase: ['kind', 'price', 'downPayment', 'fees', 'assetValue', 'loan', 'insuranceMonthly', 'insuranceMonths'],
  recurring: ['kind', 'monthlyAmount', 'startMonth', 'months'],
  goal: ['kind', 'mode', 'target', 'effectiveRateBps', 'months', 'monthlyContribution', 'deadlineMonths'],
  investment: ['kind', 'initialCapital', 'monthlyContribution', 'contributionMonths', 'effectiveRateBps'],
};
const GOAL_KEYS = ['kind', 'mode', 'monthlyContribution', 'reachedMonth', 'lastContribution', 'totalContributed', 'totalInterest', 'balanceAtReach', 'deadlineMonths', 'reachedByDeadline', 'balanceAtDeadline', 'shortfallAtDeadline', 'finalBalance', 'interestAfterReach'];
/**
 * Totaux de l'objectif sur l'horizon (correction A2). Absents des simulations enregistrées avant
 * cette correction (format 1 inchangé) : ils sont alors reconstitués à la lecture, exactement, à partir
 * des séries figées (`goalHorizonTotalsFromImpact`) — aucune simulation existante n'est invalidée.
 * Présents : tous obligatoires et contrôlés contre ces mêmes séries.
 */
const GOAL_HORIZON_KEYS = ['contributionsToReach', 'contributedToHorizon', 'interestToHorizon'];

function checkDetails(c: Checker, d: unknown, path: string, kind: DecisionInput['kind']): void {
  if (!isObject(d)) return void c.fail(path, 'objet attendu');
  if (d.kind !== kind) return void c.fail(`${path}.kind`, 'type différent de celui de la décision');
  switch (kind) {
    case 'recurring':
      c.shape(d, path, ['kind']);
      return;
    case 'investment':
      if (c.shape(d, path, ['kind', 'finalBalance', 'totalContributions', 'totalInterest'])) for (const k of ['finalBalance', 'totalContributions', 'totalInterest']) c.int(d[k], `${path}.${k}`, 0);
      return;
    case 'purchase':
      if (!c.shape(d, path, ['kind', 'loan'])) return;
      if (d.loan === null) return;
      if (c.shape(d.loan, `${path}.loan`, LOAN_KEYS)) {
        const l = d.loan as Record<string, unknown>;
        for (const k of ['installment', 'lastInstallment', 'totalInterest', 'totalPaid']) c.int(l[k], `${path}.loan.${k}`, 0);
        c.int(l.months, `${path}.loan.months`, 1, MAX_HORIZON_MONTHS);
        c.int(l.actualMonths, `${path}.loan.actualMonths`, 1, MAX_HORIZON_MONTHS);
        c.intOrNull(l.earlyPayoffMonth, `${path}.loan.earlyPayoffMonth`, 1, MAX_HORIZON_MONTHS);
      }
      return;
    case 'goal': {
      const horizonKeys = GOAL_HORIZON_KEYS.filter((k) => k in d);
      if (horizonKeys.length && horizonKeys.length !== GOAL_HORIZON_KEYS.length) return void c.fail(path, 'totaux de l\'horizon incomplets');
      if (!c.shape(d, path, [...GOAL_KEYS, ...horizonKeys])) return;
      if (horizonKeys.length) {
        c.int(d.contributedToHorizon, `${path}.contributedToHorizon`, 0);
        c.int(d.interestToHorizon, `${path}.interestToHorizon`, 0);
        c.intOrNull(d.contributionsToReach, `${path}.contributionsToReach`, 0);
        if (d.contributionsToReach !== (d.reachedMonth === null ? null : d.totalContributed)) c.fail(`${path}.contributionsToReach`, 'incohérent avec l\'atteinte');
      }
      if (d.mode !== 'effort' && d.mode !== 'contribution') c.fail(`${path}.mode`, 'mode inconnu');
      for (const k of ['monthlyContribution', 'lastContribution', 'totalContributed', 'totalInterest', 'finalBalance', 'interestAfterReach']) c.int(d[k], `${path}.${k}`, 0);
      for (const k of ['reachedMonth', 'deadlineMonths']) c.intOrNull(d[k], `${path}.${k}`, 1, MAX_HORIZON_MONTHS);
      for (const k of ['balanceAtReach', 'balanceAtDeadline', 'shortfallAtDeadline']) c.intOrNull(d[k], `${path}.${k}`, 0);
      if (d.reachedByDeadline !== null && typeof d.reachedByDeadline !== 'boolean') c.fail(`${path}.reachedByDeadline`, 'booléen ou null attendu');
    }
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/**
 * Valide strictement une valeur inconnue. En cas de succès, renvoie une COPIE profonde gelée
 * (le snapshot renvoyé ne peut pas être modifié et ne partage rien avec l'entrée).
 */
export function validateSnapshot(raw: unknown): SnapshotValidation {
  const c = new Checker();
  try {
    if (!c.shape(raw, 'snapshot', ['id', 'name', 'createdAt', 'engineVersion', 'hypotheses', 'results'])) return { ok: false, errors: c.errors };
    c.text(raw.id, 'id', 64);
    c.text(raw.name, 'name', MAX_NAME_LENGTH);
    if (typeof raw.createdAt !== 'string' || !CREATED_AT.test(raw.createdAt) || Number.isNaN(Date.parse(raw.createdAt)) || new Date(raw.createdAt).toISOString() !== raw.createdAt) c.fail('createdAt', 'date ISO 8601 UTC attendue');
    c.int(raw.engineVersion, 'engineVersion', 1);

    const h = raw.hypotheses;
    const r = raw.results;
    if (!c.shape(h, 'hypotheses', ['situation', 'horizonMonths', 'startMonth', 'variants']) || !c.shape(r, 'results', ['reference', 'variants'])) return { ok: false, errors: c.errors };
    if (c.shape(h.situation, 'hypotheses.situation', ['cash', 'netWorth', 'monthlySavings'])) for (const k of ['cash', 'netWorth', 'monthlySavings']) c.int((h.situation as Record<string, unknown>)[k], `hypotheses.situation.${k}`);
    if (h.startMonth !== null && (typeof h.startMonth !== 'string' || !MONTH.test(h.startMonth))) c.fail('hypotheses.startMonth', 'mois AAAA-MM ou null attendu');
    if (!c.int(h.horizonMonths, 'hypotheses.horizonMonths', 1, MAX_HORIZON_MONTHS)) return { ok: false, errors: c.errors };
    const horizon = h.horizonMonths;
    const n = horizon + 1;

    if (!Array.isArray(h.variants) || h.variants.length < 1 || h.variants.length > MAX_VARIANTS) return { ok: false, errors: [...c.errors, 'hypotheses.variants : 1 à 4 variantes attendues'] };
    if (!Array.isArray(r.variants) || r.variants.length !== h.variants.length) return { ok: false, errors: [...c.errors, 'results.variants : une entrée par variante attendue'] };
    const refOk = c.shape(r.reference, 'results.reference', ['cash', 'netWorth']) && c.series((r.reference as Record<string, unknown>).cash, 'results.reference.cash', n) && c.series((r.reference as Record<string, unknown>).netWorth, 'results.reference.netWorth', n);
    const ref = r.reference as { cash: number[]; netWorth: number[] };
    if (refOk && isObject(h.situation) && (ref.cash[0] !== h.situation.cash || ref.netWorth[0] !== h.situation.netWorth)) c.fail('results.reference', 'le mois 0 diffère de la situation initiale');

    const resultVariants: unknown[] = r.variants;
    const ids = new Set<string>();
    h.variants.forEach((v: unknown, k: number) => {
      const hp = `hypotheses.variants[${k}]`;
      const rp = `results.variants[${k}]`;
      if (!c.shape(v, hp, ['id', 'decision'], ['label'])) return;
      if (c.text(v.id, `${hp}.id`, 64)) {
        if (ids.has(v.id)) c.fail(`${hp}.id`, 'identifiant en double');
        ids.add(v.id);
      }
      if ('label' in v) c.text(v.label, `${hp}.label`, MAX_LABEL_LENGTH);
      // Types de décision, champs obligatoires et valeurs numériques : mêmes règles que le moteur.
      const issues = validateDecision(v.decision as DecisionInput, { horizonMonths: horizon, ...(typeof h.startMonth === 'string' ? { startMonth: h.startMonth } : {}) });
      for (const i of issues) c.fail(`${hp}.decision.${i.field}`, i.code);
      const kind = issues.length ? null : (v.decision as DecisionInput).kind;
      if (kind) {
        const d = v.decision as Record<string, unknown>;
        for (const key of Object.keys(d)) if (!DECISION_KEYS[kind].includes(key)) c.fail(`${hp}.decision.${key}`, 'champ inconnu');
        if (kind === 'purchase' && isObject(d.loan)) for (const key of Object.keys(d.loan)) if (!['nominalRateBps', 'months'].includes(key)) c.fail(`${hp}.decision.loan.${key}`, 'champ inconnu');
      }

      const res = resultVariants[k];
      if (!c.shape(res, rp, ['id', 'summary', 'endOfHorizon', 'lowestCash', 'firstNegativeCashMonth', 'cashDelta', 'netWorthDelta', 'details'])) return;
      if (res.id !== v.id) c.fail(`${rp}.id`, 'ne correspond pas à la variante');
      const sumOk = c.shape(res.summary, `${rp}.summary`, SUMMARY_KEYS) && SUMMARY_KEYS.map((key) => c.int((res.summary as Record<string, unknown>)[key], `${rp}.summary.${key}`)).every(Boolean);
      const endOk = c.shape(res.endOfHorizon, `${rp}.endOfHorizon`, ['cash', 'netWorth', 'cashDelta', 'netWorthDelta']) && ['cash', 'netWorth', 'cashDelta', 'netWorthDelta'].map((key) => c.int((res.endOfHorizon as Record<string, unknown>)[key], `${rp}.endOfHorizon.${key}`)).every(Boolean);
      const lowOk = c.shape(res.lowestCash, `${rp}.lowestCash`, ['month', 'value']) && c.int((res.lowestCash as Record<string, unknown>).month, `${rp}.lowestCash.month`, 0, horizon) && c.int((res.lowestCash as Record<string, unknown>).value, `${rp}.lowestCash.value`);
      const negOk = c.intOrNull(res.firstNegativeCashMonth, `${rp}.firstNegativeCashMonth`, 0, horizon);
      const seriesOk = c.series(res.cashDelta, `${rp}.cashDelta`, n) && c.series(res.netWorthDelta, `${rp}.netWorthDelta`, n);
      if (kind) checkDetails(c, res.details, `${rp}.details`, kind);

      // Cohérence interne des résultats figés (détecte une altération partielle).
      if (refOk && sumOk && endOk && lowOk && negOk && seriesOk) {
        const cash = res.cashDelta as number[];
        const nw = res.netWorthDelta as number[];
        const s = res.summary as unknown as DecisionSummary;
        const e = res.endOfHorizon as SnapshotVariantResult['endOfHorizon'];
        const low = res.lowestCash as SnapshotVariantResult['lowestCash'];
        const total = cash.map((d, m) => ref.cash[m] + d);
        // Chaque mois « avec la décision » (référence + écart) doit rester un entier exact (A3) : les
        // séries affichées et les tableaux de valeurs en dépendent.
        if (!total.every(isInt) || !nw.every((d, m) => isInt(ref.netWorth[m] + d))) c.fail(rp, 'valeurs hors des entiers exacts');
        const min = Math.min(...total);
        const firstNeg = total.findIndex((x) => x < 0);
        if (s.finalCumulativeCash !== cash[horizon] || s.finalNetWorthImpact !== nw[horizon]) c.fail(`${rp}.summary`, 'incohérent avec les séries');
        if (s.lowestCumulativeCash !== Math.min(...cash) || cash[s.lowestCumulativeCashMonth] !== s.lowestCumulativeCash) c.fail(`${rp}.summary.lowestCumulativeCash`, 'incohérent avec les séries');
        if (e.cashDelta !== cash[horizon] || e.netWorthDelta !== nw[horizon] || e.cash !== total[horizon] || e.netWorth !== ref.netWorth[horizon] + nw[horizon]) c.fail(`${rp}.endOfHorizon`, 'incohérent avec les séries');
        if (low.value !== min || total[low.month] !== min) c.fail(`${rp}.lowestCash`, 'incohérent avec les séries');
        if ((firstNeg === -1 ? null : firstNeg) !== res.firstNegativeCashMonth) c.fail(`${rp}.firstNegativeCashMonth`, 'incohérent avec les séries');
        // Objectif : totaux de l'horizon = identité des séries ; solde final = versé + intérêts.
        const det = res.details as Record<string, unknown>;
        if (kind === 'goal' && isObject(det) && 'contributedToHorizon' in det) {
          const expected = goalHorizonTotalsFromImpact(cash[horizon], nw[horizon]);
          if (det.contributedToHorizon !== expected.contributedToHorizon || det.interestToHorizon !== expected.interestToHorizon || det.finalBalance !== expected.contributedToHorizon + expected.interestToHorizon) {
            c.fail(`${rp}.details`, 'totaux de l\'horizon incohérents avec les séries');
          }
        }
      }
    });
  } catch (e) {
    c.fail('snapshot', `valeur illisible (${e instanceof Error ? e.message : 'erreur'})`);
  }
  if (c.errors.length) return { ok: false, errors: c.errors };
  let value: DecisionSnapshot;
  try {
    value = JSON.parse(JSON.stringify(raw)) as DecisionSnapshot;
  } catch {
    return { ok: false, errors: ['snapshot : valeur non sérialisable'] };
  }
  // Simulation enregistrée avant la correction A2 : totaux de l'objectif sur l'horizon reconstitués
  // exactement à partir des séries figées (identité du modèle), sans recalcul de la simulation.
  const horizon = value.hypotheses.horizonMonths;
  value.results.variants.forEach((v) => {
    const d = v.details;
    if (d.kind === 'goal' && (d as Partial<typeof d>).contributedToHorizon === undefined) {
      const totals = goalHorizonTotalsFromImpact(v.cashDelta[horizon], v.netWorthDelta[horizon]);
      Object.assign(d, { contributionsToReach: d.reachedMonth === null ? null : d.totalContributed, ...totals });
    }
  });
  return { ok: true, value: deepFreeze(value) };
}
