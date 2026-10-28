import type { Account, Category, DataSnapshot, Transaction } from '@/domain/types';
import { buildSeedCategories } from '@/domain/categories.seed';
import { defaultSettings } from '@/domain/settings';
import { buildContext } from '@/domain/calc/ledger';

export const UID = 'user-test';
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;
const now = '2026-01-01T00:00:00.000Z';

export function account(partial: Partial<Account> = {}): Account {
  return {
    id: id('acc'),
    userId: UID,
    name: 'Compte',
    type: 'bank',
    currency: 'MAD',
    initialBalance: 0,
    initialBalanceDate: '2026-01-01',
    archived: false,
    includeInTotal: true,
    color: '#5271FF',
    order: 0,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function tx(partial: Partial<Transaction> & Pick<Transaction, 'accountId'>): Transaction {
  const type = partial.type ?? 'expense';
  return {
    id: id('tx'),
    userId: UID,
    type,
    direction: type === 'expense' ? 'out' : 'in',
    amount: 10000,
    currency: 'MAD',
    label: 'Opération',
    date: '2026-03-10',
    categoryId: null,
    subcategoryId: null,
    tags: [],
    status: 'cleared',
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function emptySnapshot(over: Partial<DataSnapshot> = {}): DataSnapshot {
  return {
    settings: defaultSettings(UID, { onboarded: true }),
    accounts: [],
    categories: buildSeedCategories(UID),
    transactions: [],
    budgets: [],
    goals: [],
    goalContributions: [],
    recurringRules: [],
    occurrences: [],
    debts: [],
    debtPayments: [],
    assets: [],
    valuations: [],
    rates: [],
    notificationStates: [],
    ...over,
  };
}

export function catByKey(categories: Category[], key: string): Category {
  const c = categories.find((x) => x.key === key);
  if (!c) throw new Error(key);
  return c;
}

export function ctxOf(s: DataSnapshot) {
  return buildContext(s);
}
