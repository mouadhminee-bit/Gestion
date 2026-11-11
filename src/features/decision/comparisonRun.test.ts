/**
 * Decision Lab — comparateur multi-variantes (E5.5) : exécution par le moteur E3 via le contrat E4,
 * situation et horizon communs, validations indépendantes, erreurs, avertissements, écarts
 * « variante − A » et persistance. Données fictives.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSnapshot, validateSnapshot, type DecisionSnapshot } from './snapshot';
import { DECISION_STORE_KEY, loadSimulations, MAX_SIMULATIONS, saveSimulation, type StorageLike } from './store';
import { compareDecisions, simulateDecision, type DecisionInput, type InitialSituation } from '@/domain/calc/decision';
import { runSimulation, simulationNotices, trajectoryRows } from './simulationRun';
import {
  comparisonIndicators,
  comparisonRows,
  differenceFromA,
  labelError,
  runComparison,
  VARIANT_IDS,
  variantLabel,
  type ComparisonInput,
} from './comparisonRun';

const situation: InitialSituation = { cash: 5_000_000, netWorth: 30_000_000, monthlySavings: 400_000 };
const START = '2026-11';
const STAMP = '2026-11-10T10:00:00.000Z';

/** Quatre variantes par type de décision (hypothèses distinctes). */
const FAMILIES: Record<DecisionInput['kind'], DecisionInput[]> = {
  purchase: [
    { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 }, insuranceMonthly: 12_000 },
    { kind: 'purchase', price: 18_000_000, downPayment: 18_000_000, fees: 150_000 },
    { kind: 'purchase', price: 18_000_000, downPayment: 6_000_000, fees: 150_000, loan: { nominalRateBps: 550, months: 60 } },
    { kind: 'purchase', price: 15_000_000, downPayment: 0, fees: 0, assetValue: 14_000_000, loan: { nominalRateBps: 900, months: 36 } },
  ],
  recurring: [
    { kind: 'recurring', monthlyAmount: 50_000 },
    { kind: 'recurring', monthlyAmount: 80_000, startMonth: 3, months: 12 },
    { kind: 'recurring', monthlyAmount: 20_000, months: 6 },
    { kind: 'recurring', monthlyAmount: 120_000, startMonth: 1 },
  ],
  goal: [
    { kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 300, months: 24 },
    { kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 300, monthlyContribution: 300_000 },
    { kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 0, months: 36 },
    { kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 0, monthlyContribution: 200_000, deadlineMonths: 24 },
  ],
  investment: [
    { kind: 'investment', initialCapital: 2_000_000, monthlyContribution: 150_000, effectiveRateBps: 600 },
    { kind: 'investment', initialCapital: 0, monthlyContribution: 250_000, effectiveRateBps: 400 },
    { kind: 'investment', initialCapital: 5_000_000, monthlyContribution: 0, effectiveRateBps: 500 },
    { kind: 'investment', initialCapital: 1_000_000, monthlyContribution: 100_000, contributionMonths: 24, effectiveRateBps: 700 },
  ],
};

const input = (decisions: (DecisionInput | null)[], horizonText = '60', over: Partial<ComparisonInput> = {}): ComparisonInput => ({
  name: 'Comparaison test',
  horizonText,
  situation,
  variants: decisions.map((decision, k) => ({ label: `Option ${k + 1}`, decision })),
  startMonth: START,
  id: 'cmp-1',
  createdAt: STAMP,
  ...over,
});
const ok = (i: ComparisonInput) => {
  const r = runComparison(i);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const errorsOf = (i: ComparisonInput) => {
  const r = runComparison(i);
  return r.ok ? {} : r.errors;
};

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

describe('exécution : 2, 3 et 4 variantes, les quatre types, cohérence avec le moteur', () => {
  for (const [kind, family] of Object.entries(FAMILIES)) {
    for (const count of [2, 3, 4]) {
      for (const horizon of [1, 60, 480]) {
        it(`${kind}, ${count} variantes, ${horizon} mois`, () => {
          const decisions = family.slice(0, count);
          const r = ok(input(decisions, String(horizon)));
          const options = { horizonMonths: horizon, startMonth: START };
          // Snapshot identique à celui de E4 avec les mêmes entrées (identifiants A, B…, noms saisis).
          expect(r.snapshot).toEqual(
            createSnapshot({
              name: 'Comparaison test',
              situation,
              horizonMonths: horizon,
              startMonth: START,
              variants: decisions.map((decision, k) => ({ id: VARIANT_IDS[k], label: `Option ${k + 1}`, decision })),
              id: 'cmp-1',
              createdAt: STAMP,
            }),
          );
          // Situation et horizon communs, stockés une seule fois ; une série par variante, mêmes mois.
          expect(r.snapshot.hypotheses).toMatchObject({ situation, horizonMonths: horizon, startMonth: START });
          expect(r.snapshot.results.variants.map((v) => v.id)).toEqual(VARIANT_IDS.slice(0, count));
          for (const v of r.snapshot.results.variants) {
            expect(v.cashDelta).toHaveLength(horizon + 1);
            expect(v.netWorthDelta).toHaveLength(horizon + 1);
          }
          // Résultats égaux à ceux du moteur (comparaison E3) et à des exécutions isolées de chaque variante.
          const cmp = compareDecisions(situation, decisions.map((decision, k) => ({ id: VARIANT_IDS[k], decision })), options);
          expect(r.snapshot.results.reference).toEqual({ cash: cmp.reference.map((p) => p.cash), netWorth: cmp.reference.map((p) => p.netWorth) });
          decisions.forEach((decision, k) => {
            expect(r.live[k]).toEqual(simulateDecision(decision, options));
            expect(r.live[k]).toEqual(cmp.variants[k].result);
            const single = runSimulation({ name: 'Seule', horizonText: String(horizon), situation, decision, startMonth: START, id: 's', createdAt: STAMP });
            if (!single.ok) throw new Error('simulation isolée refusée');
            const { id: _a, ...alone } = single.snapshot.results.variants[0];
            const { id: _b, ...inCmp } = r.snapshot.results.variants[k];
            expect(inCmp).toEqual(alone);
            expect(single.snapshot.results.reference).toEqual(r.snapshot.results.reference);
            expect(trajectoryRows(r.snapshot, k)).toEqual(trajectoryRows(single.snapshot));
          });
          // Enregistrable tel quel ; relu à l'identique, sans recalcul.
          const st = new MemoryStorage();
          expect(saveSimulation(r.snapshot, st)).toMatchObject({ ok: true, count: 1 });
          expect(loadSimulations(st).simulations[0]).toEqual(r.snapshot);
        });
      }
    }
  }

  it('objectif d\'épargne : méthodes différentes autorisées (même type de décision)', () => {
    const r = ok(input([FAMILIES.goal[0], FAMILIES.goal[1]], '36'));
    expect(r.snapshot.hypotheses.variants.map((v) => (v.decision as { mode: string }).mode)).toEqual(['effort', 'contribution']);
    expect(r.snapshot.results.variants.map((v) => v.details.kind)).toEqual(['goal', 'goal']);
  });

  it('noms des variantes enregistrés (espaces de bord retirés) ; chaque exécution = nouveau snapshot', () => {
    const r = ok(input([FAMILIES.recurring[0], FAMILIES.recurring[1]], '12', { variants: [{ label: '  Loyer actuel ', decision: FAMILIES.recurring[0] }, { label: 'Loyer +', decision: FAMILIES.recurring[1] }] }));
    expect(r.snapshot.hypotheses.variants.map((v) => v.label)).toEqual(['Loyer actuel', 'Loyer +']);
    expect([0, 1].map((k) => variantLabel(r.snapshot, k))).toEqual(['Loyer actuel', 'Loyer +']);
    const a = ok(input(FAMILIES.recurring.slice(0, 2), '12', { id: undefined, createdAt: undefined }));
    const b = ok(input(FAMILIES.recurring.slice(0, 2), '12', { id: undefined, createdAt: undefined }));
    expect(a.snapshot.id).not.toBe(b.snapshot.id);
    const st = new MemoryStorage();
    saveSimulation(a.snapshot, st);
    expect(saveSimulation(a.snapshot, st)).toEqual({ ok: false, issue: { code: 'duplicateId', id: a.snapshot.id } });
    expect(saveSimulation(b.snapshot, st)).toMatchObject({ ok: true, count: 2 });
  });

  it('entrées non modifiées ; snapshot indépendant des objets fournis', () => {
    const decisions = FAMILIES.purchase.slice(0, 3).map((d) => structuredClone(d));
    const sit = { ...situation };
    const i = input(decisions, '60', { situation: sit });
    const frozen = JSON.stringify(i);
    const r = ok(i);
    expect(JSON.stringify(i)).toBe(frozen);
    sit.cash = 0;
    (decisions[0] as { price: number }).price = 1;
    i.variants[1].label = 'modifié';
    expect(r.snapshot.hypotheses.situation.cash).toBe(5_000_000);
    expect(r.snapshot.hypotheses.variants[0].decision).toEqual(FAMILIES.purchase[0]);
    expect(r.snapshot.hypotheses.variants[1].label).toBe('Option 2');
    expect(validateSnapshot(r.snapshot)).toEqual({ ok: true, value: r.snapshot });
  });
});

describe('erreurs bloquantes', () => {
  const two = FAMILIES.recurring.slice(0, 2);

  it('nombre de variantes : 2 à 4', () => {
    expect(errorsOf(input([FAMILIES.recurring[0]]))).toEqual({ form: 'variantCount' });
    expect(errorsOf(input([]))).toEqual({ form: 'variantCount' });
    expect(errorsOf(input([...FAMILIES.recurring, FAMILIES.recurring[0]]))).toEqual({ form: 'variantCount' });
  });

  it('un seul type de décision par comparaison', () => {
    expect(errorsOf(input([FAMILIES.recurring[0], FAMILIES.investment[0]]))).toEqual({ form: 'mixedKinds' });
  });

  it('nom de la comparaison, situation, horizon commun (règles du moteur)', () => {
    expect(errorsOf(input(two, '12', { name: ' ' }))).toEqual({ name: 'required' });
    expect(errorsOf(input(two, '12', { name: 'x'.repeat(121) }))).toEqual({ name: 'tooLong' });
    expect(errorsOf(input(two, '12', { situation: null }))).toEqual({ situation: 'required' });
    expect(errorsOf(input(two, ''))).toEqual({ horizon: 'required' });
    for (const text of ['douze', '12,5', '1e2']) expect(errorsOf(input(two, text)), text).toEqual({ horizon: 'invalid' });
    expect(errorsOf(input(two, '0'))).toEqual({ horizon: 'notPositive' });
    expect(errorsOf(input(two, '481'))).toEqual({ horizon: 'tooLarge' });
    expect(errorsOf(input(two, '480'))).toEqual({});
  });

  it('noms des variantes : obligatoires, 80 caractères au plus, distincts', () => {
    const named = (labels: string[]) => input(two, '12', { variants: labels.map((label, k) => ({ label, decision: two[k] })) });
    expect(errorsOf(named(['', 'B']))).toEqual({ variants: { 0: { label: 'required' } } });
    expect(errorsOf(named(['A', 'x'.repeat(81)]))).toEqual({ variants: { 1: { label: 'tooLong' } } });
    expect(errorsOf(named(['Loyer', ' loyer ']))).toEqual({ variants: { 0: { label: 'duplicate' }, 1: { label: 'duplicate' } } });
    expect(errorsOf(named(['A', 'x'.repeat(80)]))).toEqual({});
    expect(labelError(['a', 'b', 'A'], 1)).toBeUndefined();
    expect(labelError(['a', 'b', 'A'], 2)).toBe('duplicate');
  });

  it('variante non validée : erreur propre à cette variante', () => {
    expect(errorsOf(input([two[0], null]))).toEqual({ variants: { 1: { decision: 'notValidated' } } });
  });

  it('validations indépendantes sur l\'horizon réel : seule la variante en échec est signalée', () => {
    const big: DecisionInput = { kind: 'investment', initialCapital: 10_000_000_000_000, monthlyContribution: 0, effectiveRateBps: 3000 };
    const fine = FAMILIES.investment[0];
    // Valide à court horizon…
    expect(ok(input([fine, big], '12')).snapshot.results.variants).toHaveLength(2);
    // …refusée à 480 mois, et attribuée à la variante B uniquement.
    expect(errorsOf(input([fine, big], '480'))).toEqual({ variants: { 1: { decision: 'resultOutOfRange' } } });
    expect(errorsOf(input([big, fine, big], '480'))).toEqual({ variants: { 0: { decision: 'resultOutOfRange' }, 2: { decision: 'resultOutOfRange' } } });
    // Entrée invalide pour le moteur (même non produite par le formulaire) : refusée, attribuée.
    const invalid = { kind: 'recurring', monthlyAmount: -5 } as DecisionInput;
    expect(errorsOf(input([FAMILIES.recurring[0], FAMILIES.recurring[1], invalid], '12'))).toEqual({ variants: { 2: { decision: 'notPositive' } } });
  });

  it('situation non simulable sur l\'horizon réel : erreur bloquante', () => {
    const huge = { cash: Number.MAX_SAFE_INTEGER - 10, netWorth: 0, monthlySavings: 1_000_000 };
    const e = errorsOf(input(two, '480', { situation: huge }));
    expect(e.situation ?? e.form).toBeTruthy();
  });
});

describe('avertissements par variante (lus dans les résultats du moteur)', () => {
  it('chaque variante a ses propres avertissements et notes', () => {
    const cash: DecisionInput = { kind: 'purchase', price: 18_000_000, downPayment: 18_000_000, fees: 0 };
    const r = ok(input([FAMILIES.purchase[0], cash], '12'));
    expect(simulationNotices(r.snapshot, 0).map((n) => `${n.level}:${n.code}`)).toEqual(['info:loanBeyondHorizon']);
    expect(simulationNotices(r.snapshot, 1)).toEqual([{ level: 'warning', code: 'negativeCash', vars: { month: 0 } }]);
    const g = ok(input([FAMILIES.goal[0], { kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 0, monthlyContribution: 100 }], '24'));
    expect(simulationNotices(g.snapshot, 0)).toEqual([]);
    expect(simulationNotices(g.snapshot, 1).map((n) => n.code)).toEqual(['goalNotReached']);
  });
});

describe('écarts « variante − A » et indicateurs', () => {
  it('règle de signe : valeur de la variante − valeur de A ; absent si une valeur manque ; jamais d\'arrondi caché', () => {
    expect(differenceFromA(120, 100)).toBe(20);
    expect(differenceFromA(80, 100)).toBe(-20);
    expect(differenceFromA(100, 100)).toBe(0);
    expect(differenceFromA(null, 100)).toBeNull();
    expect(differenceFromA(100, null)).toBeNull();
    expect(differenceFromA(Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  const check = (snap: DecisionSnapshot) => {
    const inds = comparisonIndicators(snap);
    for (const ind of inds) {
      expect(ind.values).toHaveLength(snap.results.variants.length);
      expect(ind.differences[0]).toBeNull();
      ind.values.forEach((x, k) => {
        if (k === 0) return;
        expect(ind.differences[k], `${ind.key} ${k}`).toBe(!ind.comparable || x === null || ind.values[0] === null ? null : x - ind.values[0]!);
      });
    }
    return Object.fromEntries(inds.map((i) => [i.key, i]));
  };

  it('indicateurs communs : lus dans le snapshot, cohérents avec les séries', () => {
    const r = ok(input(FAMILIES.recurring.slice(0, 3), '24'));
    const ind = check(r.snapshot);
    expect(Object.keys(ind)).toEqual(['endCash', 'endCashDelta', 'endNetWorth', 'endNetWorthDelta', 'lowestCash', 'lowestCashMonth', 'firstNegativeCashMonth']);
    const rows = comparisonRows(r.snapshot);
    const last = rows[rows.length - 1];
    expect(ind.endCash.values).toEqual(last.cash);
    expect(ind.endNetWorth.values).toEqual(last.netWorth);
    expect(ind.endCashDelta.values).toEqual(r.snapshot.results.variants.map((v) => v.endOfHorizon.cashDelta));
    // Écart de fin d'horizon entre variantes = écart des séries au dernier mois (même référence).
    expect(ind.endCash.differences.slice(1)).toEqual(last.cash.slice(1).map((c) => c - last.cash[0]));
    expect(ind.endCash.differences.slice(1)).toEqual(ind.endCashDelta.differences.slice(1));
    expect(ind.firstNegativeCashMonth.values).toEqual([null, null, null]);
    expect(ind.firstNegativeCashMonth.differences).toEqual([null, null, null]);
  });

  it('achat : indicateurs du crédit ; « sans crédit » = valeur absente, écart absent', () => {
    const r = ok(input(FAMILIES.purchase.slice(0, 3), '60'));
    const ind = check(r.snapshot);
    const loans = r.live.map((x) => x.loan ?? null);
    expect(ind.loanInstallment.values).toEqual(loans.map((l) => l?.installment ?? null));
    expect(ind.loanInterest.values).toEqual(loans.map((l) => l?.totalInterest ?? null));
    expect(ind.loanPaid.values).toEqual(loans.map((l) => l?.totalPaid ?? null));
    expect(ind.loanMonths.values).toEqual([48, null, 60]);
    expect(ind.loanInstallment.differences[1]).toBeNull();
    expect(ind.loanInstallment.differences[2]).toBe(loans[2]!.installment - loans[0]!.installment);
    // Totaux du crédit sur 48 et 60 mois : périodes différentes, valeurs affichées sans écart (A2).
    for (const key of ['loanInterest', 'loanPaid']) {
      expect(ind[key].periods, key).toEqual([48, null, 60]);
      expect(ind[key].comparable, key).toBe(false);
      expect(ind[key].differences, key).toEqual([null, null, null]);
    }
    // Même durée : écart calculé.
    const same = ok(input([FAMILIES.purchase[0], { ...FAMILIES.purchase[2], loan: { nominalRateBps: 550, months: 48 } } as DecisionInput], '60'));
    const si = check(same.snapshot);
    expect(si.loanInterest.comparable).toBe(true);
    expect(si.loanInterest.differences[1]).toBe(same.live[1].loan!.totalInterest - same.live[0].loan!.totalInterest);
    // Aucune variante financée : pas d'indicateur de crédit.
    const cash = ok(input([FAMILIES.purchase[1], { kind: 'purchase', price: 18_000_000, downPayment: 18_000_000, fees: 0 }], '12'));
    expect(comparisonIndicators(cash.snapshot).some((i) => i.key.startsWith('loan'))).toBe(false);
  });

  it('objectif et placement : indicateurs propres au type', () => {
    const g = ok(input(FAMILIES.goal, '36'));
    const gi = check(g.snapshot);
    expect(gi.goalContribution.values).toEqual(g.live.map((x) => x.goal!.monthlyContribution));
    expect(gi.goalReachedMonth.values).toEqual(g.live.map((x) => x.goal!.reachedMonth));
    expect(gi.goalFinal.values).toEqual(g.live.map((x) => x.goal!.finalBalance));
    expect(gi.goalShortfall.values).toEqual(g.live.map((x) => x.goal!.shortfallAtDeadline));
    expect(gi.goalContributedHorizon.values).toEqual(g.live.map((x) => x.goal!.contributedToHorizon));
    expect(gi.goalInterestHorizon.values).toEqual(g.live.map((x) => x.goal!.interestToHorizon));
    expect(gi.goalToReach.values).toEqual(g.live.map((x) => x.goal!.contributionsToReach));
    expect(gi.goalContributedHorizon.comparable).toBe(true);
    const i = ok(input(FAMILIES.investment.slice(0, 2), '120'));
    const ii = check(i.snapshot);
    const last = (k: number) => i.live[k].savings![i.live[k].savings!.length - 1];
    expect(ii.invFinal.values).toEqual([last(0).closingBalance, last(1).closingBalance]);
    expect(ii.invContributions.values).toEqual([last(0).cumulativeContributions, last(1).cumulativeContributions]);
    expect(ii.invInterest.differences[1]).toBe(last(1).cumulativeInterest - last(0).cumulativeInterest);
    // Dépense récurrente : aucun indicateur propre (le moteur n'en fournit pas).
    expect(comparisonIndicators(ok(input(FAMILIES.recurring.slice(0, 2), '12')).snapshot)).toHaveLength(7);
  });

  it('séries comparées : une ligne par mois calculé, sans interpolation', () => {
    const r = ok(input(FAMILIES.investment.slice(0, 4), '48'));
    const rows = comparisonRows(r.snapshot);
    expect(rows).toHaveLength(49);
    rows.forEach((row, m) => {
      for (let k = 0; k < 4; k++) {
        const single = trajectoryRows(r.snapshot, k)[m];
        expect(row.cash[k]).toBe(single.cash);
        expect(row.netWorth[k]).toBe(single.netWorth);
        expect(row.refCash).toBe(single.refCash);
      }
    });
  });
});

describe('persistance (contrat E4 inchangé)', () => {
  it('limite de 50 : une comparaison compte pour une simulation ; refus explicite, aucune suppression', () => {
    const st = new MemoryStorage();
    for (let k = 0; k < MAX_SIMULATIONS - 1; k++) {
      expect(saveSimulation(ok(input(FAMILIES.recurring.slice(0, 2), '6', { id: `c-${k}` })).snapshot, st).ok).toBe(true);
    }
    const last = ok(input(FAMILIES.recurring.slice(0, 4), '6', { id: 'c-last' })).snapshot;
    expect(saveSimulation(last, st)).toMatchObject({ ok: true, count: MAX_SIMULATIONS });
    const extra = ok(input(FAMILIES.recurring.slice(0, 2), '6', { id: 'c-extra' })).snapshot;
    expect(saveSimulation(extra, st)).toEqual({ ok: false, issue: { code: 'limitReached', limit: MAX_SIMULATIONS, count: MAX_SIMULATIONS } });
    const stored = loadSimulations(st).simulations;
    expect(stored).toHaveLength(MAX_SIMULATIONS);
    expect(stored[0].id).toBe('c-0');
  });

  it('erreur de stockage : signalée, aucune donnée perdue', () => {
    const st = new MemoryStorage();
    const a = ok(input(FAMILIES.recurring.slice(0, 2), '6', { id: 'a' })).snapshot;
    saveSimulation(a, st);
    const before = st.data.get(DECISION_STORE_KEY);
    st.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    const res = saveSimulation(ok(input(FAMILIES.recurring.slice(0, 2), '6', { id: 'b' })).snapshot, st);
    expect(res.ok).toBe(false);
    expect(st.data.get(DECISION_STORE_KEY)).toBe(before);
  });

  it('compatibilité : simulations simples et comparaisons cohabitent dans le même stockage', () => {
    const st = new MemoryStorage();
    const single = runSimulation({ name: 'Simple', horizonText: '12', situation, decision: FAMILIES.recurring[0], startMonth: START, id: 's', createdAt: '2026-11-10T09:00:00.000Z' });
    if (!single.ok) throw new Error();
    const cmp = ok(input(FAMILIES.recurring.slice(0, 3), '12', { id: 'c' })).snapshot;
    saveSimulation(single.snapshot, st);
    saveSimulation(cmp, st);
    const { simulations, issues } = loadSimulations(st);
    expect(issues).toEqual([]);
    expect(simulations.map((s) => [s.id, s.results.variants.length])).toEqual([
      ['s', 1],
      ['c', 3],
    ]);
    expect(simulations[1]).toEqual(cmp);
  });
});

describe('aucun calcul financier dans l\'interface du comparateur', () => {
  it('les composants n\'appellent pas les fonctions de calcul du moteur ni le stockage brut', () => {
    for (const file of ['ComparisonBuilder.tsx', 'ComparisonPanel.tsx', 'ComparisonResults.tsx']) {
      const src = readFileSync(join(process.cwd(), 'src/features/decision', file), 'utf8');
      expect(src, file).not.toMatch(/simulateDecision|amortizationSchedule|savingsSchedule|requiredMonthlyEffort|effectiveMonthlyRate|referenceTrajectory|projectDecision|compareDecisions|createSnapshot/);
      expect(src, file).not.toMatch(/from '@\/data|dexie|localStorage|sessionStorage/);
    }
  });

  it('aucun qualificatif de jugement dans les textes du comparateur (fr, en)', async () => {
    const strings = (m: object) => Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string');
    const fr = strings((await import('@/i18n/locales/fr')).default);
    const en = strings((await import('@/i18n/locales/en')).default);
    const texts = fr.filter(([k]) => k.startsWith('dl.cmp.') || k.startsWith('dl.mode.'));
    expect(texts.length).toBeGreaterThan(40);
    for (const [k, v] of texts) expect(v, k).not.toMatch(/meilleur|rentable|optimal|recommand|gagnant|perdant/i);
    for (const [k, v] of en.filter(([k]) => k.startsWith('dl.cmp.'))) expect(v, k).not.toMatch(/\bbest\b|\bbetter\b|profitable|optimal|recommend|winner|loser/i);
  });
});
