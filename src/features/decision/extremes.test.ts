/**
 * Decision Lab — correction A3 : valeurs extrêmes. Aucun résultat silencieusement altéré (calculs
 * exacts), une erreur métier identifiable (`resultOutOfRange`) dès qu'un résultat ne peut pas être
 * représenté exactement, attribuée à la variante concernée, et jamais d'exception non interceptée
 * dans l'exécution d'une simulation ou d'une comparaison. Données fictives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareDecisions,
  DecisionInputError,
  projectDecision,
  referenceTrajectory,
  simulateDecision,
  validateDecision,
  type DecisionInput,
  type InitialSituation,
} from '@/domain/calc/decision';
import * as snapshotModule from './snapshot';
import { createSnapshot, validateSnapshot } from './snapshot';
import { runSimulation } from './simulationRun';
import { comparisonIndicators, runComparison } from './comparisonRun';

vi.mock('./snapshot', async (importOriginal) => {
  const original = await importOriginal<typeof import('./snapshot')>();
  return { ...original, createSnapshot: vi.fn(original.createSnapshot) };
});
afterEach(() => vi.restoreAllMocks());

const MAX = Number.MAX_SAFE_INTEGER;
const START = '2026-11';
const engineError = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof DecisionInputError) return e.issues;
    throw e;
  }
  return null;
};

describe('E3 — calculs exacts aux bornes des entiers', () => {
  it('référence : un produit mois × épargne au-delà de 2^53 n\'est plus arrondi (ancien calcul : 4 503 599 627 370 501)', () => {
    const s: InitialSituation = { cash: -MAX, netWorth: -MAX, monthlySavings: 2 ** 52 + 1 };
    const ref = referenceTrajectory(s, { horizonMonths: 3 });
    expect(ref[3].cash).toBe(4_503_599_627_370_500);
    expect(ref[3].netWorth).toBe(4_503_599_627_370_500);
    expect(ref.map((p) => p.cash)).toEqual([-MAX, -MAX + 2 ** 52 + 1, 3, 4_503_599_627_370_500]);
    // Un mois de plus : hors des entiers exacts → erreur métier, jamais un résultat approché.
    expect(engineError(() => referenceTrajectory(s, { horizonMonths: 4 }))).toEqual([{ field: 'result', code: 'resultOutOfRange' }]);
  });

  it('valeurs maximales autorisées : acceptées et exactes ; immédiatement au-dessus : refusées', () => {
    const atMax: DecisionInput = { kind: 'recurring', monthlyAmount: MAX };
    expect(validateDecision(atMax, { horizonMonths: 1 })).toEqual([]);
    expect(simulateDecision(atMax, { horizonMonths: 1 }).summary.finalCumulativeCash).toBe(-MAX);
    expect(validateDecision({ kind: 'recurring', monthlyAmount: MAX + 1 }, { horizonMonths: 1 })).toEqual([{ field: 'monthlyAmount', code: 'notInteger' }]);
    // Deux mois au maximum : le cumul sort des entiers exacts.
    expect(engineError(() => simulateDecision(atMax, { horizonMonths: 2 }))).toEqual([{ field: 'result', code: 'resultOutOfRange' }]);
    // Somme des flux d'un mois (apport + frais) au-delà de la borne.
    expect(engineError(() => simulateDecision({ kind: 'purchase', price: MAX, downPayment: MAX, fees: 1 }, { horizonMonths: 1 }))).toEqual([{ field: 'result', code: 'resultOutOfRange' }]);
    // Juste à la borne : exact.
    const r = simulateDecision({ kind: 'purchase', price: MAX - 1, downPayment: MAX - 1, fees: 1 }, { horizonMonths: 1 });
    expect(r.months[0].cumulativeCash).toBe(-MAX);
    expect(r.months[0].netWorthImpact).toBe(-1);
  });

  it('variations mensuelles du patrimoine contrôlées (différence de deux valeurs extrêmes)', () => {
    // Actif à la borne au mois 0, puis plus d'actif : variation −MAX exacte.
    const r = simulateDecision({ kind: 'purchase', price: 0, downPayment: 0, fees: 0, assetValue: MAX }, { horizonMonths: 2 });
    expect(r.months.every((m) => Number.isSafeInteger(m.netWorthChange))).toBe(true);
    expect(r.months[0].netWorthChange).toBe(MAX);
  });

  it('projection sur la situation : erreur métier, jamais un patrimoine approché', () => {
    const s: InitialSituation = { cash: 0, netWorth: MAX - 1_000, monthlySavings: 0 };
    const inv: DecisionInput = { kind: 'investment', initialCapital: 100_000_000, monthlyContribution: 0, effectiveRateBps: 1000 };
    const result = simulateDecision(inv, { horizonMonths: 120 });
    expect(engineError(() => projectDecision(referenceTrajectory(s, { horizonMonths: 120 }), result))).toEqual([{ field: 'result', code: 'resultOutOfRange' }]);
    expect(engineError(() => compareDecisions(s, [{ id: 'a', decision: inv }, { id: 'b', decision: inv }], { horizonMonths: 120 }))).toEqual([{ field: 'result', code: 'resultOutOfRange' }]);
    // Trésorerie très négative et dépense : même contrôle, côté trésorerie.
    const debt: InitialSituation = { cash: -(MAX - 1_000), netWorth: 0, monthlySavings: 0 };
    expect(engineError(() => projectDecision(referenceTrajectory(debt, { horizonMonths: 12 }), simulateDecision({ kind: 'recurring', monthlyAmount: 100_000 }, { horizonMonths: 12 })))).toEqual([{ field: 'result', code: 'resultOutOfRange' }]);
  });

  it('très grand patrimoine combiné à un crédit : exact tant que représentable', () => {
    const s: InitialSituation = { cash: 10_000_000_000_000, netWorth: 50_000_000_000_000, monthlySavings: 1_000_000_000 };
    const loan: DecisionInput = { kind: 'purchase', price: 2_000_000_000_000, downPayment: 500_000_000_000, fees: 10_000_000, loan: { nominalRateBps: 3000, months: 480 } };
    const r = simulateDecision(loan, { horizonMonths: 480 });
    const p = projectDecision(referenceTrajectory(s, { horizonMonths: 480 }), r);
    for (const x of p) for (const v of [x.withDecision.cash, x.withDecision.netWorth]) expect(Number.isSafeInteger(v)).toBe(true);
    // Avec décision = référence + écart, exactement (contrôle BigInt indépendant).
    const m = 240;
    expect(BigInt(p[m].withDecision.cash)).toBe(BigInt(s.cash) + BigInt(m) * BigInt(s.monthlySavings) + BigInt(r.months[m].cumulativeCash));
  });
});

describe('E4 — aucun snapshot corrompu ni approché', () => {
  it('un mois « avec la décision » hors des entiers exacts, même au milieu de l\'horizon, invalide le snapshot', () => {
    const snap = createSnapshot({ name: 'x', situation: { cash: 0, netWorth: 0, monthlySavings: 0 }, horizonMonths: 3, variants: [{ id: 'v', decision: { kind: 'recurring', monthlyAmount: 100 } }] });
    const raw = JSON.parse(JSON.stringify(snap));
    raw.results.reference.netWorth[2] = MAX;
    raw.results.variants[0].netWorthDelta[2] = 10;
    const v = validateSnapshot(raw);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' ')).toContain('valeurs hors des entiers exacts');
  });
});

describe('E5 — erreurs explicites, attribuées, jamais d\'exception non interceptée', () => {
  const huge: InitialSituation = { cash: 0, netWorth: MAX - 1_000, monthlySavings: 0 };
  const growth: DecisionInput = { kind: 'investment', initialCapital: 100_000_000, monthlyContribution: 0, effectiveRateBps: 1000 };
  const spend: DecisionInput = { kind: 'investment', initialCapital: 100, monthlyContribution: 0, effectiveRateBps: 0 };

  it('simulation simple : erreur métier `resultOutOfRange` (auparavant : exception non interceptée)', () => {
    const r = runSimulation({ name: 'x', horizonText: '120', situation: huge, decision: growth, startMonth: START });
    expect(r).toEqual({ ok: false, errors: { form: 'resultOutOfRange' } });
  });

  it('comparaison : seule la variante en dépassement est signalée, les autres sont diagnostiquées', () => {
    const r = runComparison({ name: 'c', horizonText: '120', situation: huge, startMonth: START, variants: [
      { label: 'Sans rendement', decision: spend },
      { label: 'Rendement', decision: growth },
      { label: 'Sans rendement bis', decision: { ...spend, initialCapital: 200 } },
    ] });
    expect(r).toEqual({ ok: false, errors: { variants: { 1: { decision: 'resultOutOfRange' } } } });
  });

  it('situation non représentable sur l\'horizon : erreur commune, aucune variante mise en cause', () => {
    const s: InitialSituation = { cash: MAX - 10, netWorth: 0, monthlySavings: 1_000_000 };
    expect(runComparison({ name: 'c', horizonText: '480', situation: s, startMonth: START, variants: [{ label: 'A', decision: spend }, { label: 'B', decision: spend }] })).toEqual({ ok: false, errors: { form: 'resultOutOfRange' } });
    expect(runSimulation({ name: 'x', horizonText: '480', situation: s, decision: spend, startMonth: START })).toEqual({ ok: false, errors: { form: 'resultOutOfRange' } });
  });

  it('erreur imprévue : signalée (`internalError`) et journalisée, aucun résultat partiel', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(snapshotModule.createSnapshot).mockImplementationOnce(() => {
      throw new Error('défaut simulé');
    });
    expect(runSimulation({ name: 'x', horizonText: '12', situation: { cash: 0, netWorth: 0, monthlySavings: 0 }, decision: spend, startMonth: START })).toEqual({ ok: false, errors: { form: 'internalError' } });
    vi.mocked(snapshotModule.createSnapshot).mockImplementationOnce(() => {
      throw new Error('défaut simulé');
    });
    expect(runComparison({ name: 'c', horizonText: '12', situation: { cash: 0, netWorth: 0, monthlySavings: 0 }, startMonth: START, variants: [{ label: 'A', decision: spend }, { label: 'B', decision: spend }] })).toEqual({ ok: false, errors: { form: 'internalError' } });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('comparateur : écart non représentable exactement signalé « hors limites », jamais arrondi', () => {
    const snap = createSnapshot({
      name: 'bornes',
      situation: { cash: 0, netWorth: 0, monthlySavings: 0 },
      horizonMonths: 1,
      variants: [
        { id: 'A', decision: { kind: 'purchase', price: 0, downPayment: 0, fees: 8_000_000_000_000_000 } },
        { id: 'B', decision: { kind: 'purchase', price: 0, downPayment: 0, fees: 0, assetValue: 2_000_000_000_000_000 } },
      ],
    });
    const nw = comparisonIndicators(snap).find((i) => i.key === 'endNetWorth')!;
    expect(nw.values).toEqual([-8_000_000_000_000_000, 2_000_000_000_000_000]);
    expect(nw.differences).toEqual([null, null]);
    expect(nw.outOfRange).toEqual([false, true]);
    // Écart représentable : calculé, pas signalé.
    const cash = comparisonIndicators(snap).find((i) => i.key === 'endCash')!;
    expect(cash.differences[1]).toBe(8_000_000_000_000_000);
    expect(cash.outOfRange).toEqual([false, false]);
  });
});
