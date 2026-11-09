/**
 * Decision Lab — situation initiale : périmètres de trésorerie et de patrimoine, comptes exclus,
 * absence de double comptabilisation, lecture seule. Données entièrement fictives.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, AssetValuation, DataSnapshot, Debt, SavingsGoal } from '@/domain/types';
import { account, ctxOf, emptySnapshot, tx, UID } from '@/test/fixtures';
import { computeNetWorth } from './networth';
import { buildInitialSituation, SituationPerimeterError } from './decisionSituation';
import { compareDecisions, referenceTrajectory } from './decision';

const TODAY = '2026-11-09';
const now = '2026-01-01T00:00:00.000Z';
const meta = (id: string) => ({ id, userId: UID, createdAt: now, updatedAt: now });

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** Snapshot couvrant chaque cas de périmètre. */
function fixture(over: Partial<DataSnapshot> = {}): DataSnapshot {
  const bank = account({ id: 'bank', name: 'Courant', initialBalance: 1_000_000 });
  const savings = account({ id: 'savings', name: 'Livret (hors totaux)', type: 'savings', initialBalance: 500_000, includeInTotal: false });
  const oldArchived = account({ id: 'archived', name: 'Ancien compte', initialBalance: 70_000, archived: true });
  const closedEmpty = account({ id: 'closed', name: 'Compte clos', initialBalance: 0, archived: true });
  const broker = account({ id: 'broker', name: 'Compte-titres', type: 'investment', initialBalance: 1_500_000 });
  const future = account({ id: 'future', name: 'Ouvert en décembre', initialBalance: 10_000, initialBalanceDate: '2026-12-01' });
  const usd = account({ id: 'usd', name: 'Compte USD', currency: 'USD', initialBalance: 100_000 });
  const assets: Asset[] = [
    { ...meta('portfolio'), name: 'Portefeuille', type: 'investment', currency: 'MAD', linkedAccountId: 'broker', archived: false },
    { ...meta('car'), name: 'Voiture', type: 'vehicle', currency: 'MAD', archived: false },
  ];
  const valuations: AssetValuation[] = [
    { id: 'v1', userId: UID, assetId: 'portfolio', date: '2026-10-31', value: 2_000_000, source: 'manual', createdAt: now },
    { id: 'v2', userId: UID, assetId: 'car', date: '2026-06-30', value: 9_000_000, source: 'manual', createdAt: now },
  ];
  const debts: Debt[] = [
    { ...meta('loan'), label: 'Crédit', type: 'loan', direction: 'payable', principal: 3_000_000, currency: 'MAD', startDate: '2026-02-01', status: 'active' },
    { ...meta('lent'), label: 'Prêt à un ami', type: 'lent', direction: 'receivable', principal: 100_000, currency: 'MAD', startDate: '2026-03-01', status: 'active' },
  ];
  const goals: SavingsGoal[] = [
    { ...meta('goal'), name: 'Vacances', targetAmount: 1_000_000, currency: 'MAD', savedAmount: 400_000, priority: 'medium', trackLinkedAccount: false, status: 'active', icon: 'plane', color: '#000' },
  ];
  return emptySnapshot({
    accounts: [bank, savings, oldArchived, closedEmpty, broker, future, usd],
    transactions: [
      tx({ accountId: 'bank', type: 'income', amount: 800_000, date: '2026-09-05' }),
      tx({ accountId: 'bank', type: 'expense', amount: 300_000, date: '2026-09-10' }),
      tx({ accountId: 'savings', type: 'income', amount: 20_000, date: '2026-10-15' }),
    ],
    assets,
    valuations,
    debts,
    goals,
    ...over,
  });
}

describe('situation initiale — périmètres', () => {
  const snap = deepFreeze(fixture());
  const before = JSON.stringify(snap);
  const s = buildInitialSituation(ctxOf(snap), snap, TODAY);

  it('lecture seule', () => {
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('trésorerie : comptes non archivés et inclus dans les totaux uniquement', () => {
    expect(s.perimeter.cashAccounts.map((a) => a.id)).toEqual(['bank', 'broker', 'future', 'usd']);
    // 1 500 000 (courant) + 1 500 000 (compte-titres, solde) + 10 000 (ouvert en décembre) ; USD sans taux exclu.
    expect(s.cash).toBe(3_010_000);
    expect(s.perimeter.cashAccounts.find((a) => a.id === 'usd')).toMatchObject({ balance: null, netWorthValue: null, difference: null });
    expect(s.unconverted).toBe(true);
  });

  it('comptes exclus documentés : motif et valeur comptée dans le patrimoine', () => {
    expect(s.perimeter.excludedAccounts).toEqual([
      { id: 'savings', name: 'Livret (hors totaux)', currency: 'MAD', reason: 'notInTotal', netWorthValue: 520_000 },
      { id: 'archived', name: 'Ancien compte', currency: 'MAD', reason: 'archived', netWorthValue: 70_000 },
      { id: 'closed', name: 'Compte clos', currency: 'MAD', reason: 'archived', netWorthValue: null },
    ]);
  });

  it('patrimoine : décomposition exacte, chaque élément compté une fois', () => {
    expect(s.netWorth).toBe(computeNetWorth(ctxOf(snap), snap, TODAY).netWorth);
    expect(s.perimeter.netWorth).toEqual({
      cashAccounts: 1_500_000 + 2_000_000, // compte-titres à sa valorisation, pas à son solde
      excludedAccounts: 520_000 + 70_000,
      standaloneAssets: 9_000_000,
      receivables: 100_000,
      liabilities: 3_000_000,
      total: 10_190_000,
    });
    expect(s.netWorth).toBe(10_190_000);
  });

  it('écarts trésorerie / patrimoine expliqués compte par compte', () => {
    const byId = Object.fromEntries(s.perimeter.cashAccounts.map((a) => [a.id, a]));
    expect(byId.bank).toMatchObject({ balance: 1_500_000, netWorthValue: 1_500_000, difference: null });
    expect(byId.broker).toMatchObject({ balance: 1_500_000, netWorthValue: 2_000_000, difference: 'valuation' });
    expect(byId.future).toMatchObject({ balance: 10_000, netWorthValue: null, difference: 'notYetOpened' });
    expect(s.perimeter.cashValuationDifference).toBe(500_000 - 10_000);
  });

  it('épargne de référence : opérations des seuls comptes de trésorerie', () => {
    expect(s.monthlySavings).toBe(500_000); // septembre, un seul mois avec données
    expect(s.baselineMonthsWithData).toBe(1);
    // Le revenu du livret hors totaux n'alimente pas la trésorerie de référence (information seulement).
    expect(s.monthlySavingsAllAccounts).toBe((500_000 + 20_000) / 2);
  });

  it('les objectifs d\'épargne (affectations) ne sont jamais ajoutés au patrimoine', () => {
    const withoutGoals = fixture({ goals: [] });
    expect(buildInitialSituation(ctxOf(withoutGoals), withoutGoals, TODAY).netWorth).toBe(s.netWorth);
  });

  it('projection : une décision ne recompte ni la trésorerie ni l\'actif déjà présents', () => {
    const cmp = compareDecisions(
      s,
      [
        { id: 'credit', decision: { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 } } },
        { id: 'goal', decision: { kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 0, months: 24 } },
      ],
      { horizonMonths: 24 },
    );
    const ref = referenceTrajectory(s, { horizonMonths: 24 });
    // Mois 0, achat : seule la perte des frais touche le patrimoine (bien = crédit + apport).
    expect(cmp.variants[0].trajectory[0].withDecision.netWorth).toBe(ref[0].netWorth - 150_000);
    expect(cmp.variants[0].trajectory[0].withDecision.cash).toBe(ref[0].cash - 3_150_000);
    // Objectif à 0 % : l'argent passe de la trésorerie au compte dédié, patrimoine inchangé.
    for (const p of cmp.variants[1].trajectory) expect(p.withDecision.netWorth).toBe(p.reference.netWorth);
    expect(cmp.variants[1].trajectory[24].withDecision.cash).toBe(ref[24].cash - 6_000_000);
  });
});

describe('situation initiale — garde-fous', () => {
  it('compte présent deux fois dans les données : erreur de double comptabilisation', () => {
    const snap = fixture();
    const dup = { ...snap, accounts: [...snap.accounts, snap.accounts[0]] };
    expect(() => buildInitialSituation(ctxOf(dup), dup, TODAY)).toThrow(SituationPerimeterError);
  });

  it('jeu de données vide : tout à zéro, aucun compte exclu', () => {
    const snap = emptySnapshot();
    const s = buildInitialSituation(ctxOf(snap), snap, TODAY);
    expect(s).toMatchObject({ cash: 0, netWorth: 0, monthlySavings: 0, baselineMonthsWithData: 0, unconverted: false });
    expect(s.perimeter.excludedAccounts).toEqual([]);
    expect(s.perimeter.netWorth.total).toBe(0);
  });
});
