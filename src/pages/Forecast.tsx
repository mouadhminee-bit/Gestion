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
import { isLate } from '@/domain/calc/recurring';
import { occurrenceBadge } from '@/features/recurring/status';
import { daysInMonth, formatMonth, monthKey, parseISO } from '@/domain/dates';
import { cn } from '@/lib/cn';
import { t } from '@/i18n/core';

export default function Forecast() {
  const { data, ctx, fmt, today, settings, uiLocale } = useApp();
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
  const methodLabel = { history: t('fc.method.history', { days: f.variableHistoryDays }), budget: t('fc.method.budget'), insufficient: t('fc.method.insufficient') }[f.variableMethod];

  // Cascade : chaque barre flotte entre le solde avant et après l'étape.
  const steps = [
    { name: t('fc.step.income'), d: f.expectedRecurringIncome, c: SERIES.income },
    { name: t('fc.step.charges'), d: -f.expectedRecurringExpenses, c: SERIES.expense },
    { name: t('fc.step.variable'), d: -f.variableProjected, c: SERIES.warning },
  ];
  const waterfall: { name: string; base: number; v: number; c: string; total: number }[] = [{ name: t('fc.step.current'), base: 0, v: chart.major(f.currentBalance), c: SERIES.primary, total: chart.major(f.currentBalance) }];
  let running = f.currentBalance;
  for (const st of steps) {
    const next = running + st.d;
    waterfall.push({ name: st.name, base: chart.major(Math.min(running, next)), v: chart.major(Math.abs(st.d)), c: st.c, total: chart.major(st.d) });
    running = next;
  }
  waterfall.push({ name: t('fc.step.estimated'), base: 0, v: chart.major(f.projectedEndBalance), c: SERIES.cyan, total: chart.major(f.projectedEndBalance) });
  const levels = waterfall.flatMap((w) => (w.base ? [w.base, w.base + w.v] : [w.v]));
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const pad = Math.max((hi - lo) * 0.25, Math.abs(hi) * 0.002, 1);
  const domain: [number, number] = [Math.floor(lo - pad), Math.ceil(hi + pad)];

  return (
    <div>
      <PageHeader eyebrow={t('an.eyebrow')} title={t('fc.title')} description={t('fc.description', { month: formatMonth(monthKey(today), uiLocale), count: f.remainingDays })} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={t('fc.endBalance')} info={t('fc.endBalance.info')}>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className={cn('display text-4xl font-semibold num', f.projectedEndBalance < 0 && 'text-negative')}>{fmt.money(f.projectedEndBalance)}</div>
              <div className="mt-1 text-xs text-muted">{t('fc.vsToday', { current: fmt.money(f.currentBalance), delta: fmt.money(f.projectedEndBalance - f.currentBalance, undefined, { sign: true }) })}</div>
            </div>
            <Badge tone={f.variableMethod === 'history' ? 'cyan' : f.variableMethod === 'budget' ? 'warning' : 'negative'}>{t('fc.method', { method: methodLabel })}</Badge>
          </div>
          <p className="mt-2 text-[11px] text-muted">{t('fc.axisNote')}</p>
          <div className="mt-3 h-56">
            <ResponsiveContainer>
              <BarChart data={waterfall}>
                <CartesianGrid vertical={false} stroke={SERIES.grid} />
                <XAxis dataKey="name" {...chart.axis} interval={0} tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }} />
                <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(52)} domain={domain} allowDataOverflow />
                <RTooltip cursor={{ fill: 'rgb(var(--surface-3) / 0.5)' }} content={({ active, payload, label }) => active && payload?.length ? <ChartTooltip active label={label} payload={[{ name: t('common.amount'), value: (payload[0].payload as { total: number }).total, color: (payload[0].payload as { c: string }).c }]} valueFormatter={chart.money} /> : null} />
                <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
                <Bar dataKey="v" stackId="w" name={t('common.amount')} radius={[6, 6, 6, 6]} maxBarSize={48} isAnimationActive={chart.animate} animationDuration={chart.duration}>
                  {waterfall.map((w) => <Cell key={w.name} fill={w.c} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title={t('fc.indicators')}>
          <dl className="space-y-2.5 text-sm">
            {[
              [t('fc.ind.recordedIncome'), f.recordedIncome],
              [t('fc.ind.expectedIncome'), f.expectedRecurringIncome],
              [t('fc.ind.projectedIncome'), f.projectedIncome, true],
              [t('fc.ind.recordedExpenses'), f.recordedExpenses],
              [t('fc.ind.expectedExpenses'), f.expectedRecurringExpenses],
              [t('fc.ind.variable'), f.variableProjected],
              [t('fc.ind.projectedExpenses'), f.projectedExpenses, true],
              [t('fc.ind.savings'), f.projectedSavings, true],
            ].map(([l, v, strong]) => (
              <div key={l as string} className={cn('flex justify-between gap-2', strong && 'border-t border-line/10 pt-2 font-semibold')}>
                <dt className={cn(!strong && 'text-muted')}>{l}</dt>
                <dd className="num">{fmt.money(v as number)}</dd>
              </div>
            ))}
          </dl>
          {f.variableDailyAverage != null && <p className="mt-3 text-xs text-muted">{t('fc.dailyAverage', { amount: fmt.money(Math.round(f.variableDailyAverage)), days: f.variableHistoryDays, max: HISTORY_WINDOW_DAYS })}</p>}
          {f.budgetReference != null && (
            <div className={cn('mt-4 rounded-xl border p-3 text-xs', (f.projectedBudgetOverrun ?? 0) > 0 ? 'border-warning/30 bg-warning/10' : 'border-positive/25 bg-positive/10')}>
              <div className="flex items-center gap-1.5 font-semibold">{(f.projectedBudgetOverrun ?? 0) > 0 ? <><TriangleAlert className="h-3.5 w-3.5 text-warning" /> {t('fc.overrunRisk')}</> : t('fc.budgetOk')}</div>
              <div className="mt-1 text-muted">{t('fc.budgetDetail', { reference: fmt.money(f.budgetReference), gap: fmt.money(f.projectedBudgetOverrun ?? 0, undefined, { sign: true }) })}</div>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title={t('fc.assumptions')} info={t('fc.assumptions.info')}>
          <ul className="space-y-2 text-sm">
            {f.assumptions.map((a) => <li key={a} className="flex gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan" /><span className="text-muted">{a}</span></li>)}
          </ul>
        </Card>
        <Card title={t('fc.pending')}>
          {f.pending.length ? (
            <ul className="divide-y divide-line/5 text-sm">
              {f.pending.map((o) => (
                <li key={o.id} className="flex justify-between gap-2 py-2">
                  <span className="min-w-0"><span className="block truncate">{o.rule.label}</span><span className="text-xs text-muted">{fmt.date(o.dueDate)} {isLate(o, today) && <Badge tone="warning">{t('fc.overdue')}</Badge>} {o.status === 'partial' && <Badge tone="warning">{occurrenceBadge(o, today).label}</Badge>}</span></span>
                  <span className={cn('num font-medium', o.rule.kind === 'income' && 'text-positive')}>{fmt.money(o.rule.kind === 'income' ? o.remaining : -o.remaining, o.rule.currency, { sign: true })}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">{t('fc.noPending')}</p>}
        </Card>
      </div>

      <Card className="mt-5" title={<span className="flex items-center gap-1.5"><FlaskConical className="h-4 w-4 text-violet" /> {t('fc.simulator')}</span>} info={t('fc.simulator.info')} actions={changed && <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setInput(EMPTY_SCENARIO)}>{t('fc.reset')}</Button>}>
        {!result.sufficientData ? (
          <EmptyState title={t('fc.insufficient.title')} description={t('fc.insufficient.description')} />
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <div className="space-y-3 lg:col-span-2">
              <p className="text-xs text-muted">{t('fc.base', { count: baseline.monthsWithData, months: baseline.months.map((x) => formatMonth(x, uiLocale)).join(', ') })}</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('fc.in.incomePct')}><Input type="number" inputMode="decimal" value={input.incomeChangePct || ''} placeholder={t('fc.in.incomePctPlaceholder')} onChange={(e) => setI('incomeChangePct', Number(e.target.value) || 0)} /></Field>
                <Field label={t('fc.in.incomeAmount')}><MoneyInput allowNegative value={input.incomeChangeAmount || null} onChange={(v) => setI('incomeChangeAmount', v ?? 0)} currency={settings.baseCurrency} /></Field>
                <Field label={t('fc.in.rent')}><MoneyInput value={input.rentIncrease || null} onChange={(v) => setI('rentIncrease', v ?? 0)} currency={settings.baseCurrency} /></Field>
                <Field label={t('fc.in.newRecurring')}><MoneyInput value={input.newRecurringExpense || null} onChange={(v) => setI('newRecurringExpense', v ?? 0)} currency={settings.baseCurrency} /></Field>
                <Field label={t('fc.in.oneOff')}><MoneyInput value={input.oneOffPurchase || null} onChange={(v) => setI('oneOffPurchase', v ?? 0)} currency={settings.baseCurrency} /></Field>
                <Field label={t('fc.in.extraSavings')}><MoneyInput value={input.extraSavings || null} onChange={(v) => setI('extraSavings', v ?? 0)} currency={settings.baseCurrency} /></Field>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted">{t('fc.reduce')}</div>
                {input.categoryReductions.map((r, i) => (
                  <div key={i} className="mb-2 flex gap-2">
                    <Select value={r.categoryId} onChange={(e) => setI('categoryReductions', input.categoryReductions.map((x, j) => (j === i ? { ...x, categoryId: e.target.value } : x)))}>
                      {data.categories.filter((c) => c.kind === 'expense' && !c.parentId).map((c) => <option key={c.id} value={c.id}>{t('fc.catPerMonth', { name: c.name, amount: fmt.money(baseline.byCategory.get(c.id) ?? 0) })}</option>)}
                    </Select>
                    <Input type="number" className="w-24" value={r.pct} min={0} max={100} aria-label={t('fc.reducePct')} onChange={(e) => setI('categoryReductions', input.categoryReductions.map((x, j) => (j === i ? { ...x, pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) } : x)))} />
                    <Button size="icon" variant="ghost" aria-label={t('fc.remove')} onClick={() => setI('categoryReductions', input.categoryReductions.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setI('categoryReductions', [...input.categoryReductions, { categoryId: data.categories.find((c) => c.key === 'leisure')?.id ?? data.categories.find((c) => c.kind === 'expense')!.id, pct: 15 }])}>{t('fc.addReduction')}</Button>
              </div>
            </div>
            <div className="min-w-0 lg:col-span-3">
              <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm [&_td+td]:ps-3 [&_th+th]:ps-3">
                <thead><tr className="text-start text-xs text-muted"><th className="py-1.5">{t('fc.col.monthlyAvg')}</th><th className="text-end">{t('fc.col.current')}</th><th className="text-end">{t('fc.col.scenario')}</th><th className="text-end">{t('rep.col.gap')}</th></tr></thead>
                <tbody className="divide-y divide-line/5">
                  {[
                    [t('common.income'), result.baseline.income, result.scenario.income, false],
                    [t('common.expenses'), result.baseline.expenses, result.scenario.expenses, true],
                    [t('rep.col.savings'), result.baseline.savings, result.scenario.savings, false],
                  ].map(([l, a, b, inv]) => {
                    const d = (b as number) - (a as number);
                    return (
                      <tr key={l as string}><td className="py-2">{l}</td><td className="text-end num">{fmt.money(a as number)}</td><td className="text-end num font-semibold">{fmt.money(b as number)}</td><td className={cn('text-end num', d === 0 ? 'text-muted' : (inv ? d < 0 : d > 0) ? 'text-positive' : 'text-negative')}>{fmt.money(d, undefined, { sign: true })}</td></tr>
                    );
                  })}
                  <tr><td className="py-2">{t('an.savingsRate')}</td><td className="text-end num">{fmt.percent(result.baseline.savingsRate)}</td><td className="text-end num font-semibold">{fmt.percent(result.scenario.savingsRate)}</td><td /></tr>
                  {result.budgetRemainingBaseline != null && <tr><td className="py-2 flex items-center gap-1">{t('fc.budgetRemaining')} <InfoTip>{t('fc.budgetRemaining.info')}</InfoTip></td><td className="text-end num">{fmt.money(result.budgetRemainingBaseline)}</td><td className="text-end num font-semibold">{fmt.money(result.budgetRemainingScenario!)}</td><td /></tr>}
                  <tr><td className="py-2 flex items-center gap-1">{t('fc.endOfMonth')} <InfoTip>{t('fc.endOfMonth.info')}</InfoTip></td><td className="text-end num">{fmt.money(result.endOfMonthBaseline)}</td><td className={cn('text-end num font-semibold', result.endOfMonthScenario < 0 && 'text-negative')}>{fmt.money(result.endOfMonthScenario)}</td><td /></tr>
                </tbody>
              </table>
              </div>
              {result.goals.length > 0 && (
                <div className="mt-5">
                  <div className="label mb-2 flex items-center gap-1">{t('fc.goalDelay')} <InfoTip>{t('fc.goalDelay.info')}</InfoTip></div>
                  <ul className="divide-y divide-line/5 text-sm">
                    {result.goals.map((g) => (
                      <li key={g.goal.id} className="flex justify-between gap-2 py-2">
                        <span className="truncate">{g.goal.name}</span>
                        <span className="text-end text-xs">
                          <span className="text-muted">{g.baselineMonths == null ? t('fc.unreachable') : t('an.months', { count: g.baselineMonths })}</span>
                          {' → '}
                          <b className={cn(g.scenarioMonths != null && g.baselineMonths != null && g.scenarioMonths < g.baselineMonths ? 'text-positive' : g.scenarioMonths == null || (g.baselineMonths != null && g.scenarioMonths > g.baselineMonths) ? 'text-warning' : '')}>{g.scenarioMonths == null ? t('fc.unreachable') : t('an.months', { count: g.scenarioMonths })}</b>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!changed && <p className="mt-4 text-xs text-muted">{t('fc.hint')}</p>}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
