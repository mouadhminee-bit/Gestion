import { describe, expect, it } from 'vitest';
import { account, catByKey, ctxOf, emptySnapshot, tx } from '@/test/fixtures';
import { accountBalance, dailyBalanceSeries, summarizePeriod, totalBalance } from './ledger';
import { monthPeriod } from '../dates';
import { convertMinor, findRate } from './fx';
import type { ExchangeRate } from '../types';

const MARCH = monthPeriod('2026-03');

function setup() {
  const s = emptySnapshot();
  const bank = account({ name: 'Banque', initialBalance: 500000, initialBalanceDate: '2026-03-01' });
  const savings = account({ name: 'Épargne', type: 'savings', initialBalance: 100000, initialBalanceDate: '2026-03-01' });
  s.accounts = [bank, savings];
  const food = catByKey(s.categories, 'food');
  const groceries = catByKey(s.categories, 'groceries');
  const salary = catByKey(s.categories, 'salary');
  const rent = catByKey(s.categories, 'rent');
  return { s, bank, savings, food, groceries, salary, rent };
}

describe('Revenus, dépenses, épargne, taux', () => {
  it('compte un revenu et une dépense', () => {
    const { s, bank, salary, food } = setup();
    s.transactions = [
      tx({ accountId: bank.id, type: 'income', amount: 1300000, categoryId: salary.id }),
      tx({ accountId: bank.id, type: 'expense', amount: 160000, categoryId: food.id }),
    ];
    const sum = summarizePeriod(ctxOf(s), s.transactions, MARCH);
    expect(sum.income).toBe(1300000);
    expect(sum.expenses).toBe(160000);
    expect(sum.netSavings).toBe(1140000);
    expect(sum.savingsRate).toBeCloseTo(1140000 / 1300000);
  });

  it('taux d’épargne non calculable si revenus nuls', () => {
    const { s, bank, food } = setup();
    s.transactions = [tx({ accountId: bank.id, type: 'expense', amount: 5000, categoryId: food.id })];
    const sum = summarizePeriod(ctxOf(s), s.transactions, MARCH);
    expect(sum.savingsRate).toBeNull();
    expect(sum.netSavings).toBe(-5000);
  });

  it('période sans données', () => {
    const { s } = setup();
    const sum = summarizePeriod(ctxOf(s), s.transactions, MARCH);
    expect(sum).toMatchObject({ income: 0, expenses: 0, netSavings: 0, savingsRate: null, transactionCount: 0 });
  });

  it('agrège les sous-catégories dans leur catégorie parente', () => {
    const { s, bank, food, groceries } = setup();
    s.transactions = [
      tx({ accountId: bank.id, amount: 1000, categoryId: food.id, subcategoryId: groceries.id }),
      tx({ accountId: bank.id, amount: 500, categoryId: food.id }),
    ];
    const sum = summarizePeriod(ctxOf(s), s.transactions, MARCH);
    expect(sum.expensesByCategory.get(food.id)?.amount).toBe(1500);
    expect(sum.expensesBySubcategory.get(groceries.id)?.amount).toBe(1000);
  });

  it('distingue charges fixes et variables', () => {
    const { s, bank, food, rent } = setup();
    s.transactions = [tx({ accountId: bank.id, amount: 280000, categoryId: rent.id }), tx({ accountId: bank.id, amount: 1000, categoryId: food.id })];
    const sum = summarizePeriod(ctxOf(s), s.transactions, MARCH);
    expect(sum.fixedExpenses).toBe(280000);
    expect(sum.variableExpenses).toBe(1000);
  });

  it('filtre par période (bornes incluses)', () => {
    const { s, bank, food } = setup();
    s.transactions = [
      tx({ accountId: bank.id, amount: 100, date: '2026-02-28', categoryId: food.id }),
      tx({ accountId: bank.id, amount: 200, date: '2026-03-01', categoryId: food.id }),
      tx({ accountId: bank.id, amount: 300, date: '2026-03-31', categoryId: food.id }),
      tx({ accountId: bank.id, amount: 400, date: '2026-04-01', categoryId: food.id }),
    ];
    expect(summarizePeriod(ctxOf(s), s.transactions, MARCH).expenses).toBe(500);
  });
});

describe('Transferts', () => {
  it('modifient les deux comptes sans créer ni revenu ni dépense', () => {
    const { s, bank, savings } = setup();
    s.transactions = [
      tx({ accountId: bank.id, type: 'transfer', direction: 'out', amount: 200000, transferId: 'T1', counterpartAccountId: savings.id }),
      tx({ accountId: savings.id, type: 'transfer', direction: 'in', amount: 200000, transferId: 'T1', counterpartAccountId: bank.id }),
    ];
    const ctx = ctxOf(s);
    const sum = summarizePeriod(ctx, s.transactions, MARCH);
    expect(sum.income).toBe(0);
    expect(sum.expenses).toBe(0);
    expect(sum.netSavings).toBe(0);
    expect(sum.transfers).toBe(200000);
    expect(accountBalance(bank, s.transactions)).toBe(300000);
    expect(accountBalance(savings, s.transactions)).toBe(300000);
    // Le solde total est inchangé.
    expect(totalBalance(ctx, s.accounts, s.transactions, '2026-03-31').total).toBe(600000);
  });
});

describe('Remboursements, ajustements, dettes', () => {
  it('un remboursement reçu réduit la dépense de sa catégorie, une seule fois', () => {
    const { s, bank, food } = setup();
    s.transactions = [
      tx({ accountId: bank.id, type: 'expense', amount: 120000, categoryId: food.id }),
      tx({ accountId: bank.id, type: 'refund', direction: 'in', amount: 84000, categoryId: food.id }),
    ];
    const sum = summarizePeriod(ctxOf(s), s.transactions, MARCH);
    expect(sum.income).toBe(0);
    expect(sum.grossExpenses).toBe(120000);
    expect(sum.refunds).toBe(84000);
    expect(sum.expenses).toBe(36000);
    expect(sum.expensesByCategory.get(food.id)?.amount).toBe(36000);
    expect(accountBalance(bank, s.transactions)).toBe(500000 - 120000 + 84000);
  });

  it('un ajustement modifie le solde mais pas les revenus/dépenses', () => {
    const { s, bank } = setup();
    s.transactions = [tx({ accountId: bank.id, type: 'adjustment', direction: 'out', amount: 3500, notes: 'écart' })];
    const sum = summarizePeriod(ctxOf(s), s.transactions, MARCH);
    expect(sum.expenses).toBe(0);
    expect(accountBalance(bank, s.transactions)).toBe(496500);
  });

  it('seuls les intérêts d’une échéance de crédit sont une dépense', () => {
    const { s, bank } = setup();
    s.transactions = [tx({ accountId: bank.id, type: 'debt', direction: 'out', amount: 145000, interestAmount: 25000, debtId: 'D1' })];
    const sum = summarizePeriod(ctxOf(s), s.transactions, MARCH);
    expect(sum.expenses).toBe(25000);
    expect(accountBalance(bank, s.transactions)).toBe(355000);
  });

  it('un emprunt reçu n’est pas un revenu', () => {
    const { s, bank } = setup();
    s.transactions = [tx({ accountId: bank.id, type: 'debt', direction: 'in', amount: 1000000, interestAmount: 0, debtId: 'D1' })];
    expect(summarizePeriod(ctxOf(s), s.transactions, MARCH).income).toBe(0);
  });
});

describe('Soldes de comptes', () => {
  it('solde = solde initial + mouvements depuis la date d’ancrage', () => {
    const { s, bank, food, salary } = setup();
    s.transactions = [
      tx({ accountId: bank.id, type: 'income', amount: 1000000, categoryId: salary.id, date: '2026-03-02' }),
      tx({ accountId: bank.id, amount: 20000, categoryId: food.id, date: '2026-03-05' }),
    ];
    expect(accountBalance(bank, s.transactions)).toBe(1480000);
    expect(accountBalance(bank, s.transactions, '2026-03-03')).toBe(1500000);
  });

  it('les mouvements antérieurs au solde initial n’affectent pas le solde courant', () => {
    const { s, bank, food } = setup();
    s.transactions = [tx({ accountId: bank.id, amount: 20000, categoryId: food.id, date: '2026-02-20' })];
    expect(accountBalance(bank, s.transactions)).toBe(500000);
    // ...mais permettent de reconstituer le solde passé.
    expect(accountBalance(bank, s.transactions, '2026-02-10')).toBe(520000);
  });

  it('série quotidienne cohérente avec les soldes', () => {
    const { s, bank, savings, food } = setup();
    s.transactions = [tx({ accountId: bank.id, amount: 20000, categoryId: food.id, date: '2026-03-05' })];
    const series = dailyBalanceSeries(ctxOf(s), s.accounts, s.transactions, MARCH);
    expect(series).toHaveLength(31);
    expect(series[3].balance).toBe(600000);
    expect(series[4].balance).toBe(580000);
    expect(series[30].balance).toBe(accountBalance(bank, s.transactions) + accountBalance(savings, s.transactions));
  });
});

describe('Multidevises', () => {
  const rates: ExchangeRate[] = [
    { id: 'r1', userId: 'u', base: 'EUR', quote: 'MAD', rate: 10.86, date: '2026-01-01', source: 'manual', createdAt: '' },
    { id: 'r2', userId: 'u', base: 'EUR', quote: 'MAD', rate: 11, date: '2026-03-15', source: 'manual', createdAt: '' },
  ];

  it('utilise le dernier taux daté ≤ date de valorisation', () => {
    expect(findRate(rates, 'EUR', 'MAD', '2026-03-10')?.rate).toBe(10.86);
    expect(findRate(rates, 'EUR', 'MAD', '2026-03-20')?.rate).toBe(11);
    expect(findRate(rates, 'EUR', 'MAD', '2025-12-31')).toBeNull();
  });

  it('inverse un taux si nécessaire et ajuste les décimales', () => {
    expect(convertMinor(10000, 'EUR', 'MAD', '2026-03-20', rates)).toBe(110000);
    expect(convertMinor(110000, 'MAD', 'EUR', '2026-03-20', rates)).toBe(10000);
    expect(convertMinor(10000, 'EUR', 'JPY', '2026-03-20', rates)).toBeNull();
  });

  it('n’additionne pas des devises sans taux : montants séparés', () => {
    const s = emptySnapshot();
    const mad = account({ initialBalance: 100000 });
    const usd = account({ currency: 'USD', initialBalance: 5000 });
    s.accounts = [mad, usd];
    const total = totalBalance(ctxOf(s), s.accounts, [], '2026-03-31');
    expect(total.total).toBe(100000);
    expect(total.unconverted).toEqual({ USD: 5000 });
  });

  it('convertit les soldes avec un taux identifié', () => {
    const s = emptySnapshot({ rates });
    const mad = account({ initialBalance: 100000 });
    const eur = account({ currency: 'EUR', initialBalance: 5000 });
    s.accounts = [mad, eur];
    const total = totalBalance(ctxOf(s), s.accounts, [], '2026-03-31');
    expect(total.total).toBe(100000 + 55000);
    expect(total.unconverted).toEqual({});
  });
});
