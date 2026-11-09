/**
 * Decision Lab — validation du moteur contre l'ORACLE INDÉPENDANT (references/decision-lab/).
 *
 * Les valeurs attendues proviennent exclusivement des fichiers JSON générés par
 * `references/decision-lab/generate_references.py` (Python, arithmétique exacte, double calcul).
 * Aucun résultat attendu n'est recalculé ici : les tests lisent les paramètres et les résultats de
 * l'oracle, exécutent le moteur et comparent. Seuls les blocs de statut `valide_conventions`,
 * `verifie_math` ou `synthetique` sont utilisés comme références.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { amortizationSchedule, formatEffectiveMonthlyRate, requiredMonthlyEffort, simulateDecision, type DecisionResult } from './decision';

// Données JSON externes : typage volontairement souple, la forme est imposée par les assertions.
type Json = any;
// vitest s'exécute à la racine du dépôt (même convention que restoreUi.test.ts).
const load = (name: string): Json => JSON.parse(readFileSync(join(process.cwd(), 'references/decision-lab', `${name}.json`), 'utf8'));
const c1 = load('case1_vehicle_loan');
const c2 = load('case2_investment');
const c3 = load('case3_savings_goal');

const USABLE = ['valide_conventions', 'verifie_math', 'synthetique'];
const usable = (block: Json) => expect(USABLE, `statut de l'oracle : ${block.statut}`).toContain(block.statut);
const dh = (cents: number) => (cents / 100).toFixed(2);

const goalRows = (r: DecisionResult) =>
  r.goal!.schedule.map((x) => ({ mois: x.month, solde_ouverture: x.openingBalance, interets: x.interest, versement: x.contribution, solde_cloture: x.closingBalance }));

describe('Oracle — génération', () => {
  it('les trois référentiels partagent les mêmes conventions, toutes validées', () => {
    expect(c2.meta).toEqual(c1.meta);
    expect(c3.meta).toEqual(c1.meta);
    const pending = Object.entries(c1.meta.hypotheses as Record<string, Json>).filter(([, h]) => h.etat !== 'validee');
    expect(pending).toEqual([]);
  });
});

describe('Oracle cas 1 — véhicule financé', () => {
  const p = c1.parametres;
  const res = simulateDecision(
    {
      kind: 'purchase',
      price: p.prix_vehicule,
      downPayment: p.apport,
      fees: p.frais_initiaux,
      assetValue: p.valeur_comptable_vehicule,
      loan: { nominalRateBps: p.taux_nominal_annuel_bps, months: p.duree_credit_mois },
      insuranceMonthly: p.assurance_mensuelle,
      insuranceMonths: p.duree_assurance_mois,
    },
    { horizonMonths: p.horizon_simulation_mois },
  );

  it('échéancier du crédit identique ligne à ligne', () => {
    usable(c1.credit);
    const rows = res.loan!.rows.map((r) => ({
      mois: r.month,
      capital_restant_debut: r.openingBalance,
      echeance: r.installment,
      interets: r.interest,
      capital_amorti: r.principal,
      capital_restant_fin: r.closingBalance,
    }));
    expect(rows).toEqual(c1.credit.echeancier);
    const o = c1.credit.resultats;
    expect(res.loan!.installment).toBe(o.mensualite_arrondie_centimes);
    expect(res.loan!.lastInstallment).toBe(o.derniere_echeance_centimes);
    expect(res.loan!.totalInterest).toBe(o.total_interets_centimes);
    expect(res.loan!.totalPaid).toBe(o.total_rembourse_centimes);
  });

  it('trajectoire incrémentale (trésorerie, actif, dette, patrimoine) identique sur 61 mois', () => {
    const tr = c1.trajectoire_ecart_vs_reference;
    usable(tr);
    const rows = res.months.map((m) => ({
      mois: m.month,
      flux: {
        apport: m.flows.initial,
        frais_initiaux: m.flows.fees,
        echeance: m.flows.installment,
        dont_interets: m.flows.loanInterest,
        dont_capital: m.flows.loanPrincipal,
        assurance: m.flows.insurance,
        total: m.cashFlow,
      },
      ecart_tresorerie_cumule: m.cumulativeCash,
      actif_vehicule: m.assets,
      dette_restante: m.liabilities,
      impact_patrimoine_net: m.netWorthImpact,
      variation_impact_patrimoine_du_mois: m.netWorthChange,
    }));
    expect(rows).toEqual(tr.mois);
    expect(res.summary.finalCumulativeCash).toBe(tr.synthese.ecart_tresorerie_cumule_fin_horizon);
    expect(res.summary.finalNetWorthImpact).toBe(tr.synthese.impact_patrimoine_net_fin_horizon);
  });

  it('points de contrôle des mois 0, 1, 48, 49 et 60', () => {
    for (const cp of c1.trajectoire_ecart_vs_reference.points_de_controle.mois) {
      const m = res.months[cp.mois];
      expect({
        flux_du_mois_DH: dh(m.cashFlow),
        ecart_tresorerie_cumule_DH: dh(m.cumulativeCash),
        actif_vehicule_DH: dh(m.assets),
        dette_restante_DH: dh(m.liabilities),
        impact_patrimoine_net_DH: dh(m.netWorthImpact),
      }).toEqual(Object.fromEntries(Object.entries(cp).filter(([k]) => k !== 'mois')));
    }
  });

  it('écart de dernière échéance égal à la réconciliation exacte de l\'oracle', () => {
    const d = Number(c1.analyse_ecart_derniere_echeance.reconciliation_centimes.D);
    expect(res.loan!.lastInstallment - res.loan!.installment).toBe(d);
  });

  describe('générateur d\'amortissement — jeux synthétiques G1 à G3', () => {
    for (const g of c1.verification_du_generateur.jeux_synthetiques as Json[]) {
      it(g.libelle, () => {
        usable(g);
        const s = amortizationSchedule(g.parametres.montant_finance_centimes, g.parametres.taux_annuel_nominal_bps, g.parametres.duree_mois);
        expect(s.installment).toBe(g.resultats.mensualite_arrondie_centimes);
        expect(s.lastInstallment).toBe(g.resultats.derniere_echeance_centimes);
        expect(s.totalInterest).toBe(g.resultats.total_interets_centimes);
        expect(s.totalPaid).toBe(g.resultats.total_rembourse_centimes);
        expect(s.lastInstallment - s.installment).toBe(Number(g.analyse_ecart_derniere_echeance.reconciliation_centimes.D));
        if (g.echeancier) {
          expect(s.rows.map((r) => [r.month, r.openingBalance, r.installment, r.interest, r.principal, r.closingBalance])).toEqual(
            g.echeancier.map((r: Json) => [r.mois, r.capital_restant_debut, r.echeance, r.interets, r.capital_amorti, r.capital_restant_fin]),
          );
        }
      });
    }
  });
});

describe('Oracle cas 2 — placement', () => {
  const p = c2.parametres;
  const res = simulateDecision(
    { kind: 'investment', initialCapital: p.capital_initial_centimes, monthlyContribution: p.versement_mensuel_centimes, effectiveRateBps: p.taux_annuel_effectif_bps },
    { horizonMonths: p.duree_mois },
  );
  const block = c2.resultats_candidats.fin.arrondi_mensuel;

  it('taux mensuel équivalent identique à 30 décimales', () => {
    usable(c2.taux_mensuel_equivalent);
    expect(formatEffectiveMonthlyRate(p.taux_annuel_effectif_bps, 30)).toBe(c2.taux_mensuel_equivalent.valeur);
  });

  it('échéancier mensuel identique sur 120 mois (fin de mois, intérêts arrondis)', () => {
    usable(block);
    const rows = res.savings!.map((r) => ({
      mois: r.month,
      solde_ouverture: r.openingBalance,
      versement: r.contribution,
      interets: r.interest,
      solde_cloture: r.closingBalance,
      apports_cumules_capital_initial_inclus: r.cumulativeContributions,
      interets_cumules: r.cumulativeInterest,
    }));
    expect(rows).toEqual(block.echeancier);
  });

  it('valeur finale, apports et impact patrimonial', () => {
    expect(res.summary.finalAssets).toBe(block.valeur_finale_centimes);
    expect(res.summary.finalNetWorthImpact).toBe(block.interets_cumules_centimes);
    expect(-res.summary.finalCumulativeCash).toBe(c2.resultats_verifies_math.total_apporte_centimes);
    expect(res.months[0].flows.initial).toBe(-p.capital_initial_centimes);
  });
});

describe('Oracle cas 3 — objectif d\'épargne', () => {
  const p = c3.parametres;
  for (const [key, v] of Object.entries(c3.resultats as Record<string, Json>)) {
    const bps: number = v.taux_annuel_effectif_bps;
    describe(key, () => {
      if (bps > 0) {
        it('taux mensuel équivalent', () => expect(formatEffectiveMonthlyRate(bps, 30)).toBe(v.taux_mensuel));
      }

      it('effort constant : effort, dernier versement plafonné, échéancier', () => {
        const a = v.effort_constant.avec_arrondis;
        usable(a);
        const r = simulateDecision({ kind: 'goal', mode: 'effort', target: p.cible_centimes, effectiveRateBps: bps, months: p.horizon_mois }, { horizonMonths: p.horizon_mois });
        expect(r.goal!.monthlyContribution).toBe(a.effort_mensuel_centimes);
        expect(r.goal!.lastContribution).toBe(a.dernier_versement_centimes);
        expect(r.goal!.reachedMonth).toBe(a.mois_atteinte);
        expect(r.goal!.totalContributed).toBe(a.total_verse_centimes);
        expect(r.goal!.totalInterest).toBe(a.interets_totaux_centimes);
        expect(goalRows(r)).toEqual(a.echeancier);
      });

      for (const sc of v.versement_constant.scenarios as Json[]) {
        it(`versement constant ${sc.versement_mensuel_centimes / 100} DH (${sc.role})`, () => {
          usable(sc);
          const r = simulateDecision(
            { kind: 'goal', mode: 'contribution', target: p.cible_centimes, effectiveRateBps: bps, monthlyContribution: sc.versement_mensuel_centimes, deadlineMonths: p.horizon_mois },
            { horizonMonths: p.horizon_mois },
          );
          const g = r.goal!;
          expect(g.reachedMonth).toBe(sc.mois_atteinte);
          expect(g.reachedByDeadline).toBe(sc.atteint_dans_horizon_24_mois);
          expect(g.balanceAtReach).toBe(sc.solde_a_l_atteinte_centimes);
          expect(g.balanceAtDeadline).toBe(sc.solde_au_mois_24_centimes);
          expect(g.shortfallAtDeadline).toBe(sc.manque_au_mois_24_centimes);
          // Horizon = échéance (24 mois) : solde final et rendement après atteinte (H15).
          expect(g.finalBalance).toBe(sc.solde_au_mois_24_centimes);
          expect(g.interestAfterReach).toBe(sc.interets_apres_atteinte_jusqu_au_mois_24_centimes);
          expect(r.months[p.horizon_mois].assets).toBe(sc.solde_au_mois_24_centimes);
          expect(g.lastContribution).toBe(sc.dernier_versement_centimes);
          expect(g.totalContributed).toBe(sc.total_verse_centimes);
          expect(g.totalInterest).toBe(sc.interets_totaux_centimes);
          expect(goalRows(r)).toEqual(sc.echeancier);
        });
      }
    });
  }

  describe('grilles synthétiques (autres horizons et versements)', () => {
    for (const [key, bps] of [['0_pct', 0], ['3_pct_effectif', 300]] as const) {
      const grid = c3.grilles_synthetiques[key];
      it(`${key} : effort au centime supérieur et durées`, () => {
        usable(grid);
        for (const e of grid.effort_constant) {
          expect(requiredMonthlyEffort(p.cible_centimes, bps, e.duree_mois), `n=${e.duree_mois}`).toBe(e.effort_arrondi_superieur_centimes);
          const r = simulateDecision({ kind: 'goal', mode: 'effort', target: p.cible_centimes, effectiveRateBps: bps, months: e.duree_mois }, { horizonMonths: e.duree_mois });
          expect(r.goal!.monthlyContribution, `n=${e.duree_mois}`).toBe(e.effort_minimal_avec_arrondi_mensuel_centimes);
        }
        for (const d of grid.rythme_constant) {
          const r = simulateDecision(
            { kind: 'goal', mode: 'contribution', target: p.cible_centimes, effectiveRateBps: bps, monthlyContribution: d.versement_mensuel_centimes },
            { horizonMonths: 1 },
          );
          expect(r.goal!.reachedMonth, `P=${d.versement_mensuel_centimes}`).toBe(d.duree_mois_arrondi_mensuel);
        }
      });
    }
  });
});
