import { describe, expect, it } from 'vitest';
import { account, catByKey, ctxOf, emptySnapshot, tx, UID } from '@/test/fixtures';
import { monthPeriod } from '../dates';
import type { Budget, RecurringRule, Transaction } from '../types';
import { summarizePeriod } from './ledger';
import { monthBudgetOverview } from './budgets';
import { forecastMonth } from './forecast';
import { generateInsights } from './insights';

const now = '2026-01-01T00:00:00.000Z';
const base = emptySnapshot();
const cat = (k: string) => catByKey(base.categories, k);
const budget = (k: string | null, amount: number): Budget => ({ id: `b-${k}`, userId: UID, month: '2026-11', categoryId: k ? cat(k).id : null, amount, currency: 'MAD', createdAt: now, updatedAt: now });
const spend = (k: string | null, dh: number, date: string, p: Partial<Transaction> = {}) => tx({ accountId: 'acc', amount: dh * 100, date, categoryId: k ? cat(k).id : null, label: 'Achat', ...p });
const snap = (transactions: Transaction[], budgets: Budget[] = [budget(null, 300000)], recurringRules: RecurringRule[] = []) =>
  emptySnapshot({ categories: base.categories, accounts: [account({ id: 'acc', initialBalance: 5000000 })], transactions, budgets, recurringRules });
const fc = (transactions: Transaction[], today = '2026-11-10', budgets?: Budget[], rules?: RecurringRule[]) => {
  const s = snap(transactions, budgets, rules);
  return forecastMonth(ctxOf(s), s, today);
};
/** Trois petites dépenses variables habituelles en novembre. */
const small = [spend('food', 50, '2026-11-02'), spend('food', 60, '2026-11-05'), spend('transport', 40, '2026-11-08')];

describe('Dépenses atypiques et rythme du mois', () => {
  it('dépense exceptionnelle isolée (5 000 DH au 10e jour, sans historique) : jamais extrapolée', () => {
    const f = fc([spend('food', 5000, '2026-11-03'), ...small.slice(0, 2)]);
    expect(f.atypical.map((x) => x.amount)).toEqual([500000]);
    expect(f.variableMethod).toBe('insufficient'); // 2 dépenses habituelles seulement
    expect(f.projectionStatus).toBe('minimum');
    expect(f.projectedExpenses).toBe(511000); // réalisé, aucune extrapolation des 5 000
    expect(f.assumptions.some((a) => /atypique/.test(a))).toBe(true);
  });

  it('dépense exceptionnelle + dépenses habituelles suffisantes : seul le rythme habituel est extrapolé', () => {
    const f = fc([spend('food', 5000, '2026-11-03'), ...small]);
    expect(f.variableMethod).toBe('month');
    expect(f.variableMonthCount).toBe(3);
    expect(f.variableProjected).toBe(Math.round((15000 / 10) * 20)); // 150 DH habituels ÷ 10 j × 20 j
    expect(f.projectedExpenses).toBe(515000 + f.variableProjected); // les 5 000 comptés une fois
  });

  it('dépense importante mais récurrente (échéance détectée) : charge identifiée, ni atypique ni extrapolée', () => {
    const rule: RecurringRule = { id: 'r', userId: UID, kind: 'expense', label: 'Achat', amount: 500000, currency: 'MAD', accountId: 'acc', categoryId: cat('food').id, frequency: 'monthly', startDate: '2026-01-03', active: true, createdAt: now, updatedAt: now };
    const f = fc([spend('food', 5000, '2026-11-03'), ...small], '2026-11-10', undefined, [rule]);
    expect(f.atypical).toHaveLength(0);
    expect(f.variableMonthCount).toBe(3);
    expect(f.variableProjected).toBe(Math.round((15000 / 10) * 20));
  });

  it('dépense importante avec historique comparable (même catégorie) : habituelle, prise dans le rythme', () => {
    const f = fc([spend('food', 4800, '2026-10-04'), spend('food', 5000, '2026-11-03'), ...small]);
    expect(f.atypical).toHaveLength(0);
    expect(f.variableMethod).toBe('month');
    expect(f.variableMonthCount).toBe(4);
  });

  it('montant comparable mais dans une autre catégorie : reste atypique', () => {
    const f = fc([spend('transport', 4800, '2026-10-04'), spend('food', 5000, '2026-11-03'), ...small]);
    expect(f.atypical).toHaveLength(1);
  });

  it('plusieurs dépenses variables habituelles : rythme complet', () => {
    const txs = [120, 90, 150, 80, 110].map((dh, i) => spend('food', dh, `2026-11-0${i + 2}`));
    const f = fc(txs);
    expect(f).toMatchObject({ variableMethod: 'month', projectionStatus: 'complete', variableMonthCount: 5 });
    expect(f.atypical).toHaveLength(0);
  });

  it('mois avec très peu de transactions : minimum', () => {
    const f = fc([spend('food', 200, '2026-11-12'), spend('food', 300, '2026-11-18')], '2026-11-20');
    expect(f).toMatchObject({ variableMethod: 'insufficient', projectionStatus: 'minimum', variableProjected: 0, projectedExpenses: 50000 });
  });

  it('historique de 90 jours : une dépense isolée n’alourdit pas la moyenne', () => {
    const history = Array.from({ length: 12 }, (_, k) => spend('food', 90, `2026-${String(8 + (k % 3)).padStart(2, '0')}-${String(3 + 2 * k).padStart(2, '0')}`));
    const withOutlier = fc([...history, spend('leisure', 8000, '2026-10-20')], '2026-11-05');
    const without = fc(history, '2026-11-05');
    expect(withOutlier.variableMethod).toBe('history');
    expect(withOutlier.atypical).toHaveLength(1);
    expect(withOutlier.variableProjected).toBe(without.variableProjected);
  });
});

describe('Lignes de budget : la dépense atypique est comptée une fois', () => {
  it('Alimentation : rythme habituel extrapolé + 5 000 DH une seule fois', () => {
    const txs = [spend('food', 5000, '2026-11-03'), spend('food', 100, '2026-11-02'), spend('food', 100, '2026-11-05'), spend('food', 100, '2026-11-08')];
    const s = snap(txs, [budget('food', 600000)]);
    const ctx = ctxOf(s);
    const f = forecastMonth(ctx, s, '2026-11-10');
    const o = monthBudgetOverview(s.budgets, '2026-11', summarizePeriod(ctx, txs, monthPeriod('2026-11')), ctx.categories, '2026-11-10', undefined, f.committedByCategory, f.atypicalByCategory);
    expect(o.lines[0].projected).toBe(Math.round((30000 / 10) * 30) + 500000); // et non 530 000 ÷ 10 × 30
    expect(f.budgetProjectedSpent).toBe(o.categories!.projected);
  });
});

describe('Libellés quand la projection est un minimum', () => {
  const insights = (txs: Transaction[], budgets: Budget[], today: string) => {
    const s = snap(txs, budgets);
    const ctx = ctxOf(s);
    const opts = { fmt: (m: number) => String(m / 100), locale: 'fr-MA', monthName: (m: string) => m, thresholds: [50, 75, 90, 100], billReminderDays: 7, dateFormat: 'DD/MM/YYYY' as const };
    return generateInsights(ctx, s, today, forecastMonth(ctx, s, today), opts).filter((i) => i.kind === 'pace');
  };

  it('minimum au-delà du budget global : « déjà engagées », jamais « au rythme actuel »', () => {
    const [i] = insights([spend('food', 5000, '2026-11-03')], [budget(null, 300000)], '2026-11-10');
    expect(i.title).toBe('Budget déjà dépassé par les dépenses engagées');
    expect(i.message).toMatch(/déjà engagées/);
    expect(i.message).not.toMatch(/rythme actuel/i);
    expect(i.source).toMatch(/Minimum connu/);
  });

  it('minimum au-delà des budgets par catégorie : formulation dédiée, hors budget exclu', () => {
    const [i] = insights([spend('food', 5000, '2026-11-03'), spend(null, 900, '2026-11-04')], [budget('food', 300000)], '2026-11-05');
    expect(i.message).toMatch(/catégories budgétées/);
    expect(i.message).toMatch(/hors budget non incluses/);
    expect(i.message).not.toMatch(/rythme actuel/i);
  });

  it('minimum sous le budget : aucun insight affirmatif', () => {
    expect(insights([spend('food', 500, '2026-11-02')], [budget(null, 300000)], '2026-11-05')).toHaveLength(0);
  });
});
