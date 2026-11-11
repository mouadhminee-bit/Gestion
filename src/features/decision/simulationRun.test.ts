/**
 * Decision Lab — exécution des simulations (E5.4) : horizon réel, appel du moteur, snapshot E4,
 * séries et avertissements lus dans les résultats du moteur. Données fictives.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSnapshot } from './snapshot';
import { DECISION_STORE_KEY, loadSimulations, saveSimulation, type StorageLike } from './store';
import { projectDecision, referenceTrajectory, simulateDecision, type DecisionInput, type InitialSituation } from '@/domain/calc/decision';
import { runSimulation, simulationNotices, SINGLE_VARIANT_ID, trajectoryRows, type RunInput } from './simulationRun';

const situation: InitialSituation = { cash: 5_000_000, netWorth: 30_000_000, monthlySavings: 400_000 };
const START = '2026-11';
const decisions: Record<string, DecisionInput> = {
  purchase: { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 }, insuranceMonthly: 12_000 },
  recurring: { kind: 'recurring', monthlyAmount: 50_000, startMonth: 2, months: 12 },
  goal: { kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 300, months: 24 },
  investment: { kind: 'investment', initialCapital: 2_000_000, monthlyContribution: 150_000, effectiveRateBps: 600 },
};
const input = (decision: DecisionInput, horizonText: string, over: Partial<RunInput> = {}): RunInput => ({
  name: 'Test',
  horizonText,
  situation,
  decision,
  startMonth: START,
  id: 'sim-1',
  createdAt: '2026-11-10T10:00:00.000Z',
  ...over,
});
const ok = (i: RunInput) => {
  const r = runSimulation(i);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const errorsOf = (i: RunInput) => {
  const r = runSimulation(i);
  return r.ok ? {} : r.errors;
};

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

describe('exécution : les quatre types, horizons réels, cohérence avec le moteur', () => {
  for (const [kind, decision] of Object.entries(decisions)) {
    for (const horizon of [1, 12, 60, 480]) {
      it(`${kind}, ${horizon} mois`, () => {
        const r = ok(input(decision, String(horizon)));
        const options = { horizonMonths: horizon, startMonth: START };
        // Snapshot identique à celui que produit E4 avec le même horizon (aucune transformation).
        expect(r.snapshot).toEqual(
          createSnapshot({ name: 'Test', situation, horizonMonths: horizon, startMonth: START, variants: [{ id: SINGLE_VARIANT_ID, decision }], id: 'sim-1', createdAt: '2026-11-10T10:00:00.000Z' }),
        );
        expect(r.snapshot.hypotheses.horizonMonths).toBe(horizon);
        // Détail mensuel : exactement la sortie du moteur sur l'horizon réel.
        expect(r.live).toEqual(simulateDecision(decision, options));
        // Séries : une ligne par mois calculé, égale à la projection du moteur.
        const rows = trajectoryRows(r.snapshot);
        const projection = projectDecision(referenceTrajectory(situation, options), r.live);
        expect(rows).toHaveLength(horizon + 1);
        expect(rows.map((x) => [x.month, x.monthKey, x.refCash, x.cash, x.refNetWorth, x.netWorth])).toEqual(
          projection.map((p) => [p.month, p.monthKey, p.reference.cash, p.withDecision.cash, p.reference.netWorth, p.withDecision.netWorth]),
        );
        expect(rows.map((x) => x.cashDelta)).toEqual(r.live.months.map((m) => m.cumulativeCash));
        expect(rows.map((x) => x.netWorthDelta)).toEqual(r.live.months.map((m) => m.netWorthImpact));
        // Enregistrable tel quel par le store E4.
        const st = new MemoryStorage();
        expect(saveSimulation(r.snapshot, st)).toMatchObject({ ok: true, count: 1 });
        expect(loadSimulations(st).simulations[0]).toEqual(r.snapshot);
      });
    }
  }

  it('chaque exécution produit un nouveau snapshot : jamais de remplacement', () => {
    const a = ok(input(decisions.recurring, '12', { id: undefined, createdAt: undefined }));
    const b = ok(input(decisions.recurring, '12', { id: undefined, createdAt: undefined }));
    expect(a.snapshot.id).not.toBe(b.snapshot.id);
    const st = new MemoryStorage();
    saveSimulation(a.snapshot, st);
    expect(saveSimulation(a.snapshot, st)).toEqual({ ok: false, issue: { code: 'duplicateId', id: a.snapshot.id } });
    expect(saveSimulation(b.snapshot, st)).toMatchObject({ ok: true, count: 2 });
    expect(JSON.parse(st.data.get(DECISION_STORE_KEY)!).simulations).toHaveLength(2);
  });

  it('entrées non modifiées ; snapshot indépendant des objets fournis', () => {
    const decision = structuredClone(decisions.purchase);
    const sit = { ...situation };
    const frozen = JSON.stringify([decision, sit]);
    const r = ok(input(decision, '60', { situation: sit }));
    expect(JSON.stringify([decision, sit])).toBe(frozen);
    sit.cash = 0;
    (decision as { price: number }).price = 1;
    expect(r.snapshot.hypotheses.situation.cash).toBe(5_000_000);
    expect(r.snapshot.hypotheses.variants[0].decision).toEqual(decisions.purchase);
  });
});

describe('horizon, nom et situation : erreurs bloquantes', () => {
  it('horizon obligatoire, entier, de 1 à 480 mois (règle du moteur)', () => {
    expect(errorsOf(input(decisions.goal, ''))).toEqual({ horizon: 'required' });
    expect(errorsOf(input(decisions.goal, '  '))).toEqual({ horizon: 'required' });
    for (const text of ['douze', '12,5', '1e2']) expect(errorsOf(input(decisions.goal, text)), text).toEqual({ horizon: 'invalid' });
    expect(errorsOf(input(decisions.goal, '0'))).toEqual({ horizon: 'notPositive' });
    expect(errorsOf(input(decisions.goal, '-6'))).toEqual({ horizon: 'notPositive' });
    expect(errorsOf(input(decisions.goal, '481'))).toEqual({ horizon: 'tooLarge' });
    expect(errorsOf(input(decisions.goal, '480'))).toEqual({});
  });

  it('nom obligatoire et limité ; situation requise', () => {
    expect(errorsOf(input(decisions.goal, '12', { name: ' ' }))).toEqual({ name: 'required' });
    expect(errorsOf(input(decisions.goal, '12', { name: 'x'.repeat(121) }))).toEqual({ name: 'tooLong' });
    expect(errorsOf(input(decisions.goal, '12', { situation: null }))).toEqual({ situation: 'required' });
    expect(errorsOf(input(decisions.goal, '', { situation: null, name: '' }))).toEqual({ name: 'required', situation: 'required', horizon: 'required' });
  });

  it('montants élevés : valides à court horizon, refusés sur un horizon réel où ils débordent', () => {
    const big: DecisionInput = { kind: 'investment', initialCapital: 10_000_000_000_000, monthlyContribution: 0, effectiveRateBps: 3000 };
    expect(ok(input(big, '12')).snapshot.results.variants[0].details).toMatchObject({ kind: 'investment' });
    expect(errorsOf(input(big, '480'))).toEqual({ form: 'resultOutOfRange' });
    // Achat de grande valeur, sur 40 ans : calculé sans perte de précision.
    const house: DecisionInput = { kind: 'purchase', price: 500_000_000_00, downPayment: 100_000_000_00, fees: 0, loan: { nominalRateBps: 450, months: 300 } };
    const r = ok(input(house, '480', { situation: { cash: 120_000_000_00, netWorth: 300_000_000_00, monthlySavings: 2_000_000 } }));
    expect(Number.isSafeInteger(r.snapshot.results.variants[0].endOfHorizon.netWorth)).toBe(true);
  });

  it('situation non simulable sur l\'horizon réel : erreur bloquante du moteur, jamais validée sur un autre horizon', () => {
    // Cas déjà refusé en amont par la validation de la situation (E5.2) ; le moteur le refuse aussi ici.
    const huge = { cash: Number.MAX_SAFE_INTEGER - 10, netWorth: 0, monthlySavings: 1_000_000 };
    expect(errorsOf(input(decisions.recurring, '480', { situation: huge }))).toEqual({ form: 'resultOutOfRange' });
  });
});

describe('avertissements et notes (lus dans les résultats du moteur)', () => {
  const codes = (i: RunInput) => simulationNotices(ok(i).snapshot).map((n) => `${n.level}:${n.code}`);

  it('trésorerie négative : avertissement avec le premier mois', () => {
    const cash: DecisionInput = { kind: 'purchase', price: 18_000_000, downPayment: 18_000_000, fees: 0 };
    const r = ok(input(cash, '24'));
    expect(simulationNotices(r.snapshot)).toEqual([{ level: 'warning', code: 'negativeCash', vars: { month: 0 } }]);
    expect(r.snapshot.results.variants[0].firstNegativeCashMonth).toBe(0);
    expect(r.snapshot.results.variants[0].lowestCash).toEqual({ month: 0, value: 5_000_000 - 18_000_000 });
    expect(codes(input(decisions.recurring, '24'))).toEqual([]);
  });

  it('objectif atteint, atteint après l\'horizon, non atteint, en retard', () => {
    expect(codes(input(decisions.goal, '24'))).toEqual([]);
    expect(ok(input(decisions.goal, '24')).snapshot.results.variants[0].details).toMatchObject({ reachedMonth: 24 });
    expect(codes(input(decisions.goal, '12'))).toEqual(['warning:goalAfterHorizon']);
    const tiny: DecisionInput = { kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 0, monthlyContribution: 100 };
    expect(codes(input(tiny, '60'))).toEqual(['warning:goalNotReached']);
    const late: DecisionInput = { kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 0, monthlyContribution: 250_000, deadlineMonths: 12 };
    expect(codes(input(late, '36'))).toEqual(['warning:goalLate']);
  });

  it('crédit au-delà de l\'horizon ; remboursement anticipé par l\'arrondi', () => {
    expect(codes(input(decisions.purchase, '12'))).toEqual(['info:loanBeyondHorizon']);
    expect(codes(input(decisions.purchase, '60'))).toEqual([]);
    const tiny: DecisionInput = { kind: 'purchase', price: 99, downPayment: 0, fees: 0, loan: { nominalRateBps: 1200, months: 48 } };
    expect(codes(input(tiny, '60'))[0]).toBe('info:loanEarlyPayoff');
  });
});

describe('aucun calcul financier dans l\'interface', () => {
  it('les composants n\'appellent pas les fonctions de calcul du moteur', () => {
    for (const file of ['SimulationResults.tsx', 'SimulationPanel.tsx']) {
      const src = readFileSync(join(process.cwd(), 'src/features/decision', file), 'utf8');
      expect(src, file).not.toMatch(/simulateDecision|amortizationSchedule|savingsSchedule|requiredMonthlyEffort|effectiveMonthlyRate|referenceTrajectory|projectDecision|compareDecisions|createSnapshot/);
      expect(src, file).not.toMatch(/from '@\/data|dexie|localStorage|sessionStorage/);
    }
  });
});
