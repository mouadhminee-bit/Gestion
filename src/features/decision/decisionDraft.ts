/**
 * Decision Lab — formulaires de décision (étape E5.3) : description des champs, lecture des saisies
 * et production d'une entrée typée du moteur (`DecisionInput`).
 *
 * Le moteur E3 est la seule source des règles : bornes, champs obligatoires, cohérences (apport,
 * crédit, assurance…) et faisabilité (crédit amortissable) sont vérifiées en appelant
 * `validateDecision` puis `simulateDecision`. Ce module ne contient que la lecture des saisies :
 *  - montants : centimes entiers, convertis par `MoneyInput` / `parseAmount` (aucun flottant) ;
 *  - taux : texte en % avec deux décimales au plus, converti en points de base par lecture des
 *    chiffres (7,25 % → 725 bp), sans calcul en virgule flottante ;
 *  - durées : nombre entier de mois.
 * Une saisie non interprétable n'est jamais corrigée : elle est signalée (`invalid`).
 *
 * Les clés des champs sont les chemins d'erreur du moteur (`loan.nominalRateBps`…) : une erreur
 * du moteur s'affiche ainsi directement sous le champ concerné.
 */
import {
  DecisionInputError,
  MAX_HORIZON_MONTHS,
  simulateDecision,
  validateDecision,
  type DecisionInput,
  type InvestmentDecision,
  type PurchaseDecision,
  type RecurringExpenseDecision,
  type SavingsGoalDecision,
} from '@/domain/calc/decision';

export type DecisionKind = DecisionInput['kind'];
export const DECISION_KINDS: readonly DecisionKind[] = ['purchase', 'recurring', 'goal', 'investment'];
export type GoalMode = SavingsGoalDecision['mode'];

export type FieldType = 'money' | 'rate' | 'months';
export interface FieldSpec {
  /** Chemin du champ dans l'entrée du moteur (= chemin des erreurs de `validateDecision`). */
  key: string;
  type: FieldType;
  required: boolean;
}

/** Brouillon : montants en centimes (null = vide ou non interprétable), taux et durées en texte saisi. */
export interface DecisionDraft {
  kind: DecisionKind;
  money: Record<string, number | null>;
  /** Un texte est présent dans le champ monétaire (distingue « vide » de « non interprétable »). */
  moneyText: Record<string, boolean>;
  text: Record<string, string>;
  /** Achat : financé par un crédit. */
  financed: boolean;
  /** Objectif : méthode. */
  goalMode: GoalMode;
}

export function emptyDraft(kind: DecisionKind): DecisionDraft {
  return { kind, money: {}, moneyText: {}, text: {}, financed: false, goalMode: 'effort' };
}

const money = (key: string, required: boolean): FieldSpec => ({ key, type: 'money', required });
const rate = (key: string): FieldSpec => ({ key, type: 'rate', required: true });
const months = (key: string, required: boolean): FieldSpec => ({ key, type: 'months', required });

/** Champs affichés, dans l'ordre, selon le type et les options du brouillon. */
export function fieldsOf(d: Pick<DecisionDraft, 'kind' | 'financed' | 'goalMode'>): FieldSpec[] {
  switch (d.kind) {
    case 'purchase':
      return [
        money('price', true),
        money('downPayment', true),
        money('fees', true),
        money('assetValue', false),
        ...(d.financed ? [rate('loan.nominalRateBps'), months('loan.months', true)] : []),
        money('insuranceMonthly', false),
        months('insuranceMonths', false),
      ];
    case 'recurring':
      return [money('monthlyAmount', true), months('startMonth', false), months('months', false)];
    case 'goal':
      return d.goalMode === 'effort'
        ? [money('target', true), rate('effectiveRateBps'), months('months', true)]
        : [money('target', true), rate('effectiveRateBps'), money('monthlyContribution', true), months('deadlineMonths', false)];
    case 'investment':
      return [money('initialCapital', true), money('monthlyContribution', true), months('contributionMonths', false), rate('effectiveRateBps')];
  }
}

// ------------------------------------------------------------------ lecture des saisies

/**
 * Taux annuel saisi en % → points de base, par lecture des chiffres (aucun flottant).
 * « 7 » → 700, « 7,5 » → 750, « 3.25 » → 325, « -1 » → -100. Plus de deux décimales ou texte
 * non numérique → null. Les bornes (0 à 30 %) sont celles du moteur, vérifiées ensuite.
 */
export function parseRateBps(text: string): number | null {
  const m = /^\s*(-?)(\d{1,6})(?:[.,](\d{1,2}))?\s*%?\s*$/.exec(text);
  if (!m) return null;
  const bps = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] && bps !== 0 ? -bps : bps;
}

/** Nombre entier de mois ; null si le texte n'est pas un entier. Les bornes sont celles du moteur. */
export function parseMonths(text: string): number | null {
  const m = /^\s*(-?\d{1,6})\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

/** Points de base → texte de saisie (« 7,25 »), pour préremplir un champ. */
export function formatRateInput(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  const frac = String(abs % 100).padStart(2, '0').replace(/0+$/, '');
  return `${sign}${Math.trunc(abs / 100)}${frac ? `,${frac}` : ''}`;
}

// ------------------------------------------------------------------ production de l'entrée

/**
 * Codes d'erreur : ceux de l'interface (`required`, `invalid`) et ceux du moteur, inchangés
 * (`negative`, `notPositive`, `tooLarge`, `rateOutOfRange`, `exceedsPrice`, `loanRequired`,
 * `loanNotAllowed`, `emptyInvestment`, `notAmortizable`, `resultOutOfRange`…).
 */
export type DraftErrors = Record<string, string>;
export type DraftResult = { ok: true; decision: DecisionInput } | { ok: false; errors: DraftErrors };

/** Champ hors de la liste affichée auquel rattacher une erreur globale du moteur. */
export const FORM_LEVEL = 'form';

/**
 * Lit le brouillon, construit l'entrée exacte du moteur et la fait valider par le moteur.
 * Aucune valeur n'est corrigée ; un champ facultatif vide est omis (valeur par défaut du moteur).
 */
export function buildDecision(d: DecisionDraft): DraftResult {
  const errors: DraftErrors = {};
  const values: Record<string, number | undefined> = {};
  for (const f of fieldsOf(d)) {
    let v: number | null;
    let present: boolean;
    if (f.type === 'money') {
      v = d.money[f.key] ?? null;
      present = v !== null || !!d.moneyText[f.key];
    } else {
      const raw = d.text[f.key] ?? '';
      present = raw.trim() !== '';
      v = present ? (f.type === 'rate' ? parseRateBps(raw) : parseMonths(raw)) : null;
    }
    if (!present) {
      if (f.required) errors[f.key] = 'required';
    } else if (v === null || !Number.isSafeInteger(v)) errors[f.key] = 'invalid';
    else values[f.key] = v;
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const decision = assemble(d, values);
  // Règles du moteur (bornes, cohérences) : l'horizon n'est pas encore choisi, le maximum est retenu.
  const issues = validateDecision(decision, { horizonMonths: MAX_HORIZON_MONTHS });
  if (issues.length) return { ok: false, errors: issuesToErrors(issues) };
  // Faisabilité (crédit amortissable, montants représentables) : calculée par le moteur.
  try {
    simulateDecision(decision, { horizonMonths: 1 });
  } catch (e) {
    if (e instanceof DecisionInputError) return { ok: false, errors: issuesToErrors(e.issues) };
    throw e;
  }
  return { ok: true, decision };
}

function issuesToErrors(issues: { field: string; code: string }[]): DraftErrors {
  const errors: DraftErrors = {};
  for (const i of issues) {
    const key = i.field === 'result' || i.field === 'horizonMonths' ? FORM_LEVEL : i.field;
    errors[key] ??= i.code;
  }
  return errors;
}

/** Entrée exacte du type attendu : uniquement les champs du contrat, facultatifs vides omis. */
function assemble(d: DecisionDraft, v: Record<string, number | undefined>): DecisionInput {
  const opt = <K extends string>(key: K, value: number | undefined) => (value === undefined ? {} : ({ [key]: value } as Record<K, number>));
  switch (d.kind) {
    case 'purchase': {
      const p: PurchaseDecision = {
        kind: 'purchase',
        price: v.price!,
        downPayment: v.downPayment!,
        fees: v.fees!,
        ...opt('assetValue', v.assetValue),
        ...(d.financed ? { loan: { nominalRateBps: v['loan.nominalRateBps']!, months: v['loan.months']! } } : {}),
        ...opt('insuranceMonthly', v.insuranceMonthly),
        ...opt('insuranceMonths', v.insuranceMonths),
      };
      return p;
    }
    case 'recurring': {
      const r: RecurringExpenseDecision = { kind: 'recurring', monthlyAmount: v.monthlyAmount!, ...opt('startMonth', v.startMonth), ...opt('months', v.months) };
      return r;
    }
    case 'goal': {
      const g: SavingsGoalDecision =
        d.goalMode === 'effort'
          ? { kind: 'goal', mode: 'effort', target: v.target!, effectiveRateBps: v.effectiveRateBps!, months: v.months! }
          : { kind: 'goal', mode: 'contribution', target: v.target!, effectiveRateBps: v.effectiveRateBps!, monthlyContribution: v.monthlyContribution!, ...opt('deadlineMonths', v.deadlineMonths) };
      return g;
    }
    case 'investment': {
      const i: InvestmentDecision = {
        kind: 'investment',
        initialCapital: v.initialCapital!,
        monthlyContribution: v.monthlyContribution!,
        ...opt('contributionMonths', v.contributionMonths),
        effectiveRateBps: v.effectiveRateBps!,
      };
      return i;
    }
  }
}

/** Valeurs numériques d'une entrée, indexées par chemin de champ (`loan.months`…). */
export function flattenDecision(dec: DecisionInput): Record<string, number> {
  const flat: Record<string, number> = {};
  for (const [k, v] of Object.entries(dec)) if (typeof v === 'number') flat[k] = v;
  if (dec.kind === 'purchase' && dec.loan) {
    flat['loan.nominalRateBps'] = dec.loan.nominalRateBps;
    flat['loan.months'] = dec.loan.months;
  }
  return flat;
}

/** Brouillon prérempli à partir d'une entrée valide (retour à la modification sans perte). */
export function draftFromDecision(dec: DecisionInput): DecisionDraft {
  const d = emptyDraft(dec.kind);
  if (dec.kind === 'purchase') d.financed = !!dec.loan;
  if (dec.kind === 'goal') d.goalMode = dec.mode;
  const flat = flattenDecision(dec);
  for (const f of fieldsOf(d)) {
    const v = flat[f.key];
    if (v === undefined) continue;
    if (f.type === 'money') d.money[f.key] = v;
    else d.text[f.key] = f.type === 'rate' ? formatRateInput(v) : String(v);
  }
  return d;
}
