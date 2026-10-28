import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Button } from '@/components/ui/Button';
import { Logo } from '@/components/layout/AppShell';
import type { Period } from '@/domain/dates';
import { minDate, monthKey, monthPeriod, monthRange, previousPeriod, quarterPeriod, yearPeriod, formatMonthShort } from '@/domain/dates';
import { comparePeriods, monthlySeries } from '@/domain/calc/analytics';
import { monthBudgetOverview } from '@/domain/calc/budgets';
import { summarizePeriod } from '@/domain/calc/ledger';
import { computeGoalProgress, GOAL_STATE_LABELS } from '@/domain/calc/goals';
import { computeNetWorth, ASSET_CLASS_LABELS, type AssetClass } from '@/domain/calc/networth';
import { accountBalances } from '@/domain/calc/ledger';
import { cn } from '@/lib/cn';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card mb-4 break-inside-avoid p-5">
      <h2 className="display mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function Report() {
  const { data, ctx, fmt, today, settings } = useApp();
  const [params] = useSearchParams();
  const type = (params.get('type') ?? 'month') as 'month' | 'quarter' | 'year';
  const key = params.get('key') ?? monthKey(today);

  const { period, title } = useMemo((): { period: Period; title: string } => {
    if (type === 'year') return { period: yearPeriod(Number(key)), title: `Rapport annuel ${key}` };
    if (type === 'quarter') {
      const [y, q] = key.split('-Q').map(Number);
      return { period: quarterPeriod(y, q), title: `Rapport trimestriel — T${q} ${y}` };
    }
    return { period: monthPeriod(key), title: `Rapport mensuel — ${fmt.month(key)}` };
  }, [type, key, fmt]);

  const prev = previousPeriod(period);
  const cmp = comparePeriods(ctx, data.transactions, period, prev);
  const s = cmp.current;
  const months = monthRange(monthKey(period.start), monthKey(period.end));
  const series = monthlySeries(ctx, data.transactions, months);
  const asOf = minDate(period.end, today);
  const nw = computeNetWorth(ctx, data, asOf);
  const balances = accountBalances(data.accounts, data.transactions, asOf);
  const budgetRows = months.map((m) => {
    const ov = monthBudgetOverview(data.budgets, m, summarizePeriod(ctx, data.transactions, monthPeriod(m)), ctx.categories, today, settings.budgetAlertThresholds);
    return { m, ov };
  });
  const cats = [...s.expensesByCategory.values()].sort((a, b) => b.amount - a.amount);
  const totalBudget = budgetRows.reduce((a, r) => a + (r.ov.referenceSource === 'none' ? 0 : r.ov.reference), 0);
  const hasBudgets = budgetRows.some((r) => r.ov.referenceSource !== 'none');

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print mb-4 flex items-center justify-between">
        <Link to="/analytics"><Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />}>Retour</Button></Link>
        <Button variant="primary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Imprimer / PDF</Button>
      </div>

      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="display text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted">Du {fmt.date(period.start)} au {fmt.date(period.end)} · comparé au {fmt.date(prev.start)} – {fmt.date(prev.end)} · édité le {fmt.date(today)}</p>
          {settings.demoMode && <p className="mt-1 text-xs font-semibold text-warning">Données de démonstration fictives.</p>}
          {asOf < period.end && <p className="mt-1 text-xs text-muted">Période en cours : chiffres arrêtés au {fmt.date(asOf)}.</p>}
        </div>
        <Logo />
      </header>

      <Section title="Synthèse">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ['Revenus', fmt.money(s.income), cmp.incomeChange],
            ['Dépenses', fmt.money(s.expenses), cmp.expensesChange],
            ['Épargne nette', fmt.money(s.netSavings), null],
            ['Taux d’épargne', fmt.percent(s.savingsRate), null],
          ].map(([l, v, ch]) => (
            <div key={l as string}>
              <div className="label">{l}</div>
              <div className="mt-1 text-lg font-semibold num">{v}</div>
              {ch != null && <div className="text-xs text-muted">{(ch as number) >= 0 ? '+' : ''}{fmt.percent(ch as number, 1)} vs période préc.</div>}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">Dépenses fixes : {fmt.money(s.fixedExpenses)} · variables : {fmt.money(s.variableExpenses)} · remboursements reçus : {fmt.money(s.refunds)} · transferts internes (exclus) : {fmt.money(s.transfers)}.</p>
        {months.length > 1 && (
          <table className="mt-4 w-full text-xs">
            <thead><tr className="text-left text-muted"><th className="py-1">Mois</th><th className="text-right">Revenus</th><th className="text-right">Dépenses</th><th className="text-right">Épargne</th><th className="text-right">Taux</th></tr></thead>
            <tbody className="divide-y divide-line/10">
              {series.map((p) => (
                <tr key={p.month}><td className="py-1">{formatMonthShort(p.month, settings.locale)} {p.month.slice(0, 4)}</td><td className="text-right num">{fmt.money(p.income)}</td><td className="text-right num">{fmt.money(p.expenses)}</td><td className="text-right num">{fmt.money(p.netSavings)}</td><td className="text-right num">{fmt.percent(p.savingsRate, 0)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Dépenses par catégorie">
        {cats.length ? (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted"><th className="py-1">Catégorie</th><th className="text-right">Montant</th><th className="text-right">Part</th><th className="text-right">Période préc.</th></tr></thead>
            <tbody className="divide-y divide-line/10">
              {cats.map((c) => (
                <tr key={c.categoryId ?? 'none'}>
                  <td className="py-1.5">{c.categoryId ? ctx.categories.get(c.categoryId)?.name : 'Sans catégorie'}</td>
                  <td className="text-right num">{fmt.money(c.amount)}</td>
                  <td className="text-right num">{fmt.percent(s.expenses ? c.amount / s.expenses : null, 0)}</td>
                  <td className="text-right num text-muted">{fmt.money(cmp.previous.expensesByCategory.get(c.categoryId)?.amount ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-sm text-muted">Aucune dépense sur la période.</p>}
      </Section>

      <Section title="Synthèse budgétaire">
        {hasBudgets ? (
          <>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted"><th className="py-1">Mois</th><th className="text-right">Budget</th><th className="text-right">Dépensé</th><th className="text-right">Écart</th><th className="text-right">Catégories dépassées</th></tr></thead>
              <tbody className="divide-y divide-line/10">
                {budgetRows.map(({ m, ov }) => {
                  const spent = ov.reference - (ov.available ?? 0);
                  return (
                    <tr key={m}>
                      <td className="py-1.5">{fmt.month(m)}</td>
                      <td className="text-right num">{ov.referenceSource === 'none' ? '—' : fmt.money(ov.reference)}</td>
                      <td className="text-right num">{ov.referenceSource === 'none' ? '—' : fmt.money(spent)}</td>
                      <td className={cn('text-right num', ov.available != null && ov.available < 0 && 'text-negative')}>{ov.available == null ? '—' : fmt.money(-ov.available, undefined, { sign: true })}</td>
                      <td className="text-right text-xs">{ov.lines.filter((l) => l.status === 'over').map((l) => l.category?.name).join(', ') || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">Budget cumulé de la période : {fmt.money(totalBudget)}. Écart positif = dépassement.</p>
          </>
        ) : <p className="text-sm text-muted">Aucun budget défini sur la période.</p>}
      </Section>

      <Section title="Synthèse des objectifs">
        {data.goals.length ? (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted"><th className="py-1">Objectif</th><th className="text-right">Constitué</th><th className="text-right">Cible</th><th className="text-right">Progression</th><th className="text-right">État</th></tr></thead>
            <tbody className="divide-y divide-line/10">
              {data.goals.map((g) => {
                const p = computeGoalProgress(g, today, g.linkedAccountId ? balances.get(g.linkedAccountId) : undefined);
                return (
                  <tr key={g.id}><td className="py-1.5">{g.name}</td><td className="text-right num">{fmt.money(p.saved)}</td><td className="text-right num">{fmt.money(g.targetAmount)}</td><td className="text-right num">{fmt.percent(p.progressCapped, 0)}</td><td className="text-right text-xs">{GOAL_STATE_LABELS[p.state]}</td></tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="text-sm text-muted">Aucun objectif.</p>}
        <p className="mt-2 text-xs text-muted">Les objectifs sont des affectations et ne sont pas ajoutés au patrimoine.</p>
      </Section>

      <Section title={`Synthèse patrimoniale au ${fmt.date(asOf)}`}>
        <div className="grid grid-cols-3 gap-4">
          <div><div className="label">Actifs</div><div className="font-semibold num">{fmt.money(nw.totalAssets)}</div></div>
          <div><div className="label">Passifs</div><div className="font-semibold num">{fmt.money(nw.totalLiabilities)}</div></div>
          <div><div className="label">Patrimoine net</div><div className="font-semibold num">{fmt.money(nw.netWorth)}</div></div>
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
          {(Object.keys(nw.byClass) as AssetClass[]).filter((k) => nw.byClass[k]).map((k) => <li key={k} className="flex justify-between"><span className="text-muted">{ASSET_CLASS_LABELS[k]}</span><span className="num">{fmt.money(nw.byClass[k])}</span></li>)}
        </ul>
        {nw.assets.some((a) => a.manual) && <p className="mt-2 text-xs text-muted">Certaines valeurs sont des estimations saisies manuellement.</p>}
      </Section>
      <p className="pb-6 text-center text-[11px] text-muted">NEXORA — chiffres calculés à partir des données saisies par l’utilisateur. Les projections ne sont pas des certitudes.</p>
    </div>
  );
}
