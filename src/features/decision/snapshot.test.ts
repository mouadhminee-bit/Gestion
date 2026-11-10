/**
 * Decision Lab — snapshots : création figée à partir du moteur, indépendance, validation stricte.
 * Données entièrement fictives.
 */
import { describe, expect, it } from 'vitest';
import { compareDecisions, DECISION_ENGINE_VERSION, DecisionInputError, simulateDecision, type DecisionInput } from '@/domain/calc/decision';
import { createSnapshot, validateSnapshot, type CreateSnapshotInput, type DecisionSnapshot } from './snapshot';

const situation = { cash: 5_000_000, netWorth: 30_000_000, monthlySavings: 400_000 };
const credit: DecisionInput = { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 }, insuranceMonthly: 12_000 };
const comptant: DecisionInput = { kind: 'purchase', price: 18_000_000, downPayment: 18_000_000, fees: 150_000 };
const goal: DecisionInput = { kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 300, monthlyContribution: 300_000, deadlineMonths: 24 };
const invest: DecisionInput = { kind: 'investment', initialCapital: 2_000_000, monthlyContribution: 150_000, effectiveRateBps: 600 };
const recurring: DecisionInput = { kind: 'recurring', monthlyAmount: 50_000, startMonth: 2, months: 6 };

const base = (over: Partial<CreateSnapshotInput> = {}): CreateSnapshotInput => ({
  name: 'Voiture : comptant ou crédit',
  situation,
  horizonMonths: 60,
  startMonth: '2026-11',
  variants: [
    { id: 'credit', label: 'Crédit 48 mois', decision: credit },
    { id: 'comptant', decision: comptant },
  ],
  id: 'sim-1',
  createdAt: '2026-11-09T10:00:00.000Z',
  ...over,
});

/** Copie modifiable d'un snapshot valide, pour fabriquer des données corrompues. */
const mutable = (s: DecisionSnapshot = createSnapshot(base())) => JSON.parse(JSON.stringify(s)) as Record<string, any>;
const errorsOf = (raw: unknown) => {
  const v = validateSnapshot(raw);
  return v.ok ? [] : v.errors;
};

describe('createSnapshot', () => {
  it('fige hypothèses et résultats du moteur (comparaison de 2 variantes)', () => {
    const snap = createSnapshot(base());
    const cmp = compareDecisions(situation, base().variants, { horizonMonths: 60, startMonth: '2026-11' });
    expect(snap).toMatchObject({ id: 'sim-1', name: 'Voiture : comptant ou crédit', createdAt: '2026-11-09T10:00:00.000Z', engineVersion: DECISION_ENGINE_VERSION });
    expect(snap.hypotheses).toEqual({ situation, horizonMonths: 60, startMonth: '2026-11', variants: base().variants });
    expect(snap.results.reference.cash).toEqual(cmp.reference.map((p) => p.cash));
    expect(snap.results.reference.netWorth).toEqual(cmp.reference.map((p) => p.netWorth));
    snap.results.variants.forEach((v, k) => {
      const e = cmp.variants[k];
      expect(v.id).toBe(e.id);
      expect(v.summary).toEqual(e.result.summary);
      expect(v.endOfHorizon).toEqual(e.endOfHorizon);
      expect(v.lowestCash).toEqual(e.lowestCash);
      expect(v.firstNegativeCashMonth).toBe(e.firstNegativeCashMonth);
      expect(v.cashDelta).toEqual(e.result.months.map((m) => m.cumulativeCash));
      expect(v.netWorthDelta).toEqual(e.result.months.map((m) => m.netWorthImpact));
    });
    const loan = cmp.variants[0].result.loan!;
    expect(snap.results.variants[0].details).toEqual({
      kind: 'purchase',
      loan: { installment: loan.installment, lastInstallment: loan.lastInstallment, totalInterest: loan.totalInterest, totalPaid: loan.totalPaid, months: 48, actualMonths: 48, earlyPayoffMonth: null },
    });
    expect(snap.results.variants[1].details).toEqual({ kind: 'purchase', loan: null });
  });

  it('une seule variante, et les quatre types de décision', () => {
    for (const decision of [credit, goal, invest, recurring]) {
      const snap = createSnapshot(base({ variants: [{ id: 'v', decision }], startMonth: null }));
      const res = simulateDecision(decision, { horizonMonths: 60 });
      expect(snap.hypotheses.startMonth).toBeNull();
      expect(snap.results.variants).toHaveLength(1);
      expect(snap.results.variants[0].details.kind).toBe(decision.kind);
      expect(snap.results.variants[0].summary).toEqual(res.summary);
      expect(validateSnapshot(JSON.parse(JSON.stringify(snap))).ok).toBe(true);
    }
    const g = createSnapshot(base({ variants: [{ id: 'g', decision: goal }] })).results.variants[0].details;
    expect(g).toMatchObject({ kind: 'goal', mode: 'contribution', reachedMonth: 20, reachedByDeadline: true, shortfallAtDeadline: 0 });
  });

  it('snapshot gelé, sans référence partagée avec les entrées (non modifiées)', () => {
    const input = JSON.parse(JSON.stringify(base())) as CreateSnapshotInput; // copie : le test modifie l'entrée
    const before = JSON.stringify(input);
    const snap = createSnapshot(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.results.variants[0].cashDelta)).toBe(true);
    expect(() => ((snap as { name: string }).name = 'x')).toThrow(TypeError);
    expect(() => snap.results.variants[0].cashDelta.push(1)).toThrow(TypeError);
    // Modifier l'entrée après coup ne change pas le snapshot.
    (input.variants[0].decision as { price: number }).price = 1;
    input.situation.cash = 0;
    expect(snap.hypotheses.variants[0].decision).toEqual(credit);
    expect(snap.hypotheses.situation.cash).toBe(5_000_000);
  });

  it('un recalcul crée une nouvelle simulation et laisse l\'ancienne intacte', () => {
    const first = createSnapshot(base({ id: undefined, createdAt: undefined }));
    const frozen = JSON.stringify(first);
    const again = createSnapshot(base({ id: undefined, createdAt: undefined, horizonMonths: 24 }));
    expect(again.id).not.toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(first)).toBe(frozen);
    expect(first.hypotheses.horizonMonths).toBe(60);
  });

  it('situation détaillée : seuls les trois montants de référence sont conservés', () => {
    const snap = createSnapshot(base({ situation: { ...situation, asOf: '2026-11-09', perimeter: { any: 1 } } as never }));
    expect(snap.hypotheses.situation).toEqual(situation);
  });

  it('hypothèses invalides : DecisionInputError, aucun snapshot', () => {
    const fields = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(DecisionInputError);
        return (e as DecisionInputError).issues;
      }
      throw new Error('aucune erreur');
    };
    expect(fields(() => createSnapshot(base({ name: '  ' })))).toEqual([{ field: 'name', code: 'required' }]);
    expect(fields(() => createSnapshot(base({ name: 'x'.repeat(121) })))).toEqual([{ field: 'name', code: 'tooLong' }]);
    expect(fields(() => createSnapshot(base({ variants: [] })))).toEqual([{ field: 'variants', code: 'variantCount' }]);
    expect(fields(() => createSnapshot(base({ variants: Array.from({ length: 5 }, (_, k) => ({ id: `v${k}`, decision: recurring })) })))).toEqual([{ field: 'variants', code: 'variantCount' }]);
    expect(fields(() => createSnapshot(base({ horizonMonths: 481 })))[0]).toEqual({ field: 'variants[0].horizonMonths', code: 'tooLarge' });
    expect(fields(() => createSnapshot(base({ variants: [{ id: 'v', decision: { kind: 'recurring', monthlyAmount: -5 } }] })))).toEqual([{ field: 'monthlyAmount', code: 'notPositive' }]);
    expect(fields(() => createSnapshot(base({ situation: { ...situation, cash: 0.5 } })))[0]).toEqual({ field: 'situation.cash', code: 'notInteger' });
  });
});

describe('validateSnapshot — données valides', () => {
  it('accepte un snapshot relu depuis du JSON et renvoie une copie gelée', () => {
    const raw = mutable();
    const v = validateSnapshot(raw);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value).toEqual(raw);
    expect(v.value).not.toBe(raw);
    expect(Object.isFrozen(v.value.hypotheses.variants[0].decision)).toBe(true);
    raw.name = 'modifié après validation';
    expect(v.value.name).toBe('Voiture : comptant ou crédit');
  });

  it('accepte une version de moteur différente (le snapshot reste lisible tel quel)', () => {
    const raw = mutable();
    raw.engineVersion = DECISION_ENGINE_VERSION + 3;
    expect(validateSnapshot(raw).ok).toBe(true);
  });
});

describe('validateSnapshot — données invalides', () => {
  it('ne lève jamais d\'exception, quelle que soit la valeur', () => {
    const hostile = { get id(): string { throw new Error('piège'); } };
    for (const raw of [null, undefined, 42, 'texte', true, [], {}, [1, 2], { id: 1 }, hostile, () => 1, Symbol('s'), Number.NaN]) {
      const v = validateSnapshot(raw);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors.length).toBeGreaterThan(0);
    }
  });

  const cases: [string, (s: Record<string, any>) => void, RegExp][] = [
    ['champ racine manquant', (s) => delete s.results, /results : champ manquant/],
    ['champ racine inconnu', (s) => (s.extra = 1), /extra : champ inconnu/],
    ['identifiant vide', (s) => (s.id = ''), /^id/],
    ['identifiant non textuel', (s) => (s.id = 12), /^id/],
    ['nom trop long', (s) => (s.name = 'x'.repeat(121)), /name : texte trop long/],
    ['date non ISO', (s) => (s.createdAt = '09/11/2026'), /createdAt/],
    ['date inexistante', (s) => (s.createdAt = '2026-02-30T10:00:00.000Z'), /createdAt/],
    ['date sans fuseau UTC', (s) => (s.createdAt = '2026-11-09T10:00:00.000+01:00'), /createdAt/],
    ['version du moteur nulle', (s) => (s.engineVersion = 0), /engineVersion/],
    ['version du moteur textuelle', (s) => (s.engineVersion = '1'), /engineVersion/],
    ['situation : champ manquant', (s) => delete s.hypotheses.situation.netWorth, /situation\.netWorth : champ manquant/],
    ['situation : montant décimal', (s) => (s.hypotheses.situation.cash = 10.5), /situation\.cash : entier attendu/],
    ['situation : montant textuel', (s) => (s.hypotheses.situation.cash = '5000000'), /situation\.cash : entier attendu/],
    ['situation : NaN devenu null en JSON', (s) => (s.hypotheses.situation.monthlySavings = null), /monthlySavings : entier attendu/],
    ['montant hors des entiers sûrs', (s) => (s.hypotheses.situation.netWorth = 1e20), /netWorth : entier attendu/],
    ['horizon nul', (s) => (s.hypotheses.horizonMonths = 0), /horizonMonths/],
    ['horizon > 480', (s) => (s.hypotheses.horizonMonths = 481), /horizonMonths/],
    ['mois de départ invalide', (s) => (s.hypotheses.startMonth = '2026-00'), /startMonth/],
    ['mois de départ absent', (s) => delete s.hypotheses.startMonth, /startMonth : champ manquant/],
    ['aucune variante', (s) => ((s.hypotheses.variants = []), (s.results.variants = [])), /1 à 4 variantes/],
    ['cinq variantes', (s) => (s.hypotheses.variants = Array.from({ length: 5 }, () => s.hypotheses.variants[0])), /1 à 4 variantes/],
    ['variantes en double', (s) => ((s.hypotheses.variants[1].id = 'credit'), (s.results.variants[1].id = 'credit')), /identifiant en double/],
    ['type de décision inconnu', (s) => (s.hypotheses.variants[0].decision.kind = 'loto'), /decision\.kind : unknownKind/],
    ['décision : champ obligatoire manquant', (s) => delete s.hypotheses.variants[0].decision.price, /decision\.price : notInteger/],
    ['décision : taux hors bornes', (s) => (s.hypotheses.variants[0].decision.loan.nominalRateBps = 9999), /rateOutOfRange/],
    ['décision : montant négatif', (s) => (s.hypotheses.variants[0].decision.fees = -1), /decision\.fees : negative/],
    ['décision : champ inconnu', (s) => (s.hypotheses.variants[0].decision.accountId = 'acc-1'), /decision\.accountId : champ inconnu/],
    ['libellé trop long', (s) => (s.hypotheses.variants[0].label = 'x'.repeat(81)), /label : texte trop long/],
    ['résultat manquant pour une variante', (s) => s.results.variants.pop(), /une entrée par variante/],
    ['résultat d\'une autre variante', (s) => (s.results.variants[0].id = 'autre'), /ne correspond pas à la variante/],
    ['série trop courte', (s) => s.results.variants[0].cashDelta.pop(), /série de 61 valeurs attendue/],
    ['série avec une valeur décimale', (s) => (s.results.variants[0].netWorthDelta[3] = 0.1), /valeurs entières attendues/],
    ['série avec une valeur nulle', (s) => (s.results.reference.cash[5] = null), /valeurs entières attendues/],
    ['référence incohérente avec la situation', (s) => (s.results.reference.cash[0] += 1), /mois 0 diffère de la situation/],
    ['synthèse altérée', (s) => (s.results.variants[0].summary.finalNetWorthImpact += 1), /summary : incohérent/],
    ['fin d\'horizon altérée', (s) => (s.results.variants[0].endOfHorizon.cash += 100), /endOfHorizon : incohérent/],
    ['trésorerie minimale altérée', (s) => (s.results.variants[1].lowestCash.value += 1), /lowestCash : incohérent/],
    ['premier mois négatif altéré', (s) => (s.results.variants[1].firstNegativeCashMonth = null), /firstNegativeCashMonth : incohérent/],
    ['série altérée', (s) => (s.results.variants[0].cashDelta[60] -= 5), /incohérent avec les séries/],
    ['détails d\'un autre type', (s) => (s.results.variants[0].details = { kind: 'recurring' }), /details\.kind : type différent/],
    ['détails du crédit incomplets', (s) => delete s.results.variants[0].details.loan.totalPaid, /loan\.totalPaid : champ manquant/],
    ['détails du crédit : mensualité négative', (s) => (s.results.variants[0].details.loan.installment = -1), /loan\.installment/],
    ['hypothèses non objet', (s) => (s.hypotheses = 'x'), /hypotheses : objet attendu/],
    ['résultats tableau', (s) => (s.results = []), /results : objet attendu/],
  ];
  for (const [label, corrupt, expected] of cases) {
    it(label, () => {
      const raw = mutable();
      corrupt(raw);
      const errors = errorsOf(raw);
      expect(errors.join('\n')).toMatch(expected);
    });
  }

  it('détails d\'objectif : mode inconnu et valeurs invalides', () => {
    const raw = mutable(createSnapshot(base({ variants: [{ id: 'g', decision: goal }] })));
    raw.results.variants[0].details.mode = 'x';
    raw.results.variants[0].details.finalBalance = -1;
    raw.results.variants[0].details.reachedByDeadline = 'oui';
    const errors = errorsOf(raw).join('\n');
    expect(errors).toMatch(/details\.mode : mode inconnu/);
    expect(errors).toMatch(/details\.finalBalance/);
    expect(errors).toMatch(/reachedByDeadline/);
  });
});
