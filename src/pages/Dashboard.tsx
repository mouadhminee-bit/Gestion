import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownLeft, ArrowUpRight, ChevronRight, PiggyBank, Plus, Sparkles, Target, Wallet, Percent, Gauge, AlertTriangle } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card } from '@/components/ui/Card';
import { AnimatedAmount, Badge, EmptyState, ProgressRing, DemoBadge } from '@/components/ui/Misc';
import { InfoTip } from '@/components/ui/Tooltip';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { ChartTooltip, LegendDot, NoData, SERIES, useChart } from '@/components/charts/ChartKit';
import { useBalances, useMonthData } from '@/features/hooks';
import { TransactionRow } from '@/features/transactions/TransactionRow';
import { useTransactionForm } from '@/features/transactions/TransactionForm';
import { InsightList } from '@/features/insights/InsightList';
import { generateInsights } from '@/domain/calc/insights';
import { monthlySeries, relativeChange } from '@/domain/calc/analytics';
import { dailyBalanceSeries, accountsInScope } from '@/domain/calc/ledger';
import { computeGoalProgress } from '@/domain/calc/goals';
import { addMonthsToKey, formatLongDate, formatMonthShort, monthKey, monthPeriod, parseISO } from '@/domain/dates';
import { cn } from '@/lib/cn';
import type { MoneyBag } from '@/domain/money';
import { t } from '@/i18n/core';
import { lazyLabels } from '@/i18n/labels';

export const DEFINITIONS = lazyLabels('def', ['balance', 'income', 'expenses', 'savings', 'rate', 'available']);

function Delta({ current, previous, invert }: { current: number; previous: number; invert?: boolean }) {
  const { fmt } = useApp();
  const ch = relativeChange(current, previous);
  if (ch == null) return <span className="text-[11px] text-muted">{t('dash.noComparison')}</span>;
  const good = invert ? ch <= 0 : ch >= 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium', good ? 'text-positive' : 'text-negative')}>
      {ch >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownLeft className="h-3 w-3" />}
      {fmt.percent(Math.abs(ch), 0)} <span className="font-normal text-muted">{t('dash.vsPrev')}</span>
    </span>
  );
}

function Kpi({ icon: Icon, label, info, children, footer, accent, delay }: { icon: typeof Wallet; label: string; info: string; children: React.ReactNode; footer?: React.ReactNode; accent: string; delay: number }) {
  return (
    <div className="card group relative overflow-hidden p-4 animate-fade-up sm:p-5" style={{ animationDelay: `${delay}ms` }}>
      <div className="pointer-events-none absolute -end-8 -top-8 h-24 w-24 rounded-full opacity-20 blur-2xl transition group-hover:opacity-40" style={{ background: accent }} />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs font-medium text-muted">
          {label}
          <InfoTip>{info}</InfoTip>
        </div>
        <Icon className="h-4 w-4" style={{ color: accent }} aria-hidden />
      </div>
      <div className="mt-2 truncate display text-xl font-semibold sm:text-2xl">{children}</div>
      {footer && <div className="mt-1.5 min-h-[16px]">{footer}</div>}
    </div>
  );
}

function UnconvertedNote({ bag }: { bag: MoneyBag }) {
  const { fmt } = useApp();
  const entries = Object.entries(bag).filter(([, v]) => v !== 0);
  if (!entries.length) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-muted">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <span>
        {t('dash.unconverted', { amounts: entries.map(([c, v]) => fmt.money(v, c)).join(' · ') })}{' '}
        <Link to="/settings#rates" className="text-cyan underline">{t('dash.addRate')}</Link>
      </span>
    </div>
  );
}

export default function Dashboard() {
  const { data, ctx, fmt, month, today, settings, uiLocale } = useApp();
  const openForm = useTransactionForm();
  const chart = useChart();
  const balances = useBalances();
  const md = useMonthData(month);
  const [range, setRange] = useState<'3' | '6' | '12'>('6');

  const months = useMemo(() => {
    const n = Number(range);
    return Array.from({ length: n }, (_, i) => addMonthsToKey(month, i - n + 1));
  }, [month, range]);
  const series = useMemo(() => monthlySeries(ctx, data.transactions, months), [ctx, data.transactions, months]);
  const hasSeries = series.some((p) => p.income || p.expenses);

  const balanceSeries = useMemo(() => {
    const p = monthPeriod(month);
    const end = p.end < today ? p.end : today;
    if (end < p.start) return [];
    return dailyBalanceSeries(ctx, accountsInScope(data.accounts), data.transactions, { start: p.start, end }).map((d) => ({ day: parseISO(d.date).d, date: d.date, balance: chart.major(d.balance) }));
  }, [ctx, data, month, today, chart]);

  const donut = useMemo(() => {
    const items = [...md.summary.expensesByCategory.values()].filter((v) => v.amount > 0).sort((a, b) => b.amount - a.amount);
    const top = items.slice(0, 6);
    const rest = items.slice(6).reduce((a, v) => a + v.amount, 0);
    const rows = top.map((v) => {
      const c = v.categoryId ? ctx.categories.get(v.categoryId) : undefined;
      return { name: c?.name ?? t('common.uncategorized'), value: v.amount, color: c?.color ?? '#94A3B8' };
    });
    if (rest > 0) rows.push({ name: t('dash.otherCategories'), value: rest, color: '#64748B' });
    return rows;
  }, [md.summary, ctx.categories]);

  const donutTotal = donut.reduce((a, d) => a + d.value, 0);

  const comparison = useMemo(() => {
    const ids = new Set<string | null>([...md.summary.expensesByCategory.keys(), ...md.prev.expensesByCategory.keys()]);
    return [...ids]
      .map((id) => ({
        name: id ? ctx.categories.get(id)?.name ?? '—' : t('common.uncategorized'),
        current: chart.major(md.summary.expensesByCategory.get(id)?.amount ?? 0),
        previous: chart.major(md.prev.expensesByCategory.get(id)?.amount ?? 0),
      }))
      .sort((a, b) => b.current + b.previous - (a.current + a.previous))
      .slice(0, 6);
  }, [md, ctx.categories, chart]);

  const insights = useMemo(
    () =>
      generateInsights(ctx, data, today, md.isCurrent ? md.forecast : null, {
        fmt: (m) => fmt.money(m),
        locale: settings.locale,
        monthName: fmt.month,
        thresholds: settings.budgetAlertThresholds,
        billReminderDays: settings.billReminderDays,
        dateFormat: settings.dateFormat,
      }),
    [ctx, data, today, md, fmt, settings],
  );

  const goals = data.goals.filter((g) => g.status === 'active' || g.status === 'achieved').slice(0, 4);
  const recent = data.transactions.slice(0, 7);
  const greetingHour = new Date().getHours();
  const greeting = t(greetingHour < 12 ? 'dash.greeting.morning' : greetingHour < 18 ? 'dash.greeting.afternoon' : 'dash.greeting.evening');
  const { summary, prev, overview } = md;

  if (data.accounts.length === 0) {
    return (
      <EmptyState
        icon={<Wallet className="h-5 w-5" />}
        title={t('dash.firstAccount')}
        description={t('dash.firstAccountHint')}
        action={<Link to="/accounts"><Button variant="primary">{t('dash.addAccount')}</Button></Link>}
        className="mt-10"
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* En-tête */}
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between animate-fade-in">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted">
            {formatLongDate(today, uiLocale)}
            {settings.demoMode && <DemoBadge />}
          </div>
          <h1 className="display mt-1 text-2xl font-semibold sm:text-3xl">
            {greeting}
            {settings.displayName ? `, ${settings.displayName}` : ''} <span className="text-muted">·</span>{' '}
            <span className="gradient-text">{fmt.month(month)}</span>
          </h1>
        </div>
        <div className="sm:text-end">
          <div className="flex items-center gap-1 text-xs text-muted sm:justify-end">
            {md.isCurrent ? t('dash.totalToday') : t('dash.totalAt', { date: fmt.date(md.asOf) })} <InfoTip>{DEFINITIONS.balance}</InfoTip>
          </div>
          <AnimatedAmount value={md.balance.total} className="display text-3xl font-semibold tracking-tight sm:text-4xl" />
        </div>
      </section>
      <UnconvertedNote bag={md.balance.unconverted} />

      {/* KPI */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6" aria-label={t('dash.kpis')}>
        <Kpi icon={Wallet} label={t('dash.kpi.balance')} info={DEFINITIONS.balance} accent="rgb(var(--primary))" delay={0} footer={<span className="text-[11px] text-muted">{t('dash.kpi.accountsInScope', { count: accountsInScope(data.accounts).length })}</span>}>
          <AnimatedAmount value={md.balance.total} />
        </Kpi>
        <Kpi icon={ArrowDownLeft} label={t('dash.kpi.income')} info={DEFINITIONS.income} accent="rgb(var(--positive))" delay={40} footer={<Delta current={summary.income} previous={prev.income} />}>
          <AnimatedAmount value={summary.income} />
        </Kpi>
        <Kpi icon={ArrowUpRight} label={t('dash.kpi.expenses')} info={DEFINITIONS.expenses} accent="rgb(var(--negative))" delay={80} footer={<Delta current={summary.expenses} previous={prev.expenses} invert />}>
          <AnimatedAmount value={summary.expenses} />
        </Kpi>
        <Kpi icon={PiggyBank} label={t('dash.kpi.savings')} info={DEFINITIONS.savings} accent="rgb(var(--cyan))" delay={120} footer={<span className="text-[11px] text-muted">{t('dash.kpi.prev', { value: fmt.money(prev.netSavings) })}</span>}>
          <span className={summary.netSavings < 0 ? 'text-negative' : ''}>
            <AnimatedAmount value={summary.netSavings} />
          </span>
        </Kpi>
        <Kpi icon={Percent} label={t('dash.kpi.rate')} info={DEFINITIONS.rate} accent="rgb(var(--violet))" delay={160} footer={<span className="text-[11px] text-muted">{t('dash.kpi.prev', { value: fmt.percent(prev.savingsRate) })}</span>}>
          <span className={cn('num', summary.savingsRate == null && 'text-base text-muted')}>{fmt.percent(summary.savingsRate)}</span>
        </Kpi>
        <Kpi icon={Gauge} label={t('dash.kpi.available')} info={DEFINITIONS.available} accent="rgb(var(--warning))" delay={200}
          footer={overview.available == null ? <Link to="/budgets" className="text-[11px] text-cyan hover:underline">{t('dash.kpi.defineBudget')}</Link> : <span className="text-[11px] text-muted">{t('dash.kpi.of', { amount: fmt.money(overview.reference) })} {overview.referenceSource === 'categories' ? t('dash.kpi.sumCategories') : ''}</span>}>
          {overview.available == null ? <span className="text-base text-muted">{t('dash.kpi.noBudget')}</span> : <span className={overview.available < 0 ? 'text-negative' : ''}><AnimatedAmount value={overview.available} /></span>}
        </Kpi>
      </section>

      <div className="grid items-start gap-5 xl:grid-cols-3">
        {/* Revenus vs dépenses */}
        <Card
          className="xl:col-span-2"
          delay={80}
          title={t('dash.incomeVsExpenses')}
          info={t('dash.incomeVsExpensesInfo')}
          actions={<Segmented size="sm" value={range} onChange={setRange} options={[{ value: '3', label: t('dash.range', { count: 3 }) }, { value: '6', label: t('dash.range', { count: 6 }) }, { value: '12', label: t('dash.range', { count: 12 }) }]} />}
        >
          {hasSeries ? (
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={series.map((p) => ({ name: formatMonthShort(p.month, uiLocale), income: chart.major(p.income), expenses: chart.major(p.expenses), month: p.month }))} barGap={4}>
                  <defs>
                    <linearGradient id="g-inc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SERIES.income} stopOpacity={0.95} /><stop offset="1" stopColor={SERIES.income} stopOpacity={0.45} /></linearGradient>
                    <linearGradient id="g-exp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SERIES.expense} stopOpacity={0.9} /><stop offset="1" stopColor={SERIES.expense} stopOpacity={0.4} /></linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke={SERIES.grid} />
                  <XAxis dataKey="name" {...chart.axis} />
                  <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(44)} />
                  <RTooltip cursor={{ fill: 'rgb(var(--surface-3) / 0.5)' }} content={<ChartTooltip valueFormatter={chart.money} />} />
                  <Bar dataKey="income" name={t('common.income')} fill="url(#g-inc)" radius={[6, 6, 0, 0]} maxBarSize={28} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                  <Bar dataKey="expenses" name={t('common.expenses')} fill="url(#g-exp)" radius={[6, 6, 0, 0]} maxBarSize={28} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <NoData height={256}>{t('dash.noSeries')}</NoData>
          )}
          <div className="mt-3 flex gap-4">
            <LegendDot color={SERIES.income} label={t('common.income')} />
            <LegendDot color={SERIES.expense} label={t('common.expenses')} />
          </div>
        </Card>

        {/* Insights */}
        <Card delay={120} title={<span className="flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-cyan" /> {t('dash.insights')}</span>} info={t('dash.insightsInfo')} actions={<Link to="/assistant" className="text-xs text-cyan hover:underline">{t('nav.assistant')}</Link>}>
          <InsightList insights={insights} limit={5} />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {/* Évolution du solde */}
        <Card delay={140} title={t('dash.balanceEvolution')} subtitle={fmt.month(month)} info={t('dash.balanceEvolutionInfo')}>
          {balanceSeries.length > 1 ? (
            <div className="h-52">
              <ResponsiveContainer>
                <AreaChart data={balanceSeries}>
                  <defs>
                    <linearGradient id="g-bal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SERIES.cyan} stopOpacity={0.35} /><stop offset="1" stopColor={SERIES.cyan} stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke={SERIES.grid} />
                  <XAxis dataKey="day" {...chart.axis} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(44)} domain={['auto', 'auto']} />
                  <RTooltip content={<ChartTooltip valueFormatter={chart.money} labelFormatter={(d) => t('dash.day', { day: String(d) })} />} />
                  <Area type="monotone" dataKey="balance" name={t('common.balance')} stroke={SERIES.cyan} strokeWidth={2} fill="url(#g-bal)" isAnimationActive={chart.animate} animationDuration={chart.duration} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <NoData height={208}>{t('dash.notEnoughDays')}</NoData>
          )}
        </Card>

        {/* Répartition */}
        <Card delay={160} title={t('dash.breakdown')} subtitle={fmt.month(month)} info={t('dash.breakdownInfo')}>
          {donut.length ? (
            <div className="flex items-center gap-4">
              <div className="relative h-44 w-44 shrink-0">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={donut} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="100%" paddingAngle={2} stroke="none" isAnimationActive={chart.animate} animationDuration={chart.duration}>
                      {donut.map((d) => <Cell key={d.name} fill={d.color} />)}
                    </Pie>
                    <RTooltip content={<ChartTooltip valueFormatter={(v) => fmt.money(v)} />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <div className="label text-[9px]">{t('common.total')}</div>
                  <div className="num text-sm font-semibold">{fmt.money(summary.expenses, undefined, { compact: true })}</div>
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                {donut.map((d) => (
                  <LegendDot key={d.name} color={d.color} label={d.name} value={fmt.percent(donutTotal > 0 ? d.value / donutTotal : null, 0)} />
                ))}
              </div>
            </div>
          ) : (
            <NoData height={176}>{t('dash.noExpensesMonth')}</NoData>
          )}
        </Card>

        {/* Taux d'épargne */}
        <Card delay={180} title={t('dash.rateEvolution')} info={DEFINITIONS.rate} className="lg:col-span-2 xl:col-span-1">
          {series.some((p) => p.savingsRate != null) ? (
            <div className="h-52">
              <ResponsiveContainer>
                <LineChart data={series.map((p) => ({ name: formatMonthShort(p.month, uiLocale), rate: p.savingsRate == null ? null : Math.round(p.savingsRate * 1000) / 10 }))}>
                  <CartesianGrid vertical={false} stroke={SERIES.grid} />
                  <XAxis dataKey="name" {...chart.axis} />
                  <YAxis {...chart.axis} tickFormatter={(v) => `${v} %`} width={52} />
                  <ReferenceLine y={0} stroke={SERIES.muted} strokeOpacity={0.4} />
                  <RTooltip content={<ChartTooltip valueFormatter={(v) => fmt.percent(v / 100)} />} />
                  <Line type="monotone" dataKey="rate" name={t('dash.kpi.rate')} stroke={SERIES.violet} strokeWidth={2.5} dot={{ r: 3, fill: SERIES.violet }} connectNulls={false} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <NoData height={208}>{t('dash.rateNotComputable')}</NoData>
          )}
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        {/* Comparaison mois */}
        <Card delay={200} className="xl:col-span-2" title={t('dash.compare')} subtitle={t('dash.compareSubtitle', { month: fmt.month(month), previous: fmt.month(md.prevMonth) })} info={t('dash.compareInfo')}>
          {comparison.length ? (
            <div className="h-60">
              <ResponsiveContainer>
                <BarChart data={comparison} layout="vertical" margin={{ left: 8 }} barGap={2}>
                  <CartesianGrid horizontal={false} stroke={SERIES.grid} />
                  <XAxis type="number" {...chart.axis} tickFormatter={chart.axisMoney} />
                  <YAxis type="category" dataKey="name" {...chart.axis} width={108} />
                  <RTooltip cursor={{ fill: 'rgb(var(--surface-3) / 0.5)' }} content={<ChartTooltip valueFormatter={chart.money} />} />
                  <Bar dataKey="previous" name={fmt.month(md.prevMonth)} fill={SERIES.muted} fillOpacity={0.45} radius={[0, 4, 4, 0]} maxBarSize={12} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                  <Bar dataKey="current" name={fmt.month(month)} fill={SERIES.primary} radius={[0, 4, 4, 0]} maxBarSize={12} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <NoData height={240}>{t('dash.noExpensesTwoMonths')}</NoData>
          )}
        </Card>

        {/* Objectifs */}
        <Card delay={220} title={t('dash.goals')} info={t('dash.goalsInfo')} actions={<Link to="/goals" className="text-xs text-cyan hover:underline">{t('common.seeAll')}</Link>}>
          {goals.length ? (
            <ul className="space-y-3">
              {goals.map((g) => {
                const p = computeGoalProgress(g, today, g.linkedAccountId ? balances.get(g.linkedAccountId) : undefined);
                return (
                  <li key={g.id} className="flex items-center gap-3">
                    <ProgressRing value={p.progressCapped} size={46} stroke={5} color={g.color}>
                      <span className="text-[10px] font-semibold num">{Math.round(p.progressCapped * 100)}%</span>
                    </ProgressRing>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{g.name}</div>
                      <div className="text-xs text-muted num">
                        {fmt.money(p.saved)} / {fmt.money(g.targetAmount)}
                      </div>
                    </div>
                    {p.state === 'achieved' ? <Badge tone="positive">{t('goal.badge.achieved')}</Badge> : p.state === 'behind' || p.state === 'overdue' ? <Badge tone="warning">{t('goal.badge.behind')}</Badge> : p.state === 'on_track' ? <Badge tone="cyan">{t('goal.badge.onTrack')}</Badge> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={<Target className="h-5 w-5" />} title={t('dash.noGoals')} description={t('dash.noGoalsHint')} action={<Link to="/goals"><Button size="sm" variant="outline">{t('dash.createGoal')}</Button></Link>} />
          )}
        </Card>
      </div>

      {/* Activité récente */}
      <Card delay={240} title={t('dash.recent')} actions={<><Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => openForm()}>{t('common.add')}</Button><Link to="/transactions" className="inline-flex items-center text-xs text-cyan hover:underline">{t('common.seeAll')} <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" /></Link></>}>
        {recent.length ? (
          <div className="-mx-2 divide-y divide-line/5">
            {recent.map((t) => <TransactionRow key={t.id} t={t} onOpen={() => openForm({ mode: 'edit', id: t.id })} />)}
          </div>
        ) : (
          <EmptyState title={t('dash.noTx')} description={t('dash.noTxHint')} action={<Button variant="primary" onClick={() => openForm()}>{t('shell.addTransaction')}</Button>} />
        )}
      </Card>
      {month !== monthKey(today) && (
        <p className="text-center text-xs text-muted">{t('dash.viewing', { month: fmt.month(month) })}</p>
      )}
    </div>
  );
}
