/**
 * Paiements récurrents.
 *
 * Une règle récurrente NE crée PAS de transaction : elle décrit des échéances.
 * Une échéance devient une transaction réelle uniquement quand l'utilisateur la
 * marque comme payée (transaction créée et liée via recurringRuleId + recurringDueDate).
 *
 * Les échéances sont calculées depuis la date de départ (sans dérive) :
 * départ le 31/01 mensuel → 28/02 (29/02 bissextile), 31/03, 30/04...
 * annuel au 29/02 → 28/02 les années non bissextiles.
 */
import type { ISODate, Period } from '../dates';
import { addDays, addMonths, diffDays, inPeriod, parseISO } from '../dates';
import { roundHalfAwayFromZero } from '../money';
import type { ID, RecurringOccurrence, RecurringRule, Transaction } from '../types';

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
  /** paid / skipped : traité par l'utilisateur ; matched : transaction correspondante détectée. */
  status: 'paid' | 'skipped' | 'matched' | 'upcoming' | 'overdue';
  transactionId?: ID;
};

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
  options: { includeInactive?: boolean } = {},
): OccurrenceView[] {
  const stateById = new Map(states.map((s) => [s.id, s]));
  const linked = new Map<string, Transaction>();
  for (const t of transactions) if (t.recurringRuleId && t.recurringDueDate) linked.set(occurrenceId(t.recurringRuleId, t.recurringDueDate), t);
  const out: OccurrenceView[] = [];
  const used = new Set<ID>();
  for (const rule of rules) {
    if (!rule.active && !options.includeInactive) continue;
    for (const due of occurrenceDates(rule, period.start, period.end)) {
      const id = occurrenceId(rule.id, due);
      const st = stateById.get(id);
      if (st) {
        out.push({ id, rule, dueDate: due, status: st.status, transactionId: st.transactionId });
        continue;
      }
      const tx = linked.get(id) ?? findMatchingTransaction(rule, due, transactions, used);
      if (tx) used.add(tx.id);
      if (tx) out.push({ id, rule, dueDate: due, status: tx.recurringRuleId === rule.id ? 'paid' : 'matched', transactionId: tx.id });
      else out.push({ id, rule, dueDate: due, status: due < today ? 'overdue' : 'upcoming' });
    }
  }
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

/** Échéances restant à payer (à venir ou en retard) dans une période. */
export function pendingOccurrences(occ: OccurrenceView[]): OccurrenceView[] {
  return occ.filter((o) => o.status === 'upcoming' || o.status === 'overdue');
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
