/**
 * Decision Lab — invariants, cas limites, validation et absence d'effet de bord.
 * Les valeurs chiffrées de référence sont dans decision.oracle.test.ts (oracle indépendant) ;
 * ici, uniquement des propriétés qui doivent tenir pour toute entrée valide.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  amortizationSchedule,
  compareDecisions,
  DecisionInputError,
  MAX_HORIZON_MONTHS,
  MAX_RATE_BPS,
  projectDecision,
  referenceTrajectory,
  requiredMonthlyEffort,
  simulateDecision,
  validateDecision,
  type DecisionInput,
  type DecisionResult,
  type InitialSituation,
} from './decision';
import { ValidationError } from '../errors';

const H = (horizonMonths: number) => ({ horizonMonths });

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function issuesOf(fn: () => unknown): { field: string; code: string }[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DecisionInputError);
    expect(e).toBeInstanceOf(ValidationError);
    return (e as DecisionInputError).issues;
  }
  throw new Error('aucune erreur levée');
}

function checkAccounting(r: DecisionResult) {
  expect(r.months).toHaveLength(r.horizonMonths + 1);
  let cum = 0;
  let prev = 0;
  for (const m of r.months) {
    const f = m.flows;
    expect(m.cashFlow).toBe(f.initial + f.fees + f.installment + f.insurance + f.expense + f.contribution);
    expect(f.installment).toBe(f.loanInterest + f.loanPrincipal);
    cum += m.cashFlow;
    expect(m.cumulativeCash).toBe(cum);
    expect(m.netWorthImpact).toBe(m.assets - m.liabilities + m.cumulativeCash);
    expect(m.netWorthChange).toBe(m.netWorthImpact - prev);
    prev = m.netWorthImpact;
  }
}

/** Mensualité arrondie qui ne couvre pas les intérêts : crédit non amortissable (erreur explicite). */
const NOT_AMORTIZABLE = ['1/0/13', '1/0/48', '1/0/480', '1/1/13', '1/1/48', '1/1/480', '1/700/13', '1/700/48', '1/700/480', '1/1200/13', '1/1200/48', '1/1200/480', '1/3000/13', '1/3000/48', '1/3000/480', '99/0/480', '99/1/480', '99/700/480', '99/1200/480', '99/3000/480', '1500000/3000/480'];

describe('amortissement — invariants', () => {
  for (const amount of [1, 99, 1_500_000, 15_000_000, 100_000_000]) {
    for (const bps of [0, 1, 700, 1200, MAX_RATE_BPS]) {
      for (const months of [1, 2, 13, 48, 480]) {
        it(`${amount} c, ${bps} bps, ${months} mois`, () => {
          const label = `${amount}/${bps}/${months}`;
          if (NOT_AMORTIZABLE.includes(label)) {
            expect(issuesOf(() => amortizationSchedule(amount, bps, months))).toEqual([{ field: 'loan', code: 'notAmortizable' }]);
            return;
          }
          const s = amortizationSchedule(amount, bps, months);
          expect(s.rows).toHaveLength(s.actualMonths);
          if (s.earlyPayoffMonth === null) expect(s.actualMonths).toBe(months);
          else {
            // Remboursement anticipé par l'arrondi : dernière échéance ajustée au dû, ≤ mensualité.
            expect(s.actualMonths).toBe(s.earlyPayoffMonth);
            expect(s.actualMonths).toBeLessThan(months);
            expect(s.lastInstallment).toBeLessThanOrEqual(s.installment);
          }
          expect(s.lastInstallment).toBeGreaterThan(0);
          expect(s.rows.reduce((a, r) => a + r.principal, 0)).toBe(amount);
          expect(s.rows.at(-1)!.closingBalance).toBe(0);
          expect(s.totalPaid).toBe(amount + s.totalInterest);
          expect(s.rows.reduce((a, r) => a + r.interest, 0)).toBe(s.totalInterest);
          for (const [k, r] of s.rows.entries()) {
            expect(r.principal).toBeGreaterThanOrEqual(0);
            expect(r.installment).toBe(r.interest + r.principal);
            expect(r.closingBalance).toBe(r.openingBalance - r.principal);
            if (k < s.actualMonths - 1) expect(r.installment).toBe(s.installment);
          }
          if (bps === 0) expect(s.totalInterest).toBe(0);
        });
      }
    }
  }
});

describe('achat', () => {
  const financed: DecisionInput = { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 }, insuranceMonthly: 12_000 };

  it('identité comptable mensuelle ; variation = −(intérêts + assurance)', () => {
    const r = simulateDecision(financed, H(60));
    checkAccounting(r);
    expect(r.months[0].netWorthImpact).toBe(-150_000);
    for (const m of r.months.slice(1)) expect(m.netWorthChange).toBe(m.flows.loanInterest + m.flows.insurance);
    expect(r.months[49].flows.insurance).toBe(0); // assurance limitée à la durée du crédit par défaut
  });

  it('horizon plus court que le crédit : dette restante à l\'horizon', () => {
    const r = simulateDecision(financed, H(12));
    checkAccounting(r);
    expect(r.summary.finalLiabilities).toBe(r.loan!.rows[11].closingBalance);
    expect(r.loan!.rows).toHaveLength(48);
  });

  it('achat comptant : aucune dette, patrimoine = valeur − prix − frais', () => {
    const r = simulateDecision({ kind: 'purchase', price: 5_000_000, downPayment: 5_000_000, fees: 10_000, assetValue: 4_500_000 }, H(6));
    checkAccounting(r);
    expect(r.loan).toBeUndefined();
    expect(r.months.every((m) => m.liabilities === 0)).toBe(true);
    expect(r.summary.finalNetWorthImpact).toBe(4_500_000 - 5_000_000 - 10_000);
    expect(r.summary.finalCumulativeCash).toBe(-5_010_000);
  });

  it('assurance sans crédit : durée explicite', () => {
    const r = simulateDecision({ kind: 'purchase', price: 100, downPayment: 100, fees: 0, insuranceMonthly: 10, insuranceMonths: 3 }, H(5));
    expect(r.months.map((m) => m.flows.insurance)).toEqual([0, -10, -10, -10, 0, 0]);
  });
});

describe('dépense récurrente', () => {
  it('fenêtre début / durée, impact = trésorerie', () => {
    const r = simulateDecision({ kind: 'recurring', monthlyAmount: 50_000, startMonth: 3, months: 4 }, H(10));
    checkAccounting(r);
    expect(r.months.map((m) => m.flows.expense)).toEqual([0, 0, 0, -50_000, -50_000, -50_000, -50_000, 0, 0, 0, 0]);
    expect(r.summary.finalNetWorthImpact).toBe(-200_000);
    expect(r.months.every((m) => m.netWorthImpact === m.cumulativeCash)).toBe(true);
  });

  it('sans durée : jusqu\'à l\'horizon', () => {
    const r = simulateDecision({ kind: 'recurring', monthlyAmount: 1 }, H(MAX_HORIZON_MONTHS));
    expect(r.summary.finalCumulativeCash).toBe(-MAX_HORIZON_MONTHS);
  });
});

describe('placement', () => {
  for (const bps of [0, 1, 300, 600, MAX_RATE_BPS]) {
    it(`${bps} bps : solde = apports + intérêts ; impact patrimonial = intérêts cumulés`, () => {
      const r = simulateDecision({ kind: 'investment', initialCapital: 2_000_000, monthlyContribution: 150_000, contributionMonths: 24, effectiveRateBps: bps }, H(36));
      checkAccounting(r);
      for (const [k, s] of r.savings!.entries()) {
        expect(s.closingBalance).toBe(s.cumulativeContributions + s.cumulativeInterest);
        expect(r.months[k + 1].netWorthImpact).toBe(s.cumulativeInterest);
        expect(s.contribution).toBe(k < 24 ? 150_000 : 0);
      }
      if (bps === 0) expect(r.summary.finalNetWorthImpact).toBe(0);
      else expect(r.summary.finalNetWorthImpact).toBeGreaterThan(0);
    });
  }

  it('crédit soldé avant terme par l\'arrondi : échéancier arrêté, dette nulle ensuite, assurance arrêtée', () => {
    const r = simulateDecision({ kind: 'purchase', price: 99, downPayment: 0, fees: 0, loan: { nominalRateBps: 1200, months: 48 }, insuranceMonthly: 1 }, H(60));
    checkAccounting(r);
    const loan = r.loan!;
    expect(loan.earlyPayoffMonth).not.toBeNull();
    expect(loan.actualMonths).toBeLessThan(48);
    expect(loan.rows.reduce((a, x) => a + x.principal, 0)).toBe(99);
    for (const m of r.months.slice(loan.actualMonths + 1)) {
      expect(m.liabilities).toBe(0);
      expect(m.flows.installment).toBe(0);
      expect(m.flows.insurance).toBe(0);
    }
    expect(r.months.every((m) => m.flows.installment <= 0)).toBe(true);
  });

  it('crédit non amortissable : erreur explicite dans une simulation d\'achat', () => {
    expect(issuesOf(() => simulateDecision({ kind: 'purchase', price: 99, downPayment: 0, fees: 0, loan: { nominalRateBps: 1200, months: 480 } }, H(12))))
      .toEqual([{ field: 'loan', code: 'notAmortizable' }]);
  });

  it('dépassement de la précision des montants : erreur explicite', () => {
    expect(issuesOf(() => simulateDecision({ kind: 'investment', initialCapital: Number.MAX_SAFE_INTEGER, monthlyContribution: 0, effectiveRateBps: MAX_RATE_BPS }, H(480))))
      .toEqual([{ field: 'result', code: 'resultOutOfRange' }]);
  });
});

describe('objectif d\'épargne', () => {
  it('effort au centime supérieur à 0 % et dernier versement plafonné', () => {
    expect(requiredMonthlyEffort(100, 0, 3)).toBe(34);
    const r = simulateDecision({ kind: 'goal', mode: 'effort', target: 100, effectiveRateBps: 0, months: 3 }, H(3));
    expect(r.goal!.schedule.map((s) => s.contribution)).toEqual([34, 34, 32]);
    expect(r.goal!.reachedMonth).toBe(3);
  });

  for (const bps of [0, 150, 300, MAX_RATE_BPS]) {
    for (const n of [1, 7, 24, 480]) {
      it(`effort ${bps} bps, ${n} mois : cible atteinte au plus tard au dernier mois`, () => {
        const r = simulateDecision({ kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: bps, months: n }, H(n));
        checkAccounting(r);
        const g = r.goal!;
        // Effort de quelques centimes (30 %, 480 mois) : l'arrondi supérieur, capitalisé, atteint la cible avant n.
        expect(g.reachedMonth).toBe(bps === MAX_RATE_BPS && n === 480 ? 477 : n);
        // Le versement est plafonné au besoin ; si les intérêts du mois suffisent seuls, ils peuvent dépasser la cible.
        const closing = g.schedule.at(-1)!.closingBalance;
        expect(closing).toBeGreaterThanOrEqual(6_000_000);
        if (g.lastContribution > 0) expect(closing).toBe(6_000_000);
        expect(g.totalContributed + g.totalInterest).toBe(closing);
        expect(g.schedule.every((s) => s.contribution <= g.monthlyContribution)).toBe(true);
        // Un centime de moins ne suffit pas (effort minimal).
        if (g.monthlyContribution > 1) {
          const less = simulateDecision({ kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: bps, monthlyContribution: g.monthlyContribution - 1 }, H(1));
          expect(less.goal!.reachedMonth === null || less.goal!.reachedMonth > n).toBe(true);
        }
      });
    }
  }

  it('non atteint en 480 mois : null, manque à l\'échéance', () => {
    const r = simulateDecision({ kind: 'goal', mode: 'contribution', target: 1_000_000, effectiveRateBps: 0, monthlyContribution: 1, deadlineMonths: 12 }, H(12));
    expect(r.goal!.reachedMonth).toBeNull();
    expect(r.goal!.schedule).toHaveLength(MAX_HORIZON_MONTHS);
    expect(r.goal!.reachedByDeadline).toBe(false);
    expect(r.goal!.shortfallAtDeadline).toBe(1_000_000 - 12);
  });

  it('après l\'atteinte : versements arrêtés, capital conservé et rémunéré ; atteinte et solde final distincts', () => {
    const r = simulateDecision({ kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 300, months: 12 }, H(24));
    checkAccounting(r);
    const g = r.goal!;
    expect(g.reachedMonth).toBe(12);
    expect(g.balanceAtReach).toBe(6_000_000);
    expect(r.months.slice(13).every((m) => m.flows.contribution === 0)).toBe(true);
    for (let m = 13; m <= 24; m++) {
      expect(r.months[m].assets).toBeGreaterThan(r.months[m - 1].assets);
      expect(r.months[m].netWorthChange).toBe(r.months[m].assets - r.months[m - 1].assets);
    }
    expect(g.finalBalance).toBe(r.months[24].assets);
    expect(g.interestAfterReach).toBe(g.finalBalance - g.balanceAtReach!);
    expect(g.interestAfterReach).toBeGreaterThan(0);
    expect(r.summary.finalNetWorthImpact).toBe(g.totalInterest + g.interestAfterReach);
    // Le solde à l'atteinte ne dépend pas de l'horizon.
    const longer = simulateDecision({ kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 300, months: 12 }, H(60));
    expect(longer.goal!.balanceAtReach).toBe(6_000_000);
    expect(longer.goal!.finalBalance).toBeGreaterThan(g.finalBalance);
    const flat = simulateDecision({ kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 0, months: 12 }, H(24));
    expect(flat.goal!.finalBalance).toBe(6_000_000);
    expect(flat.goal!.interestAfterReach).toBe(0);
  });

  it('horizon plus court que l\'atteinte : solde final < cible, aucun intérêt après atteinte', () => {
    const r = simulateDecision({ kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 300, monthlyContribution: 250_000 }, H(12));
    expect(r.goal!.reachedMonth).toBe(24);
    expect(r.goal!.finalBalance).toBe(r.months[12].assets);
    expect(r.goal!.finalBalance).toBeLessThan(6_000_000);
    expect(r.goal!.interestAfterReach).toBe(0);
  });
});

describe('référence et comparaison', () => {
  const situation: InitialSituation = { cash: 5_000_000, netWorth: 30_000_000, monthlySavings: 400_000 };
  const variants = [
    { id: 'comptant', decision: { kind: 'purchase', price: 18_000_000, downPayment: 18_000_000, fees: 150_000 } as DecisionInput },
    { id: 'credit', label: 'Crédit 48 mois', decision: { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 } } as DecisionInput },
    { id: 'epargne', decision: { kind: 'investment', initialCapital: 0, monthlyContribution: 100_000, effectiveRateBps: 300 } as DecisionInput },
  ];

  it('référence linéaire non rémunérée (H12)', () => {
    const ref = referenceTrajectory(situation, { horizonMonths: 3, startMonth: '2026-11' });
    expect(ref).toEqual([
      { month: 0, monthKey: '2026-11', cash: 5_000_000, netWorth: 30_000_000 },
      { month: 1, monthKey: '2026-12', cash: 5_400_000, netWorth: 30_400_000 },
      { month: 2, monthKey: '2027-01', cash: 5_800_000, netWorth: 30_800_000 },
      { month: 3, monthKey: '2027-02', cash: 6_200_000, netWorth: 31_200_000 },
    ]);
  });

  it('avec décision = référence + écart ; même référence pour toutes les variantes', () => {
    const cmp = compareDecisions(situation, variants, H(60));
    expect(cmp.variants.map((v) => v.id)).toEqual(['comptant', 'credit', 'epargne']);
    for (const v of cmp.variants) {
      expect(v.trajectory.map((p) => p.reference)).toEqual(cmp.reference.map((p) => ({ cash: p.cash, netWorth: p.netWorth })));
      for (const [m, p] of v.trajectory.entries()) {
        expect(p.withDecision.cash).toBe(p.reference.cash + v.result.months[m].cumulativeCash);
        expect(p.withDecision.netWorth).toBe(p.reference.netWorth + v.result.months[m].netWorthImpact);
      }
      expect(v.endOfHorizon.cashDelta).toBe(v.result.summary.finalCumulativeCash);
    }
    // Comptant : trésorerie négative dès le mois 0 (5 M − 18,15 M), redevient positive avec l'épargne.
    const cash = cmp.variants[0];
    expect(cash.firstNegativeCashMonth).toBe(0);
    expect(cash.lowestCash).toEqual({ month: 0, value: 5_000_000 - 18_150_000 });
    expect(cmp.variants[2].firstNegativeCashMonth).toBeNull();
    expect(cmp.variants[1].label).toBe('Crédit 48 mois');
  });

  it('projectDecision refuse des horizons différents', () => {
    const ref = referenceTrajectory(situation, H(5));
    const r = simulateDecision({ kind: 'recurring', monthlyAmount: 1 }, H(6));
    expect(() => projectDecision(ref, r)).toThrow();
  });

  it('nombre de variantes, identifiants et erreurs par variante', () => {
    expect(issuesOf(() => compareDecisions(situation, variants.slice(0, 1), H(12)))).toEqual([{ field: 'variants', code: 'variantCount' }]);
    expect(issuesOf(() => compareDecisions(situation, [...variants, ...variants].slice(0, 5).map((v, k) => ({ ...v, id: `v${k}` })), H(12)))).toEqual([{ field: 'variants', code: 'variantCount' }]);
    expect(issuesOf(() => compareDecisions(situation, [variants[0], { ...variants[1], id: 'comptant' }], H(12)))).toEqual([{ field: 'variants[1].id', code: 'duplicate' }]);
    expect(issuesOf(() => compareDecisions(situation, [variants[0], { id: 'x', decision: { kind: 'recurring', monthlyAmount: -1 } }], H(12)))).toEqual([{ field: 'variants[1].monthlyAmount', code: 'notPositive' }]);
    expect(issuesOf(() => compareDecisions({ ...situation, cash: 1.5 }, variants.slice(0, 2), H(12)))).toEqual([{ field: 'situation.cash', code: 'notInteger' }]);
  });
});

describe('validation', () => {
  const ok = { kind: 'purchase', price: 1000, downPayment: 1000, fees: 0 } as const;
  const cases: [string, unknown, number, { field: string; code: string }[]][] = [
    ['horizon nul', ok, 0, [{ field: 'horizonMonths', code: 'notPositive' }]],
    ['horizon > 480', ok, 481, [{ field: 'horizonMonths', code: 'tooLarge' }]],
    ['montant décimal', { ...ok, fees: 0.5 }, 12, [{ field: 'fees', code: 'notInteger' }]],
    ['montant négatif', { ...ok, fees: -1 }, 12, [{ field: 'fees', code: 'negative' }]],
    ['NaN', { ...ok, price: Number.NaN }, 12, [{ field: 'price', code: 'notInteger' }]],
    ['apport > prix', { ...ok, downPayment: 2000 }, 12, [{ field: 'downPayment', code: 'exceedsPrice' }]],
    ['crédit manquant', { ...ok, downPayment: 100 }, 12, [{ field: 'loan', code: 'loanRequired' }]],
    ['crédit inutile', { ...ok, loan: { nominalRateBps: 500, months: 12 } }, 12, [{ field: 'loan', code: 'loanNotAllowed' }]],
    ['taux > 30 %', { ...ok, downPayment: 0, loan: { nominalRateBps: MAX_RATE_BPS + 1, months: 12 } }, 12, [{ field: 'loan.nominalRateBps', code: 'rateOutOfRange' }]],
    ['durée de crédit > 480', { ...ok, downPayment: 0, loan: { nominalRateBps: 0, months: 481 } }, 12, [{ field: 'loan.months', code: 'tooLarge' }]],
    ['assurance sans durée', { ...ok, insuranceMonthly: 10 }, 12, [{ field: 'insuranceMonths', code: 'required' }]],
    ['dépense nulle', { kind: 'recurring', monthlyAmount: 0 }, 12, [{ field: 'monthlyAmount', code: 'notPositive' }]],
    ['début au mois 0', { kind: 'recurring', monthlyAmount: 1, startMonth: 0 }, 12, [{ field: 'startMonth', code: 'notPositive' }]],
    ['cible nulle', { kind: 'goal', mode: 'effort', target: 0, effectiveRateBps: 0, months: 12 }, 12, [{ field: 'target', code: 'notPositive' }]],
    ['taux d\'objectif négatif', { kind: 'goal', mode: 'effort', target: 1, effectiveRateBps: -1, months: 12 }, 12, [{ field: 'effectiveRateBps', code: 'negative' }]],
    ['mode inconnu', { kind: 'goal', mode: 'x', target: 1, effectiveRateBps: 0 }, 12, [{ field: 'mode', code: 'unknownMode' }]],
    ['versement nul', { kind: 'goal', mode: 'contribution', target: 1, effectiveRateBps: 0, monthlyContribution: 0 }, 12, [{ field: 'monthlyContribution', code: 'notPositive' }]],
    ['placement vide', { kind: 'investment', initialCapital: 0, monthlyContribution: 0, effectiveRateBps: 0 }, 12, [{ field: 'initialCapital', code: 'emptyInvestment' }]],
    ['type inconnu', { kind: 'loto' }, 12, [{ field: 'kind', code: 'unknownKind' }]],
  ];
  for (const [label, input, horizon, expected] of cases) {
    it(label, () => {
      expect(validateDecision(input as DecisionInput, H(horizon))).toEqual(expected);
      expect(issuesOf(() => simulateDecision(input as DecisionInput, H(horizon)))).toEqual(expected);
    });
  }

  it('mois de départ invalide', () => {
    expect(validateDecision(ok, { horizonMonths: 12, startMonth: '2026-13' })).toEqual([{ field: 'startMonth', code: 'invalidMonth' }]);
  });
});

describe('pureté et isolation', () => {
  it('entrées gelées : aucune modification, résultats déterministes', () => {
    const situation = deepFreeze({ cash: 1_000_000, netWorth: 2_000_000, monthlySavings: 50_000 });
    const variants = deepFreeze([
      { id: 'a', decision: { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 }, insuranceMonthly: 12_000 } as DecisionInput },
      { id: 'b', decision: { kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 300, months: 24 } as DecisionInput },
    ]);
    const before = JSON.stringify([situation, variants]);
    const first = compareDecisions(situation, variants, { horizonMonths: 60, startMonth: '2026-11' });
    expect(JSON.stringify([situation, variants])).toBe(before);
    expect(compareDecisions(situation, variants, { horizonMonths: 60, startMonth: '2026-11' })).toEqual(first);
    expect(first.variants[0].result.months[60].monthKey).toBe('2031-11');
  });

  it('le moteur n\'importe aucune couche de données ni stockage', () => {
    for (const file of ['decision.ts', 'decisionSituation.ts']) {
      const src = readFileSync(join(process.cwd(), 'src/domain/calc', file), 'utf8');
      expect(src, file).not.toMatch(/from '@\/data|from 'dexie|repository|indexedDB|localStorage|sessionStorage|fetch\(/);
    }
  });
});
