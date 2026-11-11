/**
 * Decision Lab — saisie de la situation initiale (étape E5.2) : validation pure d'un brouillon.
 *
 * Le modèle est celui du moteur (`InitialSituation` : trésorerie, patrimoine net, épargne mensuelle,
 * en centimes entiers de la devise de base). Aucun second modèle, aucun calcul financier ici :
 *  - les trois montants sont obligatoires ; zéro et les valeurs négatives sont admis (découvert,
 *    patrimoine négatif, épargne mensuelle négative), comme dans le moteur ;
 *  - la seule limite est celle du moteur : la situation doit rester simulable sur l'horizon maximal
 *    (`referenceTrajectory` sur 480 mois sans dépassement des entiers sûrs) ;
 *  - une valeur invalide n'est jamais corrigée : elle est refusée avec un code par champ.
 */
import { DecisionInputError, MAX_HORIZON_MONTHS, referenceTrajectory, type InitialSituation } from '@/domain/calc/decision';

export type SituationField = keyof InitialSituation;
export const SITUATION_FIELDS: readonly SituationField[] = ['cash', 'netWorth', 'monthlySavings'];

/** Brouillon de formulaire : `null` = champ vide ou saisie non interprétable. */
export type SituationDraft = Record<SituationField, number | null>;

/** required : champ vide ; invalid : saisie non interprétable ou non entière ; tooLarge : hors limites du moteur. */
export type SituationIssueCode = 'required' | 'invalid' | 'tooLarge';

export type SituationValidation = { ok: true; value: InitialSituation } | { ok: false; errors: Partial<Record<SituationField, SituationIssueCode>> };

export function draftFromSituation(s: InitialSituation): SituationDraft {
  return { cash: s.cash, netWorth: s.netWorth, monthlySavings: s.monthlySavings };
}

/** La situation est-elle acceptée par le moteur sur l'horizon maximal ? */
function simulable(s: InitialSituation): boolean {
  try {
    referenceTrajectory(s, { horizonMonths: MAX_HORIZON_MONTHS });
    return true;
  } catch (e) {
    if (e instanceof DecisionInputError) return false;
    throw e;
  }
}

/**
 * Valide un brouillon. `hasText[champ]` indique qu'une saisie est présente bien que la valeur soit
 * `null` : l'erreur est alors `invalid` (saisie non interprétable) et non `required` (champ vide).
 * Ne modifie pas le brouillon ; en cas de succès, renvoie un nouvel objet `InitialSituation`.
 */
export function validateSituationDraft(draft: SituationDraft, hasText: Partial<Record<SituationField, boolean>> = {}): SituationValidation {
  const errors: Partial<Record<SituationField, SituationIssueCode>> = {};
  for (const f of SITUATION_FIELDS) {
    const v = draft[f];
    if (v === null || v === undefined) errors[f] = hasText[f] ? 'invalid' : 'required';
    else if (typeof v !== 'number' || !Number.isSafeInteger(v)) errors[f] = 'invalid';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const value: InitialSituation = { cash: draft.cash!, netWorth: draft.netWorth!, monthlySavings: draft.monthlySavings! };
  if (!simulable(value)) {
    // Attribution du dépassement, toujours par le moteur : l'épargne seule, sinon chaque solde avec l'épargne.
    if (!simulable({ cash: 0, netWorth: 0, monthlySavings: value.monthlySavings })) errors.monthlySavings = 'tooLarge';
    else {
      if (!simulable({ cash: value.cash, netWorth: 0, monthlySavings: value.monthlySavings })) errors.cash = 'tooLarge';
      if (!simulable({ cash: 0, netWorth: value.netWorth, monthlySavings: value.monthlySavings })) errors.netWorth = 'tooLarge';
    }
    return { ok: false, errors };
  }
  return { ok: true, value };
}

export function sameSituation(a: InitialSituation, b: InitialSituation): boolean {
  return SITUATION_FIELDS.every((f) => a[f] === b[f]);
}
