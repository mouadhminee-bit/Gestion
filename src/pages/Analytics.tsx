import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { Download, FileText, Printer } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Badge, CategoryIcon, ProgressBar } from '@/components/ui/Misc';
import { InfoTip } from '@/components/ui/Tooltip';
import { ChartTooltip, LegendDot, NoData, SERIES, useChart } from '@/components/charts/ChartKit';
import { download, transactionsCSV } from '@/features/export';
import { usePersistentState } from '@/lib/usePersistentState';
import { cn } from '@/lib/cn';
import type { Period } from '@/domain/dates';
import { addMonthsToKey, formatMonthShort, inPeriod, minDate, monthEnd, monthKey, monthRange, monthStart, previousPeriod, quarterPeriod, yearPeriod, parseISO } from '@/domain/dates';
import type { TransactionFilter } from '@/domain/calc/ledger';
import { accountsInScope, matchesFilter, totalBalance } from '@/domain/calc/ledger';
import { comparePeriods, dailyAverage, exceptionalExpenses, expensesByPayee, monthlySeries } from '@/domain/calc/analytics';
import { monthlyEquivalent } from '@/domain/calc/recurring';
import { netWorthHistory } from '@/domain/calc/networth';
import { fromMajor } from '@/domain/money';
import type { TransactionType } from '@/domain/types';
import { TRANSACTION_TYPE_LABELS } from '@/domain/types';
import { DEFINITIONS } from './Dashboard';
import { t as tr } from '@/i18n/core';

interface F {
  preset: 'month' | 'prev_month' | 'quarter' | 'year' | '12m' | 'custom';
  from: string;
  to: string;
  categoryId: string;
  accountId: string;
  type: '' | TransactionType;
  tag: string;
}

export default function Analytics() {
  const { data, ctx, fmt, today, month, settings, uiLocale } = useApp();
  const chart = useChart();
  const [f, setF] = usePersistentState<F>('analytics', { preset: 'month', from: '', to: '', categoryId: '', accountId: '', type: '', tag: '' });
  const set = <K extends keyof F>(k: K, v: F[K]) => setF((p) => ({ ...p, [k]: v }));

  const period: Period = useMemo(() => {
    const y = Number(month.slice(0, 4));
    const q = Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1;
    switch (f.preset) {
      case 'prev_month':
        return { start: monthStart(addMonthsToKey(month, -1)), end: monthEnd(addMonthsToKey(month, -1)) };
      case 'quarter':
        return quarterPeriod(y, q);
      case 'year':
        return yearPeriod(y);
      case '12m':
        return { start: monthStart(addMonthsToKey(month, -11)), end: monthEnd(month) };
      case 'custom':
        return { start: f.from || monthStart(month), end: f.to && f.to >= (f.from || '') ? f.to : monthEnd(month) };
      default:
        return { start: monthStart(month), end: monthEnd(month) };
    }
  }, [f, month]);
  const prev = useMemo(() => previousPeriod(period), [period]);
  const filter: TransactionFilter = useMemo(() => ({ categoryIds: f.categoryId ? [f.categoryId] : undefined, accountIds: f.accountId ? [f.accountId] : undefined, types: f.type ? [f.type] : undefined, tags: f.tag ? [f.tag] : undefined }), [f]);

  const cmp = useMemo(() => comparePeriods(ctx, data.transactions, period, prev, filter), [ctx, data.transactions, period, prev, filter]);
  const s = cmp.current;
  const months = useMemo(() => monthRange(monthKey(period.start), monthKey(period.end)), [period]);
  const series = useMemo(() => monthlySeries(ctx, data.transactions, months.length > 1 ? months : monthRange(addMonthsToKey(months[0], -5), months[0]), filter), [ctx, data.transactions, months, filter]);
  const payees = useMemo(() => expensesByPayee(ctx, data.transactions, period, filter).slice(0, 10), [ctx, data.transactions, period, filter]);
  const exceptional = useMemo(() => exceptionalExpenses(ctx, data.transactions, period, fromMajor(500, settings.baseCurrency), filter).slice(0, 8), [ctx, data.transactions, period, filter, settings.baseCurrency]);
  const balances = useMemo(() => {
    const ms = months.length > 1 ? months : monthRange(addMonthsToKey(months[0], -5), months[0]);
    return ms.map((m) => ({ name: formatMonthShort(m, uiLocale), balance: chart.major(totalBalance(ctx, accountsInScope(data.accounts), data.transactions, minDate(monthEnd(m), today)).total) }));
  }, [months, ctx, data, today, chart, uiLocale]);
  const nwHistory = useMemo(() => {
    const ms = months.length > 1 ? months : monthRange(addMonthsToKey(months[0], -5), months[0]);
    return netWorthHistory(ctx, data, ms, today).map((h) => ({ name: formatMonthShort(h.month, uiLocale), nw: chart.major(h.netWorth) }));
  }, [months, ctx, data, today, chart, uiLocale]);

  const cats = [...s.expensesByCategory.values()].filter((c) => c.amount !== 0).sort((a, b) => b.amount - a.amount);
  const maxCat = Math.max(1, ...cats.map((c) => c.amount));
  const daily = dailyAverage(s.expenses, period, today);
  const elapsedMonths = months.filter((m) => monthStart(m) <= today).length || 1;
  const recurring = data.recurringRules.filter((r) => r.active && r.kind === 'expense').map((r) => ({ r, monthly: ctx.convert(monthlyEquivalent(r), r.currency, today) ?? 0 })).sort((a, b) => b.monthly - a.monthly);
  const tags = useMemo(() => [...new Set(data.transactions.flatMap((t) => t.tags))].sort(), [data.transactions]);
  const filtered = useMemo(() => data.transactions.filter((t) => inPeriod(t.date, period) && matchesFilter(ctx, t, filter)), [data.transactions, period, ctx, filter]);

  const reportType = f.preset === 'year' ? 'year' : f.preset === 'quarter' ? 'quarter' : 'month';
  const reportKey = reportType === 'year' ? period.start.slice(0, 4) : reportType === 'quarter' ? `${period.start.slice(0, 4)}-Q${Math.floor((parseISO(period.start).m - 1) / 3) + 1}` : monthKey(period.start);

  const ChangeBadge = ({ v, invert }: { v: number | null; invert?: boolean }) =>
    v == null ? <span className="text-[11px] text-muted">{tr('an.nc')}</span> : <Badge tone={(invert ? v <= 0 : v >= 0) ? 'positive' : 'negative'}>{v >= 0 ? '+' : ''}{fmt.percent(v, 0)}</Badge>;

  return (
    <div>
      <PageHeader
        eyebrow={tr('an.eyebrow')}
        title={tr('nav.analytics')}
        description={tr('an.description', { start: fmt.date(period.start), end: fmt.date(period.end), prevStart: fmt.date(prev.start), prevEnd: fmt.date(prev.end) })}
        actions={
          <>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download(`${tr('an.csvFile')}-${period.start}_${period.end}.csv`, transactionsCSV(filtered, ctx.categories, ctx.accounts))}>{tr('an.filteredCsv')}</Button>
            <Link to={`/report?type=${reportType}&key=${reportKey}`}><Button variant="primary" icon={<Printer className="h-4 w-4" />}>{tr('an.printableReport')}</Button></Link>
          </>
        }
      />

      <Card className="mb-5" padded>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Field label={tr('common.period')}>
            <Select value={f.preset} onChange={(e) => set('preset', e.target.value as F['preset'])}>
              <option value="month">{fmt.month(month)}</option>
              <option value="prev_month">{tr('an.preset.prevMonth')}</option>
              <option value="quarter">{tr('an.preset.quarter')}</option>
              <option value="year">{tr('an.preset.year', { year: month.slice(0, 4) })}</option>
              <option value="12m">{tr('an.preset.12m')}</option>
              <option value="custom">{tr('an.preset.custom')}</option>
            </Select>
          </Field>
          {f.preset === 'custom' ? (
            <>
              <Field label={tr('common.from')}><Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field>
              <Field label={tr('common.to')}><Input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></Field>
            </>
          ) : null}
          <Field label={tr('common.category')}>
            <Select value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">{tr('common.allF')}</option>
              {data.categories.filter((c) => !c.parentId && c.kind !== 'savings').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label={tr('common.account')}>
            <Select value={f.accountId} onChange={(e) => set('accountId', e.target.value)}>
              <option value="">{tr('common.allM')}</option>
              {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label={tr('common.type')}>
            <Select value={f.type} onChange={(e) => set('type', e.target.value as F['type'])}>
              <option value="">{tr('common.allM')}</option>
              {Object.entries(TRANSACTION_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label={tr('an.tag')}>
            <Select value={f.tag} onChange={(e) => set('tag', e.target.value)}>
              <option value="">{tr('common.allF')}</option>
              {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
            </Select>
          </Field>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          { l: tr('common.income'), v: fmt.money(s.income), c: <ChangeBadge v={cmp.incomeChange} />, i: DEFINITIONS.income },
          { l: tr('common.expenses'), v: fmt.money(s.expenses), c: <ChangeBadge v={cmp.expensesChange} invert />, i: DEFINITIONS.expenses },
          { l: tr('an.netSavings'), v: fmt.money(s.netSavings), c: <span className="text-[11px] text-muted">{tr('an.prev', { value: fmt.money(cmp.previous.netSavings) })}</span>, i: DEFINITIONS.savings },
          { l: tr('an.savingsRate'), v: fmt.percent(s.savingsRate), c: <span className="text-[11px] text-muted">{tr('an.prev', { value: fmt.percent(cmp.previous.savingsRate) })}</span>, i: DEFINITIONS.rate },
          { l: tr('an.perDay'), v: daily == null ? '—' : fmt.money(Math.round(daily)), c: <span className="text-[11px] text-muted">{tr('an.perDay.hint')}</span>, i: tr('an.perDay.info') },
          { l: tr('an.perMonth'), v: fmt.money(Math.round(s.expenses / elapsedMonths)), c: <span className="text-[11px] text-muted">{tr('an.months', { count: elapsedMonths })}</span>, i: tr('an.perMonth.info') },
        ].map((k, i) => (
          <Card key={k.l} className="!p-4" delay={i * 30}>
            <div className="flex items-center gap-1 text-xs text-muted">{k.l} <InfoTip>{k.i}</InfoTip></div>
            <div className="mt-1 truncate display text-lg font-semibold num">{k.v}</div>
            <div className="mt-1">{k.c}</div>
          </Card>
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2" title={tr('an.monthly')} subtitle={months.length > 1 ? tr('an.overPeriod') : tr('an.last6')} info={tr('an.monthly.info')}>
          {series.some((p) => p.income || p.expenses) ? (
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={series.map((p) => ({ name: formatMonthShort(p.month, uiLocale), income: chart.major(p.income), fixed: chart.major(p.fixed), variable: chart.major(p.variable) }))}>
                  <CartesianGrid vertical={false} stroke={SERIES.grid} />
                  <XAxis dataKey="name" {...chart.axis} />
                  <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(44)} />
                  <RTooltip cursor={{ fill: 'rgb(var(--surface-3) / 0.5)' }} content={<ChartTooltip valueFormatter={chart.money} />} />
                  <Bar dataKey="income" name={tr('common.income')} fill={SERIES.income} radius={[5, 5, 0, 0]} maxBarSize={22} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                  <Bar dataKey="fixed" name={tr('form.fixedExpenses')} stackId="e" fill={SERIES.violet} maxBarSize={22} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                  <Bar dataKey="variable" name={tr('form.variableExpenses')} stackId="e" fill={SERIES.expense} radius={[5, 5, 0, 0]} maxBarSize={22} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <NoData height={256}>{tr('an.noDataFilters')}</NoData>}
          <div className="mt-3 flex flex-wrap gap-4"><LegendDot color={SERIES.income} label={tr('common.income')} /><LegendDot color={SERIES.violet} label={tr('an.fixed')} /><LegendDot color={SERIES.expense} label={tr('an.variable')} /></div>
        </Card>
        <Card title={tr('an.fixedVsVariable')} info={tr('an.fixedVsVariable.info')}>
          {s.expenses > 0 ? (
            <div className="space-y-4">
              {[{ l: tr('form.fixedExpenses'), v: s.fixedExpenses, c: 'violet' as const }, { l: tr('form.variableExpenses'), v: s.variableExpenses, c: 'negative' as const }].map((x) => (
                <div key={x.l}>
                  <div className="mb-1 flex justify-between text-sm"><span>{x.l}</span><span className="num font-semibold">{fmt.money(x.v)} <span className="text-xs font-normal text-muted">({fmt.percent(x.v / s.expenses, 0)})</span></span></div>
                  <ProgressBar value={x.v / s.expenses} tone={x.c} />
                </div>
              ))}
              <div className="rounded-xl bg-surface-2/60 p-3 text-xs text-muted">
                {cmp.expensesChange == null
                  ? tr('an.cmp.none', { start: fmt.date(prev.start), end: fmt.date(prev.end) })
                  : tr(cmp.expensesChange >= 0 ? 'an.cmp.up' : 'an.cmp.down', { pct: fmt.percent(Math.abs(cmp.expensesChange), 1), start: fmt.date(prev.start), end: fmt.date(prev.end) })}
              </div>
            </div>
          ) : <NoData>{tr('an.noExpenses')}</NoData>}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title={tr('an.byCategory')} info={tr('an.byCategory.info')}>
          {cats.length ? (
            <ul className="space-y-2.5">
              {cats.map((c) => {
                const cat = c.categoryId ? ctx.categories.get(c.categoryId) : undefined;
                const p = cmp.previous.expensesByCategory.get(c.categoryId)?.amount ?? 0;
                const ch = p ? (c.amount - p) / p : null;
                return (
                  <li key={c.categoryId ?? 'none'} className="flex items-center gap-3">
                    <CategoryIcon icon={cat?.icon} color={cat?.color} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2 text-sm"><span className="truncate">{cat?.name ?? tr('common.uncategorized')}</span><span className="num font-medium">{fmt.money(c.amount)}</span></div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3/70"><div className="h-full rounded-full" style={{ width: `${Math.max(0, (c.amount / maxCat) * 100)}%`, background: cat?.color ?? '#94A3B8' }} /></div>
                    </div>
                    <div className="w-14 text-end"><ChangeBadge v={ch} invert /></div>
                  </li>
                );
              })}
            </ul>
          ) : <NoData>{tr('an.noExpenses')}</NoData>}
        </Card>
        <Card title={tr('an.byPayee')} subtitle={tr('an.byPayee.subtitle')}>
          {payees.length ? (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line/5">
                {payees.map((p) => (
                  <tr key={p.payee}><td className="py-2 pe-2">{p.payee}</td><td className="py-2 text-end text-xs text-muted">{tr('an.ops', { count: p.count })}</td><td className="py-2 ps-3 text-end num font-medium">{fmt.money(p.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <NoData>{tr('an.noExpenses')}</NoData>}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title={tr('an.balances')} subtitle={tr('an.balances.subtitle')}>
          <div className="h-52">
            <ResponsiveContainer>
              <LineChart data={balances}>
                <CartesianGrid vertical={false} stroke={SERIES.grid} />
                <XAxis dataKey="name" {...chart.axis} />
                <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(48)} domain={['auto', 'auto']} />
                <RTooltip content={<ChartTooltip valueFormatter={chart.money} />} />
                <Line type="monotone" dataKey="balance" name={tr('an.totalBalance')} stroke={SERIES.cyan} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={chart.animate} animationDuration={chart.duration} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title={tr('an.netWorth')} subtitle={tr('an.endOfMonth')}>
          <div className="h-52">
            <ResponsiveContainer>
              <LineChart data={nwHistory}>
                <CartesianGrid vertical={false} stroke={SERIES.grid} />
                <XAxis dataKey="name" {...chart.axis} />
                <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(48)} domain={['auto', 'auto']} />
                <RTooltip content={<ChartTooltip valueFormatter={chart.money} />} />
                <Line type="monotone" dataKey="nw" name={tr('nw.netWorth')} stroke={SERIES.violet} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={chart.animate} animationDuration={chart.duration} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title={tr('an.recurring')} info={tr('an.recurring.info')}>
          {recurring.length ? (
            <ul className="divide-y divide-line/5 text-sm">
              {recurring.map(({ r, monthly }) => (
                <li key={r.id} className="flex justify-between gap-2 py-2"><span className="truncate">{r.label}</span><span className="num">{fmt.money(monthly)}<span className="text-xs text-muted">{tr('an.perMonthShare', { pct: fmt.percent(s.expenses > 0 ? monthly / (s.expenses / elapsedMonths) : null, 0) })}</span></span></li>
              ))}
            </ul>
          ) : <NoData height={120}>{tr('an.noRecurring')}</NoData>}
        </Card>
        <Card title={tr('an.exceptional')} info={tr('an.exceptional.info')}>
          {exceptional.length ? (
            <ul className="divide-y divide-line/5 text-sm">
              {exceptional.map((e) => (
                <li key={e.transaction.id} className="flex justify-between gap-2 py-2">
                  <span className="min-w-0"><span className="block truncate">{e.transaction.label}</span><span className="text-xs text-muted">{fmt.date(e.transaction.date)} · {tr('an.categoryMedian', { amount: fmt.money(Math.round(e.median)) })}</span></span>
                  <span className={cn('num font-semibold')}>{fmt.money(e.value)}</span>
                </li>
              ))}
            </ul>
          ) : <NoData height={120}>{tr('an.noExceptional')}</NoData>}
        </Card>
      </div>

      <Card className="mt-5" title={tr('an.reports')} info={tr('an.reports.info')}>
        <div className="grid gap-2 sm:grid-cols-3">
          <Link to={`/report?type=month&key=${month}`}><Button variant="outline" className="w-full" icon={<FileText className="h-4 w-4" />}>{tr('an.report.month', { month: fmt.month(month) })}</Button></Link>
          <Link to={`/report?type=quarter&key=${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`}><Button variant="outline" className="w-full" icon={<FileText className="h-4 w-4" />}>{tr('an.report.quarter', { q: Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1, year: month.slice(0, 4) })}</Button></Link>
          <Link to={`/report?type=year&key=${month.slice(0, 4)}`}><Button variant="outline" className="w-full" icon={<FileText className="h-4 w-4" />}>{tr('an.report.year', { year: month.slice(0, 4) })}</Button></Link>
        </div>
        <p className="mt-2 text-xs text-muted">{tr('an.reports.note')}</p>
      </Card>
    </div>
  );
}
