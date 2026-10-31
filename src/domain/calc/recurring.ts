/**
 * Paiements récurrents.
 *
 * Une règle récurrente NE crée PAS de transaction : elle décrit des échéances.
 * Une échéance devient une transaction réelle uniquement quand l'utilisateur la
 * marque comme payée (transaction créée et liée via recurringRuleId + recurringDueDate)
 * ou y associe des opérations existantes.
 *
 * Échéance et décaissement restent distincts : `recurringDueDate` désigne l'échéance
 * soldée, `date` le jour réel de l'opération (un paiement anticipé reste daté du jour
 * où il a eu lieu). Le lien est porté par la transaction : une échéance peut être
 * réglée en plusieurs opérations, une opération ne règle qu'une seule échéance.
 *
 * Les échéances sont calculées depuis la date de départ (sans dérive) :
 * départ le 31/01 mensuel → 28/02 (29/02 bissextile), 31/03, 30/04...
 * annuel au 29/02 → 28/02 les années non bissextiles.
 */
import type { ISODate, Period } from '../dates';
import { addDays, addMonths, diffDays, inPeriod, parseISO } from '../dates';
import { roundHalfAwayFromZero } from '../money';
import type { ID, RecurringOccurrence, RecurringRule, Transaction } from '../types';
import type { Converter } from './fx';

interface Step {
  unit: 'day' | 'month';
  n: number;
}

export function ruleStep(rule: Pick<RecurringRule, 'frequency' | 'customInterval' | 'customUnit'>): Step {
  switch (rule.frequency) {
    case 'daily':
      return { unit: 'day', n: 1 };
    case 'weekly':
      return { unit: 'day', n: 7 };
    case 'monthly':
      return { unit: 'month', n: 1 };
    case 'quarterly':
      return { unit: 'month', n: 3 };
    case 'semiannual':
      return { unit: 'month', n: 6 };
    case 'annual':
      return { unit: 'month', n: 12 };
    case 'custom': {
      const k = Math.max(1, Math.floor(rule.customInterval ?? 1));
      switch (rule.customUnit) {
        case 'week':
          return { unit: 'day', n: 7 * k };
        case 'month':
          return { unit: 'month', n: k };
        case 'year':
          return { unit: 'month', n: 12 * k };
        default:
          return { unit: 'day', n: k };
      }
    }
  }
}

/** n-ième échéance (n = 0 → date de départ). */
export function nthOccurrence(rule: Pick<RecurringRule, 'startDate' | 'frequency' | 'customInterval' | 'customUnit'>, n: number): ISODate {
  const step = ruleStep(rule);
  if (step.unit === 'day') return addDays(rule.startDate, n * step.n);
  return addMonths(rule.startDate, n * step.n, parseISO(rule.startDate).d);
}

/** Dates d'échéance dans [from, to], bornées par la date de fin de la règle. */
export function occurrenceDates(rule: RecurringRule, from: ISODate, to: ISODate, limit = 1000): ISODate[] {
  const end = rule.endDate && rule.endDate < to ? rule.endDate : to;
  if (end < rule.startDate || end < from) return [];
  const step = ruleStep(rule);
  let n = 0;
  if (from > rule.startDate) {
    if (step.unit === 'day') n = Math.max(0, Math.floor(diffDays(from, rule.startDate) / step.n) - 1);
    else {
      const a = parseISO(rule.startDate);
      const b = parseISO(from);
      const months = (b.y - a.y) * 12 + (b.m - a.m);
      n = Math.max(0, Math.floor(months / step.n) - 1);
    }
  }
  const out: ISODate[] = [];
  for (let guard = 0; guard < limit + 400; guard++, n++) {
    const d = nthOccurrence(rule, n);
    if (d > end) break;
    if (d >= from) {
      out.push(d);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function occurrenceId(ruleId: ID, dueDate: ISODate): string {
  return `${ruleId}:${dueDate}`;
}

export type OccurrenceView = {
  id: string;
  rule: RecurringRule;
  dueDate: ISODate;
  /**
   * paid : réglée (opérations associées ≥ montant prévu, ou soldée par l'utilisateur) ;
   * partial : opérations associées < montant prévu ; skipped : ignorée ;
   * matched : opération correspondante détectée automatiquement, NON confirmée ;
   * upcoming / overdue : aucun paiement associé.
   */
  status: 'paid' | 'partial' | 'skipped' | 'matched' | 'upcoming' | 'overdue';
  /** Opération principale : créée par « Marquer payée », première associée, ou détectée. */
  transactionId?: ID;
  /** Opérations confirmées (associées à l'échéance). */
  transactionIds: ID[];
  /** Montant prévu, devise de la règle. */
  expected: number;
  /** Total des opérations confirmées, devise de la règle (0 pour une détection non confirmée). */
  paid: number;
  /** Reste attendu (0 si réglée, soldée ou ignorée). */
  remaining: number;
  /** Soldée par l'utilisateur alors que le payé est inférieur au prévu (reliquat abandonné). */
  settled: boolean;
  /** Date de la dernière opération confirmée. */
  paidDate?: ISODate;
};

/** Montant d'une opération exprimé dans la devise de la règle. */
function amountInRuleCurrency(t: Transaction, rule: RecurringRule, convert?: Converter): number {
  if (t.currency === rule.currency) return t.amount;
  const tx = convert?.(t.amount, t.currency, t.date);
  const unit = convert?.(rule.amount, rule.currency, t.date);
  // Sans taux de change, l'opération est réputée couvrir l'échéance (jamais de reste fictif).
  return tx != null && unit ? roundHalfAwayFromZero((tx * rule.amount) / unit) : rule.amount;
}

/**
 * Recherche une transaction réelle correspondant à une échéance non marquée :
 * même compte, même sens, même montant, date à ±5 jours, et même catégorie ou
 * même libellé. Évite la double comptabilisation dans les prévisions lorsque
 * l'utilisateur a saisi le paiement manuellement.
 */
export function findMatchingTransaction(
  rule: RecurringRule,
  dueDate: ISODate,
  transactions: Transaction[],
  exclude?: Set<ID>,
): Transaction | undefined {
  const wantType = rule.kind;
  return transactions.find((t) => {
    if (t.recurringRuleId === rule.id && t.recurringDueDate === dueDate) return true;
    if (t.recurringRuleId || exclude?.has(t.id)) return false;
    if (t.type !== wantType || t.accountId !== rule.accountId || t.amount !== rule.amount) return false;
    if (Math.abs(diffDays(t.date, dueDate)) > 5) return false;
    const sameCat = rule.categoryId != null && t.categoryId === rule.categoryId;
    const sameLabel = t.label.trim().toLowerCase() === rule.label.trim().toLowerCase();
    return sameCat || sameLabel;
  });
}

export function listOccurrences(
  rules: RecurringRule[],
  states: RecurringOccurrence[],
  transactions: Transaction[],
  period: Period,
  today: ISODate,
  options: { includeInactive?: boolean; convert?: Converter } = {},
): OccurrenceView[] {
  const stateById = new Map(states.map((s) => [s.id, s]));
  const linked = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (!t.recurringRuleId || !t.recurringDueDate) continue;
    const id = occurrenceId(t.recurringRuleId, t.recurringDueDate);
    linked.set(id, [...(linked.get(id) ?? []), t]);
  }
  const out: OccurrenceView[] = [];
  const used = new Set<ID>();
  for (const rule of rules) {
    if (!rule.active && !options.includeInactive) continue;
    for (const due of occurrenceDates(rule, period.start, period.end)) {
      const id = occurrenceId(rule.id, due);
      const st = stateById.get(id);
      const base = { id, rule, dueDate: due, expected: rule.amount, transactionIds: [] as ID[], paid: 0, remaining: rule.amount, settled: false };
      if (st?.status === 'skipped') {
        out.push({ ...base, status: 'skipped', remaining: 0 });
        continue;
      }
      const links = (linked.get(id) ?? []).filter((t) => t.type === rule.kind);
      if (links.length || st?.status === 'paid') {
        const paid = links.reduce((a, t) => a + amountInRuleCurrency(t, rule, options.convert), 0);
        const done = st?.status === 'paid' || paid >= rule.amount;
        const main = st?.transactionId ?? links[0]?.id;
        const paidDate = links.reduce<ISODate | undefined>((d, t) => (!d || t.date > d ? t.date : d), undefined);
        out.push({ ...base, status: done ? 'paid' : 'partial', transactionId: main, transactionIds: links.map((t) => t.id), paid, remaining: done ? 0 : rule.amount - paid, settled: done && paid < rule.amount && links.length > 0, paidDate });
        continue;
      }
      const tx = findMatchingTransaction(rule, due, transactions, used);
      if (tx) {
        used.add(tx.id);
        out.push({ ...base, status: 'matched', transactionId: tx.id, remaining: 0 });
      } else out.push({ ...base, status: due < today ? 'overdue' : 'upcoming' });
    }
  }
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

/** Échéances restant à payer (à venir, en retard ou partiellement réglées) dans une période. */
export function pendingOccurrences(occ: OccurrenceView[]): OccurrenceView[] {
  return occ.filter((o) => o.status === 'upcoming' || o.status === 'overdue' || o.status === 'partial');
}

/**
 * Opérations existantes pouvant être associées à une échéance : même type que la règle,
 * même devise, non associées à une autre échéance, datées à ±62 jours. Les plus proches
 * (compte, libellé ou catégorie identiques, puis écart de date) d'abord.
 */
export function linkCandidates(rule: RecurringRule, dueDate: ISODate, transactions: Transaction[]): Transaction[] {
  const own = occurrenceId(rule.id, dueDate);
  const score = (t: Transaction) =>
    Math.abs(diffDays(t.date, dueDate)) -
    (t.accountId === rule.accountId ? 30 : 0) -
    (rule.categoryId != null && t.categoryId === rule.categoryId ? 30 : 0) -
    (t.label.trim().toLowerCase() === rule.label.trim().toLowerCase() ? 60 : 0);
  return transactions
    .filter((t) => t.type === rule.kind && t.currency === rule.currency && Math.abs(diffDays(t.date, dueDate)) <= 62)
    .filter((t) => !t.recurringRuleId || occurrenceId(t.recurringRuleId, t.recurringDueDate ?? '') === own)
    .sort((a, b) => score(a) - score(b) || (a.date < b.date ? 1 : -1));
}

/** Nombre d'occurrences par an (pour l'équivalent mensuel). */
export function occurrencesPerYear(rule: Pick<RecurringRule, 'frequency' | 'customInterval' | 'customUnit'>): number {
  const step = ruleStep(rule);
  return step.unit === 'day' ? 365.25 / step.n : 12 / step.n;
}

/** Équivalent mensuel moyen d'une règle (montant × occurrences par an ÷ 12). */
export function monthlyEquivalent(rule: RecurringRule): number {
  return roundHalfAwayFromZero((rule.amount * occurrencesPerYear(rule)) / 12);
}

export function isRuleActiveOn(rule: RecurringRule, date: ISODate): boolean {
  return rule.active && rule.startDate <= date && (!rule.endDate || rule.endDate >= date);
}

export function nextOccurrence(rule: RecurringRule, from: ISODate): ISODate | null {
  const list = occurrenceDates(rule, from, addDays(from, 3700), 1);
  return list[0] ?? null;
}

export function inPeriodOcc(o: OccurrenceView, p: Period): boolean {
  return inPeriod(o.dueDate, p);
}
