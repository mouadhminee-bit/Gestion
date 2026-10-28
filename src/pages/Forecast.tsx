import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { FlaskConical, Info, Plus, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState } from '@/components/ui/Misc';
import { Field, Input, MoneyInput, Select } from '@/components/ui/Field';
import { InfoTip } from '@/components/ui/Tooltip';
import { ChartTooltip, SERIES, useChart } from '@/components/charts/ChartKit';
import { useBalances } from '@/features/hooks';
import { forecastMonth, HISTORY_WINDOW_DAYS } from '@/domain/calc/forecast';
import { computeBaseline, EMPTY_SCENARIO, simulateScenario, type ScenarioInput } from '@/domain/calc/scenario';
import { computeGoalProgress } from '@/domain/calc/goals';
import { daysInMonth, formatMonth, monthKey, parseISO } from '@/domain/dates';
import { cn } from '@/lib/cn';

export default function Forecast() {
  const { data, ctx, fmt, today, settings } = useApp();
  const chart = useChart();
  const balances = useBalances();
  const f = useMemo(() => forecastMonth(ctx, data, today), [ctx, data, today]);
  const baseline = useMemo(() => computeBaseline(ctx, data, today), [ctx, data, today]);
  const [input, setInput] = useState<ScenarioInput>(EMPTY_SCENARIO);
  const rent = data.categories.find((c) => c.key === 'rent');
  const { y, m } = parseISO(today);
  const result = useMemo(
    () =>
      simulateScenario({
        baseline,
        input,
        budgetReference: f.budgetReference,
        projectedEndBalance: f.projectedEndBalance,
        remainingDays: f.remainingDays,
        daysInMonth: daysInMonth(y, m),
        goals: data.goals,
        goalSaved: (g) => computeGoalProgress(g, today, g.linkedAccountId ? balances.get(g.linkedAccountId) : undefined).saved,
        today,
        rentCategoryId: rent?.id ?? null,
      }),
    [baseline, input, f, y, m, data.goals, today, balances, rent],
  );
  const changed = JSON.stringify(input) !== JSON.stringify(EMPTY_SCENARIO);
  const setI = <K extends keyof ScenarioInput>(k: K, v: ScenarioInput[K]) => setInput((p) => ({ ...p, [k]: v }));
  const methodLabel = { history: `Moyenne observée (${f.variableHistoryDays} j)`, budget: 'Reste des budgets variables', insufficient: 'Données insuffisantes' }[f.variableMethod];

  // Cascade : chaque barre flotte entre le solde avant et après l'étape.
  const steps = [
    { name: 'Revenus attendus', d: f.expectedRecurringIncome, c: SERIES.income },
    { name: 'Charges attendues', d: -f.expectedRecurringExpenses, c: SERIES.expense },
    { name: 'Variables projetées', d: -f.variableProjected, c: SERIES.warning },
  ];
  const waterfall: { name: string; base: number; v: number; c: string; total: number }[] = [{ name: 'Solde actuel', base: 0, v: chart.major(f.currentBalance), c: SERIES.primary, total: chart.major(f.currentBalance) }];
  let running = f.currentBalance;
  for (const st of steps) {
    const next = running + st.d;
    waterfall.push({ name: st.name, base: chart.major(Math.min(running, next)), v: chart.major(Math.abs(st.d)), c: st.c, total: chart.major(st.d) });
    running = next;
  }
  waterfall.push({ name: 'Solde estimé', base: 0, v: chart.major(f.projectedEndBalance), c: SERIES.cyan, total: chart.major(f.projectedEndBalance) });
  const levels = waterfall.flatMap((w) => (w.base ? [w.base, w.base + w.v] : [w.v]));
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const pad = Math.max((hi - lo) * 0.25, Math.abs(hi) * 0.002, 1);
  const domain: [number, number] = [Math.floor(lo - pad), Math.ceil(hi + pad)];

  return (
    <div>
      <PageHeader eyebrow="Intelligence" title="Prévisions financières" description={`Estimation pour la fin de ${formatMonth(monthKey(today), settings.locale).toLowerCase()} — ${f.remainingDays} jour(s) restant(s). Une projection n’est jamais une certitude.`} />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Solde estimé en fin de mois" info="Solde actuel + revenus récurrents attendus − dépenses récurrentes attendues − dépenses variables projetées. Les échéances déjà payées sont dans le solde actuel et ne sont pas recomptées.">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className={cn('display text-4xl font-semibold num', f.projectedEndBalance < 0 && 'text-negative')}>{fmt.money(f.projectedEndBalance)}</div>
              <div className="mt-1 text-xs text-muted">contre {fmt.money(f.currentBalance)} aujourd’hui ({fmt.money(f.projectedEndBalance - f.currentBalance, undefined, { sign: true })})</div>
            </div>
            <Badge tone={f.variableMethod === 'history' ? 'cyan' : f.variableMethod === 'budget' ? 'warning' : 'negative'}>Méthode : {methodLabel}</Badge>
          </div>
          <p className="mt-2 text-[11px] text-muted">Axe vertical resserré autour des soldes pour rendre les variations lisibles.</p>
          <div className="mt-3 h-56">
            <ResponsiveContainer>
              <BarChart data={waterfall}>
                <CartesianGrid vertical={false} stroke={SERIES.grid} />
                <XAxis dataKey="name" {...chart.axis} interval={0} tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }} />
                <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={52} domain={domain} allowDataOverflow />
                <RTooltip cursor={{ fill: 'rgb(var(--surface-3) / 0.5)' }} content={({ active, payload, label }) => active && payload?.length ? <ChartTooltip active label={label} payload={[{ name: 'Montant', value: (payload[0].payload as { total: number }).total, color: (payload[0].payload as { c: string }).c }]} valueFormatter={chart.money} /> : null} />
                <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
                <Bar dataKey="v" stackId="w" name="Montant" radius={[6, 6, 6, 6]} maxBarSize={48} isAnimationActive={chart.animate} animationDuration={chart.duration}>
                  {waterfall.map((w) => <Cell key={w.name} fill={w.c} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Indicateurs projetés">
          <dl className="space-y-2.5 text-sm">
            {[
              ['Revenus enregistrés', f.recordedIncome],
              ['+ Revenus récurrents attendus', f.expectedRecurringIncome],
              ['= Revenus projetés', f.projectedIncome, true],
              ['Dépenses enregistrées', f.recordedExpenses],
              ['+ Dépenses récurrentes attendues', f.expectedRecurringExpenses],
              ['+ Dépenses variables projetées', f.variableProjected],
              ['= Dépenses projetées', f.projectedExpenses, true],
              ['Épargne potentielle', f.projectedSavings, true],
            ].map(([l, v, strong]) => (
              <div key={l as string} className={cn('flex justify-between gap-2', strong && 'border-t border-line/10 pt-2 font-semibold')}>
                <dt className={cn(!strong && 'text-muted')}>{l}</dt>
                <dd className="num">{fmt.money(v as number)}</dd>
              </div>
            ))}
          </dl>
          {f.variableDailyAverage != null && <p className="mt-3 text-xs text-muted">Moyenne variable observée : {fmt.money(Math.round(f.variableDailyAverage))}/jour sur {f.variableHistoryDays} jours (fenêtre max. {HISTORY_WINDOW_DAYS} j).</p>}
          {f.budgetReference != null && (
            <div className={cn('mt-4 rounded-xl border p-3 text-xs', (f.projectedBudgetOverrun ?? 0) > 0 ? 'border-warning/30 bg-warning/10' : 'border-positive/25 bg-positive/10')}>
              <div className="flex items-center gap-1.5 font-semibold">{(f.projectedBudgetOverrun ?? 0) > 0 ? <><TriangleAlert className="h-3.5 w-3.5 text-warning" /> Risque de dépassement budgétaire</> : 'Budget tenable'}</div>
              <div className="mt-1 text-muted">Budget de référence {fmt.money(f.budgetReference)} — écart projeté {fmt.money(f.projectedBudgetOverrun ?? 0, undefined, { sign: true })}.</div>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Hypothèses" info="Toutes les hypothèses utilisées par le calcul, pour une projection vérifiable.">
          <ul className="space-y-2 text-sm">
            {f.assumptions.map((a) => <li key={a} className="flex gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan" /><span className="text-muted">{a}</span></li>)}
          </ul>
        </Card>
        <Card title="Échéances restant à régler ce mois-ci">
          {f.pending.length ? (
            <ul className="divide-y divide-line/5 text-sm">
              {f.pending.map((o) => (
                <li key={o.id} className="flex justify-between gap-2 py-2">
                  <span className="min-w-0"><span className="block truncate">{o.rule.label}</span><span className="text-xs text-muted">{fmt.date(o.dueDate)} {o.status === 'overdue' && <Badge tone="warning">En retard</Badge>}</span></span>
                  <span className={cn('num font-medium', o.rule.kind === 'income' && 'text-positive')}>{fmt.money(o.rule.kind === 'income' ? o.rule.amount : -o.rule.amount, o.rule.currency, { sign: true })}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Aucune échéance récurrente en attente.</p>}
        </Card>
      </div>

      <Card className="mt-5" title={<span className="flex items-center gap-1.5"><FlaskConical className="h-4 w-4 text-violet" /> Simulateur de scénarios</span>} info="Les simulations ne modifient jamais vos données réelles." actions={changed && <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setInput(EMPTY_SCENARIO)}>Réinitialiser</Button>}>
        {!result.sufficientData ? (
          <EmptyState title="Historique insuffisant" description="Le simulateur s’appuie sur la moyenne de vos 3 derniers mois complets. Aucun mois complet avec des revenus ou des dépenses n’est disponible." />
        ) : (
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="space-y-3 lg:col-span-2">
              <p className="text-xs text-muted">Base : moyenne mensuelle de {baseline.monthsWithData} mois complet(s) ({baseline.months.map((x) => formatMonth(x, settings.locale)).join(', ')}).</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Variation des revenus (%)"><Input type="number" inputMode="decimal" value={input.incomeChangePct || ''} placeholder="ex : 10 ou -15" onChange={(e) => setI('incomeChangePct', Number(e.target.value) || 0)} /></Field>
                <Field label="Revenus +/– (par mois)"><MoneyInput allowNegative value={input.incomeChangeAmount || null} onChange={(v) => setI('incomeChangeAmount', v ?? 0)} currency={settings.baseCurrency} /></Field>
                <Field label="Hausse de loyer (par mois)"><MoneyInput value={input.rentIncrease || null} onChange={(v) => setI('rentIncrease', v ?? 0)} currency={settings.baseCurrency} /></Field>
                <Field label="Nouvelle dépense récurrente"><MoneyInput value={input.newRecurringExpense || null} onChange={(v) => setI('newRecurringExpense', v ?? 0)} currency={settings.baseCurrency} /></Field>
                <Field label="Achat important (ponctuel)"><MoneyInput value={input.oneOffPurchase || null} onChange={(v) => setI('oneOffPurchase', v ?? 0)} currency={settings.baseCurrency} /></Field>
                <Field label="Épargne supplémentaire / mois"><MoneyInput value={input.extraSavings || null} onChange={(v) => setI('extraSavings', v ?? 0)} currency={settings.baseCurrency} /></Field>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted">Réduire certaines dépenses</div>
                {input.categoryReductions.map((r, i) => (
                  <div key={i} className="mb-2 flex gap-2">
                    <Select value={r.categoryId} onChange={(e) => setI('categoryReductions', input.categoryReductions.map((x, j) => (j === i ? { ...x, categoryId: e.target.value } : x)))}>
                      {data.categories.filter((c) => c.kind === 'expense' && !c.parentId).map((c) => <option key={c.id} value={c.id}>{c.name} ({fmt.money(baseline.byCategory.get(c.id) ?? 0)}/mois)</option>)}
                    </Select>
                    <Input type="number" className="w-24" value={r.pct} min={0} max={100} aria-label="Pourcentage de réduction" onChange={(e) => setI('categoryReductions', input.categoryReductions.map((x, j) => (j === i ? { ...x, pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) } : x)))} />
                    <Button size="icon" variant="ghost" aria-label="Retirer" onClick={() => setI('categoryReductions', input.categoryReductions.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setI('categoryReductions', [...input.categoryReductions, { categoryId: data.categories.find((c) => c.key === 'leisure')?.id ?? data.categories.find((c) => c.kind === 'expense')!.id, pct: 15 }])}>Ajouter une réduction</Button>
              </div>
            </div>
            <div className="lg:col-span-3">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1.5">Mensuel moyen</th><th className="text-right">Actuel</th><th className="text-right">Scénario</th><th className="text-right">Écart</th></tr></thead>
                <tbody className="divide-y divide-line/5">
                  {[
                    ['Revenus', result.baseline.income, result.scenario.income, false],
                    ['Dépenses', result.baseline.expenses, result.scenario.expenses, true],
                    ['Épargne', result.baseline.savings, result.scenario.savings, false],
                  ].map(([l, a, b, inv]) => {
                    const d = (b as number) - (a as number);
                    return (
                      <tr key={l as string}><td className="py-2">{l}</td><td className="text-right num">{fmt.money(a as number)}</td><td className="text-right num font-semibold">{fmt.money(b as number)}</td><td className={cn('text-right num', d === 0 ? 'text-muted' : (inv ? d < 0 : d > 0) ? 'text-positive' : 'text-negative')}>{fmt.money(d, undefined, { sign: true })}</td></tr>
                    );
                  })}
                  <tr><td className="py-2">Taux d’épargne</td><td className="text-right num">{fmt.percent(result.baseline.savingsRate)}</td><td className="text-right num font-semibold">{fmt.percent(result.scenario.savingsRate)}</td><td /></tr>
                  {result.budgetRemainingBaseline != null && <tr><td className="py-2 flex items-center gap-1">Budget mensuel restant <InfoTip>Budget de référence du mois en cours − dépenses mensuelles moyennes.</InfoTip></td><td className="text-right num">{fmt.money(result.budgetRemainingBaseline)}</td><td className="text-right num font-semibold">{fmt.money(result.budgetRemainingScenario!)}</td><td /></tr>}
                  <tr><td className="py-2 flex items-center gap-1">Solde fin de mois <InfoTip>Prévision actuelle + effet du scénario au prorata des jours restants − achat ponctuel.</InfoTip></td><td className="text-right num">{fmt.money(result.endOfMonthBaseline)}</td><td className={cn('text-right num font-semibold', result.endOfMonthScenario < 0 && 'text-negative')}>{fmt.money(result.endOfMonthScenario)}</td><td /></tr>
                </tbody>
              </table>
              {result.goals.length > 0 && (
                <div className="mt-5">
                  <div className="label mb-2 flex items-center gap-1">Délai d’atteinte des objectifs <InfoTip>Contributions prévues, réduites proportionnellement si l’épargne mensuelle ne suffit pas ; l’épargne supplémentaire va à l’objectif le plus prioritaire.</InfoTip></div>
                  <ul className="divide-y divide-line/5 text-sm">
                    {result.goals.map((g) => (
                      <li key={g.goal.id} className="flex justify-between gap-2 py-2">
                        <span className="truncate">{g.goal.name}</span>
                        <span className="text-right text-xs">
                          <span className="text-muted">{g.baselineMonths == null ? 'non atteignable' : `${g.baselineMonths} mois`}</span>
                          {' → '}
                          <b className={cn(g.scenarioMonths != null && g.baselineMonths != null && g.scenarioMonths < g.baselineMonths ? 'text-positive' : g.scenarioMonths == null || (g.baselineMonths != null && g.scenarioMonths > g.baselineMonths) ? 'text-warning' : '')}>{g.scenarioMonths == null ? 'non atteignable' : `${g.scenarioMonths} mois`}</b>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!changed && <p className="mt-4 text-xs text-muted">Modifiez un paramètre à gauche pour voir son impact.</p>}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
