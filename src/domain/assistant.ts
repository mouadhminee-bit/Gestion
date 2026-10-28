/**
 * Assistant financier — moteur déterministe (aucune IA externe).
 *
 * Chaque réponse est calculée avec les fonctions communes du domaine et indique
 * sa source. L'interface `AssistantProvider` permet de brancher ultérieurement un
 * modèle d'IA via un proxy serveur (jamais de clé dans le frontend) ; ce modèle ne
 * devrait recevoir que des agrégats calculés ici et ne jamais inventer de chiffres
 * ni modifier les données sans confirmation.
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

export interface AssistantAnswer {
  intent: string;
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

export const SUGGESTED_QUESTIONS = [
  'Combien ai-je dépensé en restaurants ce mois-ci ?',
  'Quelle catégorie dépasse le plus son budget ?',
  'Combien puis-je raisonnablement épargner ce mois-ci ?',
  'Comment mes dépenses ont-elles évolué depuis trois mois ?',
  'Quel sera mon solde estimé à la fin du mois ?',
  'Quelles dépenses récurrentes représentent la plus grande part de mon budget ?',
  'Que se passerait-il si je réduisais mes dépenses de loisirs de 15 % ?',
  'Quel objectif d’épargne puis-je atteindre en premier ?',
  'Quel est mon patrimoine net ?',
];

/** Mots trop génériques pour identifier une catégorie (« dépensé » ≠ « Dépenses personnelles »). */
const GENERIC_WORDS = new Set(['depense', 'depenses', 'autre', 'autres', 'revenu', 'revenus', 'charge', 'charges', 'fixes', 'epargne', 'credit', 'personnelles', 'affectations']);

function findCategory(ctx: LedgerContext, q: string): { id: ID; name: string } | null {
  let best: { id: ID; name: string; score: number } | null = null;
  const qWords = new Set(q.split(' '));
  for (const c of ctx.categories.values()) {
    if (c.archived) continue;
    const n = normalizeLabel(c.name);
    let score = 0;
    if (q.includes(n)) score = 100 + n.length; // nom complet présent dans la question
    else {
      for (const w of n.split(' ')) {
        if (w.length < 4 || GENERIC_WORDS.has(w)) continue;
        const stem = w.replace(/s$/, '');
        if (qWords.has(w) || qWords.has(stem) || qWords.has(stem + 's')) score = Math.max(score, 10 + w.length);
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { id: c.id, name: c.name, score };
  }
  return best ? { id: best.id, name: best.name } : null;
}

function periodFrom(q: string, today: ISODate): { month?: MonthKey; year?: number; label: string } {
  const current = monthKey(today);
  if (/mois (dernier|precedent)/.test(q)) return { month: addMonthsToKey(current, -1), label: 'le mois dernier' };
  if (/cette annee|annee en cours/.test(q)) return { year: Number(today.slice(0, 4)), label: 'cette année' };
  return { month: current, label: 'ce mois-ci' };
}

export function answerQuestion(question: string, ctx: LedgerContext, data: DataSnapshot, today: ISODate, fmt: AssistantFormatters): AssistantAnswer {
  const q = normalizeLabel(question);
  const month = monthKey(today);

  // 1. Réduction hypothétique d'une catégorie (« si je réduisais ... de 15 % »)
  const pct = /(\d+(?:[.,]\d+)?)\s*(%|pour ?cent)/.exec(question);
  if (/(redui|baiss|diminu|si je)/.test(q) && pct) {
    const cat = findCategory(ctx, q);
    const p = Number(pct[1].replace(',', '.'));
    const baseline = computeBaseline(ctx, data, today);
    if (!baseline.monthsWithData) return insufficient('what_if', 'Il faut au moins un mois complet de données pour simuler une réduction.');
    const base = cat ? baseline.byCategory.get(topCategoryId(ctx, cat.id)) ?? 0 : baseline.expenses;
    const saving = percentOf(base, p);
    return {
      intent: 'what_if',
      text: `En réduisant ${cat ? `vos dépenses « ${cat.name} »` : 'vos dépenses totales'} de ${p} %, vous économiseriez environ ${fmt.money(saving)} par mois, soit ${fmt.money(saving * 12)} sur un an. Votre épargne mensuelle moyenne passerait de ${fmt.money(baseline.income - baseline.expenses)} à ${fmt.money(baseline.income - baseline.expenses + saving)}.`,
      figures: [
        { label: 'Dépense mensuelle moyenne', value: fmt.money(base) },
        { label: 'Économie mensuelle', value: fmt.money(saving) },
        { label: 'Économie annuelle', value: fmt.money(saving * 12) },
      ],
      source: `Moyenne des ${baseline.monthsWithData} derniers mois complets (${baseline.months.map(fmt.month).join(', ')}). Simulation sans modification des données.`,
      verified: true,
    };
  }

  // 2. Dépenses dans une catégorie
  if (/(depense|combien.*(en|pour)|coute)/.test(q) && !/evolu|recurrent|budget|epargn|solde/.test(q)) {
    const cat = findCategory(ctx, q);
    if (cat) {
      const per = periodFrom(q, today);
      const period = per.year ? yearPeriod(per.year) : monthPeriod(per.month!);
      const s = summarizePeriod(ctx, data.transactions, period, { categoryIds: [cat.id] });
      const prevMonth = per.month ? summarizePeriod(ctx, data.transactions, monthPeriod(addMonthsToKey(per.month, -1)), { categoryIds: [cat.id] }) : null;
      const count = s.expensesByCategory.get(topCategoryId(ctx, cat.id))?.count ?? 0;
      return {
        intent: 'category_spending',
        text: `Vous avez dépensé ${fmt.money(s.expenses)} en « ${cat.name} » ${per.label} (${count} opération${count > 1 ? 's' : ''})${prevMonth ? `, contre ${fmt.money(prevMonth.expenses)} sur le mois précédent complet` : ''}.`,
        figures: [{ label: 'Total', value: fmt.money(s.expenses) }, ...(s.refunds ? [{ label: 'dont remboursements déduits', value: fmt.money(s.refunds) }] : [])],
        source: 'Somme des dépenses de la catégorie (sous-catégories incluses), nette des remboursements reçus.',
        verified: true,
      };
    }
  }

  // 7. Part des dépenses récurrentes
  if (/recurren|abonnement|charges fixes/.test(q)) {
    const rules = data.recurringRules.filter((r) => r.active && r.kind === 'expense');
    if (!rules.length) return insufficient('recurring', 'Aucune dépense récurrente n’est configurée.');
    const baseline = computeBaseline(ctx, data, today);
    const items = rules.map((r) => ({ r, m: ctx.convert(monthlyEquivalent(r), r.currency, today) ?? 0 })).sort((a, b) => b.m - a.m);
    const total = items.reduce((a, i) => a + i.m, 0);
    const ref = baseline.expenses || null;
    return {
      intent: 'recurring',
      text: `« ${items[0].r.label} » est la dépense récurrente la plus lourde (${fmt.money(items[0].m)}/mois${ref ? `, ${fmt.percent(items[0].m / ref, 0)} de vos dépenses mensuelles moyennes` : ''}). L’ensemble de vos récurrences représente ${fmt.money(total)}/mois${ref ? ` (${fmt.percent(total / ref, 0)})` : ''}.`,
      figures: items.slice(0, 5).map((i) => ({ label: i.r.label, value: `${fmt.money(i.m)}/mois` })),
      source: 'Équivalent mensuel = montant × occurrences par an ÷ 12, rapporté aux dépenses moyennes des 3 derniers mois complets.',
      verified: true,
    };
  }

  // 3. Catégorie qui dépasse le plus son budget
  if (/budget/.test(q) && /depass/.test(q)) {
    const s = summarizePeriod(ctx, data.transactions, monthPeriod(month));
    const ov = monthBudgetOverview(data.budgets, month, s, ctx.categories, today, data.settings.budgetAlertThresholds);
    if (!ov.lines.length) return insufficient('budget_over', 'Aucun budget par catégorie n’est défini pour ce mois.');
    const sorted = [...ov.lines].sort((a, b) => b.variance - a.variance);
    const worst = sorted[0];
    if (worst.variance <= 0) {
      const closest = [...ov.lines].sort((a, b) => (b.consumption ?? 0) - (a.consumption ?? 0))[0];
      return { intent: 'budget_over', text: `Aucune catégorie ne dépasse son budget ce mois-ci. La plus proche de sa limite est « ${closest.category?.name} » (${fmt.percent(closest.consumption, 0)} consommé).`, source: 'Écart = dépenses éligibles − budget prévu, par catégorie.', verified: true };
    }
    const over = sorted.filter((l) => l.variance > 0);
    return {
      intent: 'budget_over',
      text: `« ${worst.category?.name} » dépasse le plus son budget : ${fmt.money(worst.spent)} dépensés pour ${fmt.money(worst.planned)} prévus, soit ${fmt.money(worst.variance)} de dépassement (${fmt.percent(worst.variancePct, 0)}).`,
      figures: over.map((l) => ({ label: l.category?.name ?? '—', value: `+${fmt.money(l.variance)}` })),
      source: `Budgets de ${fmt.month(month)}. Écart = dépenses nettes − budget.`,
      verified: true,
    };
  }

  // 4. Capacité d'épargne
  if (/epargn/.test(q) && /(combien|puis|capacite|raisonnabl)/.test(q) && !/objectif/.test(q)) {
    const f = forecastMonth(ctx, data, today);
    const baseline = computeBaseline(ctx, data, today);
    const avg = baseline.monthsWithData ? baseline.income - baseline.expenses : null;
    const committed = data.goals.filter((g) => g.status === 'active').reduce((a, g) => a + (g.monthlyContribution ?? 0), 0);
    return {
      intent: 'savings_capacity',
      text: `D’après la projection du mois, votre épargne potentielle est d’environ ${fmt.money(f.projectedSavings)}${avg != null ? ` (moyenne des derniers mois : ${fmt.money(avg)})` : ''}. ${f.projectedSavings > 0 ? `Une cible raisonnable serait de mettre de côté ${fmt.money(Math.max(0, Math.round(Math.min(f.projectedSavings, avg ?? f.projectedSavings) * 0.8)))}, en gardant une marge de 20 % pour les imprévus.` : 'La projection ne dégage pas d’épargne ce mois-ci.'}${committed ? ` Vos objectifs prévoient ${fmt.money(committed)}/mois.` : ''}`,
      figures: [
        { label: 'Revenus projetés', value: fmt.money(f.projectedIncome) },
        { label: 'Dépenses projetées', value: fmt.money(f.projectedExpenses) },
        { label: 'Épargne potentielle', value: fmt.money(f.projectedSavings) },
      ],
      source: `Prévision du mois (méthode des dépenses variables : ${f.variableMethod === 'history' ? 'moyenne observée' : f.variableMethod === 'budget' ? 'reste des budgets' : 'données insuffisantes'}). La marge de 20 % est une convention prudente, pas un conseil personnalisé.`,
      verified: true,
    };
  }

  // 5. Évolution sur trois mois
  if (/evolu|tendance|depuis (trois|3)|trois mois|3 mois/.test(q)) {
    const months = [-3, -2, -1].map((i) => addMonthsToKey(month, i));
    const vals = months.map((m) => ({ m, s: summarizePeriod(ctx, data.transactions, monthPeriod(m)) }));
    if (vals.every((v) => v.s.expenses === 0)) return insufficient('trend', 'Aucune dépense sur les trois derniers mois complets.');
    const first = vals[0].s.expenses;
    const last = vals[2].s.expenses;
    const ch = first ? (last - first) / first : null;
    return {
      intent: 'trend',
      text: `Sur les trois derniers mois complets, vos dépenses sont passées de ${fmt.money(first)} (${fmt.month(months[0])}) à ${fmt.money(last)} (${fmt.month(months[2])})${ch != null ? `, soit ${ch >= 0 ? 'une hausse' : 'une baisse'} de ${fmt.percent(Math.abs(ch))}` : ''}.`,
      figures: vals.map((v) => ({ label: fmt.month(v.m), value: `${fmt.money(v.s.expenses)} · épargne ${fmt.money(v.s.netSavings)}` })),
      source: 'Dépenses de consommation par mois calendaire complet (le mois en cours est exclu car incomplet).',
      verified: true,
    };
  }

  // 6. Solde estimé fin de mois
  if (/solde/.test(q) && /(fin|estim|prevu|prevision)/.test(q)) {
    const f = forecastMonth(ctx, data, today);
    return {
      intent: 'end_balance',
      text: `Votre solde estimé à la fin du mois est de ${fmt.money(f.projectedEndBalance)} (aujourd’hui : ${fmt.money(f.currentBalance)}). C’est une estimation, pas une certitude.`,
      figures: [
        { label: 'Revenus récurrents attendus', value: fmt.money(f.expectedRecurringIncome) },
        { label: 'Dépenses récurrentes attendues', value: fmt.money(f.expectedRecurringExpenses) },
        { label: 'Dépenses variables projetées', value: fmt.money(f.variableProjected) },
      ],
      source: f.assumptions.join(' '),
      verified: true,
    };
  }

  // 8. Objectif atteint en premier
  if (/objectif/.test(q)) {
    const balances = accountBalances(data.accounts, data.transactions, today);
    const goals = data.goals.filter((g) => g.status === 'active').map((g) => ({ g, p: computeGoalProgress(g, today, g.linkedAccountId ? balances.get(g.linkedAccountId) : undefined) }));
    const reachable = goals.filter((x) => x.p.projectedDate).sort((a, b) => (a.p.projectedDate! < b.p.projectedDate! ? -1 : 1));
    if (!reachable.length) return insufficient('goal_first', goals.length ? 'Aucun objectif actif n’a de contribution mensuelle définie : impossible d’estimer une date.' : 'Aucun objectif actif.');
    const first = reachable[0];
    return {
      intent: 'goal_first',
      text: `« ${first.g.name} » devrait être atteint en premier, vers le ${fmt.date(first.p.projectedDate!)} : il reste ${fmt.money(first.p.remaining)} avec ${fmt.money(first.g.monthlyContribution ?? 0)}/mois prévus.`,
      figures: reachable.map((x) => ({ label: x.g.name, value: `${fmt.date(x.p.projectedDate!)} · reste ${fmt.money(x.p.remaining)}` })),
      source: 'Date estimée = aujourd’hui + montant restant ÷ contribution mensuelle souhaitée (arrondi au mois supérieur).',
      verified: true,
    };
  }

  // 9. Patrimoine net
  if (/patrimoine|valeur nette|net worth/.test(q)) {
    const nw = computeNetWorth(ctx, data, today);
    return {
      intent: 'net_worth',
      text: `Votre patrimoine net est de ${fmt.money(nw.netWorth)} : ${fmt.money(nw.totalAssets)} d’actifs moins ${fmt.money(nw.totalLiabilities)} de passifs.`,
      source: 'Comptes (une seule fois), actifs valorisés manuellement et créances, moins dettes restantes. Objectifs exclus.',
      verified: true,
    };
  }

  // 10. Revenus / taux d'épargne du mois
  if (/revenu|gagne|taux/.test(q)) {
    const s = summarizePeriod(ctx, data.transactions, monthPeriod(month));
    return { intent: 'month_summary', text: `Ce mois-ci : ${fmt.money(s.income)} de revenus, ${fmt.money(s.expenses)} de dépenses, épargne nette ${fmt.money(s.netSavings)} (taux ${fmt.percent(s.savingsRate)}).`, source: 'Mêmes règles que le dashboard.', verified: true };
  }

  return {
    intent: 'unknown',
    text: 'Je ne sais pas encore répondre à cette question. Essayez l’une des suggestions : dépenses par catégorie, budgets, épargne, solde de fin de mois, récurrences, objectifs ou simulation de réduction.',
    source: 'Assistant à règles déterministes (aucune IA externe).',
    verified: true,
  };
}

function insufficient(intent: string, why: string): AssistantAnswer {
  return { intent, text: `Données insuffisantes : ${why}`, source: 'Aucun chiffre n’est inventé lorsque les données manquent.', verified: true };
}

/** Fournisseur local par défaut. */
export function createRuleBasedProvider(getArgs: () => { ctx: LedgerContext; data: DataSnapshot; today: ISODate; fmt: AssistantFormatters }): AssistantProvider {
  return {
    name: 'Moteur de règles local',
    async answer(question) {
      const { ctx, data, today, fmt } = getArgs();
      return answerQuestion(question, ctx, data, today, fmt);
    },
  };
}
