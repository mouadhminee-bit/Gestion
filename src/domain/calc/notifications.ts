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
      const name = l.category?.name ?? 'Budget global';
      const over = l.spent > l.planned;
      out.push({
        id: `budget:${l.budget.id}:${over ? 'over' : l.thresholdReached}`,
        severity: over ? 'danger' : l.thresholdReached >= 90 ? 'warning' : 'info',
        title: over ? `${name} : budget dépassé` : `${name} : ${l.thresholdReached} % du budget atteint`,
        message: `${fmt(l.spent)} dépensés sur ${fmt(l.planned)}.`,
        href: '/budgets',
        date: today,
      });
    }
  }

  if (s.notifyBills) {
    const window = { start: addDays(today, -30), end: addDays(today, s.billReminderDays) };
    for (const o of listOccurrences(data.recurringRules, data.occurrences, data.transactions, window, today)) {
      if (o.status === 'overdue') {
        out.push({ id: `bill-overdue:${o.id}`, severity: 'warning', title: `${o.rule.label} : échéance passée`, message: `Prévue le ${formatDate(o.dueDate, dateFormat)} (${fmt(o.rule.amount)}), non marquée comme payée.`, href: '/recurring', date: o.dueDate });
      } else if (o.status === 'upcoming') {
        out.push({ id: `bill:${o.id}`, severity: 'info', title: `${o.rule.kind === 'income' ? 'Revenu attendu' : 'Échéance à venir'} : ${o.rule.label}`, message: `${fmt(o.rule.amount)} le ${formatDate(o.dueDate, dateFormat)}.`, href: '/recurring', date: o.dueDate });
      }
    }
  }

  if (s.notifyDebts) {
    for (const d of data.debts) {
      if (d.status !== 'active') continue;
      const st = computeDebtStatus(d, data.debtPayments, today);
      if (st.overdue) out.push({ id: `debt:${d.id}:overdue`, severity: 'danger', title: `${d.label} : échéance dépassée`, message: `Reste ${fmt(st.remaining)} ${d.direction === 'payable' ? 'à rembourser' : 'à recevoir'}.`, href: '/debts', date: d.dueDate! });
      else if (d.dueDate && d.dueDate <= addDays(today, 14)) out.push({ id: `debt:${d.id}:soon`, severity: 'info', title: `${d.label} : échéance proche`, message: `Échéance le ${formatDate(d.dueDate, dateFormat)}, reste ${fmt(st.remaining)}.`, href: '/debts', date: d.dueDate });
    }
  }

  const balances = accountBalances(data.accounts, data.transactions, today);
  for (const g of data.goals) {
    if (g.status !== 'active' && g.status !== 'achieved') continue;
    const p = computeGoalProgress(g, today, g.linkedAccountId ? balances.get(g.linkedAccountId) : undefined);
    if (p.state === 'achieved') out.push({ id: `goal:${g.id}:achieved`, severity: 'success', title: `Objectif atteint : ${g.name}`, message: `${fmt(p.saved)} constitués.`, href: '/goals', date: today });
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
