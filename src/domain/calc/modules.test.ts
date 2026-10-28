import { describe, expect, it } from 'vitest';
import { account, catByKey, ctxOf, emptySnapshot, tx, UID } from '@/test/fixtures';
import { monthPeriod } from '../dates';
import type { Budget, Debt, DebtPayment, RecurringRule, SavingsGoal } from '../types';
import { summarizePeriod } from './ledger';
import { computeBudgetLine, monthBudgetOverview, monthTiming, reachedThreshold } from './budgets';
import { computeGoalProgress } from './goals';
import { listOccurrences, monthlyEquivalent, occurrenceDates } from './recurring';
import { computeDebtStatus, debtRemaining, validateDebtPayment } from './debts';
import { computeNetWorth, netWorthHistory } from './networth';
import { forecastMonth, variableDailyAverage } from './forecast';
import { computeBaseline, EMPTY_SCENARIO, simulateScenario } from './scenario';

const now = '2026-01-01T00:00:00.000Z';
const budget = (p: Partial<Budget>): Budget => ({ id: 'b' + Math.random(), userId: UID, month: '2026-03', categoryId: null, amount: 0, currency: 'MAD', createdAt: now, updatedAt: now, ...p });

describe('Budgets', () => {
  it('montant restant, consommation, écarts', () => {
    const s = emptySnapshot();
    const food = catByKey(s.categories, 'food');
    const line = computeBudgetLine(budget({ categoryId: food.id, amount: 100000 }), food, 85000, monthTiming('2026-03', '2026-04-02'), [50, 75, 90, 100]);
    expect(line.remaining).toBe(15000);
    expect(line.consumption).toBeCloseTo(0.85);
    expect(line.variance).toBe(-15000);
    expect(line.variancePct).toBeCloseTo(-0.15);
    expect(line.thresholdReached).toBe(75);
    expect(line.status).toBe('warning');
  });

  it('détecte un dépassement', () => {
    const s = emptySnapshot();
    const food = catByKey(s.categories, 'food');
    const line = computeBudgetLine(budget({ categoryId: food.id, amount: 100000 }), food, 125000, monthTiming('2026-03', '2026-03-15'), [50, 75, 90, 100]);
    expect(line.status).toBe('over');
    expect(line.variance).toBe(25000);
    expect(line.thresholdReached).toBe(100);
  });

  it('budget nul : pas de taux de consommation', () => {
    const s = emptySnapshot();
    const food = catByKey(s.categories, 'food');
    const line = computeBudgetLine(budget({ categoryId: food.id, amount: 0 }), food, 5000, monthTiming('2026-03', '2026-03-15'), [50]);
    expect(line.consumption).toBeNull();
    expect(line.variancePct).toBeNull();
    expect(line.status).toBe('over');
    expect(reachedThreshold(null, [50])).toBeNull();
  });

  it('projection linéaire de fin de mois pour une catégorie variable', () => {
    const s = emptySnapshot();
    const food = catByKey(s.categories, 'food');
    const line = computeBudgetLine(budget({ categoryId: food.id, amount: 200000 }), food, 50000, monthTiming('2026-03', '2026-03-10'), []);
    expect(line.projected).toBe(155000); // 50 000 / 10 j × 31 j
  });

  it('budget disponible = budget global − dépenses du mois (toutes catégories)', () => {
    const s = emptySnapshot();
    const bank = account({ initialBalanceDate: '2026-03-01' });
    const food = catByKey(s.categories, 'food');
    const travel = catByKey(s.categories, 'travel');
    s.accounts = [bank];
    s.transactions = [tx({ accountId: bank.id, amount: 60000, categoryId: food.id }), tx({ accountId: bank.id, amount: 40000, categoryId: travel.id })];
    s.budgets = [budget({ amount: 900000 }), budget({ categoryId: food.id, amount: 100000 })];
    const ctx = ctxOf(s);
    const sum = summarizePeriod(ctx, s.transactions, monthPeriod('2026-03'));
    const o = monthBudgetOverview(s.budgets, '2026-03', sum, ctx.categories, '2026-03-20');
    expect(o.referenceSource).toBe('global');
    expect(o.available).toBe(800000);
    expect(o.unbudgetedSpent).toBe(40000);
    expect(o.lines[0].spent).toBe(60000);
  });

  it('sans budget global, la référence est la somme des catégories', () => {
    const s = emptySnapshot();
    const food = catByKey(s.categories, 'food');
    const rent = catByKey(s.categories, 'rent');
    const ctx = ctxOf(s);
    const sum = summarizePeriod(ctx, [], monthPeriod('2026-03'));
    const o = monthBudgetOverview([budget({ categoryId: food.id, amount: 1000 }), budget({ categoryId: rent.id, amount: 2000 })], '2026-03', sum, ctx.categories, '2026-03-20');
    expect(o.reference).toBe(3000);
    expect(o.referenceSource).toBe('categories');
    expect(monthBudgetOverview([], '2026-03', sum, ctx.categories, '2026-03-20').available).toBeNull();
  });
});

const goal = (p: Partial<SavingsGoal>): SavingsGoal => ({
  id: 'g1', userId: UID, name: 'Voyage', targetAmount: 1000000, currency: 'MAD', savedAmount: 0, priority: 'medium', trackLinkedAccount: false, status: 'active', icon: 'Target', color: '#fff', createdAt: now, updatedAt: now, ...p,
});

describe('Objectifs d’épargne', () => {
  it('progression, restant et contribution nécessaire', () => {
    const p = computeGoalProgress(goal({ savedAmount: 400000, targetDate: '2027-04-01', monthlyContribution: 100000 }), '2026-10-01');
    expect(p.remaining).toBe(600000);
    expect(p.progress).toBeCloseTo(0.4);
    expect(p.monthsLeft).toBe(6);
    expect(p.requiredMonthly).toBe(100000);
    expect(p.contributionGap).toBe(0);
    expect(p.state).toBe('on_track');
  });

  it('objectif déjà atteint : progression plafonnée, montant réel conservé', () => {
    const p = computeGoalProgress(goal({ savedAmount: 1200000 }), '2026-10-01');
    expect(p.state).toBe('achieved');
    expect(p.progress).toBeCloseTo(1.2);
    expect(p.progressCapped).toBe(1);
    expect(p.saved).toBe(1200000);
    expect(p.remaining).toBe(0);
  });

  it('date cible dépassée', () => {
    const p = computeGoalProgress(goal({ savedAmount: 100, targetDate: '2026-09-01' }), '2026-10-01');
    expect(p.state).toBe('overdue');
    expect(p.requiredMonthly).toBeNull();
  });

  it('en retard sur le rythme', () => {
    const p = computeGoalProgress(goal({ targetDate: '2027-10-01', monthlyContribution: 50000 }), '2026-10-01');
    expect(p.requiredMonthly).toBe(83334);
    expect(p.state).toBe('behind');
  });

  it('suit le solde d’un compte associé', () => {
    const p = computeGoalProgress(goal({ trackLinkedAccount: true, linkedAccountId: 'acc', savedAmount: 0 }), '2026-10-01', 250000);
    expect(p.saved).toBe(250000);
  });
});

const rule = (p: Partial<RecurringRule>): RecurringRule => ({
  id: 'r1', userId: UID, kind: 'expense', label: 'Loyer', amount: 280000, currency: 'MAD', accountId: 'acc', categoryId: null, frequency: 'monthly', startDate: '2026-01-31', active: true, createdAt: now, updatedAt: now, ...p,
});

describe('Échéances récurrentes', () => {
  it('gère les fins de mois sans dérive', () => {
    expect(occurrenceDates(rule({}), '2026-01-01', '2026-05-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('gère les années bissextiles', () => {
    expect(occurrenceDates(rule({ startDate: '2024-01-31' }), '2024-02-01', '2024-02-29')).toEqual(['2024-02-29']);
    expect(occurrenceDates(rule({ startDate: '2024-02-29', frequency: 'annual' }), '2024-01-01', '2028-12-31')).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  });

  it('fréquences hebdomadaire, trimestrielle, personnalisée, date de fin', () => {
    expect(occurrenceDates(rule({ startDate: '2026-03-02', frequency: 'weekly' }), '2026-03-01', '2026-03-31')).toEqual(['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']);
    expect(occurrenceDates(rule({ startDate: '2026-01-15', frequency: 'quarterly' }), '2026-01-01', '2026-12-31')).toEqual(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
    expect(occurrenceDates(rule({ startDate: '2026-01-01', frequency: 'custom', customInterval: 10, customUnit: 'day' }), '2026-01-15', '2026-02-01')).toEqual(['2026-01-21', '2026-01-31']);
    expect(occurrenceDates(rule({ startDate: '2026-01-10', endDate: '2026-03-01' }), '2026-01-01', '2026-12-31')).toEqual(['2026-01-10', '2026-02-10']);
  });

  it('commence à la bonne occurrence pour une fenêtre lointaine', () => {
    expect(occurrenceDates(rule({ startDate: '2020-01-31' }), '2026-02-01', '2026-03-31')).toEqual(['2026-02-28', '2026-03-31']);
    expect(occurrenceDates(rule({ startDate: '2020-01-06', frequency: 'daily' }), '2026-02-01', '2026-02-02')).toEqual(['2026-02-01', '2026-02-02']);
  });

  it('équivalent mensuel', () => {
    expect(monthlyEquivalent(rule({ amount: 45000, frequency: 'quarterly' }))).toBe(15000);
    expect(monthlyEquivalent(rule({ amount: 120000, frequency: 'annual' }))).toBe(10000);
  });

  it('ne crée aucune transaction et détecte les paiements déjà saisis', () => {
    const r = rule({ startDate: '2026-03-03', accountId: 'acc' });
    const manual = tx({ accountId: 'acc', amount: 280000, label: 'Loyer', date: '2026-03-04' });
    const occ = listOccurrences([r], [], [manual], monthPeriod('2026-03'), '2026-03-20');
    expect(occ).toHaveLength(1);
    expect(occ[0].status).toBe('matched');
    const occ2 = listOccurrences([r], [], [], monthPeriod('2026-03'), '2026-03-20');
    expect(occ2[0].status).toBe('overdue');
    const occ3 = listOccurrences([r], [{ id: 'r1:2026-03-03', userId: UID, ruleId: 'r1', dueDate: '2026-03-03', status: 'skipped', updatedAt: now }], [], monthPeriod('2026-03'), '2026-03-01');
    expect(occ3[0].status).toBe('skipped');
  });
});

const debt = (p: Partial<Debt>): Debt => ({
  id: 'd1', userId: UID, label: 'Crédit', type: 'loan', direction: 'payable', principal: 6000000, currency: 'MAD', startDate: '2026-01-01', status: 'active', createdAt: now, updatedAt: now, ...p,
});
const payment = (p: Partial<DebtPayment>): DebtPayment => ({ id: 'p' + Math.random(), userId: UID, debtId: 'd1', date: '2026-02-01', principal: 120000, interest: 25000, createdAt: now, ...p });

describe('Dettes et remboursements', () => {
  it('le restant dû diminue du principal uniquement', () => {
    const d = debt({});
    const ps = [payment({}), payment({ date: '2026-03-01' })];
    expect(debtRemaining(d, ps)).toBe(6000000 - 240000);
    expect(debtRemaining(d, ps, '2026-02-15')).toBe(6000000 - 120000);
    const st = computeDebtStatus(d, ps, '2026-03-10');
    expect(st.paidInterest).toBe(50000);
    expect(st.repaidPrincipal).toBe(240000);
  });

  it('refuse un principal supérieur au restant dû', () => {
    expect(validateDebtPayment(debt({ principal: 1000 }), [], 1500, 0)).toMatch(/dépasse/);
    expect(validateDebtPayment(debt({ principal: 1000 }), [], 0, 0)).toMatch(/supérieur à zéro/);
    expect(validateDebtPayment(debt({ principal: 1000 }), [], 1000, 50)).toBeNull();
  });

  it('engagement en retard', () => {
    expect(computeDebtStatus(debt({ dueDate: '2026-02-01' }), [], '2026-03-01').overdue).toBe(true);
  });
});

describe('Patrimoine net', () => {
  it('actifs − passifs, sans double comptage ni objectifs', () => {
    const s = emptySnapshot();
    const bank = account({ initialBalance: 1000000 });
    const invest = account({ type: 'investment', initialBalance: 500000 });
    s.accounts = [bank, invest];
    s.assets = [
      { id: 'a1', userId: UID, name: 'Voiture', type: 'vehicle', currency: 'MAD', archived: false, createdAt: now, updatedAt: now },
      { id: 'a2', userId: UID, name: 'Valo portefeuille', type: 'investment', currency: 'MAD', linkedAccountId: invest.id, archived: false, createdAt: now, updatedAt: now },
    ];
    s.valuations = [
      { id: 'v1', userId: UID, assetId: 'a1', date: '2026-01-01', value: 9000000, source: 'manual', createdAt: now },
      { id: 'v2', userId: UID, assetId: 'a1', date: '2026-02-01', value: 8500000, source: 'manual', createdAt: now },
      { id: 'v3', userId: UID, assetId: 'a2', date: '2026-02-01', value: 560000, source: 'manual', createdAt: now },
    ];
    s.debts = [debt({}), debt({ id: 'd2', direction: 'receivable', type: 'lent', principal: 200000 })];
    s.debtPayments = [payment({})];
    s.goals = [goal({ savedAmount: 999999 })];
    const nw = computeNetWorth(ctxOf(s), s, '2026-03-01');
    // Comptes : banque 10 000 + portefeuille valorisé 5 600 (remplace 5 000) ; voiture 85 000 ; créance 2 000
    expect(nw.totalAssets).toBe(1000000 + 560000 + 8500000 + 200000);
    expect(nw.totalLiabilities).toBe(6000000 - 120000);
    expect(nw.netWorth).toBe(nw.totalAssets - nw.totalLiabilities);
    expect(nw.assets.find((a) => a.id === invest.id)?.manual).toBe(true);
    expect(nw.assets.some((a) => a.id === 'a2')).toBe(false);
  });

  it('l’historique ignore les mois antérieurs au début du suivi', () => {
    const s = emptySnapshot();
    s.accounts = [account({ initialBalance: 1000, initialBalanceDate: '2026-03-01' })];
    s.debts = [debt({ startDate: '2025-01-01' })];
    const h = netWorthHistory(ctxOf(s), s, ['2026-01', '2026-02', '2026-03', '2026-04'], '2026-04-10');
    expect(h.map((x) => x.month)).toEqual(['2026-03', '2026-04']);
    expect(h[1].asOf).toBe('2026-04-10');
  });

  it('un emprunt reçu sur un compte ne change pas le patrimoine net', () => {
    const s = emptySnapshot();
    const bank = account({ initialBalance: 0 });
    s.accounts = [bank];
    const before = computeNetWorth(ctxOf(s), s, '2026-03-31').netWorth;
    s.debts = [debt({ principal: 1000000, startDate: '2026-03-01' })];
    s.transactions = [tx({ accountId: bank.id, type: 'debt', direction: 'in', amount: 1000000, date: '2026-03-01', debtId: 'd1' })];
    expect(computeNetWorth(ctxOf(s), s, '2026-03-31').netWorth).toBe(before);
  });
});

describe('Prévisions et scénarios', () => {
  function forecastSetup() {
    const s = emptySnapshot();
    const bank = account({ initialBalance: 1000000, initialBalanceDate: '2026-01-01' });
    s.accounts = [bank];
    const food = catByKey(s.categories, 'food');
    const salary = catByKey(s.categories, 'salary');
    const rent = catByKey(s.categories, 'rent');
    // 90 jours d'historique : 1 dépense alimentaire de 100 DH tous les 3 jours.
    for (let d = 9; d < 99; d += 3) { // 10/01 → 09/04 : 30 dépenses de 100 DH sur 90 jours
      const date = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
      s.transactions.push(tx({ accountId: bank.id, amount: 10000, categoryId: food.id, date }));
    }
    s.recurringRules = [
      rule({ id: 'rent', accountId: bank.id, categoryId: rent.id, amount: 280000, startDate: '2026-01-25' }),
      rule({ id: 'sal', kind: 'income', label: 'Salaire', accountId: bank.id, categoryId: salary.id, amount: 1300000, startDate: '2026-01-28' }),
    ];
    return { s, bank, food };
  }

  it('moyenne quotidienne des dépenses variables', () => {
    const { s } = forecastSetup();
    const avg = variableDailyAverage(ctxOf(s), s, '2026-04-10');
    expect(avg.days).toBe(90);
    expect(avg.count).toBe(30);
    expect(avg.dailyAverage).toBeCloseTo(300000 / 90);
  });

  it('solde fin de mois = solde + récurrents attendus − variables projetées', () => {
    const { s } = forecastSetup();
    const ctx = ctxOf(s);
    const f = forecastMonth(ctx, s, '2026-04-10');
    expect(f.variableMethod).toBe('history');
    expect(f.remainingDays).toBe(20);
    expect(f.expectedRecurringIncome).toBe(1300000);
    expect(f.expectedRecurringExpenses).toBe(280000);
    const expectedVar = Math.round((300000 / 90) * 20);
    expect(f.variableProjected).toBe(expectedVar);
    expect(f.projectedEndBalance).toBe(f.currentBalance + 1300000 - 280000 - expectedVar);
  });

  it('les échéances déjà payées ne sont pas recomptées', () => {
    const { s, bank } = forecastSetup();
    s.transactions.push(tx({ accountId: bank.id, amount: 280000, label: 'Loyer', categoryId: s.recurringRules[0].categoryId, date: '2026-04-09', recurringRuleId: 'rent', recurringDueDate: '2026-04-25' }));
    const f = forecastMonth(ctxOf(s), s, '2026-04-10');
    expect(f.expectedRecurringExpenses).toBe(0);
  });

  it('historique insuffisant : données insuffisantes signalées', () => {
    const s = emptySnapshot();
    s.accounts = [account({ initialBalance: 1000 })];
    const f = forecastMonth(ctxOf(s), s, '2026-04-10');
    expect(f.variableMethod).toBe('insufficient');
    expect(f.variableProjected).toBe(0);
    expect(f.assumptions.join(' ')).toMatch(/insuffisantes/);
  });

  it('le simulateur ne modifie pas les données et calcule l’impact', () => {
    const { s } = forecastSetup();
    const ctx = ctxOf(s);
    const frozen = JSON.stringify(s);
    const baseline = computeBaseline(ctx, s, '2026-04-10');
    const food = catByKey(s.categories, 'food');
    const res = simulateScenario({
      baseline,
      input: { ...EMPTY_SCENARIO, incomeChangePct: 10, categoryReductions: [{ categoryId: food.id, pct: 50 }], oneOffPurchase: 50000 },
      budgetReference: null,
      projectedEndBalance: 1000000,
      remainingDays: 20,
      daysInMonth: 30,
      goals: [],
      goalSaved: () => 0,
      today: '2026-04-10',
    });
    expect(baseline.monthsWithData).toBe(3);
    expect(res.scenario.expenses).toBe(baseline.expenses - Math.round((baseline.byCategory.get(food.id) ?? 0) / 2));
    expect(res.deltaSavings).toBe(res.scenario.savings - res.baseline.savings);
    expect(res.endOfMonthScenario).toBe(1000000 + Math.round((res.deltaSavings * 20) / 30) - 50000);
    expect(JSON.stringify(s)).toBe(frozen);
  });
});
