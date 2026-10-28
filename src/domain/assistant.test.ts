import { describe, expect, it } from 'vitest';
import { generateDemoData } from '@/data/demo';
import { buildContext } from './calc/ledger';
import { answerQuestion } from './assistant';
import { generateInsights } from './calc/insights';
import { forecastMonth } from './calc/forecast';
import { formatMoney } from './money';
import { emptySnapshot, account, tx, catByKey, ctxOf } from '@/test/fixtures';

const today = '2026-10-28';
const data = generateDemoData('u', today);
const ctx = buildContext(data);
const fmt = { money: (m: number) => formatMoney(m, 'MAD', { locale: 'fr-FR' }), percent: (r: number | null) => (r == null ? 'n/c' : `${Math.round(r * 1000) / 10} %`), month: (m: string) => m, date: (d: string) => d };

describe('Assistant déterministe', () => {
  it('répond aux dépenses d’une catégorie avec le même chiffre que le moteur comptable', () => {
    const a = answerQuestion('Combien ai-je dépensé en restaurants ce mois-ci ?', ctx, data, today, fmt);
    expect(a.intent).toBe('category_spending');
    const restaurants = catByKey(data.categories, 'restaurants');
    const expected = data.transactions.filter((t) => t.date.startsWith('2026-10') && t.categoryId === restaurants.id && t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    expect(a.text).toContain(fmt.money(expected));
  });

  it('identifie la catégorie qui dépasse le plus son budget', () => {
    const a = answerQuestion('Quelle catégorie dépasse le plus son budget ?', ctx, data, today, fmt);
    expect(a.intent).toBe('budget_over');
    expect(a.text).toMatch(/Restaurants|Shopping|dépasse|Aucune/);
  });

  it('simule une réduction sans modifier les données', () => {
    const before = JSON.stringify(data);
    const a = answerQuestion('Que se passerait-il si je réduisais mes dépenses de loisirs de 15 % ?', ctx, data, today, fmt);
    expect(a.intent).toBe('what_if');
    expect(a.text).toContain('Loisirs');
    expect(JSON.stringify(data)).toBe(before);
  });

  it('couvre solde fin de mois, récurrences, objectifs, évolution', () => {
    expect(answerQuestion('Quel sera mon solde estimé à la fin du mois ?', ctx, data, today, fmt).intent).toBe('end_balance');
    expect(answerQuestion('Quelles dépenses récurrentes représentent la plus grande part de mon budget ?', ctx, data, today, fmt).intent).toBe('recurring');
    expect(answerQuestion('Quel objectif d’épargne puis-je atteindre en premier ?', ctx, data, today, fmt).intent).toBe('goal_first');
    expect(answerQuestion('Comment mes dépenses ont-elles évolué depuis trois mois ?', ctx, data, today, fmt).intent).toBe('trend');
    expect(answerQuestion('Combien puis-je raisonnablement épargner ce mois-ci ?', ctx, data, today, fmt).intent).toBe('savings_capacity');
  });

  it('signale les données insuffisantes au lieu d’inventer', () => {
    const empty = emptySnapshot();
    const a = answerQuestion('Comment mes dépenses ont-elles évolué depuis trois mois ?', ctxOf(empty), empty, today, fmt);
    expect(a.text).toMatch(/Données insuffisantes/);
  });
});

describe('Moteur d’insights', () => {
  const opts = { fmt: fmt.money, locale: 'fr-FR', monthName: (m: string) => m, thresholds: [50, 75, 90, 100], billReminderDays: 7, dateFormat: 'DD/MM/YYYY' as const };

  it('compare les catégories à période égale et explique la source', () => {
    const ins = generateInsights(ctx, data, today, forecastMonth(ctx, data, today), opts);
    const trend = ins.find((i) => i.kind === 'category_trend');
    expect(trend).toBeDefined();
    expect(trend!.source).toMatch(/période égale/);
    expect(ins.every((i) => i.source.length > 0)).toBe(true);
  });

  it('n’émet pas de comparaison sans données comparables', () => {
    const s = emptySnapshot();
    const bank = account({ initialBalanceDate: '2026-09-01' });
    s.accounts = [bank];
    // Une seule opération ce mois-ci, aucune le mois précédent.
    s.transactions = [tx({ accountId: bank.id, amount: 5000, date: '2026-10-05', categoryId: catByKey(s.categories, 'food').id })];
    const ins = generateInsights(ctxOf(s), s, today, null, opts);
    expect(ins.some((i) => i.kind === 'category_trend')).toBe(false);
  });

  it('indique l’absence de données', () => {
    const s = emptySnapshot();
    const ins = generateInsights(ctxOf(s), s, today, null, opts);
    expect(ins[0].kind).toBe('data');
  });
});
