/**
 * Notifications calculées à partir des données réelles.
 * Identifiants déterministes : une même alerte (ex : budget Transport à 90 % en
 * octobre) n'est notifiée qu'une fois ; son état lu / masqué est persisté.
 */
import type { ISODate } from '../dates';
import { addDays, formatDate, monthKey, monthPeriod } from '../dates';
import type { DataSnapshot, NotificationSeverity } from '../types';
import type { LedgerContext } from './ledger';
import { summarizePeriod } from './ledger';
import { monthBudgetOverview } from './budgets';
import { listOccurrences } from './recurring';
import { computeDebtStatus } from './debts';
import { computeGoalProgress } from './goals';
import { accountBalances } from './ledger';
import { t } from '@/i18n/core';

export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  href: string;
  date: ISODate;
  read: boolean;
}

export function computeNotifications(ctx: LedgerContext, data: DataSnapshot, today: ISODate, fmt: (m: number) => string, dateFormat: Parameters<typeof formatDate>[1]): AppNotification[] {
  const s = data.settings;
  const out: Omit<AppNotification, 'read'>[] = [];
  const month = monthKey(today);

  if (s.notifyBudgets) {
    const summary = summarizePeriod(ctx, data.transactions, monthPeriod(month));
    const ov = monthBudgetOverview(data.budgets, month, summary, ctx.categories, today, s.budgetAlertThresholds);
    const lines = ov.global ? [...ov.lines, ov.global] : ov.lines;
    for (const l of lines) {
      if (l.thresholdReached == null) continue;
      if (l.category?.nature === 'fixed' && l.spent <= l.planned) continue;
      const name = l.category?.name ?? t('notif.budgetGlobal');
      const over = l.spent > l.planned;
      out.push({
        id: `budget:${l.budget.id}:${over ? 'over' : l.thresholdReached}`,
        severity: over ? 'danger' : l.thresholdReached >= 90 ? 'warning' : 'info',
        title: over ? t('notif.budgetOver.title', { name }) : t('notif.budgetThreshold.title', { name, pct: l.thresholdReached }),
        message: t('notif.budget.message', { spent: fmt(l.spent), planned: fmt(l.planned) }),
        href: '/budgets',
        date: today,
      });
    }
  }

  if (s.notifyBills) {
    const window = { start: addDays(today, -30), end: addDays(today, s.billReminderDays) };
    for (const o of listOccurrences(data.recurringRules, data.occurrences, data.transactions, window, today, { convert: ctx.convert })) {
      const late = o.status === 'overdue' || (o.status === 'partial' && o.dueDate < today);
      if (late) {
        out.push({ id: `bill-overdue:${o.id}`, severity: 'warning', title: t('notif.billOverdue.title', { label: o.rule.label }), message: t('notif.billOverdue.message', { date: formatDate(o.dueDate, dateFormat), amount: fmt(o.remaining) }), href: '/recurring', date: o.dueDate });
      } else if (o.status === 'upcoming' || o.status === 'partial') {
        out.push({ id: `bill:${o.id}`, severity: 'info', title: t(o.rule.kind === 'income' ? 'notif.incomeExpected' : 'notif.billUpcoming', { label: o.rule.label }), message: t('notif.bill.message', { amount: fmt(o.remaining), date: formatDate(o.dueDate, dateFormat) }), href: '/recurring', date: o.dueDate });
      }
    }
  }

  if (s.notifyDebts) {
    for (const d of data.debts) {
      if (d.status !== 'active') continue;
      const st = computeDebtStatus(d, data.debtPayments, today);
      if (st.overdue) out.push({ id: `debt:${d.id}:overdue`, severity: 'danger', title: t('notif.debtOverdue.title', { label: d.label }), message: t(d.direction === 'payable' ? 'notif.debtOverdue.payable' : 'notif.debtOverdue.receivable', { amount: fmt(st.remaining) }), href: '/debts', date: d.dueDate! });
      else if (d.dueDate && d.dueDate <= addDays(today, 14)) out.push({ id: `debt:${d.id}:soon`, severity: 'info', title: t('notif.debtSoon.title', { label: d.label }), message: t('notif.debtSoon.message', { date: formatDate(d.dueDate, dateFormat), amount: fmt(st.remaining) }), href: '/debts', date: d.dueDate });
    }
  }

  const balances = accountBalances(data.accounts, data.transactions, today);
  for (const g of data.goals) {
    if (g.status !== 'active' && g.status !== 'achieved') continue;
    const p = computeGoalProgress(g, today, g.linkedAccountId ? balances.get(g.linkedAccountId) : undefined);
    if (p.state === 'achieved') out.push({ id: `goal:${g.id}:achieved`, severity: 'success', title: t('notif.goal.title', { name: g.name }), message: t('notif.goal.message', { amount: fmt(p.saved) }), href: '/goals', date: today });
  }

  const states = new Map(data.notificationStates.map((n) => [n.id, n]));
  return out
    .filter((n) => !states.get(n.id)?.dismissed)
    .map((n) => ({ ...n, read: states.get(n.id)?.read ?? false }))
    .sort((a, b) => Number(a.read) - Number(b.read) || severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(s: NotificationSeverity) {
  return { danger: 3, warning: 2, info: 1, success: 0 }[s];
}
