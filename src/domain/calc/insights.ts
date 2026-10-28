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
  const catName = (id: string | null) => (id ? ctx.categories.get(id)?.name ?? 'Catégorie supprimée' : 'Sans catégorie');

  if (cur.transactionCount === 0 && prev.transactionCount === 0) {
    out.push({
      id: 'data:empty',
      kind: 'data',
      severity: 'info',
      title: 'Pas encore assez de données',
      message: 'Ajoutez vos premières transactions pour obtenir des observations personnalisées.',
      source: 'Aucune transaction sur le mois en cours ni sur la même période du mois précédent.',
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
      title: `${catName(catId)} : ${up ? 'hausse' : 'baisse'} de ${formatPercent(Math.abs(change), opt.locale)}`,
      message: `Vous avez dépensé ${opt.fmt(c.amount)} en ${catName(catId).toLowerCase()} du 1er au ${day} ${opt.monthName(month).toLowerCase()}, contre ${opt.fmt(p.amount)} sur la même période du mois précédent.`,
      source: `Comparaison à période égale : ${formatDate(curPeriod.start, opt.dateFormat)}–${formatDate(curPeriod.end, opt.dateFormat)} vs ${formatDate(prevPeriod.start, opt.dateFormat)}–${formatDate(prevPeriod.end, opt.dateFormat)} (${c.count} et ${p.count} opérations).`,
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
    const over = line.spent > line.planned;
    out.push({
      id: `budget:${line.budget.id}:${line.thresholdReached}`,
      kind: 'budget',
      severity: over ? 'danger' : line.thresholdReached >= 90 ? 'warning' : 'info',
      title: over ? `Budget ${line.category?.name} dépassé` : `Budget ${line.category?.name} consommé à ${formatPercent(line.consumption, opt.locale, 0)}`,
      message: over
        ? `Dépassement de ${opt.fmt(line.spent - line.planned)} (${opt.fmt(line.spent)} dépensés pour un budget de ${opt.fmt(line.planned)}).`
        : `${opt.fmt(line.spent)} dépensés sur ${opt.fmt(line.planned)} ; il reste ${opt.fmt(line.remaining)}.`,
      source: 'Dépenses nettes des remboursements de la catégorie (sous-catégories incluses) ÷ budget du mois.',
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
        title: 'Rythme de dépenses supérieur au budget',
        message: `Au rythme actuel, vos dépenses du mois pourraient atteindre ${opt.fmt(forecast.projectedExpenses)}, soit ${opt.fmt(forecast.projectedBudgetOverrun)} au-delà du budget de ${opt.fmt(forecast.budgetReference)}.`,
        source: 'Projection : dépenses enregistrées + échéances récurrentes à venir + dépenses variables projetées (voir Prévisions).',
        href: '/forecast',
      });
    } else if (forecast.projectedBudgetOverrun <= 0 && forecast.variableMethod === 'history') {
      out.push({
        id: `pace-ok:${month}`,
        kind: 'pace',
        severity: 'success',
        title: 'Dépenses sous contrôle',
        message: `Projection de fin de mois : ${opt.fmt(forecast.projectedExpenses)} pour un budget de ${opt.fmt(forecast.budgetReference)} (marge estimée ${opt.fmt(-forecast.projectedBudgetOverrun)}).`,
        source: 'Projection fondée sur la moyenne quotidienne observée et les échéances connues.',
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
        title: `Objectif « ${g.name} » en bonne voie`,
        message: `Contribution prévue ${opt.fmt(g.monthlyContribution ?? 0)}/mois pour ${opt.fmt(p.requiredMonthly ?? 0)}/mois nécessaires (${formatPercent(p.progressCapped, opt.locale, 0)} atteint).`,
        source: 'Contribution nécessaire = montant restant ÷ mois restants jusqu’à la date cible.',
        href: '/goals',
      });
    } else if (p.state === 'behind' || p.state === 'overdue') {
      out.push({
        id: `goal:${g.id}:${p.state}`,
        kind: 'goal',
        severity: 'warning',
        title: p.state === 'overdue' ? `Objectif « ${g.name} » : date dépassée` : `Objectif « ${g.name} » en retard`,
        message:
          p.state === 'overdue'
            ? `Il reste ${opt.fmt(p.remaining)} à constituer alors que la date cible est passée.`
            : `Il faudrait ${opt.fmt(p.requiredMonthly ?? 0)}/mois, contre ${opt.fmt(g.monthlyContribution ?? 0)} prévus.`,
        source: 'Comparaison entre contribution souhaitée et contribution nécessaire.',
        href: '/goals',
      });
    } else if (p.state === 'achieved') {
      out.push({
        id: `goal:${g.id}:achieved`,
        kind: 'goal',
        severity: 'success',
        title: `Objectif « ${g.name} » atteint`,
        message: `${opt.fmt(p.saved)} constitués pour une cible de ${opt.fmt(g.targetAmount)}.`,
        source: 'Montant constitué ≥ montant cible.',
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
      title: `${o.rule.label} arrive à échéance`,
      message: `${opt.fmt(o.rule.amount)} prévus le ${formatDate(o.dueDate, opt.dateFormat)}.`,
      source: `Paiement récurrent ${o.rule.label} non encore marqué comme payé.`,
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
        title: `Taux d'épargne ${diff > 0 ? 'en progression' : 'en recul'}`,
        message: `${opt.monthName(prevMonth)} : ${formatPercent(last.savingsRate, opt.locale)} de vos revenus épargnés, contre ${formatPercent(before.savingsRate, opt.locale)} le mois précédent.`,
        source: 'Taux d’épargne = (revenus − dépenses) ÷ revenus, sur deux mois complets.',
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
        title: `${catName(topId)} : 1er poste de dépenses`,
        message: `${opt.fmt(topAmount)}, soit ${formatPercent(topAmount / cur.expenses, opt.locale, 0)} de vos dépenses depuis le début du mois.`,
        source: 'Dépenses nettes par catégorie depuis le 1er du mois.',
        href: '/analytics',
      });
    }
  }

  if (out.length === 0) {
    out.push({
      id: 'data:none',
      kind: 'data',
      severity: 'info',
      title: 'Rien de notable pour le moment',
      message: 'Les comparaisons nécessitent au moins deux opérations par catégorie sur chaque période.',
      source: 'Moteur d’insights : aucune règle déclenchée avec des données comparables.',
    });
  }
  return out;
}
