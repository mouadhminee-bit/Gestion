/**
 * Règles comptables centrales de NEXORA.
 *
 * Toutes les vues (dashboard, budgets, analyses, rapports, assistant) passent par
 * ces fonctions : un même indicateur a donc partout la même valeur.
 *
 * Définitions :
 *  - Revenus           = transactions `income` (+ intérêts perçus sur créances).
 *  - Dépenses brutes   = transactions `expense` (+ intérêts payés sur dettes).
 *  - Remboursements    = transactions `refund` (argent rendu sur une dépense).
 *  - Dépenses (conso.) = Dépenses brutes − Remboursements reçus.
 *  - Épargne nette     = Revenus − Dépenses (conso.).
 *  - Taux d'épargne    = Épargne nette ÷ Revenus (non calculable si Revenus ≤ 0).
 *
 * Ne sont JAMAIS des revenus ni des dépenses :
 *  - les transferts internes (y compris vers l'épargne ou l'investissement),
 *  - les ajustements de solde,
 *  - le principal d'un emprunt reçu / d'un prêt accordé / d'un remboursement de dette.
 */
import type { CurrencyCode, MoneyBag } from '../money';
import { addToBag } from '../money';
import type { ISODate, Period } from '../dates';
import { addDays, diffDays, inPeriod } from '../dates';
import type { Account, Category, DataSnapshot, ID, Transaction } from '../types';
import type { Converter } from './fx';
import { makeConverter } from './fx';

export interface LedgerContext {
  base: CurrencyCode;
  convert: Converter;
  accounts: Map<ID, Account>;
  categories: Map<ID, Category>;
}

export function buildContext(snapshot: Pick<DataSnapshot, 'settings' | 'rates' | 'accounts' | 'categories'>): LedgerContext {
  return {
    base: snapshot.settings.baseCurrency,
    convert: makeConverter(snapshot.settings.baseCurrency, snapshot.rates),
    accounts: new Map(snapshot.accounts.map((a) => [a.id, a])),
    categories: new Map(snapshot.categories.map((c) => [c.id, c])),
  };
}

/** Effet signé d'une transaction sur le solde de son compte. */
export function signedAmount(t: Pick<Transaction, 'amount' | 'direction'>): number {
  return t.direction === 'in' ? t.amount : -t.amount;
}

/** Catégorie de premier niveau d'une transaction (agrégation des sous-catégories). */
export function topCategoryId(ctx: LedgerContext, categoryId: ID | null | undefined): ID | null {
  if (!categoryId) return null;
  const c = ctx.categories.get(categoryId);
  if (!c) return categoryId;
  return c.parentId ?? c.id;
}

export type FlowKind = 'income' | 'expense' | 'refund' | 'neutral';

/**
 * Part d'une transaction comptée en revenu / dépense / remboursement, dans sa devise.
 * Les transferts, ajustements et principal de dettes sont neutres.
 */
export function flowOf(t: Transaction): { kind: FlowKind; amount: number } {
  switch (t.type) {
    case 'income':
      return { kind: 'income', amount: t.amount };
    case 'expense':
      return { kind: 'expense', amount: t.amount };
    case 'refund':
      return { kind: 'refund', amount: t.amount };
    case 'debt': {
      const interest = Math.min(Math.max(t.interestAmount ?? 0, 0), t.amount);
      if (!interest) return { kind: 'neutral', amount: 0 };
      return t.direction === 'out' ? { kind: 'expense', amount: interest } : { kind: 'income', amount: interest };
    }
    default:
      return { kind: 'neutral', amount: 0 };
  }
}

export interface CategoryAmount {
  categoryId: ID | null;
  amount: number;
  count: number;
}

export interface PeriodSummary {
  period: Period;
  income: number;
  grossExpenses: number;
  refunds: number;
  /** Dépenses de consommation nettes des remboursements. */
  expenses: number;
  netSavings: number;
  /** null si les revenus sont nuls ou négatifs. */
  savingsRate: number | null;
  fixedExpenses: number;
  variableExpenses: number;
  transfers: number;
  transactionCount: number;
  /** Dépenses nettes par catégorie de premier niveau (montants en devise de base). */
  expensesByCategory: Map<ID | null, CategoryAmount>;
  /** Dépenses nettes par sous-catégorie (clé = id de sous-catégorie). */
  expensesBySubcategory: Map<ID, CategoryAmount>;
  incomeByCategory: Map<ID | null, CategoryAmount>;
  /** Montants non convertibles faute de taux (exclus des totaux). */
  unconverted: MoneyBag;
}

export interface TransactionFilter {
  accountIds?: ID[];
  categoryIds?: ID[]; // catégories de 1er niveau ou sous-catégories
  types?: Transaction['type'][];
  tags?: string[];
  excludeArchivedAccounts?: boolean;
}

export function matchesFilter(ctx: LedgerContext, t: Transaction, f?: TransactionFilter): boolean {
  if (!f) return true;
  if (f.accountIds?.length && !f.accountIds.includes(t.accountId)) return false;
  if (f.types?.length && !f.types.includes(t.type)) return false;
  if (f.tags?.length && !f.tags.some((tag) => t.tags.includes(tag))) return false;
  if (f.categoryIds?.length) {
    const top = topCategoryId(ctx, t.categoryId);
    const ok =
      (t.categoryId && f.categoryIds.includes(t.categoryId)) ||
      (t.subcategoryId && f.categoryIds.includes(t.subcategoryId)) ||
      (top && f.categoryIds.includes(top));
    if (!ok) return false;
  }
  if (f.excludeArchivedAccounts && ctx.accounts.get(t.accountId)?.archived) return false;
  return true;
}

function bump(map: Map<ID | null, CategoryAmount>, key: ID | null, amount: number) {
  const cur = map.get(key);
  if (cur) {
    cur.amount += amount;
    cur.count += 1;
  } else map.set(key, { categoryId: key, amount, count: 1 });
}

/** Synthèse financière d'une période (en devise de base). */
export function summarizePeriod(
  ctx: LedgerContext,
  transactions: Transaction[],
  period: Period,
  filter?: TransactionFilter,
): PeriodSummary {
  const s: PeriodSummary = {
    period,
    income: 0,
    grossExpenses: 0,
    refunds: 0,
    expenses: 0,
    netSavings: 0,
    savingsRate: null,
    fixedExpenses: 0,
    variableExpenses: 0,
    transfers: 0,
    transactionCount: 0,
    expensesByCategory: new Map(),
    expensesBySubcategory: new Map(),
    incomeByCategory: new Map(),
    unconverted: {},
  };
  for (const t of transactions) {
    if (!inPeriod(t.date, period) || !matchesFilter(ctx, t, filter)) continue;
    s.transactionCount += 1;
    if (t.type === 'transfer' && t.direction === 'out') {
      const v = ctx.convert(t.amount, t.currency, t.date);
      if (v != null) s.transfers += v;
    }
    const flow = flowOf(t);
    if (flow.kind === 'neutral') continue;
    const value = ctx.convert(flow.amount, t.currency, t.date);
    if (value == null) {
      addToBag(s.unconverted, t.currency, flow.kind === 'income' ? flow.amount : -flow.amount);
      continue;
    }
    const top = topCategoryId(ctx, t.categoryId);
    const sub = t.subcategoryId ?? (t.categoryId && ctx.categories.get(t.categoryId)?.parentId ? t.categoryId : null);
    if (flow.kind === 'income') {
      s.income += value;
      bump(s.incomeByCategory, top, value);
      continue;
    }
    const signed = flow.kind === 'expense' ? value : -value;
    if (flow.kind === 'expense') s.grossExpenses += value;
    else s.refunds += value;
    bump(s.expensesByCategory, top, signed);
    if (sub) bump(s.expensesBySubcategory as Map<ID | null, CategoryAmount>, sub, signed);
    const nature = top ? ctx.categories.get(top)?.nature : undefined;
    if (nature === 'fixed') s.fixedExpenses += signed;
    else s.variableExpenses += signed;
  }
  s.expenses = s.grossExpenses - s.refunds;
  s.netSavings = s.income - s.expenses;
  s.savingsRate = s.income > 0 ? s.netSavings / s.income : null;
  return s;
}

// ---------------------------------------------------------------------------
// Soldes
// ---------------------------------------------------------------------------

/**
 * Solde d'un compte à la fin de la journée `asOf` (dans la devise du compte).
 *
 * Le solde initial est un point d'ancrage valable au DÉBUT de `initialBalanceDate` :
 *  - les mouvements datés à partir de cette date s'y ajoutent ;
 *  - les mouvements antérieurs expliquent le solde initial : ils ne modifient pas
 *    le solde courant, mais servent à reconstituer les soldes passés.
 */
export function accountBalance(account: Account, transactions: Transaction[], asOf?: ISODate): number {
  let balance = account.initialBalance;
  const anchor = account.initialBalanceDate;
  for (const t of transactions) {
    if (t.accountId !== account.id) continue;
    if (t.date >= anchor) {
      if (!asOf || t.date <= asOf) balance += signedAmount(t);
    } else if (asOf && t.date > asOf) {
      // Mouvement antérieur au point d'ancrage mais postérieur à la date demandée.
      balance -= signedAmount(t);
    }
  }
  return balance;
}

export function accountBalances(accounts: Account[], transactions: Transaction[], asOf?: ISODate): Map<ID, number> {
  const map = new Map<ID, number>();
  for (const a of accounts) map.set(a.id, a.initialBalance);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const t of transactions) {
    const a = byId.get(t.accountId);
    if (!a) continue;
    if (t.date >= a.initialBalanceDate) {
      if (!asOf || t.date <= asOf) map.set(a.id, (map.get(a.id) ?? 0) + signedAmount(t));
    } else if (asOf && t.date > asOf) {
      map.set(a.id, (map.get(a.id) ?? 0) - signedAmount(t));
    }
  }
  return map;
}

export interface TotalBalance {
  total: number;
  unconverted: MoneyBag;
  byCurrency: MoneyBag;
  accountCount: number;
}

/** Comptes inclus dans le périmètre du « solde total ». */
export function accountsInScope(accounts: Account[]): Account[] {
  return accounts.filter((a) => !a.archived && a.includeInTotal);
}

/**
 * Solde total converti en devise de base à la date `asOf`.
 * Les soldes sans taux disponible sont exclus du total et listés par devise.
 */
export function totalBalance(
  ctx: LedgerContext,
  accounts: Account[],
  transactions: Transaction[],
  asOf: ISODate,
): TotalBalance {
  const balances = accountBalances(accounts, transactions, asOf);
  const res: TotalBalance = { total: 0, unconverted: {}, byCurrency: {}, accountCount: accounts.length };
  for (const a of accounts) {
    const b = balances.get(a.id) ?? 0;
    addToBag(res.byCurrency, a.currency, b);
    const v = ctx.convert(b, a.currency, asOf);
    if (v == null) addToBag(res.unconverted, a.currency, b);
    else res.total += v;
  }
  return res;
}

/**
 * Série quotidienne du solde total (fin de journée) sur une période.
 * La variation d'un jour est toujours la somme des mouvements de ce jour,
 * ce qui reste cohérent avec `accountBalance` de part et d'autre de l'ancrage.
 */
export function dailyBalanceSeries(
  ctx: LedgerContext,
  accounts: Account[],
  transactions: Transaction[],
  period: Period,
): { date: ISODate; balance: number }[] {
  const ids = new Set(accounts.map((a) => a.id));
  const relevant = transactions.filter((t) => ids.has(t.accountId));
  const running = accountBalances(accounts, relevant, addDays(period.start, -1));
  const deltas = new Map<ISODate, Transaction[]>();
  for (const t of relevant) {
    if (!inPeriod(t.date, period)) continue;
    const list = deltas.get(t.date);
    if (list) list.push(t);
    else deltas.set(t.date, [t]);
  }
  const out: { date: ISODate; balance: number }[] = [];
  const days = diffDays(period.end, period.start) + 1;
  for (let i = 0; i < days; i++) {
    const d = addDays(period.start, i);
    for (const t of deltas.get(d) ?? []) running.set(t.accountId, (running.get(t.accountId) ?? 0) + signedAmount(t));
    let total = 0;
    for (const a of accounts) {
      const v = ctx.convert(running.get(a.id) ?? 0, a.currency, d);
      if (v != null) total += v;
    }
    out.push({ date: d, balance: total });
  }
  return out;
}

/** Les deux jambes d'un transfert (identifiées par `transferId`). */
export function transferLegs(transactions: Transaction[], transferId: ID): { out?: Transaction; in?: Transaction } {
  const legs = transactions.filter((t) => t.transferId === transferId);
  return { out: legs.find((l) => l.direction === 'out'), in: legs.find((l) => l.direction === 'in') };
}
