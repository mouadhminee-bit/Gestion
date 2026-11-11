/**
 * Decision Lab — correction A2 : totaux d'un objectif d'épargne sur l'HORIZON simulé.
 *
 * Références indépendantes du moteur :
 *  - échéanciers de l'oracle Python E2 (references/decision-lab/case3_savings_goal.json), sommés
 *    mois par mois jusqu'à l'horizon (versements, intérêts, solde au mois 24, intérêts après l'atteinte) ;
 *  - valeurs calculées à la main à rendement nul (aucun intérêt : versé = somme des versements) ;
 *  - flux réels de la série mensuelle du moteur (la somme des versements de `months` doit retomber
 *    exactement sur le total affiché).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { goalHorizonTotalsFromImpact, MAX_HORIZON_MONTHS, simulateDecision, type DecisionInput, type DecisionResult } from './decision';

interface OracleRow {
  mois: number;
  interets: number;
  versement: number;
  solde_cloture: number;
}
interface OracleScenario {
  versement_mensuel_centimes: number;
  mois_atteinte: number;
  solde_au_mois_24_centimes: number;
  interets_apres_atteinte_jusqu_au_mois_24_centimes: number;
  total_verse_centimes: number;
  echeancier: OracleRow[];
}
const oracle = JSON.parse(readFileSync(join(process.cwd(), 'references/decision-lab/case3_savings_goal.json'), 'utf8'));
const TARGET: number = oracle.parametres.cible_centimes;
const scenarios = (rate: string): OracleScenario[] => oracle.resultats[rate].versement_constant.scenarios;
const effort3 = oracle.resultats.rendement_3_pct_effectif.effort_constant.avec_arrondis as { effort_mensuel_centimes: number; total_verse_centimes: number; echeancier: OracleRow[] };

const contribution = (monthly: number, bps: number, deadlineMonths?: number): DecisionInput => ({ kind: 'goal', mode: 'contribution', target: TARGET, effectiveRateBps: bps, monthlyContribution: monthly, ...(deadlineMonths ? { deadlineMonths } : {}) });
const goalOf = (d: DecisionInput, horizon: number) => {
  const r = simulateDecision(d, { horizonMonths: horizon });
  return { r, g: r.goal! };
};

/** Critère A2 : les totaux de l'horizon se retrouvent en additionnant les flux réels de la série mensuelle. */
function expectSeriesConsistency(r: DecisionResult, horizon: number) {
  const g = r.goal!;
  const paid = r.months.slice(1, horizon + 1).reduce((s, m) => s - m.flows.contribution, 0);
  expect(g.contributedToHorizon).toBe(paid);
  expect(g.contributedToHorizon).toBe(-r.months[horizon].cumulativeCash || 0);
  // Solde du compte dédié = versé + intérêts, au même mois (fin d'horizon).
  expect(g.finalBalance).toBe(r.months[horizon].assets);
  expect(g.contributedToHorizon + g.interestToHorizon).toBe(g.finalBalance);
  expect(g.interestToHorizon).toBe(r.months[horizon].netWorthImpact);
  expect(goalHorizonTotalsFromImpact(r.months[horizon].cumulativeCash, r.months[horizon].netWorthImpact)).toEqual({ contributedToHorizon: g.contributedToHorizon, interestToHorizon: g.interestToHorizon });
  expect(g.interestToHorizon).toBeGreaterThanOrEqual(0);
}

describe('A2 — oracle E2, 3 % effectif, cible 60 000 DH, horizon 24 mois', () => {
  const [ref2500, ref2000, ref3000] = scenarios('rendement_3_pct_effectif');

  it('1. objectif atteint AVANT la fin de l\'horizon (3 000 DH/mois, atteinte au mois 20) puis rémunéré jusqu\'au mois 24', () => {
    const { r, g } = goalOf(contribution(ref3000.versement_mensuel_centimes, 300), 24);
    expect(g.reachedMonth).toBe(ref3000.mois_atteinte);
    expect(g.reachedMonth).toBe(20);
    // Versé sur l'horizon = tous les versements jusqu'à l'atteinte (aucun versement après).
    expect(g.contributedToHorizon).toBe(ref3000.total_verse_centimes);
    expect(g.finalBalance).toBe(ref3000.solde_au_mois_24_centimes);
    expect(g.interestToHorizon).toBe(ref3000.solde_au_mois_24_centimes - ref3000.total_verse_centimes);
    expect(g.interestAfterReach).toBe(ref3000.interets_apres_atteinte_jusqu_au_mois_24_centimes);
    // Intérêts jusqu'à l'atteinte (échéancier) + intérêts après l'atteinte = intérêts sur l'horizon.
    expect(g.totalInterest + g.interestAfterReach).toBe(g.interestToHorizon);
    expect(g.contributionsToReach).toBe(ref3000.total_verse_centimes);
    expectSeriesConsistency(r, 24);
  });

  it('2. objectif atteint EXACTEMENT à la fin de l\'horizon (2 500 DH/mois ; délai fixé de 24 mois)', () => {
    const { r, g } = goalOf(contribution(ref2500.versement_mensuel_centimes, 300), 24);
    expect(g.reachedMonth).toBe(24);
    expect(g.contributedToHorizon).toBe(ref2500.total_verse_centimes);
    expect(g.finalBalance).toBe(TARGET);
    expect(g.interestToHorizon).toBe(TARGET - ref2500.total_verse_centimes);
    expect(g.interestAfterReach).toBe(0);
    expectSeriesConsistency(r, 24);
    // Délai fixé (mode effort) : effort et échéancier de l'oracle.
    const e = goalOf({ kind: 'goal', mode: 'effort', target: TARGET, effectiveRateBps: 300, months: 24 }, 24);
    expect(e.g.monthlyContribution).toBe(effort3.effort_mensuel_centimes);
    expect(e.g.contributedToHorizon).toBe(effort3.total_verse_centimes);
    expect(e.g.interestToHorizon).toBe(TARGET - effort3.total_verse_centimes);
    expect(e.g.contributionsToReach).toBe(effort3.total_verse_centimes);
    expectSeriesConsistency(e.r, 24);
  });

  it('3. objectif NON atteint à la fin de l\'horizon (2 000 DH/mois, atteinte au mois 29)', () => {
    const { r, g } = goalOf(contribution(ref2000.versement_mensuel_centimes, 300), 24);
    expect(g.reachedMonth).toBe(29); // après l'horizon, jamais présenté comme atteint dans l'horizon
    const rows = ref2000.echeancier.slice(0, 24);
    expect(g.contributedToHorizon).toBe(rows.reduce((s, x) => s + x.versement, 0));
    expect(g.contributedToHorizon).toBe(4_800_000);
    expect(g.interestToHorizon).toBe(rows.reduce((s, x) => s + x.interets, 0));
    expect(g.finalBalance).toBe(ref2000.solde_au_mois_24_centimes);
    // Les totaux de l'échéancier, eux, vont jusqu'au mois 29 : ils ne sont plus ceux de l'horizon.
    expect(g.totalContributed).toBe(ref2000.total_verse_centimes);
    expect(g.totalContributed).toBeGreaterThan(g.contributedToHorizon);
    expectSeriesConsistency(r, 24);
  });

  it('4. horizon plus court que le délai d\'atteinte : sommes de l\'oracle mois par mois', () => {
    for (const sc of [ref2500, ref2000, ref3000]) {
      for (const h of [1, 6, 12, 19, 20, 21, 23, 24]) {
        const { r, g } = goalOf(contribution(sc.versement_mensuel_centimes, 300), h);
        const rows = sc.echeancier.filter((x) => x.mois <= h);
        const paid = rows.reduce((s, x) => s + x.versement, 0);
        // Au-delà de l'échéancier de l'oracle (atteinte avant h) : solde de l'oracle au mois 24 seulement.
        if (h <= sc.mois_atteinte) {
          expect(g.contributedToHorizon, `${sc.versement_mensuel_centimes} h=${h}`).toBe(paid);
          expect(g.interestToHorizon, `${sc.versement_mensuel_centimes} h=${h}`).toBe(rows.reduce((s, x) => s + x.interets, 0));
          expect(g.finalBalance).toBe(rows[rows.length - 1].solde_cloture);
        } else {
          expect(g.contributedToHorizon).toBe(sc.total_verse_centimes);
        }
        expectSeriesConsistency(r, h);
      }
    }
  });
});

describe('A2 — rendement nul : valeurs calculées à la main', () => {
  it.each([
    // versement, horizon, atteinte attendue, versé sur l'horizon attendu
    [250_000, 12, 24, 3_000_000],
    [250_000, 24, 24, 6_000_000],
    [250_000, 60, 24, 6_000_000],
    [300_000, 24, 20, 6_000_000],
    [700_000, 12, 9, 6_000_000], // 8 × 7 000 + 4 000 plafonné au mois 9
    [10_000, 60, null, 600_000], // 100 DH/mois : cible jamais atteinte en 480 mois
    [10_000, 480, null, 4_800_000],
  ])('versement %i, horizon %i : atteinte %s, versé %i, aucun intérêt', (monthly, h, reached, paid) => {
    const { r, g } = goalOf(contribution(monthly, 0), h);
    expect(g.reachedMonth).toBe(reached);
    expect(g.contributedToHorizon).toBe(paid);
    expect(g.interestToHorizon).toBe(0);
    expect(g.finalBalance).toBe(paid);
    // Pas d'atteinte fictive : aucun montant « nécessaire pour atteindre la cible » si elle n'est pas atteinte.
    expect(g.contributionsToReach).toBe(reached === null ? null : TARGET);
    expectSeriesConsistency(r, h);
  });

  it('dernier versement plafonné : 7 000 DH/mois, le 9e versement vaut 4 000 DH', () => {
    const { g } = goalOf(contribution(700_000, 0), 12);
    expect(g.lastContribution).toBe(400_000);
    expect(g.contributedToHorizon).toBe(8 * 700_000 + 400_000);
  });
});

describe('A2 — horizons 1, 12, 60 et 480 mois, deux méthodes, avec et sans rendement', () => {
  const cases: [string, DecisionInput][] = [
    ['effort 24 mois 3 %', { kind: 'goal', mode: 'effort', target: TARGET, effectiveRateBps: 300, months: 24 }],
    ['effort 36 mois 0 %', { kind: 'goal', mode: 'effort', target: TARGET, effectiveRateBps: 0, months: 36 }],
    ['effort 480 mois 30 %', { kind: 'goal', mode: 'effort', target: 1_000_000_000, effectiveRateBps: 3000, months: 480 }],
    ['versement 3 000 DH 3 %', contribution(300_000, 300)],
    ['versement 3 000 DH échéance 18', contribution(300_000, 300, 18)],
    ['versement 100 DH non atteint', contribution(10_000, 450)],
  ];
  for (const [name, d] of cases) {
    for (const h of [1, 12, 60, 480]) {
      it(`${name}, horizon ${h}`, () => {
        const { r, g } = goalOf(d, h);
        expectSeriesConsistency(r, h);
        // Versé sur l'horizon : jamais plus que l'échéancier, et égal à lui si l'atteinte est dans l'horizon.
        expect(g.contributedToHorizon).toBeLessThanOrEqual(g.totalContributed);
        if (g.reachedMonth !== null && g.reachedMonth <= h) expect(g.contributedToHorizon).toBe(g.totalContributed);
        else expect(g.contributedToHorizon).toBe(g.monthlyContribution * h);
        expect(g.contributionsToReach).toBe(g.reachedMonth === null ? null : g.totalContributed);
        expect(Number.isSafeInteger(g.interestToHorizon)).toBe(true);
      });
    }
  }

  it('cible jamais atteinte en 480 mois : aucune atteinte, versé limité à l\'horizon', () => {
    const { g } = goalOf(contribution(10_000, 0), 60);
    expect(g.reachedMonth).toBeNull();
    expect(g.contributionsToReach).toBeNull();
    expect(g.totalContributed).toBe(MAX_HORIZON_MONTHS * 10_000); // échéancier (480 mois), non affiché
    expect(g.contributedToHorizon).toBe(60 * 10_000);
  });
});
