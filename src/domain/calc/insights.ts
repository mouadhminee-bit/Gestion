/**
 * Moteur d'insights déterministe (sans IA).
 *
 * Chaque observation :
 *  - est calculée à partir des données réelles via les fonctions communes ;
 *  - explique son origine (`source`) ;
 *  - n'est émise que si les données sont suffisantes et comparables.
 */
import type { ISODate } from '../dates';
import { addDays, addMonthsToKey, daysInMonth, formatDate, makeDate, monthKey, monthPeriod, parseISO } from '../dates';
import { formatPercent } from '../money';
import type { DataSnapshot, NotificationSeverity } from '../types';
import type { LedgerContext } from './ledger';
import { accountBalances, summarizePeriod } from './ledger';
import { monthBudgetOverview } from './budgets';
import { computeGoalProgress } from './goals';
import { listOccurrences, pendingOccurrences } from './recurring';
import type { MonthForecast } from './forecast';
import { relativeChange } from './analytics';
import { t } from '@/i18n/core';

export interface Insight {
  id: string;
  kind: 'category_trend' | 'budget' | 'pace' | 'goal' | 'bill' | 'savings_rate' | 'top_category' | 'data';
  severity: NotificationSeverity;
  title: string;
  message: string;
  source: string;
  href?: string;
}

export interface InsightOptions {
  fmt: (minor: number) => string;
  locale: string;
  monthName: (month: string) => string;
  thresholds: number[];
  billReminderDays: number;
  dateFormat: Parameters<typeof formatDate>[1];
}

const MIN_CATEGORY_TX = 2;
const MIN_CHANGE = 0.1;

export function generateInsights(
  ctx: LedgerContext,
  data: DataSnapshot,
  today: ISODate,
  forecast: MonthForecast | null,
  opt: InsightOptions,
): Insight[] {
  const out: Insight[] = [];
  const month = monthKey(today);
  const prevMonth = addMonthsToKey(month, -1);
  const day = parseISO(today).d;
  const [py, pm] = prevMonth.split('-').map(Number);
  const prevDay = Math.min(day, daysInMonth(py, pm));
  const curPeriod = { start: `${month}-01`, end: today };
  const prevPeriod = { start: `${prevMonth}-01`, end: makeDate(py, pm, prevDay) };
  const cur = summarizePeriod(ctx, data.transactions, curPeriod);
  const prev = summarizePeriod(ctx, data.transactions, prevPeriod);
  const catName = (id: string | null) => (id ? ctx.categories.get(id)?.name ?? t('common.deletedCategory') : t('common.uncategorized'));

  if (cur.transactionCount === 0 && prev.transactionCount === 0) {
    out.push({
      id: 'data:empty',
      kind: 'data',
      severity: 'info',
      title: t('ins.empty.title'),
      message: t('ins.empty.message'),
      source: t('ins.empty.source'),
      href: '/transactions',
    });
    return out;
  }

  // 1. Évolution des dépenses par catégorie, à période égale.
  const trends: { insight: Insight; weight: number }[] = [];
  for (const [catId, c] of cur.expensesByCategory) {
    const p = prev.expensesByCategory.get(catId);
    if (!p || c.count < MIN_CATEGORY_TX || p.count < MIN_CATEGORY_TX || p.amount <= 0 || c.amount <= 0) continue;
    const change = relativeChange(c.amount, p.amount);
    if (change == null || Math.abs(change) < MIN_CHANGE) continue;
    const up = change > 0;
    trends.push({ weight: Math.abs(c.amount - p.amount), insight: {
      id: `trend:${catId}:${month}`,
      kind: 'category_trend',
      severity: up ? (change > 0.25 ? 'warning' : 'info') : 'success',
      title: t(up ? 'ins.trend.up' : 'ins.trend.down', { category: catName(catId), pct: formatPercent(Math.abs(change), opt.locale) }),
      message: t('ins.trend.message', { amount: opt.fmt(c.amount), category: catName(catId), start: formatDate(curPeriod.start, opt.dateFormat), end: formatDate(curPeriod.end, opt.dateFormat), previous: opt.fmt(p.amount) }),
      source: t('ins.trend.source', { curStart: formatDate(curPeriod.start, opt.dateFormat), curEnd: formatDate(curPeriod.end, opt.dateFormat), prevStart: formatDate(prevPeriod.start, opt.dateFormat), prevEnd: formatDate(prevPeriod.end, opt.dateFormat), curCount: c.count, prevCount: p.count }),
      href: '/analytics',
    } });
  }
  // Les 3 écarts les plus importants en valeur absolue.
  trends
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .forEach((t) => out.push(t.insight));

  // 2. Budgets : seuils atteints (mois en cours).
  const monthSummary = summarizePeriod(ctx, data.transactions, monthPeriod(month));
  const overview = monthBudgetOverview(data.budgets, month, monthSummary, ctx.categories, today, opt.thresholds, forecast?.committedByCategory);
  for (const line of overview.lines) {
    if (line.consumption == null || line.thresholdReached == null || line.thresholdReached < 75) continue;
    // Une charge fixe payée exactement à son montant prévu n'est pas une alerte.
    if (line.category?.nature === 'fixed' && line.spent <= line.planned) continue;
    const over = line.spent > line.planned;
    out.push({
      id: `budget:${line.budget.id}:${line.thresholdReached}`,
      kind: 'budget',
      severity: over ? 'danger' : line.thresholdReached >= 90 ? 'warning' : 'info',
      title: over ? t('ins.budgetOver.title', { category: line.category?.name ?? '' }) : t('ins.budgetPct.title', { category: line.category?.name ?? '', pct: formatPercent(line.consumption, opt.locale, 0) }),
      message: over
        ? t('ins.budgetOver.message', { over: opt.fmt(line.spent - line.planned), spent: opt.fmt(line.spent), planned: opt.fmt(line.planned) })
        : t('ins.budgetPct.message', { spent: opt.fmt(line.spent), planned: opt.fmt(line.planned), remaining: opt.fmt(line.remaining) }),
      source: t('ins.budget.source'),
      href: '/budgets',
    });
  }

  // 3. Rythme de dépenses vs budget mensuel.
  if (forecast && forecast.budgetReference != null && forecast.projectedBudgetOverrun != null) {
    if (forecast.projectedBudgetOverrun > 0 && forecast.variableMethod !== 'insufficient') {
      out.push({
        id: `pace:${month}`,
        kind: 'pace',
        severity: 'warning',
        title: t('ins.pace.title'),
        message: t('ins.pace.message', { projected: opt.fmt(forecast.projectedExpenses), over: opt.fmt(forecast.projectedBudgetOverrun), budget: opt.fmt(forecast.budgetReference) }),
        source: t('ins.pace.source'),
        href: '/forecast',
      });
    } else if (forecast.projectedBudgetOverrun <= 0 && forecast.variableMethod === 'history') {
      out.push({
        id: `pace-ok:${month}`,
        kind: 'pace',
        severity: 'success',
        title: t('ins.paceOk.title'),
        message: t('ins.paceOk.message', { projected: opt.fmt(forecast.projectedExpenses), budget: opt.fmt(forecast.budgetReference), margin: opt.fmt(-forecast.projectedBudgetOverrun) }),
        source: t('ins.paceOk.source'),
        href: '/forecast',
      });
    }
  }

  // 4. Objectifs d'épargne.
  const balances = accountBalances(data.accounts, data.transactions, today);
  for (const g of data.goals) {
    if (g.status !== 'active') continue;
    const p = computeGoalProgress(g, today, g.linkedAccountId ? balances.get(g.linkedAccountId) : undefined);
    if (p.state === 'on_track') {
      out.push({
        id: `goal:${g.id}:on_track`,
        kind: 'goal',
        severity: 'success',
        title: t('ins.goalOnTrack.title', { name: g.name }),
        message: t('ins.goalOnTrack.message', { planned: opt.fmt(g.monthlyContribution ?? 0), required: opt.fmt(p.requiredMonthly ?? 0), pct: formatPercent(p.progressCapped, opt.locale, 0) }),
        source: t('ins.goalOnTrack.source'),
        href: '/goals',
      });
    } else if (p.state === 'behind' || p.state === 'overdue') {
      out.push({
        id: `goal:${g.id}:${p.state}`,
        kind: 'goal',
        severity: 'warning',
        title: t(p.state === 'overdue' ? 'ins.goalOverdue.title' : 'ins.goalBehind.title', { name: g.name }),
        message:
          p.state === 'overdue'
            ? t('ins.goalOverdue.message', { remaining: opt.fmt(p.remaining) })
            : t('ins.goalBehind.message', { required: opt.fmt(p.requiredMonthly ?? 0), planned: opt.fmt(g.monthlyContribution ?? 0) }),
        source: t('ins.goalBehind.source'),
        href: '/goals',
      });
    } else if (p.state === 'achieved') {
      out.push({
        id: `goal:${g.id}:achieved`,
        kind: 'goal',
        severity: 'success',
        title: t('ins.goalAchieved.title', { name: g.name }),
        message: t('ins.goalAchieved.message', { saved: opt.fmt(p.saved), target: opt.fmt(g.targetAmount) }),
        source: t('ins.goalAchieved.source'),
        href: '/goals',
      });
    }
  }

  // 5. Échéances récurrentes à venir.
  const window = { start: today, end: addDays(today, opt.billReminderDays) };
  const upcoming = pendingOccurrences(listOccurrences(data.recurringRules, data.occurrences, data.transactions, window, today)).filter(
    (o) => o.rule.kind === 'expense',
  );
  for (const o of upcoming.slice(0, 3)) {
    out.push({
      id: `bill:${o.id}`,
      kind: 'bill',
      severity: 'info',
      title: t('ins.bill.title', { label: o.rule.label }),
      message: t('ins.bill.message', { amount: opt.fmt(o.rule.amount), date: formatDate(o.dueDate, opt.dateFormat) }),
      source: t('ins.bill.source', { label: o.rule.label }),
      href: '/recurring',
    });
  }

  // 6. Taux d'épargne du dernier mois complet vs mois précédent.
  const last = summarizePeriod(ctx, data.transactions, monthPeriod(prevMonth));
  const before = summarizePeriod(ctx, data.transactions, monthPeriod(addMonthsToKey(prevMonth, -1)));
  if (last.savingsRate != null && before.savingsRate != null) {
    const diff = last.savingsRate - before.savingsRate;
    if (Math.abs(diff) >= 0.02) {
      out.push({
        id: `rate:${prevMonth}`,
        kind: 'savings_rate',
        severity: diff > 0 ? 'success' : 'info',
        title: t(diff > 0 ? 'ins.rateUp.title' : 'ins.rateDown.title'),
        message: t('ins.rate.message', { month: opt.monthName(prevMonth), rate: formatPercent(last.savingsRate, opt.locale), previous: formatPercent(before.savingsRate, opt.locale) }),
        source: t('ins.rate.source'),
        href: '/analytics',
      });
    }
  }

  // 7. Catégorie principale du mois.
  if (cur.expenses > 0) {
    let topId: string | null = null;
    let topAmount = 0;
    for (const [k, v] of cur.expensesByCategory) if (v.amount > topAmount) [topId, topAmount] = [k, v.amount];
    if (topAmount > 0 && cur.transactionCount >= 5) {
      out.push({
        id: `top:${month}:${topId}`,
        kind: 'top_category',
        severity: 'info',
        title: t('ins.top.title', { category: catName(topId) }),
        message: t('ins.top.message', { amount: opt.fmt(topAmount), pct: formatPercent(topAmount / cur.expenses, opt.locale, 0) }),
        source: t('ins.top.source'),
        href: '/analytics',
      });
    }
  }

  if (out.length === 0) {
    out.push({
      id: 'data:none',
      kind: 'data',
      severity: 'info',
      title: t('ins.none.title'),
      message: t('ins.none.message'),
      source: t('ins.none.source'),
    });
  }
  return out;
}
