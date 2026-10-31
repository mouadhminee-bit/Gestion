import { describe, expect, it } from 'vitest';
import { account, catByKey, ctxOf, emptySnapshot, tx, UID } from '@/test/fixtures';
import { monthPeriod } from '../dates';
import type { Budget, Transaction } from '../types';
import { summarizePeriod } from './ledger';
import { monthBudgetOverview } from './budgets';
import { forecastMonth } from './forecast';
import type { ScenarioInput } from './scenario';
import { computeBaseline, EMPTY_SCENARIO, simulateScenario } from './scenario';
import { generateInsights } from './insights';

const now = '2026-01-01T00:00:00.000Z';
const base = emptySnapshot();
const cat = (key: string) => catByKey(base.categories, key);
const budget = (categoryId: string | null, amount: number, month = '2026-10'): Budget => ({ id: `b-${categoryId ?? 'global'}-${month}`, userId: UID, month, categoryId, amount, currency: 'MAD', createdAt: now, updatedAt: now });
const spend = (key: string | null, amount: number, p: Partial<Transaction> = {}) => tx({ accountId: 'acc', amount, date: '2026-10-10', categoryId: key ? cat(key).id : null, ...p });

function overview(budgets: Budget[], transactions: Transaction[], today = '2026-10-31', month = '2026-10', filter?: { accountIds: string[] }) {
  const s = emptySnapshot({ categories: base.categories, accounts: [account({ id: 'acc' }), account({ id: 'acc2' })], transactions, budgets });
  const ctx = ctxOf(s);
  const summary = summarizePeriod(ctx, transactions, monthPeriod(month), filter);
  return monthBudgetOverview(budgets, month, summary, ctx.categories, today);
}

describe('Budgets — consommation des catégories budgétées', () => {
  it('cas signalé (octobre 2026) : le hors budget n’entre plus dans la consommation', () => {
    // Budget Alimentation 1 800 DH ; 99 DH en Alimentation ; 1 514,78 DH ailleurs.
    const o = overview([budget(cat('food').id, 180000)], [spend('food', 9900), spend('rent', 100000), spend('transport', 51478)]);
    expect(o.totalSpent).toBe(161378);
    expect(o.categories).toMatchObject({ planned: 180000, spent: 9900, remaining: 170100 });
    expect(o.categories!.consumption).toBeCloseTo(0.055, 10); // et non 161 378 ÷ 180 000 ≈ 90 %
    expect(o.lines[0].consumption).toBeCloseTo(o.categories!.consumption!, 10); // jauge = ligne unique
    expect(o.unbudgetedSpent).toBe(151478);
    expect(o).toMatchObject({ referenceSource: 'categories', reference: 180000, referenceSpent: 9900, available: 170100 });
  });

  it('plusieurs catégories budgétées, dont une sans dépense', () => {
    const o = overview([budget(cat('food').id, 100000), budget(cat('rent').id, 200000), budget(cat('health').id, 50000)], [spend('food', 50000), spend('rent', 200000)]);
    expect(o.categories).toMatchObject({ planned: 350000, spent: 250000 });
    expect(o.categories!.consumption).toBeCloseTo(250000 / 350000, 10);
    expect(o.lines.find((l) => l.category?.key === 'health')).toMatchObject({ spent: 0, consumption: 0 });
  });

  it('opérations sans catégorie et catégories sans budget : hors budget, dans le total', () => {
    const o = overview([budget(cat('food').id, 100000)], [spend('food', 30000), spend(null, 12000), spend('restaurants', 8000)]);
    expect(o.unbudgetedSpent).toBe(20000);
    expect(o.categories!.spent).toBe(30000);
    expect(o.totalSpent).toBe(50000);
  });

  it('sous-catégories : jamais comptées deux fois', () => {
    const groceries = cat('groceries');
    const txs = [spend('food', 10000, { subcategoryId: groceries.id, categoryId: cat('food').id }), spend('food', 5000)];
    // Budget de la sous-catégorie seul : sa dépense est budgétée, le reste de la catégorie est hors budget.
    const sub = overview([budget(groceries.id, 20000)], txs);
    expect(sub.categories).toMatchObject({ planned: 20000, spent: 10000 });
    expect(sub.unbudgetedSpent).toBe(5000);
    // Parent et sous-catégorie budgétés : seul le parent compte dans l’agrégat.
    const both = overview([budget(cat('food').id, 50000), budget(groceries.id, 20000)], txs);
    expect(both.categories).toMatchObject({ planned: 50000, spent: 15000 });
    expect(both.unbudgetedSpent).toBe(0);
  });

  it('budget global saisi : enveloppe de toutes les dépenses, affichée à part', () => {
    const o = overview([budget(null, 300000), budget(cat('food').id, 100000)], [spend('food', 40000), spend('rent', 150000)]);
    expect(o.global).toMatchObject({ planned: 300000, spent: 190000 });
    expect(o.global!.consumption).toBeCloseTo(190000 / 300000, 10);
    expect(o.categories!.consumption).toBeCloseTo(0.4, 10); // inchangée par le budget global
    expect(o).toMatchObject({ referenceSource: 'global', reference: 300000, referenceSpent: 190000, available: 110000, unbudgetedSpent: 150000 });
    // Budget global seul : pas d’agrégat de catégories, tout est hors budget de catégorie.
    const only = overview([budget(null, 300000)], [spend('food', 40000)]);
    expect(only.categories).toBeNull();
    expect(only).toMatchObject({ available: 260000, unbudgetedSpent: 40000 });
  });

  it('transferts, revenus et remboursements', () => {
    const txs = [
      spend('food', 50000),
      tx({ accountId: 'acc', type: 'refund', amount: 10000, date: '2026-10-12', categoryId: cat('food').id }),
      tx({ accountId: 'acc', type: 'transfer', direction: 'out', amount: 300000, date: '2026-10-05', transferId: 't1', counterpartAccountId: 'acc2' }),
      tx({ accountId: 'acc2', type: 'transfer', direction: 'in', amount: 300000, date: '2026-10-05', transferId: 't1', counterpartAccountId: 'acc' }),
      tx({ accountId: 'acc', type: 'income', amount: 1000000, date: '2026-10-01', categoryId: cat('salary').id }),
    ];
    const o = overview([budget(cat('food').id, 100000)], txs);
    expect(o.categories!.spent).toBe(40000); // dépense nette du remboursement
    expect(o.totalSpent).toBe(40000); // ni transfert ni revenu
    expect(o.unbudgetedSpent).toBe(0);
  });

  it('identité : dépenses totales = budgétées + hors budget, quel que soit le filtre de compte', () => {
    const txs = [spend('food', 30000), spend('rent', 90000, { accountId: 'acc2' }), spend(null, 7000, { accountId: 'acc2' })];
    const b = [budget(cat('food').id, 100000), budget(cat('rent').id, 100000)];
    for (const f of [undefined, { accountIds: ['acc'] }, { accountIds: ['acc2'] }]) {
      const o = overview(b, txs, '2026-10-31', '2026-10', f);
      expect(o.totalSpent).toBe(o.categories!.spent + o.unbudgetedSpent);
    }
    expect(overview(b, txs, '2026-10-31', '2026-10', { accountIds: ['acc2'] })).toMatchObject({ totalSpent: 97000, unbudgetedSpent: 7000 });
  });

  it('période : mois passé (projection = réalisé), mois futur (pas de projection), autre mois ignoré', () => {
    const b = [budget(cat('food').id, 100000)];
    expect(overview(b, [spend('food', 30000)], '2026-11-15').categories!.projected).toBe(30000);
    expect(overview([budget(cat('food').id, 100000, '2026-12')], [], '2026-11-15', '2026-12').categories!.projected).toBeNull();
    expect(overview(b, [spend('food', 30000, { date: '2026-09-30' })]).categories!.spent).toBe(0);
  });
});

describe('Budgets — projection de fin de mois sur la même base', () => {
  const snap = (budgets: Budget[], transactions: Transaction[]) => emptySnapshot({ categories: base.categories, accounts: [account({ id: 'acc' })], transactions, budgets });

  it('base catégories : seules les catégories budgétées sont projetées et comparées', () => {
    // Gros loyer hors budget : il ne crée pas de dépassement du budget Alimentation.
    const s = snap([budget(cat('food').id, 180000)], [spend('food', 9900, { date: '2026-10-05' }), spend('rent', 151478, { date: '2026-10-02' })]);
    const f = forecastMonth(ctxOf(s), s, '2026-10-10');
    expect(f.budgetBasis).toBe('categories');
    expect(f.budgetReference).toBe(180000);
    expect(f.budgetProjectedSpent).toBe(Math.round((9900 / 10) * 31)); // rythme du mois
    expect(f.projectedBudgetOverrun).toBe(f.budgetProjectedSpent! - 180000);
    expect(f.projectedBudgetOverrun!).toBeLessThan(0);
  });

  it('base globale : dépenses totales projetées vs budget global', () => {
    const s = snap([budget(null, 180000)], [spend('food', 9900, { date: '2026-10-05' })]);
    const f = forecastMonth(ctxOf(s), s, '2026-10-10');
    expect(f.budgetBasis).toBe('global');
    expect(f.budgetProjectedSpent).toBe(f.projectedExpenses);
    expect(f.projectedBudgetOverrun).toBe(f.projectedExpenses - 180000);
  });
});

describe('Simulateur — disponible sur budget, même règle que Budgets', () => {
  const today = '2026-10-15'; // base : juillet → septembre (mois complets)
  const months = ['2026-07', '2026-08', '2026-09'];
  const monthly = (key: string | null, amount: number, p: Partial<Transaction> = {}) => months.map((m) => spend(key, amount, { date: `${m}-10`, ...p }));
  const history = [
    ...monthly('food', 100000),
    ...monthly('rent', 300000),
    ...monthly('leisure', 50000),
    ...monthly(null, 20000), // sans catégorie : hors budget
    ...monthly('food', 30000, { subcategoryId: cat('groceries').id }),
    ...months.map((m) => tx({ accountId: 'acc', type: 'refund', amount: 10000, date: `${m}-20`, categoryId: cat('food').id })),
  ];
  const run = (budgets: Budget[], input: Partial<ScenarioInput> = {}) => {
    const s = emptySnapshot({ categories: base.categories, accounts: [account({ id: 'acc' })], transactions: history, budgets: budgets.map((b) => ({ ...b, month: '2026-10' })) });
    const ctx = ctxOf(s);
    const f = forecastMonth(ctx, s, today);
    return simulateScenario({ baseline: computeBaseline(ctx, s, today), input: { ...EMPTY_SCENARIO, ...input }, budget: f.budgetScope, projectedEndBalance: 0, remainingDays: 16, daysInMonth: 31, goals: [], goalSaved: () => 0, today, rentCategoryId: cat('rent').id });
  };

  it('budget global : enveloppe comparée aux dépenses totales simulées', () => {
    const r = run([budget(null, 600000)], { newRecurringExpense: 15000 });
    expect(r.budgetBasis).toBe('global');
    // Moyenne mensuelle totale : 100 000 + 30 000 − 10 000 + 300 000 + 50 000 + 20 000 = 490 000
    expect(r.budgetRemainingBaseline).toBe(600000 - 490000);
    expect(r.budgetRemainingScenario).toBe(600000 - 505000); // la nouvelle charge compte
  });

  it('catégories : seules les dépenses budgétées, nettes des remboursements ; hors budget exclu', () => {
    const r = run([budget(cat('food').id, 150000), budget(cat('rent').id, 300000)], { newRecurringExpense: 15000 });
    expect(r.budgetBasis).toBe('categories');
    // Alimentation nette 120 000 + Loyer 300 000 ; ni Loisirs (50 000), ni sans catégorie, ni la nouvelle charge.
    expect(r.budgetRemainingBaseline).toBe(450000 - 420000);
    expect(r.budgetRemainingScenario).toBe(450000 - 420000);
  });

  it('réductions et hausse de loyer : seules celles des catégories budgétées comptent', () => {
    const r = run([budget(cat('food').id, 150000), budget(cat('rent').id, 300000)], { categoryReductions: [{ categoryId: cat('food').id, pct: 10 }, { categoryId: cat('leisure').id, pct: 50 }], rentIncrease: 20000 });
    expect(r.budgetRemainingScenario).toBe(450000 - (120000 - 12000 + 300000 + 20000));
    expect(r.scenario.expenses).toBe(490000 - 12000 - 25000 + 20000); // le total, lui, voit tout
  });

  it('sous-catégorie budgétée seule : sa dépense, réduite comme sa catégorie parente', () => {
    const r = run([budget(cat('groceries').id, 40000)], { categoryReductions: [{ categoryId: cat('food').id, pct: 50 }] });
    expect(r.budgetRemainingBaseline).toBe(40000 - 30000);
    expect(r.budgetRemainingScenario).toBe(40000 - 15000);
  });

  it('sous-catégorie et parent budgétés : le parent seul compte (pas de double comptage)', () => {
    const r = run([budget(cat('food').id, 150000), budget(cat('groceries').id, 40000)]);
    expect(r.budgetRemainingBaseline).toBe(150000 - 120000);
  });

  it('sans budget : pas de disponible sur budget', () => {
    const r = run([]);
    expect(r).toMatchObject({ budgetBasis: null, budgetRemainingBaseline: null, budgetRemainingScenario: null });
  });
});

describe('Insights — la base de la projection est nommée', () => {
  const at = '2026-10-10';
  const insightsFor = (budgets: Budget[], transactions: Transaction[]) => {
    const s = emptySnapshot({ categories: base.categories, accounts: [account({ id: 'acc' })], transactions, budgets });
    const ctx = ctxOf(s);
    const opts = { fmt: (m: number) => String(m / 100), locale: 'fr-MA', monthName: (m: string) => m, thresholds: [50, 75, 90, 100], billReminderDays: 7, dateFormat: 'DD/MM/YYYY' as const };
    return generateInsights(ctx, s, at, forecastMonth(ctx, s, at), opts).filter((i) => i.kind === 'pace');
  };

  it('base catégories : « catégories budgétées », hors budget non inclus', () => {
    const [i] = insightsFor([budget(cat('food').id, 10000)], [spend('food', 9000, { date: '2026-10-05' }), spend('rent', 500000, { date: '2026-10-02' })]);
    expect(i.message).toMatch(/catégories budgétées/);
    expect(i.message).toMatch(/hors budget ne sont pas incluses/);
    expect(i.source).toMatch(/seules catégories budgétées/);
  });

  it('base globale : « dépenses totales » et « budget global »', () => {
    // Historique suffisant (≥ 30 jours, ≥ 10 dépenses) pour projeter les dépenses totales.
    const past = Array.from({ length: 12 }, (_, k) => spend('food', 5000, { date: `2026-0${8 + (k % 2)}-${String(3 + k).padStart(2, '0')}` }));
    const [i] = insightsFor([budget(null, 10000)], [...past, spend('food', 9000, { date: '2026-10-05' })]);
    expect(i.message).toMatch(/dépenses totales/);
    expect(i.message).toMatch(/budget global/);
  });
});
