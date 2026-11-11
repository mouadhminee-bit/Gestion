/**
 * Decision Lab — validation du brouillon de situation initiale (E5.2). Données fictives.
 * Les règles sont celles du moteur E3 : trois entiers sûrs (centimes), zéro et négatifs admis,
 * situation simulable sur l'horizon maximal.
 */
import { describe, expect, it } from 'vitest';
import { compareDecisions, MAX_HORIZON_MONTHS, referenceTrajectory, simulateDecision } from '@/domain/calc/decision';
import { createSnapshot } from './snapshot';
import { draftFromSituation, sameSituation, SITUATION_FIELDS, validateSituationDraft, type SituationDraft } from './situationDraft';

const draft = (over: Partial<SituationDraft> = {}): SituationDraft => ({ cash: 1_500_000, netWorth: 2_000_000, monthlySavings: 500_000, ...over });
const errorsOf = (d: SituationDraft, hasText = {}) => {
  const r = validateSituationDraft(d, hasText);
  return r.ok ? {} : r.errors;
};

describe('valeurs valides', () => {
  it('renvoie une nouvelle situation identique au centime, sans modifier le brouillon', () => {
    const d = Object.freeze(draft());
    const r = validateSituationDraft(d);
    expect(r).toEqual({ ok: true, value: { cash: 1_500_000, netWorth: 2_000_000, monthlySavings: 500_000 } });
    if (r.ok) expect(r.value).not.toBe(d);
  });

  it('zéro accepté pour chaque champ', () => {
    expect(validateSituationDraft({ cash: 0, netWorth: 0, monthlySavings: 0 })).toEqual({ ok: true, value: { cash: 0, netWorth: 0, monthlySavings: 0 } });
    for (const f of SITUATION_FIELDS) expect(validateSituationDraft(draft({ [f]: 0 })).ok, f).toBe(true);
  });

  it('valeurs négatives acceptées (découvert, patrimoine négatif, épargne négative), comme dans le moteur', () => {
    const r = validateSituationDraft({ cash: -250_000, netWorth: -9_876_543, monthlySavings: -45_000 });
    expect(r).toEqual({ ok: true, value: { cash: -250_000, netWorth: -9_876_543, monthlySavings: -45_000 } });
    if (r.ok) expect(referenceTrajectory(r.value, { horizonMonths: 12 })[12]).toMatchObject({ cash: -250_000 - 12 * 45_000 });
  });

  it('précision monétaire : centimes entiers conservés exactement', () => {
    for (const v of [1, -1, 99, 123_456, 10_000_000_001, -7]) {
      const r = validateSituationDraft({ cash: v, netWorth: v, monthlySavings: v });
      expect(r.ok && r.value.cash === v && r.value.netWorth === v && r.value.monthlySavings === v, String(v)).toBe(true);
    }
    // Plus grand entier sûr : accepté tant que la trajectoire reste représentable.
    expect(validateSituationDraft({ cash: Number.MAX_SAFE_INTEGER, netWorth: -Number.MAX_SAFE_INTEGER, monthlySavings: 0 }).ok).toBe(true);
  });
});

describe('champs manquants et valeurs invalides', () => {
  it('champ vide : obligatoire, pour chaque champ', () => {
    for (const f of SITUATION_FIELDS) expect(errorsOf(draft({ [f]: null }))).toEqual({ [f]: 'required' });
    expect(errorsOf({ cash: null, netWorth: null, monthlySavings: null })).toEqual({ cash: 'required', netWorth: 'required', monthlySavings: 'required' });
    expect(errorsOf({ cash: undefined, netWorth: 1, monthlySavings: 1 } as never)).toEqual({ cash: 'required' });
  });

  it('saisie présente mais non interprétable : invalide (et non obligatoire)', () => {
    expect(errorsOf(draft({ cash: null }), { cash: true })).toEqual({ cash: 'invalid' });
    expect(errorsOf(draft({ cash: null, netWorth: null }), { netWorth: true })).toEqual({ cash: 'required', netWorth: 'invalid' });
  });

  it('valeurs non entières ou non numériques : invalides, jamais arrondies ni corrigées', () => {
    for (const v of [10.5, 0.1 + 0.2, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53), '1500' as never, true as never, {} as never]) {
      expect(errorsOf(draft({ netWorth: v })), String(v)).toEqual({ netWorth: 'invalid' });
    }
  });
});

describe('valeurs hors limites (limites du moteur, horizon maximal)', () => {
  it('épargne mensuelle trop grande pour 480 mois', () => {
    const big = Math.ceil(Number.MAX_SAFE_INTEGER / MAX_HORIZON_MONTHS) + 1;
    expect(errorsOf({ cash: 0, netWorth: 0, monthlySavings: big })).toEqual({ monthlySavings: 'tooLarge' });
    expect(errorsOf({ cash: 0, netWorth: 0, monthlySavings: -big })).toEqual({ monthlySavings: 'tooLarge' });
    expect(validateSituationDraft({ cash: 0, netWorth: 0, monthlySavings: Math.floor(Number.MAX_SAFE_INTEGER / MAX_HORIZON_MONTHS) }).ok).toBe(true);
  });

  it('dépassement attribué au solde concerné', () => {
    expect(errorsOf({ cash: Number.MAX_SAFE_INTEGER, netWorth: 0, monthlySavings: 1 })).toEqual({ cash: 'tooLarge' });
    expect(errorsOf({ cash: 0, netWorth: -Number.MAX_SAFE_INTEGER, monthlySavings: -1 })).toEqual({ netWorth: 'tooLarge' });
    expect(errorsOf({ cash: Number.MAX_SAFE_INTEGER, netWorth: Number.MAX_SAFE_INTEGER, monthlySavings: 1 })).toEqual({ cash: 'tooLarge', netWorth: 'tooLarge' });
  });

  it('une situation acceptée n\'est jamais refusée ensuite par le moteur, quel que soit l\'horizon', () => {
    const r = validateSituationDraft({ cash: Number.MAX_SAFE_INTEGER - 480 * 1000, netWorth: 5, monthlySavings: 1000 });
    expect(r.ok).toBe(true);
    if (r.ok) for (const h of [1, 60, MAX_HORIZON_MONTHS]) expect(() => referenceTrajectory(r.value, { horizonMonths: h })).not.toThrow();
  });
});

describe('cohérence des données transmises au moteur', () => {
  it('la situation validée est utilisée telle quelle par le moteur et figée dans un snapshot', () => {
    const r = validateSituationDraft({ cash: 123_456, netWorth: -500, monthlySavings: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ref = referenceTrajectory(r.value, { horizonMonths: 3 });
    expect(ref.map((p) => [p.cash, p.netWorth])).toEqual([[123_456, -500], [123_456, -500], [123_456, -500], [123_456, -500]]);
    const snap = createSnapshot({ name: 'Test', situation: r.value, horizonMonths: 12, variants: [{ id: 'v', decision: { kind: 'recurring', monthlyAmount: 1000 } }] });
    expect(snap.hypotheses.situation).toEqual(r.value);
    expect(snap.results.reference.cash[0]).toBe(123_456);
    const cmp = compareDecisions(r.value, [{ id: 'a', decision: { kind: 'recurring', monthlyAmount: 1000 } }, { id: 'b', decision: { kind: 'recurring', monthlyAmount: 2000 } }], { horizonMonths: 12 });
    expect(cmp.situation).toEqual(r.value);
    expect(simulateDecision({ kind: 'recurring', monthlyAmount: 1000 }, { horizonMonths: 12 }).months).toHaveLength(13);
  });

  it('aller-retour brouillon ↔ situation ; comparaison', () => {
    const s = { cash: 1, netWorth: -2, monthlySavings: 3 };
    expect(draftFromSituation(s)).toEqual(s);
    expect(draftFromSituation({ ...s, asOf: '2026-11-15' } as never)).toEqual(s); // détails écartés
    expect(sameSituation(s, { ...s })).toBe(true);
    expect(sameSituation(s, { ...s, monthlySavings: 4 })).toBe(false);
  });
});
