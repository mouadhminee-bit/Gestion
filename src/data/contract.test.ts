/**
 * Tests de conformité du contrat `NexoraRepository` (Lot 2).
 *
 * Vérifie, sur fake-indexeddb uniquement (aucune base réelle) :
 *  1. la surface de l'API (54 méthodes, signatures identiques) ;
 *  2. le schéma Dexie inchangé ;
 *  3. l'équivalence fonctionnelle LocalRepository ↔ CloudRepository (MemoryTransport) ;
 *  4. le refus par défaut des écritures cloud (DisabledTransport) ;
 *  5. les échecs de transport et les erreurs métier : rien n'est écrit ;
 *  6. l'atomicité des opérations composées (Dexie et cloud) ;
 *  7. la correction d'atomicité (addGoalContribution, addDebtPayment, updateDebt) ;
 *  8. l'isolation entre utilisateurs ;
 *  9. la protection de la base `nexora` et du nommage `nexora-cache-<uid>`.
 */
import { describe, expect, it, vi } from 'vitest';

// Identifiants et horodatages déterministes : les deux repositories doivent produire
// exactement les mêmes données à partir du même scénario.
const ids = vi.hoisted(() => ({ n: 0, t: 0 }));
vi.mock('@/lib/id', () => ({
  newId: () => `00000000-0000-4000-8000-${String(++ids.n).padStart(12, '0')}`,
  nowISO: () => new Date(Date.UTC(2026, 9, 31, 12, 0, 0) + ++ids.t * 1000).toISOString(),
}));
const resetIds = () => {
  ids.n = 0;
  ids.t = 0;
};

import { NexoraDB, USER_TABLES as DB_USER_TABLES, SCHEMA_VERSION as DB_SCHEMA_VERSION } from './db';
import { LocalRepository, ValidationError } from './repository';
import { RepositoryCore } from './RepositoryCore';
import { REPOSITORY_METHODS, type NexoraRepository } from './contracts';
import { ALL_TABLES, PRIMARY_KEYS, SCHEMA_VERSION, USER_TABLES, type TableName } from './tables';
import { CloudRepository } from './cloud/CloudRepository';
import { CLOUD_CACHE_PREFIX, ConstraintError, cloudCacheName } from './cloud/CloudStorage';
import { CloudTransportError, CloudWriteDisabledError, DisabledTransport } from './cloud/transport';
import { IsolationViolationError, MemoryTransport } from './cloud/MemoryTransport';
import { generateDemoData } from './demo';
import type { Account, Category, DataSnapshot } from '@/domain/types';
import type { TransactionDraft } from '@/domain/validation';
import type { StoragePort } from './storage';

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

let seq = 0;
const uid = () => `user_${++seq}`;

function local(userId: string) {
  const db = new NexoraDB(`contract-local-${userId}`);
  return { repo: new LocalRepository(db, userId), db };
}

function cloud(userId: string, transport = new MemoryTransport()) {
  const cache = new NexoraDB(cloudCacheName(userId));
  return { repo: new CloudRepository(userId, { transport, cache }), cache, transport };
}

/** Toutes les lignes de toutes les tables d'une base (comparaison exhaustive). */
async function dump(db: NexoraDB): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of ALL_TABLES) {
    const rows = await db.table(t).toArray();
    out[t] = t === 'attachments' ? rows.map((a) => ({ ...a, blob: { size: a.blob?.size, type: a.blob?.type } })) : rows;
  }
  return out;
}

const store = (repo: NexoraRepository) => Reflect.get(repo, 'store') as StoragePort;

const draft = (accountId: string, p: Partial<TransactionDraft> = {}): TransactionDraft => ({
  type: 'expense',
  amount: 10000,
  label: 'Test',
  date: '2026-03-10',
  categoryId: null,
  subcategoryId: null,
  accountId,
  tags: [],
  status: 'cleared',
  ...p,
});

const account = (name: string, currency = 'MAD', initialBalance = 500000): Omit<Account, 'id' | 'userId' | 'createdAt' | 'updatedAt'> => ({
  name,
  type: 'bank',
  currency,
  initialBalance,
  initialBalanceDate: '2026-03-01',
  archived: false,
  includeInTotal: true,
  color: '#fff',
  order: 0,
});

async function seeded(repo: NexoraRepository) {
  await repo.ensureUser('Test');
  const bank = await repo.createAccount(account('Banque'));
  const savings = await repo.createAccount({ ...account('Épargne', 'MAD', 0), type: 'savings', order: 1 });
  const cats = (await repo.snapshot())!.categories;
  const cat = (key: string) => cats.find((c) => c.key === key)!;
  return { bank, savings, cat };
}

// ---------------------------------------------------------------------------
// Scénario complet : les 54 méthodes, cas nominaux et cas d'erreur
// ---------------------------------------------------------------------------

type Log = unknown[];

async function scenario(repo: NexoraRepository): Promise<{ log: Log; checkpoints: (DataSnapshot | null)[]; called: Set<string> }> {
  const called = new Set<string>();
  const r = new Proxy(repo, {
    get(obj, prop) {
      const v = Reflect.get(obj, prop);
      if (typeof v === 'function' && typeof prop === 'string') {
        called.add(prop);
        return v.bind(obj);
      }
      return v;
    },
  }) as NexoraRepository;
  const log: Log = [];
  const checkpoints: (DataSnapshot | null)[] = [];
  const rec = async (label: string, p: Promise<unknown>) => {
    try {
      log.push([label, await p]);
    } catch (e) {
      log.push([label, 'ERROR', (e as Error).name, (e as Error).message]);
    }
  };
  const snap = async () => checkpoints.push(await r.snapshot());

  // Initialisation, paramètres
  await rec('getSettings-empty', r.getSettings());
  await snap();
  await rec('ensureUser', r.ensureUser('Test'));
  await rec('ensureUser-again', r.ensureUser('Autre'));
  await rec('updateSettings', r.updateSettings({ displayName: 'Sara', privacyMode: true }));
  await rec('getSettings', r.getSettings());

  // Comptes
  const bank = (await r.createAccount(account('Banque'))) as Account;
  const savings = await r.createAccount({ ...account('Épargne', 'MAD', 0), type: 'savings', order: 1 });
  const eur = await r.createAccount(account('Euros', 'EUR', 10000));
  const spare = await r.createAccount(account('Inutilisé'));
  log.push(['accounts', bank, savings, eur, spare]);
  await rec('createAccount-invalid', r.createAccount({ ...account(''), initialBalance: 1.5 }));
  await rec('updateAccount', r.updateAccount(bank.id, { name: 'Banque principale', color: '#000' }));
  await rec('updateAccount-invalid', r.updateAccount(bank.id, { name: ' ' }));
  await rec('archiveAccount', r.archiveAccount(spare.id));
  await rec('archiveAccount-restore', r.archiveAccount(spare.id, false));
  await rec('deleteAccount-unused', r.deleteAccount(spare.id));
  await rec('deleteAccount-missing', r.deleteAccount('nope'));

  // Catégories
  const cats = (await r.snapshot())!.categories;
  const cat = (key: string) => cats.find((c) => c.key === key)! as Category;
  const sub = await r.createCategory({ name: 'Marché', kind: 'expense', parentId: cat('food').id, icon: 'X', color: '#123', archived: false, order: 99 });
  log.push(['sub', sub]);
  await rec('createCategory-empty', r.createCategory({ name: ' ', kind: 'expense', parentId: null, icon: 'X', color: '#123', archived: false, order: 1 }));
  await rec('createCategory-nested', r.createCategory({ name: 'Trop', kind: 'expense', parentId: sub.id, icon: 'X', color: '#123', archived: false, order: 1 }));
  await rec('updateCategory-propagate', r.updateCategory(cat('food').id, { nature: 'fixed' }));
  await rec('reorderCategories', r.reorderCategories([cat('rent').id, cat('food').id]));
  const temp = await r.createCategory({ name: 'Temporaire', kind: 'income', parentId: null, icon: 'X', color: '#123', archived: false, order: 5 });
  await rec('deleteCategory-unused', r.deleteCategory(temp.id));
  await snap();

  // Transactions
  const [exp] = await r.createTransaction(draft(bank.id, { categoryId: cat('food').id, subcategoryId: sub.id, tags: ['a', 'a', ' b '] }));
  const [inc] = await r.createTransaction(draft(bank.id, { type: 'income', amount: 900000, categoryId: cat('salary').id, label: 'Salaire' }));
  const legs = await r.createTransaction(draft(bank.id, { type: 'transfer', amount: 50000, toAccountId: savings.id, label: '' }));
  const fx = await r.createTransaction(draft(bank.id, { type: 'transfer', amount: 110000, toAccountId: eur.id, toAmount: 10000, label: 'Change' }));
  const [refund] = await r.createTransaction(draft(bank.id, { type: 'refund', amount: 2000, categoryId: cat('food').id, refundOfId: exp.id }));
  log.push(['tx', exp, inc, legs, fx, refund]);
  await rec('createTransaction-invalid', r.createTransaction(draft(bank.id, { amount: null })));
  await rec('createTransaction-sameAccount', r.createTransaction(draft(bank.id, { type: 'transfer', toAccountId: bank.id })));
  await rec('categoryUsage', r.categoryUsage(cat('food').id));
  await rec('deleteCategory-used', r.deleteCategory(cat('food').id));
  await rec('deleteAccount-history', r.deleteAccount(bank.id));
  await rec('updateAccount-currencyLocked', r.updateAccount(bank.id, { currency: 'EUR' }));
  await rec('getTransactionGroup', r.getTransactionGroup(legs[1].id));
  await rec('updateTransaction-transfer', r.updateTransaction(legs[0].id, draft(bank.id, { type: 'transfer', amount: 60000, toAccountId: savings.id, label: 'Épargne' })));
  await rec('updateTransaction-toExpense', r.updateTransaction(fx[0].id, draft(bank.id, { amount: 3000, categoryId: cat('food').id })));
  await rec('updateTransaction-invalid', r.updateTransaction(exp.id, draft(bank.id, { date: 'x' })));
  await rec('recategorize', r.recategorize([exp.id, inc.id, refund.id], sub.id));
  await rec('addAttachment', r.addAttachment(exp.id, new File(['abc'], 'recu.png', { type: 'image/png' })));
  await rec('addAttachment-replace', r.addAttachment(exp.id, new File(['abcd'], 'recu2.pdf', { type: 'application/pdf' })));
  await rec('addAttachment-format', r.addAttachment(exp.id, new File(['x'], 'a.exe', { type: 'application/x-msdownload' })));
  const withAtt = (await r.snapshot())!.transactions.find((t) => t.id === exp.id)!;
  const att = await r.getAttachment(withAtt.attachmentId!);
  log.push(['getAttachment', att && { ...att, blob: { size: att.blob.size, type: att.blob.type } }]);
  await rec('getAttachment-missing', r.getAttachment('nope'));
  await rec('removeAttachment', r.removeAttachment(exp.id));
  await rec('removeAttachment-none', r.removeAttachment(exp.id));
  await rec(
    'importTransactions',
    r.importTransactions({ fileName: 'releve.csv', rowCount: 2, importedCount: 2, skippedCount: 0, accountId: bank.id }, [
      draft(bank.id, { label: 'Import 1', categoryId: cat('food').id }),
      draft(bank.id, { type: 'income', label: 'Import 2', amount: 5000, categoryId: cat('salary').id }),
    ]),
  );
  await rec('importTransactions-invalid', r.importTransactions({ fileName: 'x.csv', rowCount: 1, importedCount: 1, skippedCount: 0, accountId: bank.id }, [draft(bank.id, { amount: -1 })]));
  await snap();

  // Budgets
  await rec('setBudget-global', r.setBudget('2026-03', null, 900000, 'MAD'));
  await rec('setBudget-cat', r.setBudget('2026-03', cat('food').id, 160000, 'MAD', { alertThresholds: [80], applyToFollowingMonths: 2 }));
  await rec('setBudget-update', r.setBudget('2026-03', cat('food').id, 170000, 'MAD'));
  await rec('setBudget-invalid', r.setBudget('2026-03', null, -1, 'MAD'));
  await rec('copyBudgets', r.copyBudgets('2026-03', '2026-04'));
  await rec('copyBudgets-overwrite', r.copyBudgets('2026-03', '2026-04', true));
  const budget = (await r.snapshot())!.budgets.find((b) => b.month === '2026-05')!;
  await rec('deleteBudget', r.deleteBudget(budget.id));

  // Objectifs
  const goal = await r.saveGoal({ name: 'Voyage', targetAmount: 100000, currency: 'MAD', savedAmount: 0, priority: 'medium', trackLinkedAccount: false, status: 'active', icon: 'Plane', color: '#fff' });
  await rec('saveGoal-update', r.saveGoal({ ...goal, name: 'Voyage Japon' }));
  await rec('saveGoal-invalid', r.saveGoal({ ...goal, id: undefined, targetAmount: 0 }));
  await rec('addGoalContribution', r.addGoalContribution(goal.id, 100000, '2026-03-10', 'note'));
  await rec('addGoalContribution-withdraw', r.addGoalContribution(goal.id, -30000, '2026-03-11'));
  await rec('addGoalContribution-tooHigh', r.addGoalContribution(goal.id, -900000, '2026-03-12'));
  await rec('addGoalContribution-missing', r.addGoalContribution('nope', 100, '2026-03-12'));
  const goal2 = await r.saveGoal({ name: 'À supprimer', targetAmount: 1000, currency: 'MAD', savedAmount: 0, priority: 'low', trackLinkedAccount: false, status: 'active', icon: 'X', color: '#fff' });
  await r.addGoalContribution(goal2.id, 100, '2026-03-10');
  await rec('deleteGoal', r.deleteGoal(goal2.id));
  await snap();

  // Récurrences
  const rule = await r.saveRecurringRule({ kind: 'expense', label: 'Loyer', amount: 280000, currency: 'MAD', accountId: bank.id, categoryId: cat('rent').id, frequency: 'monthly', startDate: '2026-03-03', active: true });
  await rec('saveRecurringRule-update', r.saveRecurringRule({ ...rule, label: 'Loyer appartement' }));
  await rec('saveRecurringRule-invalid', r.saveRecurringRule({ ...rule, id: undefined, accountId: 'nope', amount: 0 }));
  await rec('markOccurrencePaid-partial', r.markOccurrencePaid(rule.id, '2026-03-03', { date: '2026-03-04', amount: 200000, accountId: bank.id }));
  const [part] = await r.createTransaction(draft(bank.id, { amount: 80000, categoryId: cat('rent').id, label: 'Reliquat' }));
  await rec('linkOccurrence', r.linkOccurrence(rule.id, '2026-03-03', part.id));
  await rec('markOccurrencePaid-already', r.markOccurrencePaid(rule.id, '2026-03-03', { date: '2026-03-04', amount: 1, accountId: bank.id }));
  await rec('linkOccurrence-wrongType', r.linkOccurrence(rule.id, '2026-04-03', inc.id));
  await rec('linkOccurrence-alreadyLinked', r.linkOccurrence(rule.id, '2026-04-03', part.id));
  await rec('unlinkTransaction', r.unlinkTransaction(part.id));
  await rec('unlinkTransaction-notLinked', r.unlinkTransaction(part.id));
  await rec('settleOccurrence', r.settleOccurrence(rule.id, '2026-03-03'));
  await rec('settleOccurrence-noPayment', r.settleOccurrence(rule.id, '2026-05-03'));
  await rec('reopenOccurrence', r.reopenOccurrence(rule.id, '2026-03-03'));
  await rec('skipOccurrence', r.skipOccurrence(rule.id, '2026-04-03'));
  await rec('linkOccurrence-unskip', r.linkOccurrence(rule.id, '2026-04-03', part.id));
  await rec('resetOccurrence', r.resetOccurrence(rule.id, '2026-03-03', true));
  await rec('resetOccurrence-other', r.resetOccurrence(rule.id, '2026-04-03', false));
  const rule2 = await r.saveRecurringRule({ kind: 'income', label: 'Prime', amount: 1000, currency: 'MAD', accountId: bank.id, categoryId: null, frequency: 'custom', customInterval: 2, customUnit: 'week', startDate: '2026-03-01', active: true });
  await r.skipOccurrence(rule2.id, '2026-03-01');
  await rec('deleteRecurringRule', r.deleteRecurringRule(rule2.id));
  await snap();

  // Dettes
  const debt = await r.createDebt({ label: 'Crédit', type: 'loan', direction: 'payable', principal: 1000000, currency: 'MAD', startDate: '2026-03-01', status: 'active' }, { accountId: bank.id, date: '2026-03-01' });
  await rec('createDebt-invalid', r.createDebt({ label: '', type: 'loan', direction: 'payable', principal: 0, currency: 'MAD', startDate: 'x', status: 'active' }));
  await rec('createDebt-currency', r.createDebt({ label: 'EUR', type: 'lent', direction: 'receivable', principal: 100, currency: 'MAD', startDate: '2026-03-01', status: 'active' }, { accountId: eur.id, date: '2026-03-01' }));
  await rec('updateDebt', r.updateDebt(debt.id, { counterparty: 'Banque X' }));
  const pay = await r.addDebtPayment(debt.id, { date: '2026-03-15', principal: 100000, interest: 5000, accountId: bank.id, note: 'Échéance' });
  log.push(['pay', pay]);
  await rec('addDebtPayment-noAccount', r.addDebtPayment(debt.id, { date: '2026-03-16', principal: 50000, interest: 0 }));
  await rec('addDebtPayment-tooHigh', r.addDebtPayment(debt.id, { date: '2026-03-16', principal: 2000000, interest: 0 }));
  await rec('addDebtPayment-badDate', r.addDebtPayment(debt.id, { date: 'x', principal: 1, interest: 0 }));
  await rec('addDebtPayment-currency', r.addDebtPayment(debt.id, { date: '2026-03-16', principal: 1, interest: 0, accountId: eur.id }));
  await rec('updateDebt-belowRepaid', r.updateDebt(debt.id, { principal: 100 }));
  await rec('addDebtPayment-settle', r.addDebtPayment(debt.id, { date: '2026-03-20', principal: 850000, interest: 0 }));
  await rec('deleteDebtPayment', r.deleteDebtPayment(pay.id));
  const small = await r.createDebt({ label: 'Prêt ami', type: 'lent', direction: 'receivable', principal: 5000, currency: 'MAD', startDate: '2026-03-01', status: 'active' }, { accountId: bank.id, date: '2026-03-02' });
  await r.addDebtPayment(small.id, { date: '2026-03-05', principal: 1000, interest: 0, accountId: bank.id });
  await rec('deleteDebt', r.deleteDebt(small.id));
  await snap();

  // Patrimoine et taux
  const asset = await r.saveAsset({ name: 'Portefeuille', type: 'investment', currency: 'MAD', linkedAccountId: savings.id, archived: false }, { date: '2026-03-01', value: 70000 });
  await rec('saveAsset-update', r.saveAsset({ ...asset, notes: 'PEA' }));
  await rec('saveAsset-duplicate', r.saveAsset({ name: 'Doublon', type: 'investment', currency: 'MAD', linkedAccountId: savings.id, archived: false }));
  await rec('saveAsset-invalid', r.saveAsset({ name: '', type: 'other', currency: 'MAD', archived: false }));
  await rec('addValuation', r.addValuation(asset.id, '2026-03-20', 72000, 'hausse'));
  await rec('addValuation-invalid', r.addValuation(asset.id, '2026-03-20', -1));
  const val = (await r.snapshot())!.valuations.find((v) => v.value === 72000)!;
  await rec('deleteValuation', r.deleteValuation(val.id));
  const car = await r.saveAsset({ name: 'Voiture', type: 'vehicle', currency: 'MAD', archived: false }, { date: '2026-03-01', value: 9000000 });
  await rec('deleteAsset', r.deleteAsset(car.id));
  await rec('saveRate', r.saveRate('EUR', 'MAD', 10.9, '2026-03-01'));
  await rec('saveRate-same', r.saveRate('EUR', 'EUR', 1, '2026-03-01'));
  await rec('saveRate-invalid', r.saveRate('EUR', 'MAD', 0, '2026-03-01'));
  await r.saveRate('USD', 'MAD', 9.9, '2026-03-01');
  const usd = (await r.snapshot())!.rates.find((x) => x.base === 'USD')!;
  await rec('deleteRate', r.deleteRate(usd.id));

  // Notifications
  await rec('setNotificationState', r.setNotificationState(['budget:x:2026-03:90', 'bill:y'], { read: true }));
  await rec('setNotificationState-merge', r.setNotificationState(['bill:y'], { dismissed: true }));

  // Suppressions en cascade
  await rec('deleteTransactions', r.deleteTransactions([legs[1].id, exp.id, 'nope']));
  await snap();

  // Sauvegarde / restauration / démo / réinitialisation
  const backup = await r.exportBackup();
  log.push(['exportBackup', backup]);
  await rec('restoreBackup-invalid', r.restoreBackup({ app: 'other' } as never));
  await rec('restoreBackup-newer', r.restoreBackup({ ...backup, schemaVersion: 99 }));
  await rec('clearUserData', r.clearUserData());
  await snap();
  await rec('restoreBackup', r.restoreBackup(backup));
  await snap();
  await rec('replaceWithSnapshot', r.replaceWithSnapshot(generateDemoData(repo.userId, '2026-03-20')));
  await snap();
  await rec('resetToEmpty', r.resetToEmpty({ displayName: 'Sara', theme: 'light', onboarded: true }));
  await snap();
  return { log, checkpoints, called };
}

// ---------------------------------------------------------------------------
// 1. Surface de l'API
// ---------------------------------------------------------------------------

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type M = (typeof REPOSITORY_METHODS)[number];
type LocalMismatch = { [K in M]: Equals<LocalRepository[K], NexoraRepository[K]> extends true ? never : K }[M];
type CloudMismatch = { [K in M]: Equals<CloudRepository[K], NexoraRepository[K]> extends true ? never : K }[M];
// Erreur de compilation (npm run typecheck) si une signature diverge du contrat.
const _local: [LocalMismatch] extends [never] ? true : LocalMismatch = true;
const _cloud: [CloudMismatch] extends [never] ? true : CloudMismatch = true;

const PRIVATE_HELPERS = ['constructor', 't', 'stamp', 'own', 'assertAccount', 'validationContext', 'buildFromDraft', 'linkedTransactions', 'dropPaidStateIfOrphan'];

describe('contrat : surface de l’API', () => {
  it('54 méthodes, uniques, identiques sur RepositoryCore, LocalRepository et CloudRepository', () => {
    expect(_local && _cloud).toBe(true);
    expect(REPOSITORY_METHODS).toHaveLength(54);
    expect(new Set(REPOSITORY_METHODS).size).toBe(54);
    const proto = Object.getOwnPropertyNames(RepositoryCore.prototype).filter((n) => !PRIVATE_HELPERS.includes(n));
    expect(proto.sort()).toEqual([...REPOSITORY_METHODS].sort());
    // LocalRepository et CloudRepository n'ajoutent ni ne redéfinissent aucune méthode métier.
    expect(Object.getOwnPropertyNames(LocalRepository.prototype)).toEqual(['constructor']);
    expect(Object.getOwnPropertyNames(CloudRepository.prototype)).toEqual(['constructor']);
    const l = local(uid()).repo;
    const c = cloud(uid()).repo;
    for (const m of REPOSITORY_METHODS) {
      expect(typeof l[m], m).toBe('function');
      expect(typeof c[m], m).toBe('function');
      expect(l[m].length, `${m} : nombre de paramètres`).toBe(RepositoryCore.prototype[m].length);
    }
  });

  it('LocalRepository conserve son constructeur et sa propriété publique `db`', () => {
    const db = new NexoraDB('contract-ctor');
    const repo = new LocalRepository(db, 'u1');
    expect(repo.db).toBe(db);
    expect(repo.userId).toBe('u1');
    expect(repo).toBeInstanceOf(RepositoryCore);
    expect(new ValidationError('m', { a: 'champ' }).message).toBe('champ');
  });
});

// ---------------------------------------------------------------------------
// 2. Schéma Dexie inchangé
// ---------------------------------------------------------------------------

describe('contrat : schéma IndexedDB inchangé', () => {
  it('base « nexora » en version 1, tables et index identiques au schéma publié', () => {
    const db = new NexoraDB('contract-schema');
    expect(db.verno).toBe(1);
    const schema = Object.fromEntries(db.tables.map((t) => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(', ')]));
    expect(schema).toEqual({
      meta: 'key',
      users: 'id',
      settings: 'id, userId',
      accounts: 'id, userId',
      categories: 'id, userId',
      transactions: 'id, userId, [userId+date], accountId, transferId',
      attachments: 'id, userId',
      budgets: 'id, userId, [userId+month]',
      goals: 'id, userId',
      goalContributions: 'id, userId, goalId',
      recurringRules: 'id, userId',
      occurrences: 'id, userId, ruleId',
      debts: 'id, userId',
      debtPayments: 'id, userId, debtId',
      assets: 'id, userId',
      valuations: 'id, userId, assetId',
      rates: 'id, userId',
      notificationStates: '[userId+id], userId',
      importBatches: 'id, userId',
    });
    expect(new NexoraDB().name).toBe('nexora');
  });

  it('tables.ts est conforme à db.ts (constantes et clés primaires)', () => {
    const db = new NexoraDB('contract-schema-2');
    expect(USER_TABLES).toEqual(DB_USER_TABLES);
    expect(SCHEMA_VERSION).toBe(DB_SCHEMA_VERSION);
    expect([...ALL_TABLES].sort()).toEqual(db.tables.map((t) => t.name).sort());
    for (const t of ALL_TABLES) expect(PRIMARY_KEYS[t], t).toEqual(db.table(t).schema.primKey.keyPath);
  });
});

// ---------------------------------------------------------------------------
// 3. Équivalence fonctionnelle
// ---------------------------------------------------------------------------

describe('contrat : équivalence LocalRepository ↔ CloudRepository', () => {
  it('même scénario (54 méthodes, succès et erreurs) → mêmes résultats, mêmes données', async () => {
    const u = uid();
    const l = local(u);
    const c = cloud(u);
    // Horloge figée (defaultSettings et le jeu de démo lisent `new Date()`).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
    resetIds();
    const a = await scenario(l.repo);
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    resetIds();
    const b = await scenario(c.repo);
    vi.useRealTimers();

    expect([...a.called].filter((m) => (REPOSITORY_METHODS as readonly string[]).includes(m)).sort()).toEqual([...REPOSITORY_METHODS].sort());
    for (let i = 0; i < a.log.length; i++) expect(b.log[i], String((a.log[i] as unknown[])[0])).toEqual(a.log[i]);
    expect(b.log).toEqual(a.log);
    expect(b.checkpoints).toEqual(a.checkpoints);
    expect(a.checkpoints).toHaveLength(11);
    // Le scénario produit bien des erreurs métier, identiques des deux côtés.
    expect(a.log.filter((x) => (x as unknown[])[1] === 'ERROR').length).toBeGreaterThan(30);
    // Contenu physique : base locale ≡ cache cloud, table par table.
    expect(await dump(c.cache)).toEqual(await dump(l.db));
  });

  it('cloud : le serveur (MemoryTransport) contient exactement le cache', async () => {
    const u = uid();
    const c = cloud(u);
    resetIds();
    await scenario(c.repo);
    const d = await dump(c.cache);
    for (const t of ALL_TABLES) {
      const server = c.transport.rows(u, t);
      const norm = (rows: unknown[]) => (t === 'attachments' ? (rows as { blob?: Blob }[]).map((x) => ({ ...x, blob: { size: x.blob?.size, type: x.blob?.type } })) : rows);
      expect(norm(server).length, t).toBe(d[t].length);
      expect(norm(server), t).toEqual(expect.arrayContaining(d[t]));
    }
  });
});

// ---------------------------------------------------------------------------
// 4. DisabledTransport : écritures cloud refusées par défaut
// ---------------------------------------------------------------------------

describe('contrat : écritures cloud refusées par défaut', () => {
  it('transport par défaut = DisabledTransport ; toute écriture échoue, le cache reste vide', async () => {
    const u = uid();
    const cache = new NexoraDB(cloudCacheName(u));
    const repo = new CloudRepository(u, { cache });
    expect(repo.transportKind).toBe('disabled');
    expect(repo.cacheName).toBe(`nexora-cache-${u}`);
    await expect(repo.ensureUser('x')).rejects.toBeInstanceOf(CloudWriteDisabledError);
    await expect(repo.updateSettings({ displayName: 'x' })).rejects.toBeInstanceOf(CloudWriteDisabledError);
    await expect(repo.setNotificationState(['a'], { read: true })).rejects.toBeInstanceOf(CloudWriteDisabledError);
    await expect(repo.snapshot()).resolves.toBeNull();
    for (const t of ALL_TABLES) expect(await cache.table(t).count(), t).toBe(0);
    await expect(new DisabledTransport().commit()).rejects.toBeInstanceOf(CloudWriteDisabledError);
  });

  it('lecture seule : un cache déjà rempli reste lisible et intact, toute écriture est refusée', async () => {
    const u = uid();
    const cache = new NexoraDB(cloudCacheName(u));
    // Cache rempli par un repository cloud « en ligne », puis rouvert avec le transport par défaut.
    const online = new CloudRepository(u, { cache, transport: new MemoryTransport() });
    const { bank, cat } = await seeded(online);
    await online.createTransaction(draft(bank.id, { categoryId: cat('food').id }));
    const before = await dump(cache);
    const offline = new CloudRepository(u, { cache });
    const s = (await offline.snapshot())!;
    expect(s.accounts).toHaveLength(2);
    expect(s.transactions).toHaveLength(1);
    const attempts: Promise<unknown>[] = [
      offline.createTransaction(draft(bank.id, { categoryId: cat('food').id })),
      offline.createAccount(account('X')),
      offline.deleteTransactions([s.transactions[0].id]),
      offline.setBudget('2026-03', null, 1000, 'MAD'),
      offline.clearUserData(),
      offline.restoreBackup(await offline.exportBackup()),
    ];
    for (const p of attempts) await expect(p).rejects.toBeInstanceOf(CloudWriteDisabledError);
    expect(await dump(cache)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 5. Échecs de transport et erreurs métier
// ---------------------------------------------------------------------------

describe('contrat : échecs de transport et erreurs métier', () => {
  it('échec du transport → CloudTransportError, ni cache ni serveur modifiés ; l’écriture suivante réussit', async () => {
    const u = uid();
    const c = cloud(u);
    const { bank, savings, cat } = await seeded(c.repo);
    const debt = await c.repo.createDebt({ label: 'D', type: 'loan', direction: 'payable', principal: 100000, currency: 'MAD', startDate: '2026-03-01', status: 'active' });
    const [exp] = await c.repo.createTransaction(draft(bank.id, { categoryId: cat('food').id }));
    const backup = await c.repo.exportBackup();
    const ops: [string, () => Promise<unknown>][] = [
      ['transfert', () => c.repo.createTransaction(draft(bank.id, { type: 'transfer', toAccountId: savings.id }))],
      ['suppression en cascade', () => c.repo.deleteTransactions([exp.id])],
      ['paiement de dette', () => c.repo.addDebtPayment(debt.id, { date: '2026-03-02', principal: 1000, interest: 100, accountId: bank.id })],
      ['budgets multi-mois', () => c.repo.setBudget('2026-03', null, 1000, 'MAD', { applyToFollowingMonths: 3 })],
      ['restauration', () => c.repo.restoreBackup(backup)],
      ['réinitialisation', () => c.repo.resetToEmpty()],
    ];
    for (const [label, op] of ops) {
      const cacheBefore = await dump(c.cache);
      const commits = c.transport.commits.length;
      c.transport.failNext = new Error('réseau indisponible');
      const err = await op().catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(CloudTransportError);
      expect((err as CloudTransportError).message, label).toContain('réseau indisponible');
      expect(await dump(c.cache), label).toEqual(cacheBefore);
      expect(c.transport.commits.length, label).toBe(commits);
    }
    await c.repo.createTransaction(draft(bank.id, { type: 'transfer', toAccountId: savings.id }));
    expect((await c.repo.snapshot())!.transactions).toHaveLength(3);
  });

  it('erreur métier dans une transaction → aucun lot envoyé, rien d’écrit (cloud)', async () => {
    const c = cloud(uid());
    const { bank } = await seeded(c.repo);
    const goal = await c.repo.saveGoal({ name: 'G', targetAmount: 1000, currency: 'MAD', savedAmount: 0, priority: 'low', trackLinkedAccount: false, status: 'active', icon: 'X', color: '#fff' });
    const before = await dump(c.cache);
    const commits = c.transport.commits.length;
    await expect(c.repo.addGoalContribution(goal.id, -10, '2026-03-01')).rejects.toBeInstanceOf(ValidationError);
    await expect(c.repo.addDebtPayment('nope', { date: '2026-03-01', principal: 1, interest: 0 })).rejects.toThrow();
    await expect(c.repo.createDebt({ label: 'D', type: 'loan', direction: 'payable', principal: 100, currency: 'EUR', startDate: '2026-03-01', status: 'active' }, { accountId: bank.id, date: '2026-03-01' })).rejects.toBeInstanceOf(ValidationError);
    await expect(c.repo.markOccurrencePaid('nope', '2026-03-01', { date: '2026-03-01', amount: 1, accountId: bank.id })).rejects.toThrow();
    expect(c.transport.commits.length).toBe(commits);
    expect(await dump(c.cache)).toEqual(before);
  });

  it('une opération composée part en UN seul lot atomique (transfert : 2 jambes)', async () => {
    const c = cloud(uid());
    const { bank, savings } = await seeded(c.repo);
    const n = c.transport.commits.length;
    await c.repo.createTransaction(draft(bank.id, { type: 'transfer', toAccountId: savings.id }));
    // createTransaction utilise bulkAdd hors transaction explicite : un seul lot quand même.
    expect(c.transport.commits.length).toBe(n + 1);
    const lot = c.transport.commits.at(-1)!;
    expect(lot.ops.map((o) => [o.table, o.type])).toEqual([
      ['transactions', 'put'],
      ['transactions', 'put'],
    ]);
    const legs = (await c.repo.snapshot())!.transactions;
    await c.repo.deleteTransactions([legs[0].id]);
    expect(c.transport.commits.at(-1)!.ops.map((o) => [o.table, o.type])).toEqual([
      ['transactions', 'delete'],
      ['transactions', 'delete'],
    ]);
  });

  it('add sur une clé existante → ConstraintError (comme Dexie), sans écriture', async () => {
    const c = cloud(uid());
    const { bank, cat } = await seeded(c.repo);
    const [t] = await c.repo.createTransaction(draft(bank.id, { categoryId: cat('food').id }));
    const before = await dump(c.cache);
    await expect(store(c.repo).tables.transactions.add(t)).rejects.toBeInstanceOf(ConstraintError);
    expect(await dump(c.cache)).toEqual(before);
    const l = local(uid());
    const ls = await seeded(l.repo);
    const [lt] = await l.repo.createTransaction(draft(ls.bank.id, { categoryId: ls.cat('food').id }));
    await expect(store(l.repo).tables.transactions.add(lt)).rejects.toMatchObject({ name: 'ConstraintError' });
  });
});

// ---------------------------------------------------------------------------
// 6. Atomicité des opérations composées (échec au milieu d'une transaction)
// ---------------------------------------------------------------------------

describe('contrat : atomicité des opérations composées', () => {
  const both = [
    ['LocalRepository (transaction Dexie)', (u: string) => local(u)],
    ['CloudRepository (surcouche + lot)', (u: string) => cloud(u)],
  ] as const;

  for (const [name, make] of both) {
    describe(name, () => {
      /** Fait échouer la Nème écriture `method` sur `table` pendant l'opération. */
      function failOn(repo: NexoraRepository, table: TableName, method: 'put' | 'add' | 'delete' | 'bulkPut' | 'bulkDelete') {
        const port = store(repo).tables[table] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        return vi.spyOn(port, method).mockImplementationOnce(() => Promise.reject(new Error('panne simulée')));
      }

      it('addGoalContribution : panne sur la mise à jour de l’objectif → aucune contribution conservée', async () => {
        const { repo, ...rest } = make(uid());
        await seeded(repo);
        const goal = await repo.saveGoal({ name: 'G', targetAmount: 1000, currency: 'MAD', savedAmount: 0, priority: 'low', trackLinkedAccount: false, status: 'active', icon: 'X', color: '#fff' });
        const before = await dump('db' in rest ? rest.db : rest.cache);
        const spy = failOn(repo, 'goals', 'put');
        await expect(repo.addGoalContribution(goal.id, 500, '2026-03-01')).rejects.toThrow('panne simulée');
        spy.mockRestore();
        expect(await dump('db' in rest ? rest.db : rest.cache)).toEqual(before);
      });

      it('addDebtPayment : panne sur l’enregistrement du paiement → transaction de paiement annulée', async () => {
        const { repo, ...rest } = make(uid());
        const { bank } = await seeded(repo);
        const debt = await repo.createDebt({ label: 'D', type: 'loan', direction: 'payable', principal: 100000, currency: 'MAD', startDate: '2026-03-01', status: 'active' });
        const before = await dump('db' in rest ? rest.db : rest.cache);
        const spy = failOn(repo, 'debtPayments', 'add');
        await expect(repo.addDebtPayment(debt.id, { date: '2026-03-02', principal: 1000, interest: 0, accountId: bank.id })).rejects.toThrow('panne simulée');
        spy.mockRestore();
        expect(await dump('db' in rest ? rest.db : rest.cache)).toEqual(before);
      });

      it('updateTransaction : panne après suppression de la jambe obsolète → transfert intact', async () => {
        const { repo, ...rest } = make(uid());
        const { bank, savings, cat } = await seeded(repo);
        const legs = await repo.createTransaction(draft(bank.id, { type: 'transfer', toAccountId: savings.id }));
        const before = await dump('db' in rest ? rest.db : rest.cache);
        const spy = failOn(repo, 'transactions', 'bulkPut');
        await expect(repo.updateTransaction(legs[0].id, draft(bank.id, { categoryId: cat('food').id }))).rejects.toThrow('panne simulée');
        spy.mockRestore();
        expect(await dump('db' in rest ? rest.db : rest.cache)).toEqual(before);
      });

      it('deleteTransactions : panne sur le paiement de dette lié → aucune suppression', async () => {
        const { repo, ...rest } = make(uid());
        const { bank } = await seeded(repo);
        const debt = await repo.createDebt({ label: 'D', type: 'loan', direction: 'payable', principal: 100000, currency: 'MAD', startDate: '2026-03-01', status: 'active' });
        const p = await repo.addDebtPayment(debt.id, { date: '2026-03-02', principal: 1000, interest: 0, accountId: bank.id });
        const before = await dump('db' in rest ? rest.db : rest.cache);
        const spy = failOn(repo, 'debtPayments', 'delete');
        await expect(repo.deleteTransactions([p.transactionId!])).rejects.toThrow('panne simulée');
        spy.mockRestore();
        expect(await dump('db' in rest ? rest.db : rest.cache)).toEqual(before);
      });

      it('restoreBackup : panne en cours de restauration → données d’origine conservées', async () => {
        const { repo, ...rest } = make(uid());
        const { bank, cat } = await seeded(repo);
        await repo.createTransaction(draft(bank.id, { categoryId: cat('food').id }));
        const backup = await repo.exportBackup();
        await repo.createTransaction(draft(bank.id, { label: 'Après sauvegarde', categoryId: cat('food').id }));
        const before = await dump('db' in rest ? rest.db : rest.cache);
        const spy = failOn(repo, 'transactions', 'bulkPut');
        await expect(repo.restoreBackup(backup)).rejects.toThrow('panne simulée');
        spy.mockRestore();
        expect(await dump('db' in rest ? rest.db : rest.cache)).toEqual(before);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Correction d'atomicité : lecture et écriture dans la même transaction
// ---------------------------------------------------------------------------

describe('contrat : aucune mise à jour perdue (addGoalContribution, addDebtPayment, updateDebt)', () => {
  const both = [
    ['LocalRepository', (u: string) => local(u).repo],
    ['CloudRepository', (u: string) => cloud(u).repo],
  ] as const;

  for (const [name, make] of both) {
    describe(name, () => {
      it('contributions concurrentes : le montant constitué est la somme de toutes', async () => {
        const repo = make(uid());
        await seeded(repo);
        const goal = await repo.saveGoal({ name: 'G', targetAmount: 100000, currency: 'MAD', savedAmount: 0, priority: 'low', trackLinkedAccount: false, status: 'active', icon: 'X', color: '#fff' });
        await Promise.all([100, 200, 300, 400].map((a) => repo.addGoalContribution(goal.id, a, '2026-03-01')));
        const s = (await repo.snapshot())!;
        expect(s.goalContributions).toHaveLength(4);
        expect(s.goals[0].savedAmount).toBe(1000);
      });

      it('paiements concurrents : jamais plus que le principal', async () => {
        const repo = make(uid());
        await seeded(repo);
        const debt = await repo.createDebt({ label: 'D', type: 'loan', direction: 'payable', principal: 1000, currency: 'MAD', startDate: '2026-03-01', status: 'active' });
        const res = await Promise.allSettled([600, 600].map((p) => repo.addDebtPayment(debt.id, { date: '2026-03-02', principal: p, interest: 0 })));
        expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
        const s = (await repo.snapshot())!;
        expect(s.debtPayments.reduce((a, p) => a + p.principal, 0)).toBe(600);
      });

      it('updateDebt concurrent à un paiement : le principal reste ≥ au remboursé', async () => {
        const repo = make(uid());
        await seeded(repo);
        const debt = await repo.createDebt({ label: 'D', type: 'loan', direction: 'payable', principal: 1000, currency: 'MAD', startDate: '2026-03-01', status: 'active' });
        await Promise.allSettled([repo.addDebtPayment(debt.id, { date: '2026-03-02', principal: 600, interest: 0 }), repo.updateDebt(debt.id, { principal: 500 })]);
        const s = (await repo.snapshot())!;
        const repaid = s.debtPayments.reduce((a, p) => a + p.principal, 0);
        expect(s.debts[0].principal).toBeGreaterThanOrEqual(repaid);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Isolation entre utilisateurs
// ---------------------------------------------------------------------------

describe('contrat : isolation entre utilisateurs', () => {
  it('local (même base) : u2 ne lit, ne modifie ni ne supprime les données de u1', async () => {
    const db = new NexoraDB(`contract-iso-${uid()}`);
    const r1 = new LocalRepository(db, 'u1');
    const r2 = new LocalRepository(db, 'u2');
    const a = await seeded(r1);
    await seeded(r2);
    const [t] = await r1.createTransaction(draft(a.bank.id, { categoryId: a.cat('food').id }));
    const before = (await r1.snapshot())!;
    expect((await r2.snapshot())!.transactions).toHaveLength(0);
    await expect(r2.getTransactionGroup(t.id)).rejects.toThrow();
    await expect(r2.updateAccount(a.bank.id, { name: 'Piraté' })).rejects.toThrow();
    expect(await r2.deleteTransactions([t.id])).toBe(0);
    await r2.recategorize([t.id], (await r2.snapshot())!.categories.find((c) => c.key === 'food')!.id);
    await expect(r2.getAttachment(t.id)).resolves.toBeUndefined();
    await r2.clearUserData();
    expect(await r1.snapshot()).toEqual(before);
  });

  // Limite connue (préexistante, hors périmètre du Lot 2) : dans une MÊME base locale, la
  // restauration réutilise les identifiants de la sauvegarde ; restaurer chez u2 une
  // sauvegarde de u1 réattribue les lignes de u1 à u2. Inatteignable dans l'application
  // (un seul utilisateur local) ; le remappage des identifiants est prévu au Lot 7.
  it.fails('LIMITE CONNUE — local : restaurer chez u2 la sauvegarde de u1 ne doit pas toucher u1', async () => {
    const db = new NexoraDB(`contract-iso-restore-${uid()}`);
    const r1 = new LocalRepository(db, 'u1');
    const r2 = new LocalRepository(db, 'u2');
    await seeded(r1);
    const before = (await r1.snapshot())!;
    await r2.restoreBackup(await r1.exportBackup());
    expect(await r1.snapshot()).toEqual(before);
  });

  it('cloud : caches distincts, partitions serveur distinctes, aucune lecture croisée', async () => {
    const transport = new MemoryTransport();
    const u1 = uid();
    const u2 = uid();
    const c1 = cloud(u1, transport);
    const c2 = cloud(u2, transport);
    expect(c1.cache.name).toBe(`nexora-cache-${u1}`);
    expect(c2.cache.name).toBe(`nexora-cache-${u2}`);
    const a = await seeded(c1.repo);
    await seeded(c2.repo);
    const [t] = await c1.repo.createTransaction(draft(a.bank.id, { categoryId: a.cat('food').id }));
    const s1 = (await c1.repo.snapshot())!;
    expect((await c2.repo.snapshot())!.transactions).toHaveLength(0);
    await expect(c2.repo.getTransactionGroup(t.id)).rejects.toThrow();
    expect(await c2.repo.deleteTransactions([t.id])).toBe(0);
    // Même sauvegarde restaurée chez u2 : u1 n'est pas affecté (cache et partition séparés).
    await c2.repo.restoreBackup(await c1.repo.exportBackup());
    expect(await c1.repo.snapshot()).toEqual(s1);
    expect(transport.rows(u1, 'transactions')).toHaveLength(1);
    expect(transport.rows(u2, 'transactions').every((r) => r.userId === u2)).toBe(true);
    expect(transport.users().sort()).toEqual([u1, u2].sort());
  });

  it('cloud : une ligne attribuée à un autre utilisateur est refusée par le transport, rien n’est écrit', async () => {
    const transport = new MemoryTransport();
    const u1 = uid();
    const c2 = cloud(uid(), transport);
    await seeded(c2.repo);
    const before = await dump(c2.cache);
    const forged = { id: 'x', userId: u1, displayName: '', createdAt: '' };
    const err = await store(c2.repo).tables.accounts.put(forged as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudTransportError);
    expect((err as CloudTransportError).cause).toBeInstanceOf(IsolationViolationError);
    expect(await dump(c2.cache)).toEqual(before);
    expect(transport.rows(u1, 'accounts')).toHaveLength(0);
  });

  it('cloud : un cache ne peut servir qu’à son propriétaire', () => {
    const u1 = uid();
    expect(() => new CloudRepository(uid(), { cache: new NexoraDB(cloudCacheName(u1)), transport: new MemoryTransport() })).toThrow(/refusé/);
  });
});

// ---------------------------------------------------------------------------
// 9. Protection de la base « nexora » et nommage du cache
// ---------------------------------------------------------------------------

describe('contrat : la base locale « nexora » n’est jamais utilisée par le mode cloud', () => {
  it('le cache est toujours « nexora-cache-<uid> » ; « nexora » et les noms invalides sont refusés', () => {
    expect(CLOUD_CACHE_PREFIX).toBe('nexora-cache-');
    expect(cloudCacheName('abc_1-2')).toBe('nexora-cache-abc_1-2');
    for (const bad of ['', '../nexora', 'a b', 'x/y', 'é']) expect(() => cloudCacheName(bad), bad).toThrow();
    expect(() => new CloudRepository('u', { cache: new NexoraDB('nexora') })).toThrow(/« nexora »/);
    expect(() => new CloudRepository('u', { cache: new NexoraDB('autre') })).toThrow();
  });

  it('créer et utiliser un CloudRepository n’ouvre jamais la base « nexora »', async () => {
    const u = uid();
    const repo = new CloudRepository(u); // cache par défaut, DisabledTransport
    await repo.snapshot();
    await repo.ensureUser('x').catch(() => undefined);
    const c = cloud(uid());
    await seeded(c.repo);
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).toContain(`nexora-cache-${u}`);
    expect(names).not.toContain('nexora');
  });
});
