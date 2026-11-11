/**
 * Decision Lab — formulaires de décision (E5.3) : lecture des saisies et production d'entrées du
 * moteur. Les règles attendues sont celles du moteur E3 (validateDecision / simulateDecision) ;
 * les entrées produites doivent être exactement celles du contrat. Données fictives.
 */
import { describe, expect, it } from 'vitest';
import { MAX_HORIZON_MONTHS, simulateDecision, validateDecision, type DecisionInput } from '@/domain/calc/decision';
import { createSnapshot } from './snapshot';
import {
  buildDecision,
  DECISION_KINDS,
  draftFromDecision,
  emptyDraft,
  fieldsOf,
  FORM_LEVEL,
  formatRateInput,
  parseMonths,
  parseRateBps,
  type DecisionDraft,
  type DecisionKind,
} from './decisionDraft';

/** Brouillon : montants en centimes, taux et durées en texte saisi. */
function draft(kind: DecisionKind, money: Record<string, number | null> = {}, text: Record<string, string> = {}, opts: Partial<DecisionDraft> = {}): DecisionDraft {
  return { ...emptyDraft(kind), money, text, ...opts };
}
const errorsOf = (d: DecisionDraft) => {
  const r = buildDecision(d);
  return r.ok ? {} : r.errors;
};
const decisionOf = (d: DecisionDraft) => {
  const r = buildDecision(d);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.decision;
};
/** L'entrée est acceptée telle quelle par le moteur. */
const engineAccepts = (dec: DecisionInput) => {
  expect(validateDecision(dec, { horizonMonths: MAX_HORIZON_MONTHS })).toEqual([]);
  expect(() => simulateDecision(dec, { horizonMonths: 60 })).not.toThrow();
};

const purchase = (over: Record<string, number | null> = {}, text: Record<string, string> = { 'loan.nominalRateBps': '7', 'loan.months': '48' }, financed = true) =>
  draft('purchase', { price: 18_000_000, downPayment: 3_000_000, fees: 150_000, ...over }, text, { financed });

describe('lecture des taux et des durées (sans virgule flottante)', () => {
  it('taux en % → points de base', () => {
    const cases: [string, number | null][] = [
      ['7', 700], ['7,5', 750], ['7.25', 725], ['0', 0], ['0,29', 29], ['0,1', 10], ['30', 3000], ['30,01', 3001],
      [' 6 % ', 600], ['-1', -100], ['-0', 0], ['7,255', null], ['7,', null], [',5', null], ['abc', null], ['', null], ['1e2', null], ['7 5', null],
    ];
    for (const [text, bps] of cases) expect(parseRateBps(text), text).toBe(bps);
  });

  it('durées en mois entiers', () => {
    const cases: [string, number | null][] = [['48', 48], [' 480 ', 480], ['0', 0], ['-3', -3], ['4.5', null], ['4,5', null], ['1e3', null], ['', null], ['douze', null]];
    for (const [text, n] of cases) expect(parseMonths(text), text).toBe(n);
  });

  it('points de base → texte de saisie, aller-retour exact', () => {
    for (const bps of [0, 1, 29, 100, 325, 700, 750, 1205, 3000, -150]) expect(parseRateBps(formatRateInput(bps)), String(bps)).toBe(bps);
    expect(formatRateInput(725)).toBe('7,25');
    expect(formatRateInput(700)).toBe('7');
  });
});

describe('champs affichés : uniquement ceux du contrat du moteur', () => {
  it('par type et par option', () => {
    const keys = (d: Pick<DecisionDraft, 'kind' | 'financed' | 'goalMode'>) => fieldsOf(d).map((f) => `${f.key}${f.required ? '*' : ''}`);
    expect(keys({ kind: 'purchase', financed: false, goalMode: 'effort' })).toEqual(['price*', 'downPayment*', 'fees*', 'assetValue', 'insuranceMonthly', 'insuranceMonths']);
    expect(keys({ kind: 'purchase', financed: true, goalMode: 'effort' })).toEqual(['price*', 'downPayment*', 'fees*', 'assetValue', 'loan.nominalRateBps*', 'loan.months*', 'insuranceMonthly', 'insuranceMonths']);
    expect(keys({ kind: 'recurring', financed: false, goalMode: 'effort' })).toEqual(['monthlyAmount*', 'startMonth', 'months']);
    expect(keys({ kind: 'goal', financed: false, goalMode: 'effort' })).toEqual(['target*', 'effectiveRateBps*', 'months*']);
    expect(keys({ kind: 'goal', financed: false, goalMode: 'contribution' })).toEqual(['target*', 'effectiveRateBps*', 'monthlyContribution*', 'deadlineMonths']);
    expect(keys({ kind: 'investment', financed: false, goalMode: 'effort' })).toEqual(['initialCapital*', 'monthlyContribution*', 'contributionMonths', 'effectiveRateBps*']);
  });
});

describe('valeurs valides : entrée exacte du contrat E3', () => {
  it('achat financé, avec assurance', () => {
    const dec = decisionOf(purchase({ insuranceMonthly: 12_000 }));
    expect(dec).toStrictEqual({ kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 }, insuranceMonthly: 12_000 });
    engineAccepts(dec);
  });

  it('achat comptant, valeur du bien et assurance avec durée', () => {
    const dec = decisionOf(purchase({ downPayment: 18_000_000, assetValue: 17_000_000, insuranceMonthly: 5_000 }, { insuranceMonths: '12' }, false));
    expect(dec).toStrictEqual({ kind: 'purchase', price: 18_000_000, downPayment: 18_000_000, fees: 150_000, assetValue: 17_000_000, insuranceMonthly: 5_000, insuranceMonths: 12 });
    engineAccepts(dec);
  });

  it('dépense récurrente : champs facultatifs omis ou fournis', () => {
    expect(decisionOf(draft('recurring', { monthlyAmount: 50_000 }))).toStrictEqual({ kind: 'recurring', monthlyAmount: 50_000 });
    const dec = decisionOf(draft('recurring', { monthlyAmount: 50_000 }, { startMonth: '3', months: '12' }));
    expect(dec).toStrictEqual({ kind: 'recurring', monthlyAmount: 50_000, startMonth: 3, months: 12 });
    engineAccepts(dec);
  });

  it('objectif d\'épargne : deux méthodes', () => {
    const effort = decisionOf(draft('goal', { target: 6_000_000 }, { effectiveRateBps: '3', months: '24' }));
    expect(effort).toStrictEqual({ kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 300, months: 24 });
    engineAccepts(effort);
    const contribution = decisionOf(draft('goal', { target: 6_000_000, monthlyContribution: 250_000 }, { effectiveRateBps: '3', deadlineMonths: '24' }, { goalMode: 'contribution' }));
    expect(contribution).toStrictEqual({ kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 300, monthlyContribution: 250_000, deadlineMonths: 24 });
    engineAccepts(contribution);
    // Sans échéance : champ omis.
    expect(decisionOf(draft('goal', { target: 1, monthlyContribution: 1 }, { effectiveRateBps: '0' }, { goalMode: 'contribution' }))).toStrictEqual({ kind: 'goal', mode: 'contribution', target: 1, effectiveRateBps: 0, monthlyContribution: 1 });
  });

  it('placement', () => {
    const dec = decisionOf(draft('investment', { initialCapital: 2_000_000, monthlyContribution: 150_000 }, { effectiveRateBps: '6' }));
    expect(dec).toStrictEqual({ kind: 'investment', initialCapital: 2_000_000, monthlyContribution: 150_000, effectiveRateBps: 600 });
    engineAccepts(dec);
    expect(decisionOf(draft('investment', { initialCapital: 0, monthlyContribution: 150_000 }, { effectiveRateBps: '6', contributionMonths: '0' }))).toStrictEqual({
      kind: 'investment', initialCapital: 0, monthlyContribution: 150_000, contributionMonths: 0, effectiveRateBps: 600,
    });
  });

  it('entrées utilisables telles quelles par un snapshot', () => {
    const dec = decisionOf(purchase());
    const snap = createSnapshot({ name: 'Test', situation: { cash: 5_000_000, netWorth: 30_000_000, monthlySavings: 400_000 }, horizonMonths: 60, variants: [{ id: 'v', decision: dec }] });
    expect(snap.hypotheses.variants[0].decision).toStrictEqual(dec);
  });

  it('précision monétaire et des taux : centimes et points de base exacts', () => {
    const dec = decisionOf(draft('investment', { initialCapital: 123_457, monthlyContribution: 1 }, { effectiveRateBps: '0,29' }));
    expect(dec).toStrictEqual({ kind: 'investment', initialCapital: 123_457, monthlyContribution: 1, effectiveRateBps: 29 });
    expect(decisionOf(purchase({ price: 1_000_001, downPayment: 1, fees: 3 }, { 'loan.nominalRateBps': '12,05', 'loan.months': '13' }))).toMatchObject({ price: 1_000_001, downPayment: 1, fees: 3, loan: { nominalRateBps: 1205 } });
  });

  it('le brouillon n\'est jamais modifié', () => {
    const d = Object.freeze(purchase());
    Object.values(d).forEach((v) => typeof v === 'object' && Object.freeze(v));
    const before = JSON.stringify(d);
    buildDecision(d);
    buildDecision({ ...d, money: { price: null } });
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('champs obligatoires manquants et saisies invalides', () => {
  it('chaque champ obligatoire vide : « required »', () => {
    for (const kind of DECISION_KINDS) {
      for (const opts of kind === 'goal' ? [{ goalMode: 'effort' as const }, { goalMode: 'contribution' as const }] : kind === 'purchase' ? [{ financed: true }] : [{}]) {
        const d = { ...emptyDraft(kind), ...opts };
        const required = fieldsOf(d).filter((f) => f.required).map((f) => f.key);
        expect(errorsOf(d), `${kind} ${JSON.stringify(opts)}`).toEqual(Object.fromEntries(required.map((k) => [k, 'required'])));
      }
    }
  });

  it('champ facultatif vide : aucune erreur, valeur du moteur par défaut', () => {
    expect(errorsOf(draft('recurring', { monthlyAmount: 1 }, { startMonth: '', months: '  ' }))).toEqual({});
  });

  it('saisie non interprétable : « invalid », jamais corrigée', () => {
    const d = draft('investment', { initialCapital: null, monthlyContribution: 1 }, { effectiveRateBps: '6,555', contributionMonths: '4,5' });
    d.moneyText = { initialCapital: true };
    expect(errorsOf(d)).toEqual({ initialCapital: 'invalid', effectiveRateBps: 'invalid', contributionMonths: 'invalid' });
    expect(d.text.effectiveRateBps).toBe('6,555');
  });

  it('valeur hors des entiers sûrs : « invalid »', () => {
    expect(errorsOf(draft('recurring', { monthlyAmount: 2 ** 53 }))).toEqual({ monthlyAmount: 'invalid' });
    expect(errorsOf(draft('recurring', { monthlyAmount: 10.5 }))).toEqual({ monthlyAmount: 'invalid' });
  });
});

describe('zéro, négatifs et bornes : règles du moteur', () => {
  it('zéro', () => {
    expect(errorsOf(purchase({ fees: 0 }))).toEqual({});
    expect(errorsOf(purchase({ price: 0, downPayment: 0, fees: 0 }, {}, false))).toEqual({});
    expect(errorsOf(draft('recurring', { monthlyAmount: 0 }))).toEqual({ monthlyAmount: 'notPositive' });
    expect(errorsOf(draft('goal', { target: 0 }, { effectiveRateBps: '0', months: '12' }))).toEqual({ target: 'notPositive' });
    expect(errorsOf(draft('goal', { target: 1 }, { effectiveRateBps: '0', months: '0' }))).toEqual({ months: 'notPositive' });
    expect(errorsOf(draft('investment', { initialCapital: 0, monthlyContribution: 0 }, { effectiveRateBps: '0' }))).toEqual({ initialCapital: 'emptyInvestment' });
    expect(errorsOf(draft('recurring', { monthlyAmount: 1 }, { startMonth: '0' }))).toEqual({ startMonth: 'notPositive' });
  });

  it('valeurs négatives', () => {
    expect(errorsOf(purchase({ price: -1 }))).toEqual({ price: 'negative' });
    expect(errorsOf(purchase({ fees: -150_000 }))).toEqual({ fees: 'negative' });
    expect(errorsOf(draft('investment', { initialCapital: 1, monthlyContribution: -1 }, { effectiveRateBps: '2' }))).toEqual({ monthlyContribution: 'negative' });
    expect(errorsOf(draft('goal', { target: 1 }, { effectiveRateBps: '-1', months: '12' }))).toEqual({ effectiveRateBps: 'negative' });
    expect(errorsOf(purchase({}, { 'loan.nominalRateBps': '7', 'loan.months': '-3' }))).toEqual({ 'loan.months': 'notPositive' });
  });

  it('bornes : taux de 0 à 30 %, durées jusqu\'à 480 mois', () => {
    expect(errorsOf(purchase({}, { 'loan.nominalRateBps': '30', 'loan.months': '480' }))).toEqual({});
    expect(errorsOf(purchase({}, { 'loan.nominalRateBps': '30,01', 'loan.months': '48' }))).toEqual({ 'loan.nominalRateBps': 'rateOutOfRange' });
    expect(errorsOf(purchase({}, { 'loan.nominalRateBps': '7', 'loan.months': '481' }))).toEqual({ 'loan.months': 'tooLarge' });
    expect(errorsOf(draft('goal', { target: 1 }, { effectiveRateBps: '31', months: '12' }))).toEqual({ effectiveRateBps: 'rateOutOfRange' });
    expect(errorsOf(draft('recurring', { monthlyAmount: 1 }, { startMonth: '481', months: '481' }))).toEqual({ startMonth: 'tooLarge', months: 'tooLarge' });
    expect(errorsOf(draft('investment', { initialCapital: 1, monthlyContribution: 1 }, { effectiveRateBps: '1', contributionMonths: '480' }))).toEqual({});
  });
});

describe('cohérences et faisabilité (moteur)', () => {
  it('apport, crédit et assurance', () => {
    expect(errorsOf(purchase({ downPayment: 18_000_001 }))).toEqual({ downPayment: 'exceedsPrice' });
    expect(errorsOf(purchase({}, {}, false))).toEqual({ loan: 'loanRequired' });
    expect(errorsOf(purchase({ downPayment: 18_000_000 }))).toEqual({ loan: 'loanNotAllowed' });
    expect(errorsOf(purchase({ downPayment: 18_000_000, insuranceMonthly: 1 }, {}, false))).toEqual({ insuranceMonths: 'required' });
  });

  it('crédit non amortissable : refusé par le moteur', () => {
    expect(errorsOf(purchase({ price: 99, downPayment: 0, fees: 0 }, { 'loan.nominalRateBps': '12', 'loan.months': '480' }))).toEqual({ loan: 'notAmortizable' });
  });

  it('montants non représentables : erreur globale du formulaire', () => {
    expect(errorsOf(draft('investment', { initialCapital: Number.MAX_SAFE_INTEGER, monthlyContribution: 0 }, { effectiveRateBps: '30' }))).toEqual({ [FORM_LEVEL]: 'resultOutOfRange' });
  });
});

describe('retour à la modification sans perte', () => {
  it('brouillon reconstruit depuis une entrée : même entrée à la validation', () => {
    const decisions: DecisionInput[] = [
      { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, assetValue: 17_000_000, loan: { nominalRateBps: 725, months: 48 }, insuranceMonthly: 12_000, insuranceMonths: 36 },
      { kind: 'purchase', price: 100, downPayment: 100, fees: 0 },
      { kind: 'recurring', monthlyAmount: 50_000, startMonth: 2, months: 6 },
      { kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 0, months: 24 },
      { kind: 'goal', mode: 'contribution', target: 6_000_000, effectiveRateBps: 305, monthlyContribution: 250_000, deadlineMonths: 24 },
      { kind: 'investment', initialCapital: 0, monthlyContribution: 150_000, contributionMonths: 0, effectiveRateBps: 600 },
    ];
    for (const dec of decisions) expect(decisionOf(draftFromDecision(dec)), dec.kind).toStrictEqual(dec);
  });
});
