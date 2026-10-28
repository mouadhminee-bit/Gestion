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
  const { data, ctx, fmt, today, month, settings } = useApp();
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
    return ms.map((m) => ({ name: formatMonthShort(m, settings.locale), balance: chart.major(totalBalance(ctx, accountsInScope(data.accounts), data.transactions, minDate(monthEnd(m), today)).total) }));
  }, [months, ctx, data, today, chart, settings.locale]);
  const nwHistory = useMemo(() => {
    const ms = months.length > 1 ? months : monthRange(addMonthsToKey(months[0], -5), months[0]);
    return netWorthHistory(ctx, data, ms, today).map((h) => ({ name: formatMonthShort(h.month, settings.locale), nw: chart.major(h.netWorth) }));
  }, [months, ctx, data, today, chart, settings.locale]);

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
    v == null ? <span className="text-[11px] text-muted">n/c</span> : <Badge tone={(invert ? v <= 0 : v >= 0) ? 'positive' : 'negative'}>{v >= 0 ? '+' : ''}{fmt.percent(v, 0)}</Badge>;

  return (
    <div>
      <PageHeader
        eyebrow="Intelligence"
        title="Analyses & rapports"
        description={`Période analysée : ${fmt.date(period.start)} → ${fmt.date(period.end)}, comparée à ${fmt.date(prev.start)} → ${fmt.date(prev.end)}.`}
        actions={
          <>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download(`nexora-analyse-${period.start}_${period.end}.csv`, transactionsCSV(filtered, ctx.categories, ctx.accounts))}>CSV filtré</Button>
            <Link to={`/report?type=${reportType}&key=${reportKey}`}><Button variant="primary" icon={<Printer className="h-4 w-4" />}>Rapport imprimable</Button></Link>
          </>
        }
      />

      <Card className="mb-5" padded>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Période">
            <Select value={f.preset} onChange={(e) => set('preset', e.target.value as F['preset'])}>
              <option value="month">{fmt.month(month)}</option>
              <option value="prev_month">Mois précédent</option>
              <option value="quarter">Trimestre en cours (sélection)</option>
              <option value="year">Année {month.slice(0, 4)}</option>
              <option value="12m">12 derniers mois</option>
              <option value="custom">Personnalisée</option>
            </Select>
          </Field>
          {f.preset === 'custom' ? (
            <>
              <Field label="Du"><Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field>
              <Field label="Au"><Input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></Field>
            </>
          ) : null}
          <Field label="Catégorie">
            <Select value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">Toutes</option>
              {data.categories.filter((c) => !c.parentId && c.kind !== 'savings').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Compte">
            <Select value={f.accountId} onChange={(e) => set('accountId', e.target.value)}>
              <option value="">Tous</option>
              {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Type">
            <Select value={f.type} onChange={(e) => set('type', e.target.value as F['type'])}>
              <option value="">Tous</option>
              {Object.entries(TRANSACTION_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Étiquette">
            <Select value={f.tag} onChange={(e) => set('tag', e.target.value)}>
              <option value="">Toutes</option>
              {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
            </Select>
          </Field>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          { l: 'Revenus', v: fmt.money(s.income), c: <ChangeBadge v={cmp.incomeChange} />, i: DEFINITIONS.income },
          { l: 'Dépenses', v: fmt.money(s.expenses), c: <ChangeBadge v={cmp.expensesChange} invert />, i: DEFINITIONS.expenses },
          { l: 'Épargne nette', v: fmt.money(s.netSavings), c: <span className="text-[11px] text-muted">préc. {fmt.money(cmp.previous.netSavings)}</span>, i: DEFINITIONS.savings },
          { l: 'Taux d’épargne', v: fmt.percent(s.savingsRate), c: <span className="text-[11px] text-muted">préc. {fmt.percent(cmp.previous.savingsRate)}</span>, i: DEFINITIONS.rate },
          { l: 'Moyenne / jour', v: daily == null ? '—' : fmt.money(Math.round(daily)), c: <span className="text-[11px] text-muted">jours écoulés de la période</span>, i: 'Dépenses de la période ÷ nombre de jours écoulés (jusqu’à aujourd’hui).' },
          { l: 'Moyenne / mois', v: fmt.money(Math.round(s.expenses / elapsedMonths)), c: <span className="text-[11px] text-muted">{elapsedMonths} mois</span>, i: 'Dépenses de la période ÷ nombre de mois entamés.' },
        ].map((k, i) => (
          <Card key={k.l} className="!p-4" delay={i * 30}>
            <div className="flex items-center gap-1 text-xs text-muted">{k.l} <InfoTip>{k.i}</InfoTip></div>
            <div className="mt-1 truncate display text-lg font-semibold num">{k.v}</div>
            <div className="mt-1">{k.c}</div>
          </Card>
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Évolution mensuelle" subtitle={months.length > 1 ? 'Sur la période' : '6 derniers mois'} info="Revenus, dépenses fixes et dépenses variables par mois (filtres appliqués).">
          {series.some((p) => p.income || p.expenses) ? (
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={series.map((p) => ({ name: formatMonthShort(p.month, settings.locale), income: chart.major(p.income), fixed: chart.major(p.fixed), variable: chart.major(p.variable) }))}>
                  <CartesianGrid vertical={false} stroke={SERIES.grid} />
                  <XAxis dataKey="name" {...chart.axis} />
                  <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={44} />
                  <RTooltip cursor={{ fill: 'rgb(var(--surface-3) / 0.5)' }} content={<ChartTooltip valueFormatter={chart.money} />} />
                  <Bar dataKey="income" name="Revenus" fill={SERIES.income} radius={[5, 5, 0, 0]} maxBarSize={22} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                  <Bar dataKey="fixed" name="Dépenses fixes" stackId="e" fill={SERIES.violet} maxBarSize={22} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                  <Bar dataKey="variable" name="Dépenses variables" stackId="e" fill={SERIES.expense} radius={[5, 5, 0, 0]} maxBarSize={22} isAnimationActive={chart.animate} animationDuration={chart.duration} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <NoData height={256}>Aucune donnée pour ces filtres.</NoData>}
          <div className="mt-3 flex flex-wrap gap-4"><LegendDot color={SERIES.income} label="Revenus" /><LegendDot color={SERIES.violet} label="Fixes" /><LegendDot color={SERIES.expense} label="Variables" /></div>
        </Card>
        <Card title="Fixes vs variables" info="Nature définie par la catégorie (modifiable dans Paramètres → Catégories).">
          {s.expenses > 0 ? (
            <div className="space-y-4">
              {[{ l: 'Dépenses fixes', v: s.fixedExpenses, c: 'violet' as const }, { l: 'Dépenses variables', v: s.variableExpenses, c: 'negative' as const }].map((x) => (
                <div key={x.l}>
                  <div className="mb-1 flex justify-between text-sm"><span>{x.l}</span><span className="num font-semibold">{fmt.money(x.v)} <span className="text-xs font-normal text-muted">({fmt.percent(x.v / s.expenses, 0)})</span></span></div>
                  <ProgressBar value={x.v / s.expenses} tone={x.c} />
                </div>
              ))}
              <div className="rounded-xl bg-surface-2/60 p-3 text-xs text-muted">
                Comparaison : dépenses {cmp.expensesChange == null ? 'non comparables' : `${cmp.expensesChange >= 0 ? 'en hausse' : 'en baisse'} de ${fmt.percent(Math.abs(cmp.expensesChange), 1)}`} par rapport à la période précédente ({fmt.date(prev.start)} → {fmt.date(prev.end)}).
              </div>
            </div>
          ) : <NoData>Aucune dépense.</NoData>}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Dépenses par catégorie" info="Nettes des remboursements reçus ; comparaison à la période précédente de même durée.">
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
                      <div className="flex justify-between gap-2 text-sm"><span className="truncate">{cat?.name ?? 'Sans catégorie'}</span><span className="num font-medium">{fmt.money(c.amount)}</span></div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3/70"><div className="h-full rounded-full" style={{ width: `${Math.max(0, (c.amount / maxCat) * 100)}%`, background: cat?.color ?? '#94A3B8' }} /></div>
                    </div>
                    <div className="w-14 text-right"><ChangeBadge v={ch} invert /></div>
                  </li>
                );
              })}
            </ul>
          ) : <NoData>Aucune dépense.</NoData>}
        </Card>
        <Card title="Dépenses par commerçant" subtitle="Top 10 (bénéficiaire, sinon libellé)">
          {payees.length ? (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line/5">
                {payees.map((p) => (
                  <tr key={p.payee}><td className="py-2 pr-2">{p.payee}</td><td className="py-2 text-right text-xs text-muted">{p.count} op.</td><td className="py-2 pl-3 text-right num font-medium">{fmt.money(p.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <NoData>Aucune dépense.</NoData>}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Évolution des soldes" subtitle="Solde total en fin de mois">
          <div className="h-52">
            <ResponsiveContainer>
              <LineChart data={balances}>
                <CartesianGrid vertical={false} stroke={SERIES.grid} />
                <XAxis dataKey="name" {...chart.axis} />
                <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={48} domain={['auto', 'auto']} />
                <RTooltip content={<ChartTooltip valueFormatter={chart.money} />} />
                <Line type="monotone" dataKey="balance" name="Solde total" stroke={SERIES.cyan} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={chart.animate} animationDuration={chart.duration} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Évolution du patrimoine net" subtitle="Fin de mois">
          <div className="h-52">
            <ResponsiveContainer>
              <LineChart data={nwHistory}>
                <CartesianGrid vertical={false} stroke={SERIES.grid} />
                <XAxis dataKey="name" {...chart.axis} />
                <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={48} domain={['auto', 'auto']} />
                <RTooltip content={<ChartTooltip valueFormatter={chart.money} />} />
                <Line type="monotone" dataKey="nw" name="Patrimoine net" stroke={SERIES.violet} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={chart.animate} animationDuration={chart.duration} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Dépenses récurrentes" info="Équivalent mensuel des récurrences actives et part dans les dépenses mensuelles moyennes de la période.">
          {recurring.length ? (
            <ul className="divide-y divide-line/5 text-sm">
              {recurring.map(({ r, monthly }) => (
                <li key={r.id} className="flex justify-between gap-2 py-2"><span className="truncate">{r.label}</span><span className="num">{fmt.money(monthly)}<span className="text-xs text-muted"> /mois · {fmt.percent(s.expenses > 0 ? monthly / (s.expenses / elapsedMonths) : null, 0)}</span></span></li>
              ))}
            </ul>
          ) : <NoData height={120}>Aucune dépense récurrente configurée.</NoData>}
        </Card>
        <Card title="Dépenses exceptionnelles" info="Dépense ponctuelle ≥ 3 × la médiane de sa catégorie (au moins 4 opérations dans la catégorie) et ≥ 500 unités de devise.">
          {exceptional.length ? (
            <ul className="divide-y divide-line/5 text-sm">
              {exceptional.map((e) => (
                <li key={e.transaction.id} className="flex justify-between gap-2 py-2">
                  <span className="min-w-0"><span className="block truncate">{e.transaction.label}</span><span className="text-xs text-muted">{fmt.date(e.transaction.date)} · médiane catégorie {fmt.money(Math.round(e.median))}</span></span>
                  <span className={cn('num font-semibold')}>{fmt.money(e.value)}</span>
                </li>
              ))}
            </ul>
          ) : <NoData height={120}>Aucune dépense exceptionnelle détectée sur la période.</NoData>}
        </Card>
      </div>

      <Card className="mt-5" title="Rapports" info="Rapports imprimables (Ctrl/Cmd + P → Enregistrer en PDF).">
        <div className="grid gap-2 sm:grid-cols-3">
          <Link to={`/report?type=month&key=${month}`}><Button variant="outline" className="w-full" icon={<FileText className="h-4 w-4" />}>Mensuel — {fmt.month(month)}</Button></Link>
          <Link to={`/report?type=quarter&key=${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`}><Button variant="outline" className="w-full" icon={<FileText className="h-4 w-4" />}>Trimestriel — T{Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1} {month.slice(0, 4)}</Button></Link>
          <Link to={`/report?type=year&key=${month.slice(0, 4)}`}><Button variant="outline" className="w-full" icon={<FileText className="h-4 w-4" />}>Annuel — {month.slice(0, 4)}</Button></Link>
        </div>
        <p className="mt-2 text-xs text-muted">Chaque rapport inclut la synthèse budgétaire, la synthèse des objectifs et la synthèse patrimoniale.</p>
      </Card>
    </div>
  );
}
