/**
 * Assistant financier — moteur déterministe (aucune IA externe).
 *
 * Chaque réponse est calculée avec les fonctions communes du domaine et indique
 * sa source. L'interface `AssistantProvider` permet de brancher ultérieurement un
 * modèle d'IA via un proxy serveur (jamais de clé dans le frontend) ; ce modèle ne
 * devrait recevoir que des agrégats calculés ici et ne jamais inventer de chiffres
 * ni modifier les données sans confirmation.
 *
 * Multilingue : la détection d'intention s'appuie sur des listes de mots-clés
 * traduites (clés `assist.kw.*`), complétées des mots-clés français et anglais pour
 * qu'une question posée dans ces langues fonctionne quelle que soit l'interface.
 * Les suggestions appellent directement l'intention (`answerIntent`) : elles
 * fonctionnent dans toutes les langues, indépendamment des mots-clés.
 */
import type { ISODate, MonthKey } from './dates';
import { addMonthsToKey, monthKey, monthPeriod, yearPeriod } from './dates';
import type { DataSnapshot, ID } from './types';
import type { LedgerContext } from './calc/ledger';
import { accountBalances, summarizePeriod, topCategoryId } from './calc/ledger';
import { monthBudgetOverview } from './calc/budgets';
import { forecastMonth } from './calc/forecast';
import { computeBaseline } from './calc/scenario';
import { computeGoalProgress } from './calc/goals';
import { monthlyEquivalent } from './calc/recurring';
import { computeNetWorth } from './calc/networth';
import { normalizeLabel } from './duplicates';
import { percentOf } from './money';
import type { MessageKey, Messages } from '@/i18n/core';
import { t } from '@/i18n/core';
import fr from '@/i18n/locales/fr';

export interface AssistantAnswer {
  intent: Intent;
  text: string;
  figures?: { label: string; value: string }[];
  source: string;
  /** Réponse issue de calculs vérifiables (toujours vrai pour le moteur à règles). */
  verified: boolean;
}

export interface AssistantFormatters {
  money: (minor: number) => string;
  percent: (r: number | null, digits?: number) => string;
  month: (m: MonthKey) => string;
  date: (d: ISODate) => string;
}

export interface AssistantProvider {
  readonly name: string;
  answer(question: string): Promise<AssistantAnswer>;
}

export type Intent =
  | 'what_if'
  | 'category_spending'
  | 'recurring'
  | 'budget_over'
  | 'savings_capacity'
  | 'trend'
  | 'end_balance'
  | 'goal_first'
  | 'net_worth'
  | 'month_summary'
  | 'unknown';

export interface IntentParams {
  /** Catégorie (id) concernée. */
  categoryId?: ID;
  /** Pourcentage de réduction (what_if). */
  pct?: number;
  period?: 'this_month' | 'last_month' | 'this_year';
}

/** Suggestions : texte traduit + intention appelée directement. */
export const SUGGESTIONS: { key: MessageKey; intent: Intent; categoryKey?: string; pct?: number }[] = [
  { key: 'assist.q.categorySpending', intent: 'category_spending', categoryKey: 'restaurants' },
  { key: 'assist.q.budgetOver', intent: 'budget_over' },
  { key: 'assist.q.savingsCapacity', intent: 'savings_capacity' },
  { key: 'assist.q.trend', intent: 'trend' },
  { key: 'assist.q.endBalance', intent: 'end_balance' },
  { key: 'assist.q.recurring', intent: 'recurring' },
  { key: 'assist.q.whatIf', intent: 'what_if', categoryKey: 'leisure', pct: 15 },
  { key: 'assist.q.goalFirst', intent: 'goal_first' },
  { key: 'assist.q.netWorth', intent: 'net_worth' },
];

type KwGroup =
  | 'reduce' | 'spent' | 'recurring' | 'budget' | 'over' | 'savings' | 'capacity' | 'goal'
  | 'trend' | 'balance' | 'end' | 'netWorth' | 'income' | 'lastMonth' | 'thisYear' | 'percent' | 'generic';

let enMessages: Messages | null = null;
/** Le dictionnaire anglais est chargé par l'interface ; on l'utilise s'il est disponible. */
export function registerEnglishKeywords(m: Messages) {
  enMessages = m;
}

function kw(group: KwGroup): string[] {
  const key = `assist.kw.${group}` as MessageKey;
  const sources = [t(key), String(fr[key] ?? '')];
  if (enMessages) sources.push(String(enMessages[key] ?? ''));
  const out = new Set<string>();
  for (const s of sources) for (const w of s.split('|')) {
    const n = norm(w);
    if (n) out.add(n);
  }
  return [...out];
}

/** Lettres que NFD ne décompose pas (ł, ı, đ, ø…) : repliées pour comparer questions et mots-clés. */
const FOLD: Record<string, string> = { ł: 'l', ı: 'i', đ: 'd', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ð: 'd', þ: 'th', ħ: 'h' };
function norm(s: string): string {
  return normalizeLabel(s).replace(/[łıđøæœßðþħ]/g, (c) => FOLD[c]);
}

function has(q: string, group: KwGroup): boolean {
  return kw(group).some((w) => q.includes(w));
}

/** Convertit les chiffres arabes orientaux / persans en chiffres ASCII. */
function asciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function findCategory(ctx: LedgerContext, q: string): { id: ID; name: string } | null {
  let best: { id: ID; name: string; score: number } | null = null;
  const qWords = new Set(q.split(' '));
  const generic = new Set(kw('generic'));
  for (const c of ctx.categories.values()) {
    if (c.archived) continue;
    const n = norm(c.name);
    if (!n) continue;
    let score = 0;
    if (q.includes(n)) score = 100 + n.length; // nom complet présent dans la question
    else {
      for (const w of n.split(' ')) {
        if (w.length < 4 || generic.has(w)) continue;
        const stem = w.replace(/s$/, '');
        if (qWords.has(w) || qWords.has(stem) || qWords.has(stem + 's')) score = Math.max(score, 10 + w.length);
        else if (w.length >= 6) {
          // Langues à déclinaisons : « rozrywkę » ↔ « rozrywka » (seule la terminaison diffère).
          for (const qw of qWords) {
            const min = Math.min(w.length, qw.length);
            let cp = 0;
            while (cp < min && w[cp] === qw[cp]) cp++;
            if (cp >= Math.max(5, min - 2)) score = Math.max(score, 5 + cp);
          }
        }
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { id: c.id, name: c.name, score };
  }
  return best ? { id: best.id, name: best.name } : null;
}

/** Détecte l'intention et ses paramètres à partir d'une question libre. */
export function detectIntent(question: string, ctx: LedgerContext): { intent: Intent; params: IntentParams } {
  const raw = asciiDigits(question);
  const q = norm(raw);
  const period: IntentParams['period'] = has(q, 'lastMonth') ? 'last_month' : has(q, 'thisYear') ? 'this_year' : 'this_month';
  // « 15 % », « 15٪ » ou, en turc, « %15 ».
  const pctMatch = /(\d+(?:[.,]\d+)?)\s*(?:%|٪)/.exec(raw) ?? /(?:%|٪)\s*(\d+(?:[.,]\d+)?)/.exec(raw) ?? (has(q, 'percent') ? /(\d+(?:[.,]\d+)?)/.exec(raw) : null);
  const cat = findCategory(ctx, q);
  if (pctMatch && has(q, 'reduce')) return { intent: 'what_if', params: { pct: Number(pctMatch[1].replace(',', '.')), categoryId: cat?.id } };
  if (cat && has(q, 'spent') && !has(q, 'trend') && !has(q, 'recurring') && !has(q, 'budget') && !has(q, 'savings') && !has(q, 'balance')) {
    return { intent: 'category_spending', params: { categoryId: cat.id, period } };
  }
  if (has(q, 'recurring')) return { intent: 'recurring', params: {} };
  if (has(q, 'budget') && has(q, 'over')) return { intent: 'budget_over', params: {} };
  if (has(q, 'savings') && has(q, 'capacity') && !has(q, 'goal')) return { intent: 'savings_capacity', params: {} };
  if (has(q, 'trend')) return { intent: 'trend', params: {} };
  if (has(q, 'balance') && has(q, 'end')) return { intent: 'end_balance', params: {} };
  if (has(q, 'goal')) return { intent: 'goal_first', params: {} };
  if (has(q, 'netWorth')) return { intent: 'net_worth', params: {} };
  if (has(q, 'income')) return { intent: 'month_summary', params: {} };
  return { intent: 'unknown', params: {} };
}

export function answerQuestion(question: string, ctx: LedgerContext, data: DataSnapshot, today: ISODate, fmt: AssistantFormatters): AssistantAnswer {
  const { intent, params } = detectIntent(question, ctx);
  return answerIntent(intent, params, ctx, data, today, fmt);
}

export function answerIntent(intent: Intent, params: IntentParams, ctx: LedgerContext, data: DataSnapshot, today: ISODate, fmt: AssistantFormatters): AssistantAnswer {
  const month = monthKey(today);
  const catName = (id?: ID) => (id ? ctx.categories.get(id)?.name ?? '—' : '—');

  switch (intent) {
    case 'what_if': {
      const p = params.pct ?? 0;
      const baseline = computeBaseline(ctx, data, today);
      if (!baseline.monthsWithData) return insufficient('what_if', t('assist.ins.whatIf'));
      const base = params.categoryId ? baseline.byCategory.get(topCategoryId(ctx, params.categoryId)) ?? 0 : baseline.expenses;
      const saving = percentOf(base, p);
      const savingsNow = baseline.income - baseline.expenses;
      return {
        intent,
        text: t(params.categoryId ? 'assist.whatIf.textCategory' : 'assist.whatIf.textTotal', {
          category: catName(params.categoryId),
          pct: p,
          monthly: fmt.money(saving),
          yearly: fmt.money(saving * 12),
          from: fmt.money(savingsNow),
          to: fmt.money(savingsNow + saving),
        }),
        figures: [
          { label: t('assist.whatIf.avgSpending'), value: fmt.money(base) },
          { label: t('assist.whatIf.monthlySaving'), value: fmt.money(saving) },
          { label: t('assist.whatIf.yearlySaving'), value: fmt.money(saving * 12) },
        ],
        source: t('assist.whatIf.source', { count: baseline.monthsWithData, months: baseline.months.map(fmt.month).join(', ') }),
        verified: true,
      };
    }

    case 'category_spending': {
      if (!params.categoryId) return unknown();
      const per = params.period ?? 'this_month';
      const period = per === 'this_year' ? yearPeriod(Number(today.slice(0, 4))) : monthPeriod(per === 'last_month' ? addMonthsToKey(month, -1) : month);
      const s = summarizePeriod(ctx, data.transactions, period, { categoryIds: [params.categoryId] });
      const prev = per === 'this_year' ? null : summarizePeriod(ctx, data.transactions, monthPeriod(addMonthsToKey(period.start.slice(0, 7), -1)), { categoryIds: [params.categoryId] });
      const count = s.expensesByCategory.get(topCategoryId(ctx, params.categoryId))?.count ?? 0;
      const periodLabel = t(per === 'last_month' ? 'assist.period.lastMonth' : per === 'this_year' ? 'assist.period.thisYear' : 'assist.period.thisMonth');
      return {
        intent,
        text: t(prev ? 'assist.catSpend.textCompare' : 'assist.catSpend.text', {
          amount: fmt.money(s.expenses),
          category: catName(params.categoryId),
          period: periodLabel,
          ops: t('assist.ops', { count }),
          previous: prev ? fmt.money(prev.expenses) : '',
        }),
        figures: [{ label: t('assist.catSpend.total'), value: fmt.money(s.expenses) }, ...(s.refunds ? [{ label: t('assist.catSpend.refunds'), value: fmt.money(s.refunds) }] : [])],
        source: t('assist.catSpend.source'),
        verified: true,
      };
    }

    case 'recurring': {
      const rules = data.recurringRules.filter((r) => r.active && r.kind === 'expense');
      if (!rules.length) return insufficient('recurring', t('assist.ins.recurring'));
      const baseline = computeBaseline(ctx, data, today);
      const items = rules.map((r) => ({ r, m: ctx.convert(monthlyEquivalent(r), r.currency, today) ?? 0 })).sort((a, b) => b.m - a.m);
      const total = items.reduce((a, i) => a + i.m, 0);
      const ref = baseline.expenses || null;
      return {
        intent,
        text: t(ref ? 'assist.recurring.textShare' : 'assist.recurring.text', {
          label: items[0].r.label,
          amount: fmt.money(items[0].m),
          share: ref ? fmt.percent(items[0].m / ref, 0) : '',
          total: fmt.money(total),
          totalShare: ref ? fmt.percent(total / ref, 0) : '',
        }),
        figures: items.slice(0, 5).map((i) => ({ label: i.r.label, value: t('assist.perMonth', { amount: fmt.money(i.m) }) })),
        source: t('assist.recurring.source'),
        verified: true,
      };
    }

    case 'budget_over': {
      const s = summarizePeriod(ctx, data.transactions, monthPeriod(month));
      const ov = monthBudgetOverview(data.budgets, month, s, ctx.categories, today, data.settings.budgetAlertThresholds);
      if (!ov.lines.length) return insufficient('budget_over', t('assist.ins.budget'));
      const sorted = [...ov.lines].sort((a, b) => b.variance - a.variance);
      const worst = sorted[0];
      if (worst.variance <= 0) {
        const closest = [...ov.lines].sort((a, b) => (b.consumption ?? 0) - (a.consumption ?? 0))[0];
        return { intent, text: t('assist.budget.none', { category: closest.category?.name ?? '—', pct: fmt.percent(closest.consumption, 0) }), source: t('assist.budget.sourceNone'), verified: true };
      }
      return {
        intent,
        text: t('assist.budget.text', { category: worst.category?.name ?? '—', spent: fmt.money(worst.spent), planned: fmt.money(worst.planned), over: fmt.money(worst.variance), pct: fmt.percent(worst.variancePct, 0) }),
        figures: sorted.filter((l) => l.variance > 0).map((l) => ({ label: l.category?.name ?? '—', value: `+${fmt.money(l.variance)}` })),
        source: t('assist.budget.source', { month: fmt.month(month) }),
        verified: true,
      };
    }

    case 'savings_capacity': {
      const f = forecastMonth(ctx, data, today);
      const baseline = computeBaseline(ctx, data, today);
      const avg = baseline.monthsWithData ? baseline.income - baseline.expenses : null;
      const committed = data.goals.filter((g) => g.status === 'active').reduce((a, g) => a + (g.monthlyContribution ?? 0), 0);
      const parts = [t(avg != null ? 'assist.savings.projectedAvg' : 'assist.savings.projected', { amount: fmt.money(f.projectedSavings), avg: avg != null ? fmt.money(avg) : '' })];
      parts.push(f.projectedSavings > 0 ? t('assist.savings.target', { amount: fmt.money(Math.max(0, Math.round(Math.min(f.projectedSavings, avg ?? f.projectedSavings) * 0.8))) }) : t('assist.savings.none'));
      if (committed) parts.push(t('assist.savings.goals', { amount: fmt.money(committed) }));
      const method = t(f.variableMethod === 'history' ? 'assist.method.history' : f.variableMethod === 'budget' ? 'assist.method.budget' : 'assist.method.insufficient');
      return {
        intent,
        text: parts.join(' '),
        figures: [
          { label: t('assist.savings.income'), value: fmt.money(f.projectedIncome) },
          { label: t('assist.savings.expenses'), value: fmt.money(f.projectedExpenses) },
          { label: t('assist.savings.potential'), value: fmt.money(f.projectedSavings) },
        ],
        source: t('assist.savings.source', { method }),
        verified: true,
      };
    }

    case 'trend': {
      const months = [-3, -2, -1].map((i) => addMonthsToKey(month, i));
      const vals = months.map((m) => ({ m, s: summarizePeriod(ctx, data.transactions, monthPeriod(m)) }));
      if (vals.every((v) => v.s.expenses === 0)) return insufficient('trend', t('assist.ins.trend'));
      const first = vals[0].s.expenses;
      const last = vals[2].s.expenses;
      const ch = first ? (last - first) / first : null;
      return {
        intent,
        text: t(ch == null ? 'assist.trend.text' : ch >= 0 ? 'assist.trend.textUp' : 'assist.trend.textDown', {
          from: fmt.money(first),
          fromMonth: fmt.month(months[0]),
          to: fmt.money(last),
          toMonth: fmt.month(months[2]),
          pct: ch == null ? '' : fmt.percent(Math.abs(ch)),
        }),
        figures: vals.map((v) => ({ label: fmt.month(v.m), value: t('assist.trend.figure', { expenses: fmt.money(v.s.expenses), savings: fmt.money(v.s.netSavings) }) })),
        source: t('assist.trend.source'),
        verified: true,
      };
    }

    case 'end_balance': {
      const f = forecastMonth(ctx, data, today);
      return {
        intent,
        text: t('assist.end.text', { amount: fmt.money(f.projectedEndBalance), current: fmt.money(f.currentBalance) }),
        figures: [
          { label: t('assist.end.income'), value: fmt.money(f.expectedRecurringIncome) },
          { label: t('assist.end.expenses'), value: fmt.money(f.expectedRecurringExpenses) },
          { label: t('assist.end.variable'), value: fmt.money(f.variableProjected) },
        ],
        source: f.assumptions.join(' '),
        verified: true,
      };
    }

    case 'goal_first': {
      const balances = accountBalances(data.accounts, data.transactions, today);
      const goals = data.goals.filter((g) => g.status === 'active').map((g) => ({ g, p: computeGoalProgress(g, today, g.linkedAccountId ? balances.get(g.linkedAccountId) : undefined) }));
      const reachable = goals.filter((x) => x.p.projectedDate).sort((a, b) => (a.p.projectedDate! < b.p.projectedDate! ? -1 : 1));
      if (!reachable.length) return insufficient('goal_first', t(goals.length ? 'assist.ins.goalNoPlan' : 'assist.ins.goalNone'));
      const first = reachable[0];
      return {
        intent,
        text: t('assist.goal.text', { name: first.g.name, date: fmt.date(first.p.projectedDate!), remaining: fmt.money(first.p.remaining), monthly: fmt.money(first.g.monthlyContribution ?? 0) }),
        figures: reachable.map((x) => ({ label: x.g.name, value: t('assist.goal.figure', { date: fmt.date(x.p.projectedDate!), remaining: fmt.money(x.p.remaining) }) })),
        source: t('assist.goal.source'),
        verified: true,
      };
    }

    case 'net_worth': {
      const nw = computeNetWorth(ctx, data, today);
      return {
        intent,
        text: t('assist.nw.text', { amount: fmt.money(nw.netWorth), assets: fmt.money(nw.totalAssets), liabilities: fmt.money(nw.totalLiabilities) }),
        source: t('assist.nw.source'),
        verified: true,
      };
    }

    case 'month_summary': {
      const s = summarizePeriod(ctx, data.transactions, monthPeriod(month));
      return {
        intent,
        text: t('assist.month.text', { income: fmt.money(s.income), expenses: fmt.money(s.expenses), savings: fmt.money(s.netSavings), rate: fmt.percent(s.savingsRate) }),
        source: t('assist.month.source'),
        verified: true,
      };
    }

    default:
      return unknown();
  }
}

function unknown(): AssistantAnswer {
  return { intent: 'unknown', text: t('assist.unknown.text'), source: t('assist.unknown.source'), verified: true };
}

function insufficient(intent: Intent, why: string): AssistantAnswer {
  return { intent, text: t('assist.insufficient', { why }), source: t('assist.insufficient.source'), verified: true };
}

/** Fournisseur local par défaut. */
export function createRuleBasedProvider(getArgs: () => { ctx: LedgerContext; data: DataSnapshot; today: ISODate; fmt: AssistantFormatters }): AssistantProvider {
  return {
    name: 'rules',
    async answer(question) {
      const { ctx, data, today, fmt } = getArgs();
      return answerQuestion(question, ctx, data, today, fmt);
    },
  };
}
