/**
 * Couche d'accès aux données (implémentation locale IndexedDB).
 *
 * - Toutes les lectures/écritures sont limitées à `userId`.
 * - Les opérations composées (transfert = 2 jambes, paiement de dette = paiement +
 *   transaction, etc.) sont exécutées dans une transaction IndexedDB atomique.
 * - Les règles de validation métier sont réappliquées ici avant écriture.
 *
 * Une implémentation cloud (Supabase) doit respecter la même interface publique
 * (voir docs/ARCHITECTURE.md et supabase/schema.sql).
 */
import type { NexoraDB, UserTableName } from './db';
import { USER_TABLES, SCHEMA_VERSION } from './db';
import { newId, nowISO } from '@/lib/id';
import type {
  Account,
  Asset,
  AssetValuation,
  Attachment,
  Budget,
  Category,
  DataSnapshot,
  Debt,
  DebtPayment,
  ExchangeRate,
  GoalContribution,
  ID,
  ImportBatch,
  NotificationState,
  RecurringOccurrence,
  RecurringRule,
  SavingsGoal,
  Transaction,
  UserSettings,
} from '@/domain/types';
import { buildSeedCategories } from '@/domain/categories.seed';
import { defaultSettings } from '@/domain/settings';
import type { TransactionDraft } from '@/domain/validation';
import { hasErrors, validateTransactionDraft } from '@/domain/validation';
import { validateDebtPayment } from '@/domain/calc/debts';
import { occurrenceId } from '@/domain/calc/recurring';
import type { MonthKey } from '@/domain/dates';
import { addMonthsToKey, isValidISODate } from '@/domain/dates';
import { t as tr } from '@/i18n/core';

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly fields: Record<string, string | undefined> = {},
  ) {
    // Le message expose la première erreur de champ, plus utile qu'un libellé générique.
    super(Object.values(fields).find(Boolean) ?? message);
    this.name = 'ValidationError';
  }
}

type NewEntity<T> = Omit<T, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { id?: ID };

export class LocalRepository {
  constructor(
    public readonly db: NexoraDB,
    public readonly userId: ID,
  ) {}

  private stamp<T extends object>(data: T & { id?: ID }) {
    const now = nowISO();
    return { ...data, id: data.id ?? newId(), userId: this.userId, createdAt: now, updatedAt: now };
  }

  private async own<T extends { userId: ID }>(table: UserTableName, id: ID): Promise<T> {
    const row = (await (this.db[table] as unknown as { get(id: ID): Promise<T | undefined> }).get(id)) as T | undefined;
    if (!row || row.userId !== this.userId) throw new Error(tr('err.notFound'));
    return row;
  }

  // -------------------------------------------------------------------------
  // Initialisation, paramètres, instantané
  // -------------------------------------------------------------------------

  async ensureUser(displayName = ''): Promise<UserSettings> {
    return this.db.transaction('rw', [this.db.users, this.db.settings, this.db.categories, this.db.meta], async () => {
      const existing = await this.db.settings.get(this.userId);
      if (existing) return existing;
      await this.db.users.put({ id: this.userId, displayName, createdAt: nowISO() });
      const s = defaultSettings(this.userId, { displayName });
      await this.db.settings.put(s);
      await this.db.categories.bulkPut(buildSeedCategories(this.userId));
      await this.db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
      return s;
    });
  }

  async getSettings(): Promise<UserSettings | undefined> {
    return this.db.settings.get(this.userId);
  }

  async updateSettings(patch: Partial<UserSettings>): Promise<void> {
    const current = (await this.getSettings()) ?? defaultSettings(this.userId);
    await this.db.settings.put({ ...current, ...patch, id: this.userId, userId: this.userId, updatedAt: nowISO() });
  }

  async snapshot(): Promise<DataSnapshot | null> {
    const settings = await this.getSettings();
    if (!settings) return null;
    const by = <T>(table: UserTableName) =>
      (this.db[table] as unknown as { where(k: string): { equals(v: string): { toArray(): Promise<T[]> } } })
        .where('userId')
        .equals(this.userId)
        .toArray();
    const [accounts, categories, transactions, budgets, goals, goalContributions, recurringRules, occurrences, debts, debtPayments, assets, valuations, rates, notificationStates] =
      await Promise.all([
        by<Account>('accounts'),
        by<Category>('categories'),
        by<Transaction>('transactions'),
        by<Budget>('budgets'),
        by<SavingsGoal>('goals'),
        by<GoalContribution>('goalContributions'),
        by<RecurringRule>('recurringRules'),
        by<RecurringOccurrence>('occurrences'),
        by<Debt>('debts'),
        by<DebtPayment>('debtPayments'),
        by<Asset>('assets'),
        by<AssetValuation>('valuations'),
        by<ExchangeRate>('rates'),
        by<NotificationState>('notificationStates'),
      ]);
    return {
      settings,
      accounts: accounts.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
      categories: categories.sort((a, b) => a.order - b.order),
      transactions: transactions.sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1)),
      budgets,
      goals,
      goalContributions,
      recurringRules,
      occurrences,
      debts,
      debtPayments,
      assets,
      valuations,
      rates,
      notificationStates,
    };
  }

  // -------------------------------------------------------------------------
  // Comptes
  // -------------------------------------------------------------------------

  async createAccount(input: NewEntity<Account>): Promise<Account> {
    this.assertAccount(input);
    const count = await this.db.accounts.where('userId').equals(this.userId).count();
    const acc = this.stamp({ ...input, order: input.order ?? count }) as Account;
    await this.db.accounts.add(acc);
    return acc;
  }

  async updateAccount(id: ID, patch: Partial<Account>): Promise<void> {
    const cur = await this.own<Account>('accounts', id);
    const next = { ...cur, ...patch, id, userId: this.userId, updatedAt: nowISO() };
    this.assertAccount(next);
    if (patch.currency && patch.currency !== cur.currency) {
      const used = await this.db.transactions.where('accountId').equals(id).count();
      if (used) throw new ValidationError(tr('err.currencyLocked'), { currency: tr('err.currencyLockedShort') });
    }
    await this.db.accounts.put(next);
  }

  private assertAccount(a: Partial<Account>) {
    const f: Record<string, string> = {};
    if (!a.name?.trim()) f.name = tr('err.nameRequired');
    if (!a.currency) f.currency = tr('err.currencyRequired');
    if (!Number.isSafeInteger(a.initialBalance)) f.initialBalance = tr('err.initialBalance');
    if (!isValidISODate(a.initialBalanceDate)) f.initialBalanceDate = tr('err.invalidDate');
    if (Object.keys(f).length) throw new ValidationError(tr('err.accountInvalid'), f);
  }

  async archiveAccount(id: ID, archived = true): Promise<void> {
    await this.updateAccount(id, { archived });
  }

  /** Suppression définitive autorisée uniquement pour un compte sans historique. */
  async deleteAccount(id: ID): Promise<void> {
    await this.own<Account>('accounts', id);
    const used = await this.db.transactions.where('accountId').equals(id).count();
    if (used) throw new ValidationError(tr('err.accountHasHistory'));
    await this.db.accounts.delete(id);
  }

  // -------------------------------------------------------------------------
  // Catégories
  // -------------------------------------------------------------------------

  async createCategory(input: NewEntity<Category>): Promise<Category> {
    if (!input.name.trim()) throw new ValidationError(tr('err.nameRequired'), { name: tr('err.nameRequired') });
    if (input.parentId) {
      const parent = await this.own<Category>('categories', input.parentId);
      if (parent.parentId) throw new ValidationError(tr('err.nestedSubcategory'));
      input = { ...input, kind: parent.kind, nature: parent.nature };
    }
    const cat = this.stamp(input) as Category;
    await this.db.categories.add(cat);
    return cat;
  }

  async updateCategory(id: ID, patch: Partial<Category>): Promise<void> {
    const cur = await this.own<Category>('categories', id);
    const next = { ...cur, ...patch, id, userId: this.userId, updatedAt: nowISO() };
    if (!next.name.trim()) throw new ValidationError(tr('err.nameRequired'), { name: tr('err.nameRequired') });
    await this.db.transaction('rw', this.db.categories, async () => {
      await this.db.categories.put(next);
      // La nature / le type d'une catégorie se propage à ses sous-catégories.
      if (!cur.parentId && (patch.kind || patch.nature)) {
        const children = await this.db.categories.where('userId').equals(this.userId).filter((c) => c.parentId === id).toArray();
        await this.db.categories.bulkPut(children.map((c) => ({ ...c, kind: next.kind, nature: next.nature, updatedAt: nowISO() })));
      }
    });
  }

  async categoryUsage(id: ID): Promise<number> {
    const tx = await this.db.transactions
      .where('userId')
      .equals(this.userId)
      .filter((t) => t.categoryId === id || t.subcategoryId === id)
      .count();
    const rules = await this.db.recurringRules.where('userId').equals(this.userId).filter((r) => r.categoryId === id).count();
    const budgets = await this.db.budgets.where('userId').equals(this.userId).filter((b) => b.categoryId === id).count();
    return tx + rules + budgets;
  }

  /** Supprime une catégorie inutilisée ; sinon impose l'archivage (historique lisible). */
  async deleteCategory(id: ID): Promise<void> {
    await this.own<Category>('categories', id);
    const children = await this.db.categories.where('userId').equals(this.userId).filter((c) => c.parentId === id).toArray();
    let usage = await this.categoryUsage(id);
    for (const c of children) usage += await this.categoryUsage(c.id);
    if (usage > 0) throw new ValidationError(tr('err.categoryUsed'));
    await this.db.categories.bulkDelete([id, ...children.map((c) => c.id)]);
  }

  async reorderCategories(orderedIds: ID[]): Promise<void> {
    await this.db.transaction('rw', this.db.categories, async () => {
      for (let i = 0; i < orderedIds.length; i++) {
        const c = await this.db.categories.get(orderedIds[i]);
        if (c && c.userId === this.userId) await this.db.categories.put({ ...c, order: i * 10, updatedAt: nowISO() });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  private async validationContext(existing?: Transaction[]) {
    const [accounts, categories] = await Promise.all([
      this.db.accounts.where('userId').equals(this.userId).toArray(),
      this.db.categories.where('userId').equals(this.userId).toArray(),
    ]);
    return {
      accounts: new Map(accounts.map((a) => [a.id, a])),
      categories: new Map(categories.map((c) => [c.id, c])),
      existing: existing
        ? {
            accountIds: existing.flatMap((t) => [t.accountId, t.counterpartAccountId].filter(Boolean) as ID[]),
            categoryIds: existing.flatMap((t) => [t.categoryId, t.subcategoryId].filter(Boolean) as ID[]),
          }
        : undefined,
    };
  }

  /** Construit les enregistrements d'une saisie (1 transaction, ou 2 jambes pour un transfert). */
  private buildFromDraft(
    d: TransactionDraft,
    accounts: Map<ID, Account>,
    base: Partial<Transaction> = {},
    ids: { main?: ID; counter?: ID; transferId?: ID } = {},
  ): Transaction[] {
    const now = nowISO();
    const acc = accounts.get(d.accountId!)!;
    const common = {
      userId: this.userId,
      label: d.label.trim(),
      date: d.date,
      paymentMethod: d.paymentMethod,
      payee: d.payee?.trim() || undefined,
      notes: d.notes?.trim() || undefined,
      tags: [...new Set(d.tags.map((t) => t.trim()).filter(Boolean))],
      status: d.status,
      createdAt: base.createdAt ?? now,
      updatedAt: now,
    };
    if (d.type === 'transfer') {
      const to = accounts.get(d.toAccountId!)!;
      const transferId = ids.transferId ?? newId();
      const label = common.label || tr('tx.transferLabel', { from: acc.name, to: to.name });
      const outLeg: Transaction = {
        ...base,
        ...common,
        label,
        id: ids.main ?? newId(),
        type: 'transfer',
        direction: 'out',
        amount: d.amount!,
        currency: acc.currency,
        accountId: acc.id,
        categoryId: d.categoryId,
        subcategoryId: null,
        transferId,
        counterpartAccountId: to.id,
      };
      const inLeg: Transaction = {
        ...common,
        label,
        id: ids.counter ?? newId(),
        type: 'transfer',
        direction: 'in',
        amount: to.currency === acc.currency ? d.amount! : d.toAmount!,
        currency: to.currency,
        accountId: to.id,
        categoryId: d.categoryId,
        subcategoryId: null,
        transferId,
        counterpartAccountId: acc.id,
      };
      return [outLeg, inLeg];
    }
    const direction = d.type === 'expense' ? 'out' : d.type === 'adjustment' ? d.direction! : 'in';
    const tx: Transaction = {
      ...base,
      ...common,
      id: ids.main ?? newId(),
      type: d.type,
      direction,
      amount: d.amount!,
      currency: acc.currency,
      accountId: acc.id,
      categoryId: d.type === 'adjustment' ? null : d.categoryId,
      subcategoryId: d.type === 'adjustment' ? null : d.subcategoryId,
      refundOfId: d.type === 'refund' ? d.refundOfId : undefined,
      transferId: undefined,
      counterpartAccountId: undefined,
    };
    return [tx];
  }

  async createTransaction(d: TransactionDraft, extra: Partial<Transaction> = {}): Promise<Transaction[]> {
    const ctx = await this.validationContext();
    const errors = validateTransactionDraft(d, ctx);
    if (hasErrors(errors)) throw new ValidationError(tr('err.transactionInvalid'), errors);
    const records = this.buildFromDraft(d, ctx.accounts, extra);
    await this.db.transactions.bulkAdd(records);
    return records;
  }

  /** Renvoie les enregistrements liés (les 2 jambes pour un transfert). */
  async getTransactionGroup(id: ID): Promise<Transaction[]> {
    const t = await this.own<Transaction>('transactions', id);
    if (t.transferId) {
      const legs = await this.db.transactions.where('transferId').equals(t.transferId).toArray();
      return legs.filter((l) => l.userId === this.userId);
    }
    return [t];
  }

  async updateTransaction(id: ID, d: TransactionDraft): Promise<Transaction[]> {
    const group = await this.getTransactionGroup(id);
    const ctx = await this.validationContext(group);
    const errors = validateTransactionDraft(d, ctx);
    if (hasErrors(errors)) throw new ValidationError(tr('err.transactionInvalid'), errors);
    const main = group.find((t) => t.direction === 'out') ?? group[0];
    const counter = group.find((t) => t !== main);
    // Préserve les liens métier (récurrence, import, pièce jointe, dette).
    const base: Partial<Transaction> = {
      createdAt: main.createdAt,
      attachmentId: main.attachmentId,
      recurringRuleId: main.recurringRuleId,
      recurringDueDate: main.recurringDueDate,
      importBatchId: main.importBatchId,
      debtId: main.debtId,
      debtPaymentId: main.debtPaymentId,
      interestAmount: main.interestAmount,
    };
    if (main.type === 'debt') throw new ValidationError(tr('err.debtTxEdit'));
    const records = this.buildFromDraft(d, ctx.accounts, base, {
      main: main.id,
      counter: d.type === 'transfer' ? counter?.id : undefined,
      transferId: d.type === 'transfer' ? main.transferId : undefined,
    });
    await this.db.transaction('rw', this.db.transactions, async () => {
      const keep = new Set(records.map((r) => r.id));
      const obsolete = group.filter((g) => !keep.has(g.id)).map((g) => g.id);
      if (obsolete.length) await this.db.transactions.bulkDelete(obsolete);
      await this.db.transactions.bulkPut(records);
    });
    return records;
  }

  /** Supprime des transactions (et leurs jambes / liens dépendants). */
  async deleteTransactions(ids: ID[]): Promise<number> {
    let removed = 0;
    await this.db.transaction(
      'rw',
      [this.db.transactions, this.db.occurrences, this.db.debtPayments, this.db.debts, this.db.attachments],
      async () => {
        const toDelete = new Set<ID>();
        for (const id of ids) {
          const t = await this.db.transactions.get(id);
          if (!t || t.userId !== this.userId) continue;
          toDelete.add(t.id);
          if (t.transferId) {
            const legs = await this.db.transactions.where('transferId').equals(t.transferId).toArray();
            legs.forEach((l) => l.userId === this.userId && toDelete.add(l.id));
          }
        }
        for (const id of toDelete) {
          const t = (await this.db.transactions.get(id))!;
          if (t.recurringRuleId && t.recurringDueDate) await this.dropPaidStateIfOrphan(t.recurringRuleId, t.recurringDueDate, toDelete);
          if (t.debtPaymentId) await this.db.debtPayments.delete(t.debtPaymentId);
          if (t.debtId && !t.debtPaymentId) {
            const debt = await this.db.debts.get(t.debtId);
            if (debt?.originTransactionId === t.id) await this.db.debts.put({ ...debt, originTransactionId: undefined, updatedAt: nowISO() });
          }
          if (t.attachmentId) await this.db.attachments.delete(t.attachmentId);
        }
        await this.db.transactions.bulkDelete([...toDelete]);
        removed = toDelete.size;
      },
    );
    return removed;
  }

  async recategorize(ids: ID[], categoryId: ID): Promise<void> {
    const cat = await this.own<Category>('categories', categoryId);
    await this.db.transaction('rw', this.db.transactions, async () => {
      for (const id of ids) {
        const t = await this.db.transactions.get(id);
        if (!t || t.userId !== this.userId) continue;
        const kindOk = (cat.kind === 'expense' && (t.type === 'expense' || t.type === 'refund')) || (cat.kind === 'income' && t.type === 'income');
        if (!kindOk) continue;
        await this.db.transactions.put({ ...t, categoryId: cat.parentId ?? cat.id, subcategoryId: cat.parentId ? cat.id : null, updatedAt: nowISO() });
      }
    });
  }

  async addAttachment(transactionId: ID, file: File): Promise<void> {
    if (file.size > 5 * 1024 * 1024) throw new ValidationError(tr('err.fileTooLarge'));
    if (!/^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(file.type)) throw new ValidationError(tr('err.fileFormat'));
    const t = await this.own<Transaction>('transactions', transactionId);
    const att: Attachment = { id: newId(), userId: this.userId, name: file.name, mimeType: file.type, size: file.size, blob: file, createdAt: nowISO() };
    await this.db.transaction('rw', this.db.transactions, this.db.attachments, async () => {
      if (t.attachmentId) await this.db.attachments.delete(t.attachmentId);
      await this.db.attachments.add(att);
      await this.db.transactions.put({ ...t, attachmentId: att.id, updatedAt: nowISO() });
    });
  }

  async getAttachment(id: ID): Promise<Attachment | undefined> {
    const a = await this.db.attachments.get(id);
    return a && a.userId === this.userId ? a : undefined;
  }

  async removeAttachment(transactionId: ID): Promise<void> {
    const t = await this.own<Transaction>('transactions', transactionId);
    if (!t.attachmentId) return;
    await this.db.transaction('rw', this.db.transactions, this.db.attachments, async () => {
      await this.db.attachments.delete(t.attachmentId!);
      await this.db.transactions.put({ ...t, attachmentId: undefined, updatedAt: nowISO() });
    });
  }

  /** Import en masse (déjà validé par l'assistant d'import). */
  async importTransactions(batch: Omit<ImportBatch, 'id' | 'userId' | 'createdAt'>, drafts: TransactionDraft[]): Promise<ImportBatch> {
    const ctx = await this.validationContext();
    const batchRec: ImportBatch = { ...batch, id: newId(), userId: this.userId, createdAt: nowISO() };
    const records: Transaction[] = [];
    for (const d of drafts) {
      const errors = validateTransactionDraft(d, ctx);
      if (hasErrors(errors)) throw new ValidationError(tr('err.importLine'), errors);
      records.push(...this.buildFromDraft(d, ctx.accounts, { importBatchId: batchRec.id }));
    }
    await this.db.transaction('rw', this.db.transactions, this.db.importBatches, async () => {
      await this.db.transactions.bulkAdd(records);
      await this.db.importBatches.add(batchRec);
    });
    return batchRec;
  }

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  async setBudget(month: MonthKey, categoryId: ID | null, amount: number, currency: string, options: { alertThresholds?: number[]; applyToFollowingMonths?: number } = {}): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new ValidationError(tr('err.budgetAmount'), { amount: tr('err.invalidAmount') });
    const months = [month];
    for (let i = 1; i <= (options.applyToFollowingMonths ?? 0); i++) months.push(addMonthsToKey(month, i));
    await this.db.transaction('rw', this.db.budgets, async () => {
      for (const m of months) {
        const existing = await this.db.budgets
          .where('[userId+month]')
          .equals([this.userId, m])
          .filter((b) => b.categoryId === categoryId)
          .first();
        if (existing) await this.db.budgets.put({ ...existing, amount, alertThresholds: options.alertThresholds ?? existing.alertThresholds, updatedAt: nowISO() });
        else await this.db.budgets.add(this.stamp({ month: m, categoryId, amount, currency, alertThresholds: options.alertThresholds }) as Budget);
      }
    });
  }

  async deleteBudget(id: ID): Promise<void> {
    await this.own<Budget>('budgets', id);
    await this.db.budgets.delete(id);
  }

  /** Copie les budgets d'un mois vers un autre (remplace ceux du mois cible si demandé). */
  async copyBudgets(from: MonthKey, to: MonthKey, overwrite = false): Promise<number> {
    let copied = 0;
    await this.db.transaction('rw', this.db.budgets, async () => {
      const src = await this.db.budgets.where('[userId+month]').equals([this.userId, from]).toArray();
      const dst = await this.db.budgets.where('[userId+month]').equals([this.userId, to]).toArray();
      for (const b of src) {
        const existing = dst.find((d) => d.categoryId === b.categoryId);
        if (existing && !overwrite) continue;
        if (existing) await this.db.budgets.put({ ...existing, amount: b.amount, alertThresholds: b.alertThresholds, updatedAt: nowISO() });
        else await this.db.budgets.add(this.stamp({ month: to, categoryId: b.categoryId, amount: b.amount, currency: b.currency, alertThresholds: b.alertThresholds }) as Budget);
        copied++;
      }
    });
    return copied;
  }

  // -------------------------------------------------------------------------
  // Objectifs
  // -------------------------------------------------------------------------

  async saveGoal(input: NewEntity<SavingsGoal> & { id?: ID }): Promise<SavingsGoal> {
    if (!input.name.trim()) throw new ValidationError(tr('err.nameRequired'), { name: tr('err.nameRequired') });
    if (!Number.isSafeInteger(input.targetAmount) || input.targetAmount <= 0) throw new ValidationError(tr('err.targetAmount'), { targetAmount: tr('err.targetAmount') });
    if (!Number.isSafeInteger(input.savedAmount) || input.savedAmount < 0) throw new ValidationError(tr('err.savedAmount'), { savedAmount: tr('err.invalidAmount') });
    if (input.targetDate && !isValidISODate(input.targetDate)) throw new ValidationError(tr('err.targetDate'), { targetDate: tr('err.invalidDate') });
    if (input.id) {
      const cur = await this.own<SavingsGoal>('goals', input.id);
      const next = { ...cur, ...input, id: cur.id, userId: this.userId, updatedAt: nowISO() } as SavingsGoal;
      await this.db.goals.put(next);
      return next;
    }
    const g = this.stamp(input) as SavingsGoal;
    await this.db.goals.add(g);
    return g;
  }

  async deleteGoal(id: ID): Promise<void> {
    await this.own<SavingsGoal>('goals', id);
    await this.db.transaction('rw', this.db.goals, this.db.goalContributions, async () => {
      await this.db.goalContributions.where('goalId').equals(id).delete();
      await this.db.goals.delete(id);
    });
  }

  /** Affectation (ou retrait) d'un montant à un objectif — ne crée aucun actif ni transaction. */
  async addGoalContribution(goalId: ID, amount: number, date: string, note?: string): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount === 0) throw new ValidationError(tr('err.invalidAmount'), { amount: tr('err.invalidAmount') });
    if (!isValidISODate(date)) throw new ValidationError(tr('err.invalidDate'), { date: tr('err.invalidDate') });
    const goal = await this.own<SavingsGoal>('goals', goalId);
    const saved = goal.savedAmount + amount;
    if (saved < 0) throw new ValidationError(tr('err.withdrawTooHigh'), { amount: tr('err.withdrawTooHighShort') });
    await this.db.transaction('rw', this.db.goals, this.db.goalContributions, async () => {
      await this.db.goalContributions.add({ id: newId(), userId: this.userId, goalId, amount, date, note, createdAt: nowISO() });
      const status = goal.status === 'active' && saved >= goal.targetAmount ? 'achieved' : goal.status === 'achieved' && saved < goal.targetAmount ? 'active' : goal.status;
      await this.db.goals.put({ ...goal, savedAmount: saved, status, updatedAt: nowISO() });
    });
  }

  // -------------------------------------------------------------------------
  // Paiements récurrents
  // -------------------------------------------------------------------------

  async saveRecurringRule(input: NewEntity<RecurringRule> & { id?: ID }): Promise<RecurringRule> {
    const f: Record<string, string> = {};
    if (!input.label.trim()) f.label = tr('err.labelRequired');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) f.amount = tr('err.invalidAmount');
    if (!isValidISODate(input.startDate)) f.startDate = tr('err.invalidDate');
    if (input.endDate && (!isValidISODate(input.endDate) || input.endDate < input.startDate)) f.endDate = tr('err.endAfterStart');
    if (input.frequency === 'custom' && !(Number(input.customInterval) >= 1)) f.customInterval = tr('err.interval');
    const acc = await this.db.accounts.get(input.accountId);
    if (!acc || acc.userId !== this.userId) f.accountId = tr('err.accountInvalid');
    if (Object.keys(f).length) throw new ValidationError(tr('err.recurringInvalid'), f);
    const data = { ...input, currency: acc!.currency };
    if (input.id) {
      const cur = await this.own<RecurringRule>('recurringRules', input.id);
      const next = { ...cur, ...data, id: cur.id, userId: this.userId, updatedAt: nowISO() } as RecurringRule;
      await this.db.recurringRules.put(next);
      return next;
    }
    const r = this.stamp(data) as RecurringRule;
    await this.db.recurringRules.add(r);
    return r;
  }

  /** Supprime la règle ; les transactions déjà payées restent (historique). */
  async deleteRecurringRule(id: ID): Promise<void> {
    await this.own<RecurringRule>('recurringRules', id);
    await this.db.transaction('rw', this.db.recurringRules, this.db.occurrences, async () => {
      await this.db.occurrences.where('ruleId').equals(id).delete();
      await this.db.recurringRules.delete(id);
    });
  }

  /**
   * Marque une échéance comme payée : crée explicitement la transaction réelle
   * (montant / date / compte confirmés par l'utilisateur) et la lie à l'échéance.
   */
  /** Opérations déjà associées à une échéance (lien porté par la transaction). */
  private async linkedTransactions(ruleId: ID, dueDate: string): Promise<Transaction[]> {
    return this.db.transactions.where('userId').equals(this.userId).filter((t) => t.recurringRuleId === ruleId && t.recurringDueDate === dueDate).toArray();
  }

  /**
   * Crée l'opération d'une échéance (ou de son reliquat). Refusé si l'échéance est déjà
   * réglée : on n'enregistre jamais deux fois le même paiement.
   */
  async markOccurrencePaid(ruleId: ID, dueDate: string, confirm: { date: string; amount: number; accountId: ID; label?: string }): Promise<Transaction> {
    const rule = await this.own<RecurringRule>('recurringRules', ruleId);
    const draft: TransactionDraft = {
      type: rule.kind,
      amount: confirm.amount,
      label: confirm.label ?? rule.label,
      date: confirm.date,
      categoryId: rule.categoryId,
      subcategoryId: rule.subcategoryId ?? null,
      accountId: confirm.accountId,
      payee: rule.payee,
      tags: [],
      status: 'cleared',
      paymentMethod: 'direct_debit',
    };
    const ctx = await this.validationContext();
    const errors = validateTransactionDraft(draft, ctx);
    if (hasErrors(errors)) throw new ValidationError(tr('err.occurrenceInvalid'), errors);
    const [tx] = this.buildFromDraft(draft, ctx.accounts, { recurringRuleId: ruleId, recurringDueDate: dueDate });
    await this.db.transaction('rw', this.db.transactions, this.db.occurrences, async () => {
      const id = occurrenceId(ruleId, dueDate);
      const st = await this.db.occurrences.get(id);
      const linked = await this.linkedTransactions(ruleId, dueDate);
      const paid = linked.filter((t) => t.currency === rule.currency).reduce((a, t) => a + t.amount, 0);
      if (st?.status === 'paid' || paid >= rule.amount) throw new ValidationError(tr('err.occurrenceAlreadyPaid'));
      await this.db.transactions.add(tx);
      // Paiement complet : l'échéance est marquée réglée et garde la trace de l'opération créée.
      // Paiement partiel : seul le lien est posé, le reliquat reste attendu.
      if (paid + (tx.currency === rule.currency ? tx.amount : rule.amount) >= rule.amount) {
        await this.db.occurrences.put({ id, userId: this.userId, ruleId, dueDate, status: 'paid', transactionId: tx.id, updatedAt: nowISO() });
      } else if (st) await this.db.occurrences.delete(id);
    });
    return tx;
  }

  /**
   * Associe une ou plusieurs opérations existantes à une échéance, sans créer de transaction.
   * Une opération ne règle qu'une échéance : celles déjà associées ailleurs sont refusées.
   */
  async linkOccurrence(ruleId: ID, dueDate: string, transactionIds: ID | ID[]): Promise<void> {
    const rule = await this.own<RecurringRule>('recurringRules', ruleId);
    const ids = [...new Set(Array.isArray(transactionIds) ? transactionIds : [transactionIds])];
    const txs = await Promise.all(ids.map((id) => this.own<Transaction>('transactions', id)));
    for (const t of txs) {
      if (t.type !== rule.kind) throw new ValidationError(tr('err.linkWrongType'));
      if (t.recurringRuleId && (t.recurringRuleId !== ruleId || t.recurringDueDate !== dueDate)) throw new ValidationError(tr('err.linkAlreadyLinked'));
    }
    await this.db.transaction('rw', this.db.transactions, this.db.occurrences, async () => {
      for (const t of txs) await this.db.transactions.put({ ...t, recurringRuleId: ruleId, recurringDueDate: dueDate, updatedAt: nowISO() });
      const id = occurrenceId(ruleId, dueDate);
      // Associer un paiement annule une éventuelle mise à l'écart de l'échéance.
      if ((await this.db.occurrences.get(id))?.status === 'skipped') await this.db.occurrences.delete(id);
    });
  }

  /** Retire le lien entre une opération et son échéance (l'opération est conservée). */
  async unlinkTransaction(transactionId: ID): Promise<void> {
    const t = await this.own<Transaction>('transactions', transactionId);
    if (!t.recurringRuleId || !t.recurringDueDate) return;
    const { recurringRuleId: ruleId, recurringDueDate: dueDate } = t;
    await this.db.transaction('rw', this.db.transactions, this.db.occurrences, async () => {
      await this.db.transactions.put({ ...t, recurringRuleId: undefined, recurringDueDate: undefined, updatedAt: nowISO() });
      await this.dropPaidStateIfOrphan(ruleId, dueDate, new Set([t.id]));
    });
  }

  /**
   * Après retrait d'opérations : l'état « réglée » est supprimé s'il désignait l'une d'elles
   * ou s'il ne reste aucun paiement associé ; le statut redevient alors calculé.
   */
  private async dropPaidStateIfOrphan(ruleId: ID, dueDate: string, removed: Set<ID>): Promise<void> {
    const id = occurrenceId(ruleId, dueDate);
    const st = await this.db.occurrences.get(id);
    if (!st || st.status !== 'paid') return;
    const remaining = (await this.linkedTransactions(ruleId, dueDate)).filter((x) => !removed.has(x.id));
    if ((st.transactionId && removed.has(st.transactionId)) || remaining.length === 0) await this.db.occurrences.delete(id);
  }

  /** Solde une échéance partiellement payée : le reliquat n'est plus attendu. */
  async settleOccurrence(ruleId: ID, dueDate: string): Promise<void> {
    await this.own<RecurringRule>('recurringRules', ruleId);
    if (!(await this.linkedTransactions(ruleId, dueDate)).length) throw new ValidationError(tr('err.settleNoPayment'));
    await this.db.occurrences.put({ id: occurrenceId(ruleId, dueDate), userId: this.userId, ruleId, dueDate, status: 'paid', updatedAt: nowISO() });
  }

  async skipOccurrence(ruleId: ID, dueDate: string): Promise<void> {
    await this.own<RecurringRule>('recurringRules', ruleId);
    await this.db.occurrences.put({ id: occurrenceId(ruleId, dueDate), userId: this.userId, ruleId, dueDate, status: 'skipped', updatedAt: nowISO() });
  }

  /**
   * Annule le statut d'une échéance : les opérations associées sont dissociées (conservées),
   * sauf celle créée par « Marquer payée », supprimée si demandé.
   */
  async resetOccurrence(ruleId: ID, dueDate: string, deleteTransaction: boolean): Promise<void> {
    const id = occurrenceId(ruleId, dueDate);
    const st = await this.db.occurrences.get(id);
    if (st && st.userId !== this.userId) return;
    if (st?.transactionId && deleteTransaction) await this.deleteTransactions([st.transactionId]);
    await this.db.transaction('rw', this.db.transactions, this.db.occurrences, async () => {
      for (const t of await this.linkedTransactions(ruleId, dueDate)) await this.db.transactions.put({ ...t, recurringRuleId: undefined, recurringDueDate: undefined, updatedAt: nowISO() });
      await this.db.occurrences.delete(id);
    });
  }

  // -------------------------------------------------------------------------
  // Dettes et créances
  // -------------------------------------------------------------------------

  async createDebt(input: NewEntity<Debt>, origin?: { accountId: ID; date: string }): Promise<Debt> {
    const f: Record<string, string> = {};
    if (!input.label.trim()) f.label = tr('err.labelRequired');
    if (!Number.isSafeInteger(input.principal) || input.principal <= 0) f.principal = tr('err.invalidAmount');
    if (!isValidISODate(input.startDate)) f.startDate = tr('err.invalidDate');
    if (input.dueDate && !isValidISODate(input.dueDate)) f.dueDate = tr('err.invalidDate');
    if (Object.keys(f).length) throw new ValidationError(tr('err.debtInvalid'), f);
    const debt = this.stamp(input) as Debt;
    await this.db.transaction('rw', this.db.debts, this.db.transactions, this.db.accounts, async () => {
      if (origin) {
        const acc = await this.own<Account>('accounts', origin.accountId);
        if (acc.currency !== debt.currency) throw new ValidationError(tr('err.accountCurrencyDebt'));
        const tx: Transaction = this.stamp({
          type: 'debt',
          direction: debt.direction === 'payable' ? 'in' : 'out',
          amount: debt.principal,
          currency: acc.currency,
          label: tr(debt.direction === 'payable' ? 'debt.label.borrowed' : 'debt.label.lent', { label: debt.label }),
          date: origin.date,
          categoryId: null,
          subcategoryId: null,
          accountId: acc.id,
          payee: debt.counterparty,
          tags: [],
          status: 'cleared',
          debtId: debt.id,
          interestAmount: 0,
        }) as Transaction;
        await this.db.transactions.add(tx);
        debt.originTransactionId = tx.id;
      }
      await this.db.debts.add(debt);
    });
    return debt;
  }

  async updateDebt(id: ID, patch: Partial<Debt>): Promise<void> {
    const cur = await this.own<Debt>('debts', id);
    const payments = await this.db.debtPayments.where('debtId').equals(id).toArray();
    const repaid = payments.reduce((a, p) => a + p.principal, 0);
    if (patch.principal != null && patch.principal < repaid) throw new ValidationError(tr('err.principalBelowRepaid'));
    await this.db.debts.put({ ...cur, ...patch, id, userId: this.userId, updatedAt: nowISO() });
  }

  async deleteDebt(id: ID): Promise<void> {
    const debt = await this.own<Debt>('debts', id);
    await this.db.transaction('rw', [this.db.debts, this.db.debtPayments, this.db.transactions], async () => {
      const payments = await this.db.debtPayments.where('debtId').equals(id).toArray();
      const txIds = payments.map((p) => p.transactionId).filter(Boolean) as ID[];
      if (debt.originTransactionId) txIds.push(debt.originTransactionId);
      await this.db.transactions.bulkDelete(txIds);
      await this.db.debtPayments.bulkDelete(payments.map((p) => p.id));
      await this.db.debts.delete(id);
    });
  }

  /**
   * Enregistre un remboursement : met à jour le restant dû et, si un compte est
   * indiqué, crée la transaction correspondante (principal neutre, intérêts en
   * dépense/revenu).
   */
  async addDebtPayment(debtId: ID, p: { date: string; principal: number; interest: number; accountId?: ID; note?: string }): Promise<DebtPayment> {
    const debt = await this.own<Debt>('debts', debtId);
    const payments = await this.db.debtPayments.where('debtId').equals(debtId).toArray();
    const err = validateDebtPayment(debt, payments, p.principal, p.interest);
    if (err) throw new ValidationError(err, { principal: err });
    if (!isValidISODate(p.date)) throw new ValidationError(tr('err.invalidDate'), { date: tr('err.invalidDate') });
    const payment: DebtPayment = { id: newId(), userId: this.userId, debtId, date: p.date, principal: p.principal, interest: p.interest, accountId: p.accountId, note: p.note, createdAt: nowISO() };
    await this.db.transaction('rw', [this.db.debts, this.db.debtPayments, this.db.transactions, this.db.accounts, this.db.categories], async () => {
      if (p.accountId) {
        const acc = await this.own<Account>('accounts', p.accountId);
        if (acc.currency !== debt.currency) throw new ValidationError(tr('err.accountCurrencyDebt'));
        const cats = await this.db.categories.where('userId').equals(this.userId).toArray();
        const interestCat = cats.find((c) => c.key === (debt.direction === 'payable' ? 'loan_payments' : 'dividends'));
        const tx = this.stamp({
          type: 'debt',
          direction: debt.direction === 'payable' ? 'out' : 'in',
          amount: p.principal + p.interest,
          currency: acc.currency,
          label: tr(debt.direction === 'payable' ? 'debt.label.repayment' : 'debt.label.collection', { label: debt.label }),
          date: p.date,
          categoryId: p.interest > 0 ? interestCat?.id ?? null : null,
          subcategoryId: null,
          accountId: acc.id,
          payee: debt.counterparty,
          notes: p.note,
          tags: [],
          status: 'cleared',
          debtId,
          debtPaymentId: payment.id,
          interestAmount: p.interest,
        }) as Transaction;
        await this.db.transactions.add(tx);
        payment.transactionId = tx.id;
      }
      await this.db.debtPayments.add(payment);
      const repaid = payments.reduce((a, x) => a + x.principal, 0) + p.principal;
      if (repaid >= debt.principal && debt.status === 'active') await this.db.debts.put({ ...debt, status: 'settled', updatedAt: nowISO() });
    });
    return payment;
  }

  async deleteDebtPayment(paymentId: ID): Promise<void> {
    const p = await this.own<DebtPayment>('debtPayments', paymentId);
    await this.db.transaction('rw', [this.db.debts, this.db.debtPayments, this.db.transactions], async () => {
      if (p.transactionId) await this.db.transactions.delete(p.transactionId);
      await this.db.debtPayments.delete(paymentId);
      const debt = await this.db.debts.get(p.debtId);
      if (debt?.status === 'settled') await this.db.debts.put({ ...debt, status: 'active', updatedAt: nowISO() });
    });
  }

  // -------------------------------------------------------------------------
  // Patrimoine & taux de change
  // -------------------------------------------------------------------------

  async saveAsset(input: NewEntity<Asset> & { id?: ID }, initialValuation?: { date: string; value: number }): Promise<Asset> {
    if (!input.name.trim()) throw new ValidationError(tr('err.nameRequired'), { name: tr('err.nameRequired') });
    if (input.linkedAccountId) {
      const others = await this.db.assets.where('userId').equals(this.userId).filter((a) => a.linkedAccountId === input.linkedAccountId && a.id !== input.id && !a.archived).count();
      if (others) throw new ValidationError(tr('err.accountAlreadyValued'));
    }
    let asset: Asset;
    if (input.id) {
      const cur = await this.own<Asset>('assets', input.id);
      asset = { ...cur, ...input, id: cur.id, userId: this.userId, updatedAt: nowISO() } as Asset;
      await this.db.assets.put(asset);
    } else {
      asset = this.stamp(input) as Asset;
      await this.db.assets.add(asset);
    }
    if (initialValuation) await this.addValuation(asset.id, initialValuation.date, initialValuation.value);
    return asset;
  }

  async deleteAsset(id: ID): Promise<void> {
    await this.own<Asset>('assets', id);
    await this.db.transaction('rw', this.db.assets, this.db.valuations, async () => {
      await this.db.valuations.where('assetId').equals(id).delete();
      await this.db.assets.delete(id);
    });
  }

  async addValuation(assetId: ID, date: string, value: number, note?: string): Promise<void> {
    await this.own<Asset>('assets', assetId);
    if (!isValidISODate(date)) throw new ValidationError(tr('err.invalidDate'), { date: tr('err.invalidDate') });
    if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError(tr('err.invalidValue'), { value: tr('err.invalidValue') });
    await this.db.valuations.add({ id: newId(), userId: this.userId, assetId, date, value, source: 'manual', note, createdAt: nowISO() });
  }

  async deleteValuation(id: ID): Promise<void> {
    await this.own<AssetValuation>('valuations', id);
    await this.db.valuations.delete(id);
  }

  async saveRate(base: string, quote: string, rate: number, date: string): Promise<void> {
    if (base === quote) throw new ValidationError(tr('err.sameCurrencies'));
    if (!(rate > 0) || !Number.isFinite(rate)) throw new ValidationError(tr('err.invalidRate'), { rate: tr('err.invalidRate') });
    if (!isValidISODate(date)) throw new ValidationError(tr('err.invalidDate'), { date: tr('err.invalidDate') });
    await this.db.rates.add({ id: newId(), userId: this.userId, base, quote, rate, date, source: 'manual', createdAt: nowISO() });
  }

  async deleteRate(id: ID): Promise<void> {
    await this.own<ExchangeRate>('rates', id);
    await this.db.rates.delete(id);
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  async setNotificationState(ids: string[], patch: { read?: boolean; dismissed?: boolean }): Promise<void> {
    await this.db.transaction('rw', this.db.notificationStates, async () => {
      for (const id of ids) {
        const cur = await this.db.notificationStates.get([this.userId, id]);
        await this.db.notificationStates.put({
          id,
          userId: this.userId,
          read: patch.read ?? cur?.read ?? false,
          dismissed: patch.dismissed ?? cur?.dismissed ?? false,
          updatedAt: nowISO(),
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Sauvegarde, restauration, réinitialisation
  // -------------------------------------------------------------------------

  async exportBackup(): Promise<BackupFile> {
    const data: Record<string, unknown[]> = {};
    for (const t of USER_TABLES) {
      data[t] = await (this.db[t] as unknown as { where(k: string): { equals(v: string): { toArray(): Promise<unknown[]> } } })
        .where('userId')
        .equals(this.userId)
        .toArray();
    }
    return { app: 'nexora', schemaVersion: SCHEMA_VERSION, exportedAt: nowISO(), data };
  }

  /** Remplace toutes les données de l'utilisateur par celles de la sauvegarde. */
  async restoreBackup(file: BackupFile): Promise<void> {
    if (file?.app !== 'nexora' || typeof file.data !== 'object') throw new ValidationError(tr('err.backupInvalid'));
    if (file.schemaVersion > SCHEMA_VERSION) throw new ValidationError(tr('err.backupNewer'));
    if (!Array.isArray(file.data.settings) || !file.data.settings.length) throw new ValidationError(tr('err.backupIncomplete'));
    const tables = [...USER_TABLES.map((t) => this.db[t]), this.db.attachments];
    await this.db.transaction('rw', tables, async () => {
      await this.clearUserData();
      for (const t of USER_TABLES) {
        const rows = (file.data[t] ?? []) as Record<string, unknown>[];
        const owned = rows.map((r) => ({ ...r, userId: this.userId, ...(t === 'settings' ? { id: this.userId } : {}) }));
        if (owned.length) await (this.db[t] as unknown as { bulkPut(r: unknown[]): Promise<unknown> }).bulkPut(owned);
      }
    });
  }

  /** Remplace toutes les données par un instantané (ex : jeu de démonstration). */
  async replaceWithSnapshot(s: DataSnapshot): Promise<void> {
    const data: Record<string, unknown[]> = {
      settings: [{ ...s.settings, id: this.userId, userId: this.userId }],
      accounts: s.accounts,
      categories: s.categories,
      transactions: s.transactions,
      budgets: s.budgets,
      goals: s.goals,
      goalContributions: s.goalContributions,
      recurringRules: s.recurringRules,
      occurrences: s.occurrences,
      debts: s.debts,
      debtPayments: s.debtPayments,
      assets: s.assets,
      valuations: s.valuations,
      rates: s.rates,
      notificationStates: s.notificationStates,
      importBatches: [],
    };
    await this.restoreBackup({ app: 'nexora', schemaVersion: SCHEMA_VERSION, exportedAt: nowISO(), data });
  }

  /** Efface tout puis recrée un espace vierge (catégories initiales) en conservant les préférences d'affichage. */
  async resetToEmpty(keep: Partial<UserSettings> = {}): Promise<void> {
    await this.clearUserData();
    await this.ensureUser(keep.displayName ?? '');
    await this.updateSettings({ ...keep, demoMode: false });
  }

  async clearUserData(): Promise<void> {
    const tables = [...USER_TABLES.map((t) => this.db[t]), this.db.attachments];
    await this.db.transaction('rw', tables, async () => {
      for (const t of [...USER_TABLES, 'attachments' as const]) {
        await (this.db[t] as unknown as { where(k: string): { equals(v: string): { delete(): Promise<number> } } })
          .where('userId')
          .equals(this.userId)
          .delete();
      }
    });
  }
}

export interface BackupFile {
  app: 'nexora';
  schemaVersion: number;
  exportedAt: string;
  data: Record<string, unknown[]>;
}
