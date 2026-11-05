// @vitest-environment jsdom
/**
 * Rendu réel des pages Dashboard, Prévisions (projection + simulateur) et Budgets selon le statut
 * de projection. Instantanés fictifs en mémoire, date système fixée ; aucune base n'est ouverte.
 * Règles :
 *  - Dashboard : jamais d'avertissement de statut de projection (ni minimum, ni no-data).
 *  - Prévisions / simulateur : 'minimum' → avertissement ; 'no-data' → état neutre ; 'complete' → rien.
 *  - Budgets : jamais de statut de complétude ; projection et verdict seulement si la projection est complète.
 *  - Dashboard : les alertes financières réelles (« Budget déjà dépassé ») sont conservées.
 */
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '@/app/AppContext';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Dialog';
import type { NexoraRepository } from '@/data/repository';
import { account, catByKey, emptySnapshot, tx, UID } from '@/test/fixtures';
import type { Budget, DataSnapshot, RecurringRule, Transaction } from '@/domain/types';
import { t } from '@/i18n/core';
import Dashboard from '@/pages/Dashboard';
import Forecast from '@/pages/Forecast';
import Budgets from '@/pages/Budgets';
import { projectionNotice } from './projectionNotice';
import { ProjectionNote } from './ProjectionNote';

const now = '2026-01-01T00:00:00.000Z';
const base = emptySnapshot();
const cat = (k: string) => catByKey(base.categories, k);
const spend = (k: string, amount: number, date: string): Transaction => tx({ accountId: 'acc', amount, date, categoryId: cat(k).id });
const income = (amount: number, date: string): Transaction => tx({ accountId: 'acc', type: 'income', direction: 'in', amount, date });
const globalBudget: Budget = { id: 'b-global', userId: UID, month: '2026-11', categoryId: null, amount: 300000, currency: 'MAD', createdAt: now, updatedAt: now };
const rent: RecurringRule = { id: 'rent', userId: UID, kind: 'expense', label: 'Loyer', amount: 280000, currency: 'MAD', accountId: 'acc', categoryId: null, frequency: 'monthly', startDate: '2026-01-25', active: true, createdAt: now, updatedAt: now };
/** Revenus d'août à octobre : mois complets pour le simulateur, sans aucune dépense. */
const pastIncome = ['2026-08-01', '2026-09-01', '2026-10-01'].map((d) => income(1000000, d));
/** Historique exploitable (≥ 30 jours, ≥ 10 dépenses variables). */
const history = Array.from({ length: 12 }, (_, k) => spend('food', 9000, `2026-${k % 2 ? '09' : '10'}-${String(3 + 2 * k).padStart(2, '0')}`));

const snap = (o: { txs?: Transaction[]; rules?: RecurringRule[]; budgets?: Budget[]; initial?: number } = {}): DataSnapshot =>
  emptySnapshot({ categories: base.categories, accounts: [account({ id: 'acc', initialBalance: o.initial ?? 0 })], transactions: o.txs ?? [], recurringRules: o.rules ?? [], budgets: o.budgets ?? [] });

const render = (Page: ComponentType, data: DataSnapshot) =>
  renderToStaticMarkup(
    // Mêmes fournisseurs que App.tsx (hors I18nProvider : français par défaut).
    createElement(MemoryRouter, null, createElement(TooltipProvider, null, createElement(ToastProvider, null, createElement(ConfirmProvider, null, createElement(AppProvider, { repo: {} as NexoraRepository, data, children: createElement(Page) }))))),
  );
const notices = (html: string) => [...html.matchAll(/data-projection-notice="([^"]+)"/g)].map((m) => m[1]);
const has = (html: string, text: string) => html.includes(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;'));

const SCENARIOS = {
  empty: snap(),
  emptyWithBalance: snap({ initial: 500000 }),
  incomeOnly: snap({ txs: [income(1000000, '2026-11-01')] }),
  oneExpense: snap({ txs: [spend('food', 15000, '2026-11-01')] }),
  knownBill: snap({ rules: [rent] }),
  insufficientHistory: snap({ txs: [spend('food', 10000, '2026-10-10'), spend('food', 10000, '2026-10-20')] }),
  compensated: snap({ txs: [spend('food', 20000, '2026-11-01'), tx({ accountId: 'acc', type: 'refund', direction: 'in', amount: 20000, date: '2026-11-02', categoryId: cat('food').id })] }),
  complete: snap({ txs: history }),
};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
});
afterAll(() => vi.useRealTimers());

describe('Dashboard — jamais d’avertissement de statut de projection', () => {
  for (const [name, data] of Object.entries(SCENARIOS)) {
    it(`${name} : aucun bandeau « Projection incomplète », aucune note minimum / no-data`, () => {
      const html = render(Dashboard, data);
      expect(html).toContain(t('dash.kpi.expenses')); // la page est bien rendue (synthèse)
      expect(html).not.toContain('Projection incomplète');
      expect(html).not.toContain('Détail dans Prévisions');
      expect(notices(html)).toEqual([]);
      expect(has(html, t('fc.minimumNote'))).toBe(false);
      expect(has(html, t('fc.noDataNote'))).toBe(false);
    });
  }
});

describe('Prévisions — projection', () => {
  const expected: Record<keyof typeof SCENARIOS, 'minimum' | 'no-data' | null> = {
    empty: 'no-data',
    emptyWithBalance: 'no-data',
    incomeOnly: 'no-data',
    oneExpense: 'minimum',
    knownBill: 'minimum',
    insufficientHistory: 'minimum',
    compensated: 'minimum',
    complete: null,
  };
  for (const [name, kind] of Object.entries(expected) as [keyof typeof SCENARIOS, 'minimum' | 'no-data' | null][]) {
    it(`${name} : ${kind ?? 'aucune note (projection complète)'}`, () => {
      const html = render(Forecast, SCENARIOS[name]);
      // Note de projection en premier ; le simulateur (s'il est affiché) porte la même nature de note.
      expect(notices(html)[0] ?? null).toBe(kind);
      expect(new Set(notices(html))).toEqual(new Set(kind ? [kind] : []));
      expect(has(html, t('fc.minimumNote'))).toBe(kind === 'minimum');
      expect(has(html, t('fc.noDataNote'))).toBe(kind === 'no-data');
    });
  }

  it('no-data : la note est neutre (pas de couleur d’avertissement) ; minimum : avertissement', () => {
    const neutral = render(Forecast, SCENARIOS.empty).match(/<p data-projection-notice="no-data" class="([^"]+)"/)![1];
    expect(neutral).not.toContain('warning');
    const warn = render(Forecast, SCENARIOS.oneExpense).match(/<p data-projection-notice="minimum" class="([^"]+)"/)![1];
    expect(warn).toContain('text-warning');
  });

  it('budget global sans donnée : « pas encore évaluable », état neutre, sans verdict ni avertissement minimum', () => {
    const html = render(Forecast, snap({ budgets: [globalBudget] }));
    expect(has(html, t('fc.budgetNoData'))).toBe(true);
    expect(has(html, t('fc.budgetOk'))).toBe(false);
    expect(has(html, t('fc.minimumNote'))).toBe(false);
  });

  it('non-régression : budget global avec une dépense (minimum) → « pas encore évaluable complètement » + note minimum', () => {
    const html = render(Forecast, snap({ budgets: [globalBudget], txs: [spend('food', 15000, '2026-11-01')] }));
    expect(has(html, t('fc.budgetNotAssessable'))).toBe(true);
    expect(has(html, t('fc.minimumNote'))).toBe(true);
  });
});

describe('Prévisions — simulateur', () => {
  it('compte neuf : état neutre existant (historique insuffisant), aucune note de projection dans le simulateur', () => {
    const html = render(Forecast, SCENARIOS.empty);
    expect(has(html, t('fc.insufficient.title'))).toBe(true);
    expect(has(html, t('fc.sim.noDataNote'))).toBe(false);
    expect(has(html, t('fc.sim.minimumNote'))).toBe(false);
  });

  it('simulateur affiché, aucune donnée de dépense : note neutre « pas encore assez de données »', () => {
    const html = render(Forecast, snap({ txs: pastIncome }));
    expect(has(html, t('fc.sim.noDataNote'))).toBe(true);
    expect(has(html, t('fc.sim.minimumNote'))).toBe(false);
  });

  it('simulateur affiché, projection minimum : avertissement sur le solde fin de mois', () => {
    const html = render(Forecast, snap({ txs: [...pastIncome, spend('food', 15000, '2026-11-01')] }));
    expect(has(html, t('fc.sim.minimumNote'))).toBe(true);
    expect(has(html, t('fc.sim.noDataNote'))).toBe(false);
  });

  it('simulateur affiché, projection complète : aucun avertissement', () => {
    const html = render(Forecast, snap({ txs: [...pastIncome, ...history] }));
    expect(has(html, t('fc.simulator'))).toBe(true);
    expect(has(html, t('fc.sim.minimumNote'))).toBe(false);
    expect(has(html, t('fc.sim.noDataNote'))).toBe(false);
  });
});

describe('Budgets — aucun statut de complétude de projection', () => {
  const foodBudget: Budget = { ...globalBudget, id: 'b-food', categoryId: cat('food').id, amount: 180000 };
  /** Textes qui exposeraient le statut minimum / no-data. */
  const FORBIDDEN = ['inimum', 'Données insuffisantes', 'projection complète', 'Pas encore assez de données', t('fc.minimumNote'), t('fc.noDataNote')];
  const withinVerdict = (html: string) => has(html, t('budget.withinBudget'));

  for (const [label, budgets] of [['budget global', [globalBudget]], ['budget par catégorie', [foodBudget]], ['global + catégorie', [globalBudget, foodBudget]]] as const) {
    for (const [name, data] of Object.entries(SCENARIOS)) {
      it(`${label} — ${name} : aucune mention de statut (minimum / no-data)`, () => {
        const html = render(Budgets, { ...data, budgets: [...budgets] });
        expect(html).toContain(t('budget.available')); // la carte de suivi est bien rendue
        expect(notices(html)).toEqual([]);
        for (const text of FORBIDDEN) expect(html).not.toContain(text);
      });
    }
  }

  for (const name of ['empty', 'emptyWithBalance', 'incomeOnly', 'oneExpense', 'knownBill', 'insufficientHistory', 'compensated'] as const) {
    it(`${name} (budget global) : ni projection ni verdict « dans le budget » dans la carte`, () => {
      const html = render(Budgets, { ...SCENARIOS[name], budgets: [globalBudget] });
      expect(has(html, t('budget.projection'))).toBe(false);
      expect(withinVerdict(html)).toBe(false);
    });
  }

  it('no-data : aucun verdict artificiel, ni dans Budgets ni « Dépenses sous contrôle » sur le Dashboard', () => {
    for (const budgets of [[globalBudget], [foodBudget]]) {
      const data = { ...SCENARIOS.incomeOnly, budgets };
      expect(withinVerdict(render(Budgets, data))).toBe(false);
      const dash = render(Dashboard, data);
      expect(has(dash, t('ins.paceOk.title'))).toBe(false);
      expect(has(dash, t('ins.paceMin.title'))).toBe(false);
    }
  });

  it('non-régression : projection complète → projection fin de mois et verdict (inchangés)', () => {
    const html = render(Budgets, snap({ budgets: [globalBudget], txs: history }));
    expect(has(html, t('budget.projection'))).toBe(true);
    expect(withinVerdict(html)).toBe(true);
  });

  it('non-régression : suivi budgétaire conservé (prévu, réalisé, reste, écart) avec une projection minimum', () => {
    const html = render(Budgets, snap({ budgets: [foodBudget], txs: [spend('food', 200000, '2026-11-01')] }));
    for (const k of ['budget.available', 'budget.reference', 'budget.remaining', 'budget.variance'] as const) expect(has(html, t(k))).toBe(true);
    expect(html).toContain('text-negative'); // dépassement réel visible (reste négatif)
  });
});

describe('Dashboard — alertes financières conservées', () => {
  const salary = [income(1000000, '2026-11-01')];
  it('dépassement réel déjà engagé (loyer connu > budget) : alerte « Budget déjà dépassé » affichée', () => {
    const html = render(Dashboard, snap({ budgets: [{ ...globalBudget, amount: 100000 }], rules: [rent], txs: salary }));
    expect(has(html, t('ins.paceMin.title'))).toBe(true);
    expect(notices(html)).toEqual([]);
    expect(html).not.toContain('Projection incomplète');
  });
  it('minimum sous le budget : aucune alerte (pas de dépassement réel)', () => {
    const html = render(Dashboard, snap({ budgets: [globalBudget], txs: [...salary, spend('food', 15000, '2026-11-01')] }));
    expect(has(html, t('ins.paceMin.title'))).toBe(false);
    expect(has(html, t('ins.paceOk.title'))).toBe(false);
  });
});

describe('Règle d’affichage par surface', () => {
  it('Dashboard : jamais, quel que soit le statut', () => {
    for (const s of ['complete', 'minimum', 'no-data', null] as const) expect(projectionNotice('dashboard', s)).toBeNull();
  });
  it('Budgets : jamais, quel que soit le statut', () => {
    for (const s of ['complete', 'minimum', 'no-data', null] as const) expect(projectionNotice('budgets', s)).toBeNull();
  });
  it('Projection, Simulation : minimum / no-data expliqués, complete silencieux', () => {
    for (const surface of ['projection', 'simulation'] as const) {
      expect(projectionNotice(surface, 'complete')).toBeNull();
      expect(projectionNotice(surface, null)).toBeNull();
      expect(projectionNotice(surface, 'minimum')).toBe('minimum');
      expect(projectionNotice(surface, 'no-data')).toBe('no-data');
    }
  });
  it('ProjectionNote : rien sans statut ; neutre pour no-data ; avertissement pour minimum', () => {
    const r = (kind: 'minimum' | 'no-data' | null) => renderToStaticMarkup(createElement(ProjectionNote, { kind, minimum: 'MIN', noData: 'NODATA' }));
    expect(r(null)).toBe('');
    expect(r('no-data')).toContain('NODATA');
    expect(r('no-data')).not.toContain('warning');
    expect(r('minimum')).toContain('MIN');
    expect(r('minimum')).toContain('text-warning');
  });
});
