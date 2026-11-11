/**
 * Decision Lab — compatibilité des simulations enregistrées avec la correction A2 (totaux d'un
 * objectif sur l'horizon). Les snapshots créés avant la correction n'ont pas `contributionsToReach`,
 * `contributedToHorizon` ni `interestToHorizon` : ils restent lisibles (aucune invalidation), les
 * totaux sont reconstitués exactement à partir de leurs séries figées, et sont identiques à ceux
 * qu'une nouvelle exécution du moteur fournit. Données fictives.
 */
import { describe, expect, it } from 'vitest';
import type { DecisionInput } from '@/domain/calc/decision';
import { createSnapshot, validateSnapshot, type DecisionSnapshot } from './snapshot';
import { DECISION_QUARANTINE_KEY, DECISION_STORE_FORMAT, DECISION_STORE_KEY, loadSimulations, saveSimulation, type StorageLike } from './store';

const situation = { cash: 5_000_000, netWorth: 30_000_000, monthlySavings: 400_000 };
const goals: DecisionInput[] = [
  { kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 300, monthlyContribution: 300_000, deadlineMonths: 24 },
  { kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 0, monthlyContribution: 10_000 },
  { kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 300, months: 24 },
];
const NEW_KEYS = ['contributionsToReach', 'contributedToHorizon', 'interestToHorizon'];

const fresh = (horizon: number, decisions: DecisionInput[] = goals, id = 'g') =>
  createSnapshot({ name: 'Objectifs', situation, horizonMonths: horizon, startMonth: '2026-11', variants: decisions.map((decision, k) => ({ id: `v${k}`, decision })), id, createdAt: '2026-11-10T10:00:00.000Z' });

/** Snapshot tel qu'enregistré avant la correction A2 (sans les nouveaux champs). */
function legacy(s: DecisionSnapshot): Record<string, any> {
  const raw = JSON.parse(JSON.stringify(s));
  for (const v of raw.results.variants) if (v.details.kind === 'goal') for (const k of NEW_KEYS) delete v.details[k];
  return raw;
}

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

describe('snapshots antérieurs à A2 : lisibles, totaux de l\'horizon reconstitués exactement', () => {
  for (const horizon of [1, 12, 24, 60, 480]) {
    it(`horizon ${horizon} : relu identique à une nouvelle exécution du moteur`, () => {
      const now = fresh(horizon);
      const old = legacy(now);
      expect(old.results.variants[0].details.contributedToHorizon).toBeUndefined();
      const v = validateSnapshot(old);
      if (!v.ok) throw new Error(v.errors.join(' ; '));
      expect(v.value).toEqual(now);
      expect(Object.isFrozen(v.value.results.variants[0].details)).toBe(true);
      // L'entrée n'est pas modifiée.
      expect(old.results.variants[0].details.contributedToHorizon).toBeUndefined();
    });
  }

  it('cible non atteinte : aucune atteinte fictive après reconstitution', () => {
    const v = validateSnapshot(legacy(fresh(60)));
    if (!v.ok) throw new Error();
    const d = v.value.results.variants[1].details;
    expect(d).toMatchObject({ kind: 'goal', reachedMonth: null, contributionsToReach: null, contributedToHorizon: 600_000, interestToHorizon: 0 });
  });

  it('autres types de décision : snapshots inchangés (aucun champ ajouté)', () => {
    const other = fresh(24, [
      { kind: 'recurring', monthlyAmount: 50_000 },
      { kind: 'investment', initialCapital: 2_000_000, monthlyContribution: 150_000, effectiveRateBps: 600 },
    ] as DecisionInput[]);
    const v = validateSnapshot(JSON.parse(JSON.stringify(other)));
    expect(v).toEqual({ ok: true, value: other });
  });

  it('nouveaux champs présents : obligatoires ensemble et contrôlés contre les séries', () => {
    const tamper = (f: (d: Record<string, any>) => void) => {
      const raw = JSON.parse(JSON.stringify(fresh(60)));
      f(raw.results.variants[0].details);
      return validateSnapshot(raw);
    };
    expect(tamper((d) => delete d.interestToHorizon).ok).toBe(false); // incomplet
    expect(tamper((d) => (d.contributedToHorizon += 100)).ok).toBe(false);
    expect(tamper((d) => (d.interestToHorizon -= 1)).ok).toBe(false);
    expect(tamper((d) => (d.contributionsToReach = 1)).ok).toBe(false);
    expect(tamper((d) => (d.contributionsToReach = null)).ok).toBe(false); // cible atteinte : montant obligatoire
    expect(tamper(() => {}).ok).toBe(true);
  });
});

describe('store : simulations enregistrées avant A2', () => {
  it('lues sans perte ni quarantaine ; réécrites, lors de l\'enregistrement suivant, avec les totaux reconstitués', () => {
    const st = new MemoryStorage();
    const before = fresh(24, goals, 'ancienne');
    st.setItem(DECISION_STORE_KEY, JSON.stringify({ formatVersion: DECISION_STORE_FORMAT, simulations: [legacy(before)] }));
    const loaded = loadSimulations(st);
    expect(loaded.issues).toEqual([]);
    expect(loaded.simulations).toEqual([before]);
    // Lecture seule : rien n'est réécrit à la lecture.
    expect(JSON.parse(st.getItem(DECISION_STORE_KEY)!).simulations[0].results.variants[0].details.contributedToHorizon).toBeUndefined();
    // Enregistrement d'une nouvelle simulation : l'ancienne est conservée, complétée à l'identique.
    expect(saveSimulation(fresh(12, goals, 'nouvelle'), st)).toMatchObject({ ok: true, count: 2 });
    const stored = JSON.parse(st.getItem(DECISION_STORE_KEY)!).simulations as DecisionSnapshot[];
    expect(stored.find((s) => s.id === 'ancienne')).toEqual(JSON.parse(JSON.stringify(before)));
    expect(st.getItem(DECISION_QUARANTINE_KEY)).toBeNull();
  });
});
