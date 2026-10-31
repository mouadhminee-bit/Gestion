import { beforeEach, describe, expect, it } from 'vitest';
import { NexoraDB } from './db';
import { LocalRepository, ValidationError } from './repository';
import { generateDemoData } from './demo';
import type { Account, Category } from '@/domain/types';
import type { TransactionDraft } from '@/domain/validation';
import { accountBalance, buildContext, summarizePeriod, totalBalance, accountsInScope } from '@/domain/calc/ledger';
import { monthPeriod, monthKey } from '@/domain/dates';
import { computeDebtStatus } from '@/domain/calc/debts';
import { listOccurrences } from '@/domain/calc/recurring';
import { toCSV, parseCSV } from '@/domain/csv';

let dbName = 0;
let db: NexoraDB;
let repo: LocalRepository;
let bank: Account;
let savings: Account;
let cats: Category[];
const cat = (key: string) => cats.find((c) => c.key === key)!;

const draft = (p: Partial<TransactionDraft>): TransactionDraft => ({
  type: 'expense',
  amount: 10000,
  label: 'Test',
  date: '2026-03-10',
  categoryId: null,
  subcategoryId: null,
  accountId: bank.id,
  tags: [],
  status: 'cleared',
  ...p,
});

beforeEach(async () => {
  db = new NexoraDB(`test-${++dbName}`);
  repo = new LocalRepository(db, 'u1');
  await repo.ensureUser('Test');
  bank = await repo.createAccount({ name: 'Banque', type: 'bank', currency: 'MAD', initialBalance: 500000, initialBalanceDate: '2026-03-01', archived: false, includeInTotal: true, color: '#fff', order: 0 });
  savings = await repo.createAccount({ name: 'Épargne', type: 'savings', currency: 'MAD', initialBalance: 0, initialBalanceDate: '2026-03-01', archived: false, includeInTotal: true, color: '#fff', order: 1 });
  cats = (await repo.snapshot())!.categories;
});

async function balanceOf(acc: Account) {
  const s = (await repo.snapshot())!;
  return accountBalance(s.accounts.find((a) => a.id === acc.id)!, s.transactions);
}

describe('Transactions — CRUD', () => {
  it('crée un revenu et une dépense, et met à jour le solde', async () => {
    await repo.createTransaction(draft({ type: 'income', amount: 1300000, categoryId: cat('salary').id }));
    await repo.createTransaction(draft({ type: 'expense', amount: 160000, categoryId: cat('food').id }));
    expect(await balanceOf(bank)).toBe(500000 + 1300000 - 160000);
  });

  it('modifie une transaction', async () => {
    const [t] = await repo.createTransaction(draft({ categoryId: cat('food').id }));
    await repo.updateTransaction(t.id, draft({ amount: 25000, categoryId: cat('restaurants').id, label: 'Dîner' }));
    const s = (await repo.snapshot())!;
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0]).toMatchObject({ amount: 25000, label: 'Dîner', categoryId: cat('restaurants').id, createdAt: t.createdAt });
    expect(await balanceOf(bank)).toBe(475000);
  });

  it('supprime une transaction', async () => {
    const [t] = await repo.createTransaction(draft({ categoryId: cat('food').id }));
    expect(await repo.deleteTransactions([t.id])).toBe(1);
    expect((await repo.snapshot())!.transactions).toHaveLength(0);
    expect(await balanceOf(bank)).toBe(500000);
  });

  it('valide les entrées (montant, compte, catégorie, date)', async () => {
    await expect(repo.createTransaction(draft({ amount: 0, categoryId: cat('food').id }))).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.createTransaction(draft({ amount: -5, categoryId: cat('food').id }))).rejects.toThrow();
    await expect(repo.createTransaction(draft({ accountId: 'nope', categoryId: cat('food').id }))).rejects.toThrow();
    await expect(repo.createTransaction(draft({ categoryId: cat('salary').id }))).rejects.toThrow(); // catégorie de revenu sur une dépense
    await expect(repo.createTransaction(draft({ date: '2026-02-30', categoryId: cat('food').id }))).rejects.toThrow();
    await expect(repo.createTransaction(draft({ type: 'adjustment', direction: 'in', notes: '' }))).rejects.toThrow();
  });
});

describe('Transferts', () => {
  it('crée deux jambes liées et ne compte ni revenu ni dépense', async () => {
    await repo.createTransaction(draft({ type: 'transfer', amount: 200000, toAccountId: savings.id, categoryId: cat('emergency_fund').id }));
    const s = (await repo.snapshot())!;
    expect(s.transactions).toHaveLength(2);
    const [a, b] = s.transactions;
    expect(a.transferId).toBe(b.transferId);
    expect(await balanceOf(bank)).toBe(300000);
    expect(await balanceOf(savings)).toBe(200000);
    const sum = summarizePeriod(buildContext(s), s.transactions, monthPeriod('2026-03'));
    expect(sum.income + sum.expenses).toBe(0);
  });

  it('refuse un transfert vers le même compte', async () => {
    await expect(repo.createTransaction(draft({ type: 'transfer', toAccountId: bank.id }))).rejects.toThrow();
  });

  it('modifie et supprime les deux jambes ensemble', async () => {
    const [out, inn] = await repo.createTransaction(draft({ type: 'transfer', amount: 200000, toAccountId: savings.id }));
    await repo.updateTransaction(inn.id, draft({ type: 'transfer', amount: 50000, toAccountId: savings.id }));
    expect(await balanceOf(savings)).toBe(50000);
    expect(await balanceOf(bank)).toBe(450000);
    // Transformer le transfert en dépense supprime la jambe d'arrivée.
    await repo.updateTransaction(out.id, draft({ type: 'expense', amount: 50000, categoryId: cat('food').id }));
    let s = (await repo.snapshot())!;
    expect(s.transactions).toHaveLength(1);
    expect(await balanceOf(savings)).toBe(0);
    const [t2] = await repo.createTransaction(draft({ type: 'transfer', amount: 1000, toAccountId: savings.id }));
    await repo.deleteTransactions([t2.id]);
    s = (await repo.snapshot())!;
    expect(s.transactions).toHaveLength(1);
  });

  it('transfert multidevise : montant crédité obligatoire', async () => {
    const eur = await repo.createAccount({ name: 'EUR', type: 'ewallet', currency: 'EUR', initialBalance: 0, initialBalanceDate: '2026-03-01', archived: false, includeInTotal: true, color: '#fff', order: 2 });
    await expect(repo.createTransaction(draft({ type: 'transfer', amount: 109200, toAccountId: eur.id }))).rejects.toThrow();
    await repo.createTransaction(draft({ type: 'transfer', amount: 109200, toAccountId: eur.id, toAmount: 10000 }));
    expect(await balanceOf(eur)).toBe(10000);
    expect(await balanceOf(bank)).toBe(500000 - 109200);
  });
});

describe('Persistance', () => {
  it('les données survivent à la fermeture / réouverture de la base', async () => {
    await repo.createTransaction(draft({ amount: 4200, categoryId: cat('food').id }));
    const name = db.name;
    db.close();
    const reopened = new NexoraDB(name);
    const repo2 = new LocalRepository(reopened, 'u1');
    const s = (await repo2.snapshot())!;
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0].amount).toBe(4200);
    expect(s.accounts).toHaveLength(2);
    reopened.close();
  });

  it('sauvegarde / restauration JSON', async () => {
    await repo.createTransaction(draft({ amount: 4200, categoryId: cat('food').id }));
    const backup = await repo.exportBackup();
    await repo.clearUserData();
    expect(await repo.snapshot()).toBeNull();
    await repo.restoreBackup(JSON.parse(JSON.stringify(backup)));
    const s = (await repo.snapshot())!;
    expect(s.transactions).toHaveLength(1);
    expect(s.categories.length).toBe(cats.length);
  });

  it('refuse une sauvegarde invalide', async () => {
    await expect(repo.restoreBackup({ app: 'autre' } as never)).rejects.toThrow();
  });
});

describe('Isolation des données entre utilisateurs', () => {
  it('un utilisateur ne voit ni ne modifie les données d’un autre', async () => {
    const other = new LocalRepository(db, 'u2');
    await other.ensureUser('Autre');
    const [t] = await repo.createTransaction(draft({ categoryId: cat('food').id }));
    const s2 = (await other.snapshot())!;
    expect(s2.accounts).toHaveLength(0);
    expect(s2.transactions).toHaveLength(0);
    await expect(other.deleteTransactions([t.id])).resolves.toBe(0);
    await expect(other.updateAccount(bank.id, { name: 'Piraté' })).rejects.toThrow();
    await other.clearUserData();
    expect((await repo.snapshot())!.transactions).toHaveLength(1);
  });
});

describe('Catégories et comptes archivés', () => {
  it('une catégorie utilisée ne peut pas être supprimée, seulement archivée', async () => {
    await repo.createTransaction(draft({ categoryId: cat('food').id }));
    await expect(repo.deleteCategory(cat('food').id)).rejects.toThrow(/archivez/);
    await repo.updateCategory(cat('food').id, { archived: true });
    await expect(repo.createTransaction(draft({ categoryId: cat('food').id }))).rejects.toThrow();
    // L'historique reste lisible et modifiable.
    const s = (await repo.snapshot())!;
    await repo.updateTransaction(s.transactions[0].id, draft({ categoryId: cat('food').id, amount: 999 }));
  });

  it('un compte archivé reste dans l’historique mais n’accepte plus de nouvelles opérations', async () => {
    await repo.createTransaction(draft({ categoryId: cat('food').id }));
    await expect(repo.deleteAccount(bank.id)).rejects.toThrow();
    await repo.archiveAccount(bank.id);
    await expect(repo.createTransaction(draft({ categoryId: cat('food').id }))).rejects.toThrow(/archivé/);
    const s = (await repo.snapshot())!;
    expect(accountsInScope(s.accounts).map((a) => a.id)).not.toContain(bank.id);
  });
});

describe('Budgets, objectifs, récurrences, dettes', () => {
  it('copie les budgets d’un mois à l’autre', async () => {
    await repo.setBudget('2026-03', null, 900000, 'MAD');
    await repo.setBudget('2026-03', cat('food').id, 160000, 'MAD');
    expect(await repo.copyBudgets('2026-03', '2026-04')).toBe(2);
    expect(await repo.copyBudgets('2026-03', '2026-04')).toBe(0);
    await repo.setBudget('2026-04', cat('food').id, 170000, 'MAD', { applyToFollowingMonths: 2 });
    const s = (await repo.snapshot())!;
    expect(s.budgets.filter((b) => b.categoryId === cat('food').id).map((b) => [b.month, b.amount]).sort()).toEqual([
      ['2026-03', 160000],
      ['2026-04', 170000],
      ['2026-05', 170000],
      ['2026-06', 170000],
    ]);
  });

  it('marquer une échéance payée crée UNE transaction liée', async () => {
    const r = await repo.saveRecurringRule({ kind: 'expense', label: 'Loyer', amount: 280000, currency: 'MAD', accountId: bank.id, categoryId: cat('rent').id, frequency: 'monthly', startDate: '2026-03-03', active: true });
    expect((await repo.snapshot())!.transactions).toHaveLength(0);
    await repo.markOccurrencePaid(r.id, '2026-03-03', { date: '2026-03-04', amount: 280000, accountId: bank.id });
    await expect(repo.markOccurrencePaid(r.id, '2026-03-03', { date: '2026-03-04', amount: 280000, accountId: bank.id })).rejects.toThrow();
    const s = (await repo.snapshot())!;
    expect(s.transactions).toHaveLength(1);
    const occ = listOccurrences(s.recurringRules, s.occurrences, s.transactions, monthPeriod('2026-03'), '2026-03-20');
    expect(occ[0].status).toBe('paid');
    await repo.deleteTransactions([s.transactions[0].id]);
    const s2 = (await repo.snapshot())!;
    expect(listOccurrences(s2.recurringRules, s2.occurrences, s2.transactions, monthPeriod('2026-03'), '2026-03-20')[0].status).toBe('overdue');
  });

  describe('rapprochement manuel des échéances', () => {
    const loyer = () => repo.saveRecurringRule({ kind: 'expense', label: 'Loyer', amount: 280000, currency: 'MAD', accountId: bank.id, categoryId: cat('rent').id, frequency: 'monthly', startDate: '2026-03-03', active: true });
    const occ = async () => {
      const s = (await repo.snapshot())!;
      return listOccurrences(s.recurringRules, s.occurrences, s.transactions, monthPeriod('2026-03'), '2026-03-20')[0];
    };

    it('associe plusieurs opérations existantes sans en créer (paiement fractionné)', async () => {
      const r = await loyer();
      const a = await repo.createTransaction(draft({ categoryId: cat('rent').id, amount: 150000, label: 'Virement 1', date: '2026-03-01' }));
      const b = await repo.createTransaction(draft({ categoryId: cat('rent').id, amount: 130000, label: 'Virement 2', date: '2026-03-05' }));
      await repo.linkOccurrence(r.id, '2026-03-03', [a[0].id]);
      expect(await occ()).toMatchObject({ status: 'partial', paid: 150000, remaining: 130000 });
      await repo.linkOccurrence(r.id, '2026-03-03', [b[0].id]);
      expect(await occ()).toMatchObject({ status: 'paid', paid: 280000, remaining: 0 });
      const s = (await repo.snapshot())!;
      expect(s.transactions).toHaveLength(2);
      // Dates réelles conservées : le paiement anticipé du 01/03 reste daté du 01/03.
      expect(s.transactions.map((t) => t.date).sort()).toEqual(['2026-03-01', '2026-03-05']);
      expect(summarizePeriod(buildContext(s), s.transactions, monthPeriod('2026-03')).expenses).toBe(280000);
    });

    it('refuse une opération déjà associée à une autre échéance ou d’un autre type', async () => {
      const r = await loyer();
      const t = await repo.createTransaction(draft({ categoryId: cat('rent').id, amount: 280000 }));
      await repo.linkOccurrence(r.id, '2026-03-03', t[0].id);
      await expect(repo.linkOccurrence(r.id, '2026-04-03', t[0].id)).rejects.toThrow(ValidationError);
      const inc = await repo.createTransaction(draft({ type: 'income', categoryId: cats.find((c) => c.kind === 'income')!.id, amount: 280000 }));
      await expect(repo.linkOccurrence(r.id, '2026-03-03', inc[0].id)).rejects.toThrow(ValidationError);
    });

    it('« Marquer payée » ne règle que le reliquat et refuse un second paiement complet', async () => {
      const r = await loyer();
      const t = await repo.createTransaction(draft({ categoryId: cat('rent').id, amount: 100000 }));
      await repo.linkOccurrence(r.id, '2026-03-03', t[0].id);
      await repo.markOccurrencePaid(r.id, '2026-03-03', { date: '2026-03-10', amount: 180000, accountId: bank.id });
      expect(await occ()).toMatchObject({ status: 'paid', paid: 280000 });
      await expect(repo.markOccurrencePaid(r.id, '2026-03-03', { date: '2026-03-11', amount: 280000, accountId: bank.id })).rejects.toThrow(ValidationError);
      expect((await repo.snapshot())!.transactions).toHaveLength(2);
    });

    it('un paiement partiel via « Marquer payée » laisse le reliquat attendu', async () => {
      const r = await loyer();
      await repo.markOccurrencePaid(r.id, '2026-03-03', { date: '2026-03-04', amount: 200000, accountId: bank.id });
      expect(await occ()).toMatchObject({ status: 'partial', remaining: 80000 });
    });

    it('solder, dissocier, annuler : les opérations sont toujours conservées', async () => {
      const r = await loyer();
      await expect(repo.settleOccurrence(r.id, '2026-03-03')).rejects.toThrow(ValidationError);
      const t = await repo.createTransaction(draft({ categoryId: cat('rent').id, amount: 200000 }));
      await repo.linkOccurrence(r.id, '2026-03-03', t[0].id);
      await repo.settleOccurrence(r.id, '2026-03-03');
      expect(await occ()).toMatchObject({ status: 'paid', settled: true, remaining: 0 });
      await repo.unlinkTransaction(t[0].id);
      expect(await occ()).toMatchObject({ status: 'overdue', paid: 0 });
      await repo.linkOccurrence(r.id, '2026-03-03', t[0].id);
      await repo.resetOccurrence(r.id, '2026-03-03', true);
      const s = (await repo.snapshot())!;
      expect(s.transactions).toHaveLength(1); // opération saisie à la main : dissociée, jamais supprimée
      expect(s.transactions[0].recurringRuleId).toBeUndefined();
    });

    it('supprimer une des opérations d’un paiement fractionné garde le lien des autres', async () => {
      const r = await loyer();
      const a = await repo.createTransaction(draft({ categoryId: cat('rent').id, amount: 150000 }));
      const b = await repo.createTransaction(draft({ categoryId: cat('rent').id, amount: 130000 }));
      await repo.linkOccurrence(r.id, '2026-03-03', [a[0].id, b[0].id]);
      await repo.deleteTransactions([a[0].id]);
      expect(await occ()).toMatchObject({ status: 'partial', paid: 130000, remaining: 150000 });
    });
  });

  it('remboursement de dette : solde restant, compte débité, intérêts seuls en dépense', async () => {
    const d = await repo.createDebt({ label: 'Crédit', type: 'loan', direction: 'payable', principal: 1000000, currency: 'MAD', startDate: '2026-03-01', status: 'active' }, { accountId: bank.id, date: '2026-03-01' });
    expect(await balanceOf(bank)).toBe(1500000);
    await repo.addDebtPayment(d.id, { date: '2026-03-15', principal: 100000, interest: 5000, accountId: bank.id });
    const s = (await repo.snapshot())!;
    expect(computeDebtStatus(s.debts[0], s.debtPayments, '2026-03-20').remaining).toBe(900000);
    expect(await balanceOf(bank)).toBe(1500000 - 105000);
    const sum = summarizePeriod(buildContext(s), s.transactions, monthPeriod('2026-03'));
    expect(sum.income).toBe(0);
    expect(sum.expenses).toBe(5000);
    await expect(repo.addDebtPayment(d.id, { date: '2026-03-16', principal: 2000000, interest: 0 })).rejects.toThrow();
  });

  it('contribution à un objectif : affectation sans transaction ni actif', async () => {
    const g = await repo.saveGoal({ name: 'Voyage', targetAmount: 100000, currency: 'MAD', savedAmount: 0, priority: 'medium', trackLinkedAccount: false, status: 'active', icon: 'Plane', color: '#fff' });
    await repo.addGoalContribution(g.id, 100000, '2026-03-10');
    const s = (await repo.snapshot())!;
    expect(s.goals[0].savedAmount).toBe(100000);
    expect(s.goals[0].status).toBe('achieved');
    expect(s.transactions).toHaveLength(0);
    await expect(repo.addGoalContribution(g.id, -200000, '2026-03-11')).rejects.toThrow();
  });
});

describe('Import / export CSV', () => {
  it('importe des lignes validées, rattachées à un lot', async () => {
    const batch = await repo.importTransactions({ fileName: 'releve.csv', rowCount: 2, importedCount: 2, skippedCount: 0, accountId: bank.id }, [
      draft({ amount: 12050, categoryId: cat('food').id, label: 'Marjane' }),
      draft({ type: 'income', amount: 50000, categoryId: cat('other_income').id, label: 'Vente' }),
    ]);
    const s = (await repo.snapshot())!;
    expect(s.transactions.every((t) => t.importBatchId === batch.id)).toBe(true);
    expect(await balanceOf(bank)).toBe(500000 - 12050 + 50000);
  });

  it('exporte un CSV relisible', async () => {
    await repo.createTransaction(draft({ amount: 12050, categoryId: cat('food').id, label: 'Courses; marché' }));
    const s = (await repo.snapshot())!;
    const csv = toCSV([['Date', 'Libellé', 'Montant'], ...s.transactions.map((t) => [t.date, t.label, (-t.amount / 100).toFixed(2)])]);
    const rows = parseCSV(csv);
    expect(rows[1]).toEqual(['2026-03-10', 'Courses; marché', '-120.50']);
  });
});

describe('Jeu de démonstration', () => {
  const today = '2026-10-28';
  const demo = generateDemoData('u1', today);
  const ctx = buildContext(demo);

  it('est cohérent : chaque transfert a deux jambes équilibrées (même devise)', () => {
    const groups = new Map<string, typeof demo.transactions>();
    for (const t of demo.transactions.filter((t) => t.transferId)) groups.set(t.transferId!, [...(groups.get(t.transferId!) ?? []), t]);
    for (const legs of groups.values()) {
      expect(legs).toHaveLength(2);
      const [a, b] = legs;
      if (a.currency === b.currency) expect(a.amount).toBe(b.amount);
      expect(a.direction).not.toBe(b.direction);
    }
  });

  it('ne contient aucune transaction future ni montant invalide', () => {
    for (const t of demo.transactions) {
      expect(t.date <= today).toBe(true);
      expect(Number.isSafeInteger(t.amount) && t.amount > 0).toBe(true);
    }
  });

  it('couvre 6 mois avec revenus, dépenses fixes/variables, transferts, remboursements, dettes', () => {
    const types = new Set(demo.transactions.map((t) => t.type));
    for (const t of ['income', 'expense', 'transfer', 'refund', 'adjustment', 'debt']) expect(types.has(t as never)).toBe(true);
    const sum = summarizePeriod(ctx, demo.transactions, monthPeriod('2026-09'));
    expect(sum.income).toBeGreaterThanOrEqual(1300000);
    expect(sum.fixedExpenses).toBeGreaterThan(0);
    expect(sum.variableExpenses).toBeGreaterThan(0);
  });

  it('les totaux du dashboard correspondent aux soldes recalculés des comptes', async () => {
    await repo.replaceWithSnapshot(demo);
    const s = (await repo.snapshot())!;
    const c2 = buildContext(s);
    const total = totalBalance(c2, accountsInScope(s.accounts), s.transactions, today);
    let manual = 0;
    for (const a of accountsInScope(s.accounts)) {
      const b = accountBalance(a, s.transactions, today);
      manual += a.currency === 'MAD' ? b : c2.convert(b, a.currency, today)!;
    }
    expect(total.total).toBe(manual);
    expect(total.unconverted).toEqual({});
    // Les revenus du mois du dashboard = somme des revenus enregistrés du mois.
    const m = monthKey(today);
    const income = s.transactions.filter((t) => t.type === 'income' && t.date.startsWith(m)).reduce((a, t) => a + (t.currency === 'MAD' ? t.amount : c2.convert(t.amount, t.currency, t.date)!), 0);
    const interestIn = s.transactions.filter((t) => t.type === 'debt' && t.direction === 'in' && t.date.startsWith(m)).reduce((a, t) => a + (t.interestAmount ?? 0), 0);
    expect(summarizePeriod(c2, s.transactions, monthPeriod(m)).income).toBe(income + interestIn);
  });
});
