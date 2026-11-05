/**
 * Statut de projection : complete / minimum / no-data.
 * 'no-data' repose sur l'existence de données de dépenses (réalisé, échéances, historique),
 * jamais sur le montant projeté. Les montants projetés ne changent pas (non-régression).
 * Données entièrement fictives.
 */
import { describe, expect, it } from 'vitest';
import { account, catByKey, ctxOf, emptySnapshot, tx, UID } from '@/test/fixtures';
import type { Budget, RecurringRule, Transaction } from '../types';
import { forecastMonth } from './forecast';
import { generateInsights } from './insights';

const now = '2026-01-01T00:00:00.000Z';
const base = emptySnapshot();
const cat = (k: string) => catByKey(base.categories, k);
const spend = (k: string | null, amount: number, date: string, p: Partial<Transaction> = {}) => tx({ accountId: 'acc', amount, date, categoryId: k ? cat(k).id : null, ...p });
const income = (amount: number, date: string) => tx({ accountId: 'acc', type: 'income', direction: 'in', amount, date });
const refund = (k: string, amount: number, date: string) => tx({ accountId: 'acc', type: 'refund', direction: 'in', amount, date, categoryId: cat(k).id });
const budget = (k: string | null, amount: number, month = '2026-11'): Budget => ({ id: `b-${k}-${month}`, userId: UID, month, categoryId: k ? cat(k).id : null, amount, currency: 'MAD', createdAt: now, updatedAt: now });
const rule = (p: Partial<RecurringRule>): RecurringRule => ({ id: 'rent', userId: UID, kind: 'expense', label: 'Loyer', amount: 280000, currency: 'MAD', accountId: 'acc', categoryId: null, frequency: 'monthly', startDate: '2026-01-25', active: true, createdAt: now, updatedAt: now, ...p });
const run = (o: { txs?: Transaction[]; today?: string; rules?: RecurringRule[]; budgets?: Budget[]; initial?: number } = {}) => {
  const s = emptySnapshot({ categories: base.categories, accounts: [account({ id: 'acc', initialBalance: o.initial ?? 0 })], transactions: o.txs ?? [], recurringRules: o.rules ?? [], budgets: o.budgets ?? [] });
  return { s, f: forecastMonth(ctxOf(s), s, o.today ?? '2026-11-02') };
};
/** 12 dépenses variables de 90 DH sur septembre-octobre : historique exploitable (≥ 30 jours, ≥ 10 dépenses). */
const history = Array.from({ length: 12 }, (_, k) => spend('food', 9000, `2026-${k % 2 ? '09' : '10'}-${String(3 + 2 * k).padStart(2, '0')}`));

describe('Statut de projection — no-data / minimum / complete', () => {
  it('1. compte totalement vide : no-data (et non minimum), montants nuls inchangés', () => {
    const { f } = run();
    expect(f.projectionStatus).toBe('no-data');
    expect(f).toMatchObject({ variableMethod: 'insufficient', recordedExpenses: 0, expectedRecurringExpenses: 0, variableProjected: 0, projectedExpenses: 0, projectedIncome: 0, projectedEndBalance: 0 });
  });

  it('1b. compte vide en milieu de mois et le dernier jour : no-data, jamais complete par artifice', () => {
    expect(run({ today: '2026-11-15' }).f.projectionStatus).toBe('no-data');
    const last = run({ today: '2026-11-30' }).f;
    expect(last.remainingDays).toBe(0);
    expect(last.projectionStatus).toBe('no-data');
  });

  it('2. compte vide avec solde initial : no-data, le solde est conservé', () => {
    const { f } = run({ initial: 500000 });
    expect(f.projectionStatus).toBe('no-data');
    expect(f).toMatchObject({ currentBalance: 500000, projectedEndBalance: 500000, projectedExpenses: 0 });
  });

  it('3. uniquement des revenus : no-data (aucune donnée de dépense), revenus projetés inchangés', () => {
    const { f } = run({ txs: [income(1000000, '2026-11-01')] });
    expect(f.projectionStatus).toBe('no-data');
    expect(f).toMatchObject({ recordedIncome: 1000000, projectedIncome: 1000000, projectedExpenses: 0, projectedSavings: 1000000, projectedEndBalance: 1000000 });
  });

  it('3b. revenu récurrent attendu seul : toujours no-data (une échéance de revenu n’est pas une dépense)', () => {
    const { f } = run({ rules: [rule({ id: 'sal', kind: 'income', label: 'Salaire', amount: 1000000, startDate: '2026-01-28' })] });
    expect(f.expectedRecurringIncome).toBe(1000000);
    expect(f.projectionStatus).toBe('no-data');
  });

  it('4. une dépense enregistrée, sans historique : minimum (pas no-data)', () => {
    const { f } = run({ txs: [spend('food', 15000, '2026-11-01')] });
    expect(f).toMatchObject({ projectionStatus: 'minimum', variableMethod: 'insufficient', recordedExpenses: 15000, projectedExpenses: 15000 });
  });

  it('5. une échéance de dépense connue, rien d’autre : minimum (pas no-data)', () => {
    const { f } = run({ rules: [rule({})] });
    expect(f).toMatchObject({ projectionStatus: 'minimum', expectedRecurringExpenses: 280000, projectedExpenses: 280000 });
  });

  it('5b. paiement d’une charge récurrente enregistré, sans autre donnée : minimum (le paiement est une dépense réelle)', () => {
    const paid = spend(null, 280000, '2026-11-01', { recurringRuleId: 'rent' });
    const { f } = run({ rules: [rule({ startDate: '2026-01-01' })], txs: [paid] });
    expect(f.recordedExpenses).toBe(280000);
    expect(f.projectionStatus).toBe('minimum');
  });

  it('6. historique insuffisant (2 dépenses le mois dernier, aucune ce mois-ci) : minimum', () => {
    const { f } = run({ txs: [spend('food', 10000, '2026-10-10'), spend('food', 10000, '2026-10-20')] });
    expect(f).toMatchObject({ projectionStatus: 'minimum', variableMethod: 'insufficient', recordedExpenses: 0, projectedExpenses: 0 });
  });

  it('6b. dépense hors fenêtre historique (> 90 jours) uniquement : no-data', () => {
    const { f } = run({ txs: [spend('food', 10000, '2026-07-01')] });
    expect(f.projectionStatus).toBe('no-data');
  });

  it('7. dépense compensée par un remboursement (net nul) : minimum, pas no-data — fondé sur l’existence, pas le montant', () => {
    const { f } = run({ txs: [spend('food', 20000, '2026-11-01'), refund('food', 20000, '2026-11-02')] });
    expect(f.recordedExpenses).toBe(0);
    expect(f.projectedExpenses).toBe(0);
    expect(f.projectionStatus).toBe('minimum');
  });

  it('7b. remboursement seul : c’est une donnée de dépense (minimum)', () => {
    expect(run({ txs: [refund('food', 5000, '2026-11-01')] }).f.projectionStatus).toBe('minimum');
  });

  it('7c. intérêts de dette payés : donnée de dépense (minimum) ; principal seul : neutre (no-data)', () => {
    const debt = (interestAmount: number) => tx({ accountId: 'acc', type: 'debt', direction: 'out', amount: 100000, interestAmount, date: '2026-11-01' });
    expect(run({ txs: [debt(5000)] }).f.projectionStatus).toBe('minimum');
    expect(run({ txs: [debt(0)] }).f.projectionStatus).toBe('no-data');
  });

  it('8. historique suffisant : complete, projection variable inchangée', () => {
    const { f } = run({ txs: history });
    expect(f).toMatchObject({ projectionStatus: 'complete', variableMethod: 'history' });
    expect(f.variableProjected).toBeGreaterThan(0);
    expect(f.projectedExpenses).toBe(f.recordedExpenses + f.expectedRecurringExpenses + f.variableProjected);
  });

  it('8b. dernier jour du mois avec une dépense : complete (rien à projeter), comme avant', () => {
    const { f } = run({ txs: [spend('food', 15000, '2026-11-10')], today: '2026-11-30' });
    expect(f).toMatchObject({ projectionStatus: 'complete', projectedExpenses: 15000 });
  });
});

describe('budgetProjectionStatus — même logique', () => {
  it('sans budget : null, quel que soit le statut', () => {
    expect(run().f.budgetProjectionStatus).toBeNull();
    expect(run({ txs: history }).f.budgetProjectionStatus).toBeNull();
  });

  it('budget global : suit projectionStatus (no-data / minimum / complete)', () => {
    const budgets = [budget(null, 300000)];
    expect(run({ budgets }).f.budgetProjectionStatus).toBe('no-data');
    expect(run({ budgets, txs: [income(500000, '2026-11-01')] }).f.budgetProjectionStatus).toBe('no-data');
    expect(run({ budgets, txs: [spend('food', 15000, '2026-11-01')] }).f.budgetProjectionStatus).toBe('minimum');
    expect(run({ budgets, rules: [rule({})] }).f.budgetProjectionStatus).toBe('minimum');
    expect(run({ budgets, txs: history }).f.budgetProjectionStatus).toBe('complete');
  });

  it('budgets par catégorie : no-data sans aucune donnée, sinon la règle existante (rythme des catégories)', () => {
    const budgets = [budget('food', 180000)];
    const empty = run({ budgets }).f;
    expect(empty).toMatchObject({ budgetBasis: 'categories', budgetProjectionStatus: 'no-data' });
    // Une dépense, J2 : rythme des catégories non fiable → minimum (règle inchangée).
    expect(run({ budgets, txs: [spend('food', 15000, '2026-11-01')] }).f.budgetProjectionStatus).toBe('minimum');
  });

  it('no-data : écart budgétaire inchangé (= − budget), aucun dépassement', () => {
    const { f } = run({ budgets: [budget(null, 300000)] });
    expect(f).toMatchObject({ budgetReference: 300000, budgetProjectedSpent: 0, projectedBudgetOverrun: -300000 });
  });
});

describe('Insights — aucune affirmation sans donnée', () => {
  const opt = { fmt: (m: number) => String(m), locale: 'fr-FR', monthName: (m: string) => m, thresholds: [80, 100], billReminderDays: 3, dateFormat: 'DD/MM/YYYY' as const };
  const paceOf = (o: Parameters<typeof run>[0]) => {
    const { s, f } = run(o);
    return generateInsights(ctxOf(s), s, f.today, f, opt).filter((i) => i.kind === 'pace');
  };
  // Un revenu dans le mois : sans aucune opération, generateInsights s'arrête plus tôt (« data:empty », comportement existant).
  const salary = [income(1000000, '2026-11-01')];
  it('no-data (revenus seuls) avec budgets par catégorie ou global : ni « sous contrôle » ni dépassement', () => {
    expect(run({ budgets: [budget('food', 180000)], txs: salary }).f.budgetProjectionStatus).toBe('no-data');
    expect(paceOf({ budgets: [budget('food', 180000)], txs: salary })).toHaveLength(0);
    expect(paceOf({ budgets: [budget(null, 300000)], txs: salary })).toHaveLength(0);
  });
  it('non-régression : minimum qui dépasse déjà le budget → alerte « déjà engagé »', () => {
    const pace = paceOf({ budgets: [budget(null, 100000)], rules: [rule({})], txs: salary });
    expect(pace).toHaveLength(1);
    expect(pace[0].severity).toBe('warning');
  });
  it('non-régression : projection complète sous le budget → insight « sous contrôle »', () => {
    expect(paceOf({ budgets: [budget(null, 10000000)], txs: [...history, ...salary] })).toHaveLength(1);
  });
});
