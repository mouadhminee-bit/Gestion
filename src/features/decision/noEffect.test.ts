/**
 * Decision Lab — correction A4 : décisions sans effet dans l'horizon. Une décision valide dont aucun
 * flux n'intervient pendant la période simulée est signalée (avertissement contextualisé) ; une
 * décision dont l'effet existe — même au dernier mois, ou avec des montants qui se compensent dans le
 * patrimoine — ne l'est jamais ; une décision invalide reste refusée. Simulations simples, variantes
 * du comparateur et simulations relues dans l'historique : même règle. Données fictives.
 */
import { describe, expect, it } from 'vitest';
import { validateDecision, type DecisionInput, type InitialSituation } from '@/domain/calc/decision';
import { createSnapshot, validateSnapshot } from './snapshot';
import { runSimulation, simulationNotices } from './simulationRun';
import { runComparison } from './comparisonRun';

const situation: InitialSituation = { cash: 5_000_000, netWorth: 30_000_000, monthlySavings: 400_000 };
const START = '2026-11';
const run = (decision: DecisionInput, horizon: number) => {
  const r = runSimulation({ name: 'x', horizonText: String(horizon), situation, decision, startMonth: START });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.snapshot;
};
const codes = (decision: DecisionInput, horizon: number) => simulationNotices(run(decision, horizon)).map((n) => n.code);

describe('décision sans effet dans l\'horizon : signalée', () => {
  it('dépense commençant au mois 24 avec un horizon de 12 mois : premier effet après l\'horizon', () => {
    const snap = run({ kind: 'recurring', monthlyAmount: 50_000, startMonth: 24 }, 12);
    expect(simulationNotices(snap)).toEqual([{ level: 'warning', code: 'noEffectAfterHorizon', vars: { start: 24, months: 12 } }]);
    // Aucun résultat inventé : écarts nuls, ceux du moteur.
    expect(snap.results.variants[0].cashDelta.every((x) => x === 0)).toBe(true);
    expect(snap.results.variants[0].endOfHorizon).toMatchObject({ cashDelta: 0, netWorthDelta: 0 });
  });

  it('placement sans capital initial et sans aucun versement dans la période (0 versement) : zéro flux effectif', () => {
    const d: DecisionInput = { kind: 'investment', initialCapital: 0, monthlyContribution: 100_000, contributionMonths: 0, effectiveRateBps: 500 };
    expect(validateDecision(d, { horizonMonths: 12 })).toEqual([]); // valide…
    expect(codes(d, 12)).toEqual(['noEffect']); // …mais sans effet
  });

  it('achat de prix nul, sans frais : zéro flux effectif', () => {
    expect(codes({ kind: 'purchase', price: 0, downPayment: 0, fees: 0 }, 12)).toEqual(['noEffect']);
  });
});

describe('décision ayant un effet : jamais signalée à tort', () => {
  it('effet exactement au dernier mois de l\'horizon', () => {
    const snap = run({ kind: 'recurring', monthlyAmount: 50_000, startMonth: 12 }, 12);
    expect(simulationNotices(snap).map((n) => n.code)).toEqual([]);
    expect(snap.results.variants[0].cashDelta[11]).toBe(0);
    expect(snap.results.variants[0].cashDelta[12]).toBe(-50_000);
  });

  it('placement avec versements mensuels nuls mais un capital initial : effet dès le mois 0', () => {
    expect(codes({ kind: 'investment', initialCapital: 1_000_000, monthlyContribution: 0, effectiveRateBps: 0 }, 12)).toEqual([]);
  });

  it('placement entièrement nul : décision invalide (refusée), pas « sans effet »', () => {
    const d: DecisionInput = { kind: 'investment', initialCapital: 0, monthlyContribution: 0, effectiveRateBps: 500 };
    expect(validateDecision(d, { horizonMonths: 12 })).toEqual([{ field: 'initialCapital', code: 'emptyInvestment' }]);
    expect(runSimulation({ name: 'x', horizonText: '12', situation, decision: d, startMonth: START })).toEqual({ ok: false, errors: { form: 'emptyInvestment' } });
  });

  it('flux de signes opposés qui se compensent dans le patrimoine : effet sur la trésorerie, aucun avertissement', () => {
    // Achat comptant à la valeur du bien, sans frais : patrimoine inchangé, trésorerie −180 000 DH.
    const purchase = run({ kind: 'purchase', price: 18_000_000, downPayment: 18_000_000, fees: 0 }, 12);
    expect(purchase.results.variants[0].netWorthDelta.every((x) => x === 0)).toBe(true);
    expect(purchase.results.variants[0].cashDelta[0]).toBe(-18_000_000);
    expect(simulationNotices(purchase).map((n) => n.code)).not.toContain('noEffect');
    // Placement à 0 % : versements sortis de la trésorerie, entrés dans le placement.
    const inv = run({ kind: 'investment', initialCapital: 0, monthlyContribution: 100_000, effectiveRateBps: 0 }, 12);
    expect(inv.results.variants[0].netWorthDelta.every((x) => x === 0)).toBe(true);
    expect(simulationNotices(inv).map((n) => n.code)).not.toContain('noEffect');
  });

  it('les quatre types, paramètres usuels : aucun avertissement d\'absence d\'effet', () => {
    const usual: DecisionInput[] = [
      { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 } },
      { kind: 'recurring', monthlyAmount: 50_000 },
      { kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 300, months: 24 },
      { kind: 'investment', initialCapital: 2_000_000, monthlyContribution: 150_000, effectiveRateBps: 600 },
    ];
    for (const d of usual) for (const h of [1, 12, 480]) expect(codes(d, h), `${d.kind} ${h}`).not.toContain('noEffect');
  });
});

describe('comparateur et historique : même règle', () => {
  it('une variante sans effet et une autre avec effet : seule la première est signalée', () => {
    const r = runComparison({ name: 'c', horizonText: '12', situation, startMonth: START, variants: [
      { label: 'Loyer maintenant', decision: { kind: 'recurring', monthlyAmount: 50_000 } },
      { label: 'Loyer dans 2 ans', decision: { kind: 'recurring', monthlyAmount: 50_000, startMonth: 24 } },
    ] });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(simulationNotices(r.snapshot, 0).map((n) => n.code)).toEqual([]);
    expect(simulationNotices(r.snapshot, 1)).toEqual([{ level: 'warning', code: 'noEffectAfterHorizon', vars: { start: 24, months: 12 } }]);
  });

  it('simulation relue dans l\'historique : avertissement identique, sans recalcul', () => {
    const snap = createSnapshot({ name: 'h', situation, horizonMonths: 12, variants: [{ id: 'v', decision: { kind: 'recurring', monthlyAmount: 50_000, startMonth: 24 } }] });
    const reread = validateSnapshot(JSON.parse(JSON.stringify(snap)));
    if (!reread.ok) throw new Error();
    expect(simulationNotices(reread.value)).toEqual(simulationNotices(snap));
    expect(simulationNotices(reread.value)[0].code).toBe('noEffectAfterHorizon');
  });
});
