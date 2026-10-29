/**
 * Jeu de démonstration FICTIF (profil illustratif en MAD).
 *
 * Généré de façon déterministe (générateur pseudo-aléatoire à graine fixe) sur les
 * 6 derniers mois jusqu'à aujourd'hui. Toutes les écritures passent par les mêmes
 * structures que l'application : les soldes, budgets et KPI découlent donc
 * mathématiquement des mouvements enregistrés.
 */
import type { ISODate, MonthKey } from '@/domain/dates';
import { addMonthsToKey, daysInMonth, makeDate, monthEnd, monthKey, monthStart, parseISO } from '@/domain/dates';
import { fromMajor } from '@/domain/money';
import { buildSeedCategories } from '@/domain/categories.seed';
import { defaultSettings } from '@/domain/settings';
import { newId } from '@/lib/id';
import { t as tr } from '@/i18n/core';
import { occurrenceDates, occurrenceId } from '@/domain/calc/recurring';
import type {
  Account,
  Asset,
  AssetValuation,
  Budget,
  Category,
  DataSnapshot,
  Debt,
  DebtPayment,
  ExchangeRate,
  GoalContribution,
  RecurringOccurrence,
  RecurringRule,
  SavingsGoal,
  Transaction,
  UserSettings,
} from '@/domain/types';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_MONTHS = 6;

export function generateDemoData(userId: string, today: ISODate, displayName = 'Sara'): DataSnapshot {
  const rnd = mulberry32(20261028);
  const between = (min: number, max: number) => min + rnd() * (max - min);
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
  const MAD = (v: number) => fromMajor(Math.round(v * 100) / 100, 'MAD');
  const created = new Date().toISOString();
  const stamp = { userId, createdAt: created, updatedAt: created };

  const currentMonth = monthKey(today);
  const firstMonth = addMonthsToKey(currentMonth, -(DEMO_MONTHS - 1));
  const start = monthStart(firstMonth);
  const months: MonthKey[] = [];
  for (let i = 0; i < DEMO_MONTHS; i++) months.push(addMonthsToKey(firstMonth, i));

  const settings: UserSettings = defaultSettings(userId, { displayName, onboarded: true, demoMode: true });
  const categories: Category[] = buildSeedCategories(userId);
  const cat = (key: string) => {
    const c = categories.find((x) => x.key === key);
    if (!c) throw new Error(`Catégorie ${key} absente`);
    return c;
  };
  const top = (key: string) => {
    const c = cat(key);
    return c.parentId ? { categoryId: c.parentId, subcategoryId: c.id } : { categoryId: c.id, subcategoryId: null };
  };

  // ---------------------------------------------------------------- Comptes
  const mkAccount = (name: string, type: Account['type'], currency: string, initial: number, color: string, order: number, description?: string): Account => ({
    id: newId(),
    ...stamp,
    name,
    type,
    currency,
    initialBalance: fromMajor(initial, currency),
    initialBalanceDate: start,
    archived: false,
    includeInTotal: true,
    color,
    description,
    order,
  });
  const checking = mkAccount(tr('demo.acc.checking'), 'bank', 'MAD', 8500, '#5271FF', 0, tr('demo.acc.checkingDesc'));
  const cash = mkAccount(tr('demo.acc.cash'), 'cash', 'MAD', 600, '#FFBF69', 1);
  const savings = mkAccount(tr('demo.acc.savings'), 'savings', 'MAD', 25000, '#25D9A0', 2, tr('demo.acc.savingsDesc'));
  const invest = mkAccount(tr('demo.acc.invest'), 'investment', 'MAD', 15000, '#9B7BFF', 3, tr('demo.acc.investDesc'));
  const eur = mkAccount('Wallet EUR', 'ewallet', 'EUR', 350, '#41E7F5', 4, tr('demo.acc.eurDesc'));
  const accounts = [checking, cash, savings, invest, eur];

  const rates: ExchangeRate[] = [
    { id: newId(), userId, base: 'EUR', quote: 'MAD', rate: 10.86, date: start, source: 'manual', createdAt: created },
    { id: newId(), userId, base: 'EUR', quote: 'MAD', rate: 10.92, date: monthStart(addMonthsToKey(currentMonth, -2)), source: 'manual', createdAt: created },
    { id: newId(), userId, base: 'USD', quote: 'MAD', rate: 9.98, date: start, source: 'manual', createdAt: created },
  ];

  const transactions: Transaction[] = [];
  const add = (t: Partial<Transaction> & Pick<Transaction, 'type' | 'direction' | 'amount' | 'label' | 'date' | 'accountId'>) => {
    const acc = accounts.find((a) => a.id === t.accountId)!;
    const tx: Transaction = {
      id: newId(),
      ...stamp,
      currency: acc.currency,
      categoryId: null,
      subcategoryId: null,
      tags: [],
      status: 'cleared',
      ...t,
    };
    transactions.push(tx);
    return tx;
  };
  const expense = (date: ISODate, amount: number, label: string, key: string, accountId: string, extra: Partial<Transaction> = {}) =>
    add({ type: 'expense', direction: 'out', amount, label, date, accountId, ...top(key), paymentMethod: accountId === cash.id ? 'cash' : 'card', payee: label, ...extra });
  const transfer = (date: ISODate, amount: number, from: Account, to: Account, label: string, catKey?: string, toAmount?: number) => {
    const transferId = newId();
    const categoryId = catKey ? cat(catKey).id : null;
    add({ type: 'transfer', direction: 'out', amount, label, date, accountId: from.id, transferId, counterpartAccountId: to.id, categoryId, paymentMethod: 'transfer' });
    add({ type: 'transfer', direction: 'in', amount: toAmount ?? amount, label, date, accountId: to.id, transferId, counterpartAccountId: from.id, categoryId, paymentMethod: 'transfer' });
  };
  const isPast = (d: ISODate) => d <= today;
  const day = (m: MonthKey, d: number) => {
    const [y, mo] = m.split('-').map(Number);
    return makeDate(y, mo, Math.min(d, daysInMonth(y, mo)));
  };

  // ------------------------------------------------------- Paiements récurrents
  const rule = (r: Omit<RecurringRule, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'currency' | 'active'> & { active?: boolean }): RecurringRule => ({
    id: newId(),
    ...stamp,
    currency: accounts.find((a) => a.id === r.accountId)!.currency,
    active: true,
    ...r,
  });
  const rules: RecurringRule[] = [
    rule({ kind: 'income', label: tr('demo.rule.salary'), amount: MAD(13000), accountId: checking.id, categoryId: cat('salary').id, payee: 'Atlas Digital SARL', frequency: 'monthly', startDate: day(firstMonth, 1) }),
    rule({ kind: 'expense', label: tr('demo.rule.rent'), amount: MAD(2800), accountId: checking.id, categoryId: cat('rent').id, payee: tr('demo.payee.landlord'), frequency: 'monthly', startDate: day(firstMonth, 3) }),
    rule({ kind: 'expense', label: tr('demo.rule.telecom'), amount: MAD(300), accountId: checking.id, categoryId: cat('telecom').id, payee: tr('demo.payee.telecom'), frequency: 'monthly', startDate: day(firstMonth, 10) }),
    rule({ kind: 'expense', label: tr('demo.rule.streaming'), amount: MAD(65), accountId: checking.id, ...top('streaming'), payee: tr('demo.payee.streaming'), frequency: 'monthly', startDate: day(firstMonth, 15) }),
    rule({ kind: 'expense', label: tr('demo.rule.insurance'), amount: MAD(450), accountId: checking.id, categoryId: cat('insurance').id, payee: tr('demo.payee.insurer'), frequency: 'quarterly', startDate: day(firstMonth, 20) }),
    rule({ kind: 'expense', label: tr('demo.rule.gym'), amount: MAD(250), accountId: checking.id, ...top('sport'), payee: tr('demo.payee.gym'), frequency: 'monthly', startDate: day(firstMonth, 25) }),
  ];
  const occurrences: RecurringOccurrence[] = [];
  for (const r of rules) {
    for (const due of occurrenceDates(r, start, today)) {
      const tx = add({
        type: r.kind,
        direction: r.kind === 'income' ? 'in' : 'out',
        amount: r.amount,
        label: r.label,
        date: due,
        accountId: r.accountId,
        categoryId: r.categoryId,
        subcategoryId: r.subcategoryId ?? null,
        payee: r.payee,
        paymentMethod: r.kind === 'income' ? 'transfer' : 'direct_debit',
        recurringRuleId: r.id,
        recurringDueDate: due,
      });
      occurrences.push({ id: occurrenceId(r.id, due), userId, ruleId: r.id, dueDate: due, status: 'paid', transactionId: tx.id, updatedAt: created });
    }
  }

  // ------------------------------------------------------------- Dépenses courantes
  const food = ['Marjane', 'Carrefour Market', tr('demo.m.grocery'), 'BIM', tr('demo.m.bakery')];
  const market = [tr('demo.m.centralMarket'), tr('demo.m.weeklySouk'), tr('demo.m.greengrocer')];
  const restos = [tr('demo.m.cafe'), 'Restaurant Dar Naji', tr('demo.m.delivery'), 'Pizzeria Venezia', tr('demo.m.teaRoom')];
  const outings = [tr('demo.m.cinema'), tr('demo.m.concert'), tr('demo.m.bowling'), tr('demo.m.museum')];
  const shops = ['Decathlon', tr('demo.m.bookshop'), tr('demo.m.appliances'), 'Zara'];

  months.forEach((m, mi) => {
    const restoFactor = mi === DEMO_MONTHS - 1 ? 1.32 : mi === DEMO_MONTHS - 2 ? 1.0 : between(0.85, 1.1);
    const foodFactor = between(0.92, 1.08);
    const dim = daysInMonth(...(m.split('-').map(Number) as [number, number]));

    // Virements internes (épargne, investissement, retrait d'espèces)
    if (isPast(day(m, 2))) transfer(day(m, 2), MAD(2000), checking, savings, tr('demo.tx.savings'), 'emergency_fund');
    if (isPast(day(m, 5))) transfer(day(m, 5), MAD(1000), checking, invest, tr('demo.tx.invest'), 'investments');
    if (isPast(day(m, 7))) transfer(day(m, 7), MAD(500), checking, cash, tr('demo.tx.atm'));
    if (isPast(day(m, 21))) transfer(day(m, 21), MAD(400), checking, cash, tr('demo.tx.atm'));

    // Eau et électricité (montant variable, non récurrent)
    if (isPast(day(m, 12))) expense(day(m, 12), MAD(Math.round(between(340, 480))), tr('demo.tx.utilities'), 'utilities', checking.id, { paymentMethod: 'direct_debit' });

    // Alimentation ≈ 1 600 DH (8 courses) dont souk en espèces
    const foodTargets = [260, 180, 240, 150, 220, 190, 210, 150].map((v) => v * foodFactor);
    foodTargets.forEach((v, i) => {
      const d = day(m, 2 + Math.floor((i * (dim - 3)) / foodTargets.length) + Math.floor(rnd() * 3));
      if (!isPast(d)) return;
      if (i % 3 === 1) expense(d, MAD(Math.round(v)), pick(market), 'market', cash.id);
      else expense(d, MAD(Math.round(v * 100) / 100), pick(food), 'groceries', checking.id);
    });

    // Restaurants ≈ 900 DH
    [170, 120, 210, 95, 160, 145].forEach((v, i) => {
      const d = day(m, 3 + Math.floor((i * (dim - 4)) / 6) + Math.floor(rnd() * 3));
      if (isPast(d)) expense(d, MAD(Math.round(v * restoFactor)), pick(restos), 'restaurants', i % 2 ? cash.id : checking.id);
    });

    // Transport ≈ 500 DH
    [{ v: 250, k: 'fuel', l: tr('demo.tx.fuel') }, { v: 60, k: 'public_transport', l: tr('demo.tx.taxi') }, { v: 45, k: 'public_transport', l: tr('demo.tx.tram') }, { v: 80, k: 'parking', l: tr('demo.tx.toll') }, { v: 65, k: 'public_transport', l: tr('demo.tx.taxi') }].forEach((x, i) => {
      const d = day(m, 4 + i * 5 + Math.floor(rnd() * 3));
      if (isPast(d)) expense(d, MAD(Math.round(x.v * between(0.85, 1.15))), x.l, x.k, x.k === 'public_transport' ? cash.id : checking.id);
    });

    // Loisirs ≈ 450 DH hors salle de sport (250, récurrent)
    [180, 140, 130].forEach((v, i) => {
      const d = day(m, 8 + i * 8 + Math.floor(rnd() * 3));
      if (isPast(d)) expense(d, MAD(Math.round(v * between(0.8, 1.2))), pick(outings), 'outings', checking.id);
    });

    // Divers : santé, habillement, shopping, dépenses personnelles
    const d1 = day(m, 9 + Math.floor(rnd() * 6));
    if (isPast(d1)) expense(d1, MAD(Math.round(between(80, 220))), tr('demo.tx.pharmacy'), 'health', checking.id);
    const d2 = day(m, 17 + Math.floor(rnd() * 5));
    if (isPast(d2) && mi % 2 === 0) expense(d2, MAD(Math.round(between(250, 450))), pick(shops), 'shopping', checking.id);
    const d3 = day(m, 14);
    if (isPast(d3)) expense(d3, MAD(Math.round(between(90, 160))), tr('demo.tx.hairdresser'), 'personal', cash.id);
    const d4 = day(m, 19);
    if (isPast(d4) && mi % 2 === 1) expense(d4, fromMajor(Math.round(between(28, 55) * 100) / 100, 'EUR'), tr('demo.tx.online'), 'shopping', eur.id);
  });

  // ------------------------------------------------------- Événements ponctuels
  const mAt = (offsetFromCurrent: number) => addMonthsToKey(currentMonth, offsetFromCurrent);
  const once = (date: ISODate, f: () => void) => {
    if (isPast(date) && date >= start) f();
  };
  once(day(mAt(-4), 11), () => add({ type: 'income', direction: 'in', amount: fromMajor(300, 'EUR'), label: tr('demo.tx.freelance'), date: day(mAt(-4), 11), accountId: eur.id, categoryId: cat('freelance').id, payee: tr('demo.payee.client'), paymentMethod: 'transfer' }));
  once(day(mAt(-3), 16), () => expense(day(mAt(-3), 16), MAD(3200), tr('demo.tx.carRepair'), 'transport', checking.id, { payee: tr('demo.payee.garage'), tags: [tr('demo.tag.exceptional')] }));
  let healthExpenseId: string | undefined;
  once(day(mAt(-2), 8), () => {
    healthExpenseId = expense(day(mAt(-2), 8), MAD(1200), tr('demo.tx.medical'), 'health', checking.id, { payee: tr('demo.payee.clinic') }).id;
  });
  once(day(mAt(-2), 24), () => add({ type: 'refund', direction: 'in', amount: MAD(840), label: tr('demo.tx.refund'), date: day(mAt(-2), 24), accountId: checking.id, categoryId: cat('health').id, refundOfId: healthExpenseId, payee: tr('demo.payee.mutual'), paymentMethod: 'transfer' }));
  once(day(mAt(-2), 13), () => expense(day(mAt(-2), 13), MAD(4200), tr('demo.tx.flights'), 'travel', checking.id, { payee: tr('demo.payee.airline'), tags: [tr('demo.tag.holidays'), tr('demo.tag.exceptional')] }));
  once(day(mAt(-1), 28), () => add({ type: 'income', direction: 'in', amount: MAD(2500), label: tr('demo.tx.bonus'), date: day(mAt(-1), 28), accountId: checking.id, categoryId: cat('bonus').id, payee: 'Atlas Digital SARL', paymentMethod: 'transfer' }));
  once(day(mAt(-1), 6), () => expense(day(mAt(-1), 6), MAD(650), tr('demo.tx.gift'), 'gifts', checking.id, { payee: tr('demo.payee.jeweller') }));
  once(day(mAt(-5), 18), () => add({ type: 'adjustment', direction: 'out', amount: MAD(35), label: tr('demo.tx.cashAdjust'), date: day(mAt(-5), 18), accountId: cash.id, notes: tr('demo.tx.cashAdjustNote') }));
  once(day(mAt(-3), 26), () => transfer(day(mAt(-3), 26), MAD(1092), checking, eur, tr('demo.tx.eurTopUp'), undefined, fromMajor(100, 'EUR')));

  // ------------------------------------------------------- Dettes et créances
  const debts: Debt[] = [];
  const debtPayments: DebtPayment[] = [];
  const loanStart = addMonthsToKey(currentMonth, -14);
  const carLoan: Debt = {
    id: newId(),
    ...stamp,
    label: tr('demo.debt.carLoan'),
    type: 'loan',
    direction: 'payable',
    principal: MAD(60000),
    currency: 'MAD',
    startDate: day(loanStart, 6),
    dueDate: day(addMonthsToKey(loanStart, 48), 6),
    counterparty: tr('demo.payee.bank'),
    interestRate: 5.2,
    installmentAmount: MAD(1450),
    installmentFrequency: 'monthly',
    status: 'active',
    notes: tr('demo.debt.carLoanNote'),
  };
  debts.push(carLoan);
  let remaining = carLoan.principal;
  for (let i = 1; ; i++) {
    const m = addMonthsToKey(loanStart, i);
    const d = day(m, 6);
    if (!isPast(d)) break;
    const interest = Math.round((remaining * 0.052) / 12);
    const principal = MAD(1450) - interest;
    remaining -= principal;
    const p: DebtPayment = { id: newId(), userId, debtId: carLoan.id, date: d, principal, interest, createdAt: created };
    if (d >= start) {
      const tx = add({ type: 'debt', direction: 'out', amount: principal + interest, label: tr('debt.label.repayment', { label: carLoan.label }), date: d, accountId: checking.id, categoryId: cat('loan_payments').id, payee: carLoan.counterparty, debtId: carLoan.id, debtPaymentId: p.id, interestAmount: interest, paymentMethod: 'direct_debit' });
      p.accountId = checking.id;
      p.transactionId = tx.id;
    } else {
      p.note = tr('demo.debt.before');
    }
    debtPayments.push(p);
  }

  const lentDate = day(mAt(-2), 15);
  if (isPast(lentDate) && lentDate >= start) {
    const lent: Debt = {
      id: newId(),
      ...stamp,
      label: tr('demo.debt.lent'),
      type: 'lent',
      direction: 'receivable',
      principal: MAD(2000),
      currency: 'MAD',
      startDate: lentDate,
      dueDate: day(mAt(1), 15),
      counterparty: 'Yassine',
      status: 'active',
    };
    const origin = add({ type: 'debt', direction: 'out', amount: lent.principal, label: tr('debt.label.lent', { label: lent.label }), date: lentDate, accountId: checking.id, payee: 'Yassine', debtId: lent.id, interestAmount: 0, paymentMethod: 'transfer' });
    lent.originTransactionId = origin.id;
    debts.push(lent);
    const back = day(mAt(-1), 20);
    if (isPast(back)) {
      const p: DebtPayment = { id: newId(), userId, debtId: lent.id, date: back, principal: MAD(1000), interest: 0, accountId: checking.id, createdAt: created };
      const tx = add({ type: 'debt', direction: 'in', amount: MAD(1000), label: tr('debt.label.collection', { label: lent.label }), date: back, accountId: checking.id, payee: 'Yassine', debtId: lent.id, debtPaymentId: p.id, interestAmount: 0, paymentMethod: 'transfer' });
      p.transactionId = tx.id;
      debtPayments.push(p);
    }
  }

  // ------------------------------------------------------------- Budgets
  const budgets: Budget[] = [];
  const budgetPlan: [string | null, number][] = [
    [null, 9500],
    ['rent', 2800],
    ['utilities', 450],
    ['telecom', 300],
    ['food', 1700],
    ['restaurants', 900],
    ['transport', 600],
    ['leisure', 700],
    ['shopping', 400],
    ['health', 300],
  ];
  for (const m of months) {
    for (const [key, amount] of budgetPlan) {
      budgets.push({ id: newId(), ...stamp, month: m, categoryId: key ? cat(key).id : null, amount: MAD(amount), currency: 'MAD' });
    }
  }

  // ------------------------------------------------------------- Objectifs
  const goal = (g: Omit<SavingsGoal, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'currency'>): SavingsGoal => ({ id: newId(), ...stamp, currency: 'MAD', ...g });
  const goals: SavingsGoal[] = [
    goal({ name: tr('demo.goal.emergency'), description: tr('demo.goal.emergencyDesc'), targetAmount: MAD(60000), savedAmount: 0, targetDate: day(mAt(14), 28), priority: 'high', linkedAccountId: savings.id, trackLinkedAccount: true, monthlyContribution: MAD(2000), status: 'active', icon: 'LifeBuoy', color: '#25D9A0' }),
    goal({ name: tr('demo.goal.japan'), description: tr('demo.goal.japanDesc'), targetAmount: MAD(25000), savedAmount: MAD(8000), targetDate: day(mAt(12), 30), priority: 'medium', trackLinkedAccount: false, monthlyContribution: MAD(1500), status: 'active', icon: 'Plane', color: '#41E7F5' }),
    goal({ name: tr('demo.goal.car'), description: tr('demo.goal.carDesc'), targetAmount: MAD(120000), savedAmount: MAD(15000), targetDate: day(mAt(24), 1), priority: 'low', trackLinkedAccount: false, monthlyContribution: MAD(2500), status: 'active', icon: 'Car', color: '#9B7BFF' }),
    goal({ name: tr('demo.goal.training'), description: tr('demo.goal.trainingDesc'), targetAmount: MAD(6000), savedAmount: MAD(6000), targetDate: day(mAt(-1), 1), priority: 'medium', trackLinkedAccount: false, monthlyContribution: MAD(1000), status: 'achieved', icon: 'GraduationCap', color: '#FFBF69' }),
  ];
  const goalContributions: GoalContribution[] = [];
  const japan = goals[1];
  [3000, 1500, 1500, 2000].forEach((v, i) => {
    goalContributions.push({ id: newId(), userId, goalId: japan.id, date: day(mAt(-4 + i), 3), amount: MAD(v), note: tr('demo.goal.contribution'), createdAt: created });
  });

  // ------------------------------------------------------------- Patrimoine
  const car: Asset = { id: newId(), ...stamp, name: tr('demo.asset.car'), type: 'vehicle', currency: 'MAD', archived: false, notes: tr('demo.asset.carNote') };
  const portfolio: Asset = { id: newId(), ...stamp, name: tr('demo.asset.portfolio'), type: 'investment', currency: 'MAD', linkedAccountId: invest.id, archived: false, notes: tr('demo.asset.portfolioNote') };
  const assets: Asset[] = [car, portfolio];
  const valuations: AssetValuation[] = [];
  const val = (assetId: string, date: ISODate, value: number, note?: string) =>
    valuations.push({ id: newId(), userId, assetId, date, value: MAD(value), source: 'manual', note, createdAt: created });
  val(car.id, start, 98000, tr('demo.val.initial'));
  val(car.id, monthStart(mAt(-2)), 95000, tr('demo.val.updated'));
  months.forEach((m, i) => {
    const d = i === months.length - 1 ? (today < monthEnd(m) ? today : monthEnd(m)) : monthEnd(m);
    if (d > today) return;
    const book = 15000 + 1000 * (i + 1);
    const perf = [1.012, 1.004, 0.991, 1.018, 1.026, 1.031][i] ?? 1;
    val(portfolio.id, d, Math.round(book * perf), tr('demo.val.broker'));
  });

  return {
    settings,
    accounts,
    categories,
    transactions,
    budgets,
    goals,
    goalContributions,
    recurringRules: rules,
    occurrences,
    debts,
    debtPayments,
    assets,
    valuations,
    rates,
    notificationStates: [],
  };
}

/** Date de début du jeu de démonstration. */
export function demoStart(today: ISODate): ISODate {
  return monthStart(addMonthsToKey(monthKey(today), -(DEMO_MONTHS - 1)));
}

export function demoDayOfMonth(today: ISODate): number {
  return parseISO(today).d;
}
