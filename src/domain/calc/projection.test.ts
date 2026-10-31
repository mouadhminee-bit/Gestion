import { describe, expect, it } from 'vitest';
import { account, catByKey, ctxOf, emptySnapshot, tx, UID } from '@/test/fixtures';
import { monthPeriod } from '../dates';
import type { Budget, RecurringRule, Transaction } from '../types';
import { summarizePeriod } from './ledger';
import { MIN_PACE_DAYS, monthBudgetOverview } from './budgets';
import { forecastMonth } from './forecast';
import { generateInsights } from './insights';

const now = '2026-01-01T00:00:00.000Z';
const base = emptySnapshot();
const cat = (k: string) => catByKey(base.categories, k);
const budget = (k: string | null, amount: number, month = '2026-10'): Budget => ({ id: `b-${k}-${month}`, userId: UID, month, categoryId: k ? cat(k).id : null, amount, currency: 'MAD', createdAt: now, updatedAt: now });
const spend = (k: string | null, amount: number, date: string, p: Partial<Transaction> = {}) => tx({ accountId: 'acc', amount, date, categoryId: k ? cat(k).id : null, ...p });
const rent: RecurringRule = { id: 'rent', userId: UID, kind: 'expense', label: 'Loyer', amount: 280000, currency: 'MAD', accountId: 'acc', categoryId: null, frequency: 'monthly', startDate: '2026-01-25', active: true, createdAt: now, updatedAt: now };
const snap = (budgets: Budget[], transactions: Transaction[], recurringRules: RecurringRule[] = []) =>
  emptySnapshot({ categories: base.categories, accounts: [account({ id: 'acc', initialBalance: 5000000 })], transactions, budgets, recurringRules });
const forecast = (budgets: Budget[], transactions: Transaction[], today: string, rules: RecurringRule[] = []) => {
  const s = snap(budgets, transactions, rules);
  return forecastMonth(ctxOf(s), s, today);
};
/** 12 dépenses variables sur août-septembre : historique exploitable (≥ 30 jours, ≥ 10 dépenses). */
const history = Array.from({ length: 12 }, (_, k) => spend('food', 9000, `2026-0${8 + (k % 2)}-${String(3 + 2 * k).padStart(2, '0')}`));
/** Mois d'octobre sans historique : 4 dépenses variables de 100 DH les 2, 4, 6 et 8. */
const october = [2, 4, 6, 8].map((d) => spend('food', 10000, `2026-10-0${d}`));

describe('Projection de fin de mois — historique absent ou insuffisant', () => {
  it('début de mois (J3) : aucune dépense variable inventée, la projection est un minimum', () => {
    const f = forecast([budget(null, 300000)], october.slice(0, 1), '2026-10-03');
    expect(f.variableMethod).toBe('insufficient');
    expect(f.variableProjected).toBe(0);
    expect(f.projectionStatus).toBe('minimum');
    expect(f.projectedExpenses).toBe(10000); // réalisé seulement : jamais le reste du budget (290 000)
    expect(f.budgetProjectionStatus).toBe('minimum');
  });

  it('milieu de mois (J15, ≥ 10 jours et 3 dépenses) : rythme du mois × jours restants', () => {
    const f = forecast([budget(null, 300000)], october, '2026-10-15');
    expect(f.variableMethod).toBe('month');
    expect(f).toMatchObject({ variableMonthDays: 15, variableMonthCount: 4 });
    expect(f.variableProjected).toBe(Math.round((40000 / 15) * 16));
    expect(f.projectionStatus).toBe('complete');
    expect(f.projectedExpenses).toBe(40000 + f.variableProjected);
  });

  it('J15 avec trop peu de dépenses (2) : minimum, pas d’extrapolation', () => {
    const f = forecast([budget(null, 300000)], october.slice(0, 2), '2026-10-15');
    expect(f).toMatchObject({ variableMethod: 'insufficient', variableProjected: 0, projectionStatus: 'minimum' });
  });

  it('fin de mois (J31) : rien à projeter, projection complète = réalisé (défaut de l’audit corrigé)', () => {
    // Cas de l’audit : budget global 3 000 + Alimentation 1 800, 1 613,78 dépensés.
    const txs = [spend('food', 9900, '2026-10-05'), spend('rent', 100000, '2026-10-02'), spend('transport', 51478, '2026-10-20')];
    const f = forecast([budget(null, 300000), budget('food', 180000)], txs, '2026-10-31');
    expect(f.remainingDays).toBe(0);
    expect(f.variableProjected).toBe(0);
    expect(f.projectedExpenses).toBe(161378); // et non 331 478 (reste du budget Alimentation ajouté)
    expect(f.projectionStatus).toBe('complete');
    expect(f.projectedBudgetOverrun).toBe(161378 - 300000);
  });

  it('avec historique : la méthode « history » reste prioritaire', () => {
    const f = forecast([budget(null, 300000)], [...history, ...october.slice(0, 1)], '2026-10-03');
    expect(f.variableMethod).toBe('history');
    expect(f.projectionStatus).toBe('complete');
    expect(f.variableProjected).toBeGreaterThan(0);
  });
});

describe('Projection — récurrences, hors budget et bases budgétaires', () => {
  it('échéance récurrente à venir : toujours comptée, même sans historique', () => {
    const f = forecast([budget(null, 400000)], october.slice(0, 1), '2026-10-03', [rent]);
    expect(f.expectedRecurringExpenses).toBe(280000);
    expect(f.projectedExpenses).toBe(10000 + 280000);
    expect(f.projectionStatus).toBe('minimum');
  });

  it('budget global : les dépenses hors catégories budgétées comptent dans la projection', () => {
    const f = forecast([budget(null, 300000), budget('food', 100000)], [...october, spend(null, 50000, '2026-10-05')], '2026-10-15');
    expect(f.budgetBasis).toBe('global');
    expect(f.unbudgetedRecorded).toBe(50000);
    expect(f.budgetProjectedSpent).toBe(f.projectedExpenses);
  });

  it('budgets par catégorie : hors budget exclu, début de mois = minimum, milieu = rythme de la ligne', () => {
    const txs = [spend('food', 10000, '2026-10-02'), spend(null, 70000, '2026-10-02')];
    const early = forecast([budget('food', 100000)], txs, '2026-10-03');
    expect(early.budgetBasis).toBe('categories');
    expect(early.unbudgetedRecorded).toBe(70000);
    expect(early.budgetProjectedSpent).toBe(10000); // pas 10 000 ÷ 3 × 31
    expect(early.budgetProjectionStatus).toBe('minimum');
    const mid = forecast([budget('food', 100000)], txs, '2026-10-15');
    expect(mid.budgetProjectedSpent).toBe(Math.round((10000 / 15) * 31));
    expect(mid.budgetProjectionStatus).toBe('complete');
  });

  it('catégorie budgétée avec échéance connue : le minimum inclut l’échéance', () => {
    const rentRule = { ...rent, categoryId: cat('rent').id };
    const f = forecast([budget('rent', 280000), budget('food', 100000)], [spend('food', 5000, '2026-10-02')], '2026-10-03', [rentRule]);
    expect(f.budgetProjectedSpent).toBe(5000 + 280000);
    expect(f.budgetProjectionStatus).toBe('minimum');
  });
});

describe('Projection des lignes de budget — mois passé, en cours, futur', () => {
  const overview = (budgets: Budget[], txs: Transaction[], today: string, month = '2026-10') => {
    const s = snap(budgets, txs);
    const ctx = ctxOf(s);
    return monthBudgetOverview(budgets, month, summarizePeriod(ctx, txs, monthPeriod(month)), ctx.categories, today);
  };
  const b = [budget('food', 100000)];
  const txs = [spend('food', 20000, '2026-10-02')];

  it(`mois en cours avant ${MIN_PACE_DAYS} jours : minimum ; après : rythme`, () => {
    expect(overview(b, txs, '2026-10-05').categories).toMatchObject({ projected: 20000, projectionComplete: false });
    expect(overview(b, txs, '2026-10-10').categories).toMatchObject({ projected: Math.round((20000 / 10) * 31), projectionComplete: true });
  });

  it('mois passé : projection = réalisé ; mois futur : aucune projection', () => {
    expect(overview(b, txs, '2026-11-20').categories).toMatchObject({ projected: 20000, projectionComplete: true });
    expect(overview([budget('food', 100000, '2026-12')], [], '2026-11-20', '2026-12').categories!.projected).toBeNull();
  });

  it('charge fixe : réalisé + échéances, complète même en début de mois', () => {
    const o = overview([budget('rent', 280000)], [spend('rent', 280000, '2026-10-01')], '2026-10-02');
    expect(o.categories).toMatchObject({ projected: 280000, projectionComplete: true });
  });
});

describe('Insights — cohérents avec le statut de la projection', () => {
  const insights = (budgets: Budget[], txs: Transaction[], today: string) => {
    const s = snap(budgets, txs);
    const ctx = ctxOf(s);
    const opts = { fmt: (m: number) => String(m / 100), locale: 'fr-MA', monthName: (m: string) => m, thresholds: [50, 75, 90, 100], billReminderDays: 7, dateFormat: 'DD/MM/YYYY' as const };
    return generateInsights(ctx, s, today, forecastMonth(ctx, s, today), opts).filter((i) => i.kind === 'pace');
  };

  it('minimum sous le budget : aucune affirmation « sous contrôle »', () => {
    expect(insights([budget(null, 300000)], october.slice(0, 1), '2026-10-03')).toHaveLength(0);
  });

  it('minimum déjà au-delà du budget : alerte, avec la source « minimum connu »', () => {
    const [i] = insights([budget(null, 5000)], october.slice(0, 1), '2026-10-03');
    expect(i.severity).toBe('warning');
    expect(i.source).toMatch(/Minimum connu/);
  });

  it('projection complète (rythme du mois) : « sous contrôle » possible', () => {
    const [i] = insights([budget(null, 300000)], october, '2026-10-15');
    expect(i.severity).toBe('success');
  });
});
