/**
 * Decision Lab — résultats d'une simulation (étape E5.4).
 *
 * Tout ce qui est affiché provient du snapshot (résultats figés du moteur E3) ou, pour la
 * simulation en cours, du détail mensuel du moteur (`live`). Aucun calcul financier ici : les
 * valeurs sont lues et mises en forme. « Avec la décision » = référence + écart (définition de
 * l'écart stocké, voir `trajectoryRows`).
 */
import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Info } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Button } from '@/components/ui/Button';
import { ChartTooltip, LegendDot, SERIES, useChart } from '@/components/charts/ChartKit';
import { MAX_HORIZON_MONTHS, type DecisionResult } from '@/domain/calc/decision';
import { formatMonthShort } from '@/domain/dates';
import { cn } from '@/lib/cn';
import { t, td } from '@/i18n/core';
import type { DecisionSnapshot } from './snapshot';
import { simulationNotices, trajectoryRows, type TrajectoryRow } from './simulationRun';

function Metric({ label, value, tone, testId }: { label: string; value: string; tone?: 'positive' | 'negative' | null; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('num mt-0.5 font-semibold', tone === 'positive' && 'text-positive', tone === 'negative' && 'text-negative')}>
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

const toneOf = (v: number) => (v > 0 ? 'positive' : v < 0 ? 'negative' : null);
/** Isole un montant inséré dans une phrase (ordre correct en arabe, hébreu, persan). */
const isolate = (s: string) => `\u2068${s}\u2069`;

export function SimulationResults({ snapshot, live }: { snapshot: DecisionSnapshot; live?: DecisionResult }) {
  const { fmt, settings, uiLocale } = useApp();
  const chart = useChart();
  const [table, setTable] = useState(false);
  const cur = settings.baseCurrency;
  const money = (v: number) => fmt.money(v, cur);
  const signed = (v: number) => fmt.money(v, cur, { sign: true });
  const horizon = snapshot.hypotheses.horizonMonths;
  const v = snapshot.results.variants[0];
  const decision = snapshot.hypotheses.variants[0].decision;
  const rows = useMemo(() => trajectoryRows(snapshot), [snapshot]);
  const notices = useMemo(() => simulationNotices(snapshot), [snapshot]);
  const last = rows[rows.length - 1];
  const first = rows[0];
  const monthLabel = (r: TrajectoryRow) => (r.monthKey ? formatMonthShort(r.monthKey, uiLocale) : String(r.month));

  // Séries supplémentaires du moteur (simulation en cours uniquement) : solde du compte dédié ou dette.
  const extra =
    live && (decision.kind === 'goal' || decision.kind === 'investment')
      ? { key: 'dl.res.chart.assets', values: live.months.map((m) => m.assets) }
      : live && decision.kind === 'purchase' && decision.loan
        ? { key: 'dl.res.chart.debt', values: live.months.map((m) => m.liabilities) }
        : null;

  const lineChart = (testId: string, title: string, series: { key: string; name: string; color: string; values: number[]; dashed?: boolean }[]) => (
    <figure data-testid={testId} className="min-w-0">
      <figcaption className="mb-2 text-sm font-semibold">{title}</figcaption>
      {/* Graphique numérique : toujours de gauche à droite (axes lisibles en arabe, hébreu, persan). */}
      <div className="h-56" role="img" aria-label={title} dir="ltr">
        <ResponsiveContainer>
          <LineChart data={rows.map((r, i) => ({ name: r.month, ...Object.fromEntries(series.map((s) => [s.key, chart.major(s.values[i])])) }))}>
            <CartesianGrid vertical={false} stroke={SERIES.grid} />
            <XAxis dataKey="name" {...chart.axis} minTickGap={24} />
            <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(48)} domain={['auto', 'auto']} />
            <RTooltip content={<ChartTooltip valueFormatter={chart.money} labelFormatter={(l) => (rows[Number(l)] ? `${t('dl.res.table.month')} ${l} · ${monthLabel(rows[Number(l)])}` : l)} />} />
            {series.map((s) => (
              <Line key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} isAnimationActive={chart.animate} animationDuration={chart.duration} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <LegendDot key={s.key} color={s.color} label={s.name} />
        ))}
      </div>
    </figure>
  );

  return (
    <section data-testid="dl-results" className="space-y-5">
      <h3 className="text-base font-semibold">{t('dl.res.title', { months: horizon })}</h3>

      {/* Indicateurs communs : trésorerie et patrimoine (départ, fin d'horizon avec / sans décision, écart). */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {(
          [
            // « Au départ » = situation initiale (référence au mois 0), avant toute opération de la décision.
            ['cash', 'dl.res.cash', first.refCash, last.cash, last.refCash, v.endOfHorizon.cashDelta],
            ['netWorth', 'dl.res.netWorth', first.refNetWorth, last.netWorth, last.refNetWorth, v.endOfHorizon.netWorthDelta],
          ] as const
        ).map(([id, label, initial, withD, without, delta]) => (
          <div key={id} data-testid={`dl-res-${id}`} className="rounded-2xl border border-line/10 bg-surface-2/40 p-4">
            <h4 className="mb-3 text-sm font-semibold">{t(label)}</h4>
            <dl className="grid grid-cols-2 gap-3">
              <Metric label={t('dl.res.initial')} value={money(initial)} />
              <Metric label={t('dl.res.withDecision')} value={money(withD)} tone={withD < 0 ? 'negative' : null} />
              <Metric label={t('dl.res.without')} value={money(without)} />
              <Metric label={t('dl.res.delta')} value={signed(delta)} tone={toneOf(delta)} testId={`dl-res-${id}-delta`} />
            </dl>
          </div>
        ))}
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Metric label={t('dl.res.lowest', { month: v.lowestCash.month })} value={money(v.lowestCash.value)} tone={v.lowestCash.value < 0 ? 'negative' : null} testId="dl-res-lowest" />
        <Metric label={t('dl.res.firstNegative')} value={v.firstNegativeCashMonth === null ? t('dl.res.never') : String(v.firstNegativeCashMonth)} testId="dl-res-first-negative" />
      </dl>

      {/* Indicateurs propres au type de décision : uniquement ceux que le moteur fournit. */}
      {v.details.kind === 'purchase' && v.details.loan && (
        <div data-testid="dl-res-loan" className="rounded-2xl border border-line/10 p-4">
          <h4 className="mb-3 text-sm font-semibold">{t('dl.res.loan.title')}</h4>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label={t('dl.res.loan.installment')} value={money(v.details.loan.installment)} />
            <Metric label={t('dl.res.loan.last')} value={money(v.details.loan.lastInstallment)} />
            <Metric label={t('dl.res.loan.months')} value={String(v.details.loan.actualMonths)} />
            <Metric label={t('dl.res.loan.interest')} value={money(v.details.loan.totalInterest)} />
            <Metric label={t('dl.res.loan.paid')} value={money(v.details.loan.totalPaid)} />
          </dl>
        </div>
      )}
      {v.details.kind === 'goal' && (
        <div data-testid="dl-res-goal" className="rounded-2xl border border-line/10 p-4">
          <h4 className="mb-3 text-sm font-semibold">{t('dl.res.goal.title')}</h4>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label={t('dl.res.goal.effort')} value={money(v.details.monthlyContribution)} />
            <Metric label={t('dl.res.goal.reached')} value={v.details.reachedMonth === null ? t('dl.res.goal.notReached', { max: MAX_HORIZON_MONTHS }) : String(v.details.reachedMonth)} testId="dl-res-goal-reached" />
            {v.details.reachedMonth !== null && <Metric label={t('dl.res.goal.lastContribution')} value={money(v.details.lastContribution)} />}
            <Metric label={t('dl.res.goal.contributed')} value={money(v.details.totalContributed)} />
            <Metric label={t('dl.res.goal.interest')} value={money(v.details.totalInterest)} />
            {v.details.deadlineMonths !== null && v.details.balanceAtDeadline !== null && <Metric label={t('dl.res.goal.deadline', { month: v.details.deadlineMonths })} value={money(v.details.balanceAtDeadline)} />}
            {!!v.details.shortfallAtDeadline && <Metric label={t('dl.res.goal.shortfall')} value={money(v.details.shortfallAtDeadline)} tone="negative" />}
            <Metric label={t('dl.res.goal.final')} value={money(v.details.finalBalance)} />
          </dl>
        </div>
      )}
      {v.details.kind === 'investment' && (
        <div data-testid="dl-res-investment" className="rounded-2xl border border-line/10 p-4">
          <h4 className="mb-3 text-sm font-semibold">{t('dl.res.inv.title')}</h4>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label={t('dl.res.inv.final')} value={money(v.details.finalBalance)} />
            <Metric label={t('dl.res.inv.contributions')} value={money(v.details.totalContributions)} />
            <Metric label={t('dl.res.inv.interest')} value={money(v.details.totalInterest)} />
          </dl>
        </div>
      )}

      {/* Lecture factuelle : résultats calculés, puis avertissements, puis limites du calcul. */}
      <div data-testid="dl-res-summary" className="space-y-1.5 rounded-2xl border border-line/10 bg-surface-2/40 p-4 text-sm">
        <h4 className="font-semibold">{t('dl.res.summary.title')}</h4>
        <p>{t('dl.res.summary.cash', { months: horizon, delta: isolate(signed(v.endOfHorizon.cashDelta)) })}</p>
        <p>{t('dl.res.summary.netWorth', { months: horizon, delta: isolate(signed(v.endOfHorizon.netWorthDelta)) })}</p>
        <p>{t('dl.res.summary.lowest', { amount: isolate(money(v.lowestCash.value)), month: v.lowestCash.month })}</p>
      </div>
      {notices.length > 0 && (
        <ul data-testid="dl-res-notices" className="space-y-2">
          {notices.map((n) => (
            <li
              key={n.code}
              data-notice={n.code}
              role={n.level === 'warning' ? 'alert' : 'status'}
              className={cn('flex gap-2 rounded-xl border px-3 py-2 text-xs', n.level === 'warning' ? 'border-warning/30 bg-warning/10' : 'border-cyan/30 bg-cyan/10')}
            >
              {n.level === 'warning' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan" aria-hidden />}
              <span>{td(`dl.res.notice.${n.code}`, { ...n.vars, max: MAX_HORIZON_MONTHS })}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Trajectoires : une valeur par mois calculé par le moteur, sans interpolation. */}
      <p className="text-xs text-muted">{t('dl.res.axis', { currency: cur })}</p>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {lineChart('dl-chart-cash', t('dl.res.chart.cash'), [
          { key: 'without', name: t('dl.res.series.without'), color: SERIES.muted, values: rows.map((r) => r.refCash), dashed: true },
          { key: 'with', name: t('dl.res.series.with'), color: SERIES.cyan, values: rows.map((r) => r.cash) },
        ])}
        {lineChart('dl-chart-networth', t('dl.res.chart.netWorth'), [
          { key: 'without', name: t('dl.res.series.without'), color: SERIES.muted, values: rows.map((r) => r.refNetWorth), dashed: true },
          { key: 'with', name: t('dl.res.series.with'), color: SERIES.violet, values: rows.map((r) => r.netWorth) },
        ])}
        {extra && lineChart('dl-chart-extra', td(extra.key), [{ key: 'value', name: td(extra.key), color: SERIES.primary, values: extra.values }])}
      </div>

      <div>
        <Button variant="ghost" size="sm" aria-expanded={table} onClick={() => setTable(!table)}>
          {t('dl.res.table.show')}
        </Button>
        {table && (
          <div className="mt-2 max-h-80 overflow-auto rounded-xl border border-line/10">
            <table data-testid="dl-res-table" className="w-full text-xs">
              <thead className="sticky top-0 bg-surface-2">
                <tr className="text-muted">
                  <th className="px-2 py-1.5 text-start font-medium">{t('dl.res.table.month')}</th>
                  <th className="px-2 py-1.5 text-end font-medium">{t('dl.res.cash')} · {t('dl.res.series.without')}</th>
                  <th className="px-2 py-1.5 text-end font-medium">{t('dl.res.cash')} · {t('dl.res.series.with')}</th>
                  <th className="px-2 py-1.5 text-end font-medium">{t('dl.res.netWorth')} · {t('dl.res.series.without')}</th>
                  <th className="px-2 py-1.5 text-end font-medium">{t('dl.res.netWorth')} · {t('dl.res.series.with')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.month} className="border-t border-line/5">
                    <td className="whitespace-nowrap px-2 py-1">
                      {r.month}
                      {r.monthKey && <span className="text-muted"> · {monthLabel(r)}</span>}
                    </td>
                    {[r.refCash, r.cash, r.refNetWorth, r.netWorth].map((x, i) => (
                      <td key={i} className={cn('num whitespace-nowrap px-2 py-1 text-end', x < 0 && 'text-negative')}>
                        <bdi>{money(x)}</bdi>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div data-testid="dl-res-limits" className="rounded-xl bg-surface-2/60 p-3 text-xs text-muted">
        <div className="mb-1 font-semibold text-fg">{t('dl.res.limits.title')}</div>
        <p>{t('dl.res.limits.text')}</p>
        {decision.kind === 'purchase' && <p className="mt-1">{t('dl.res.limits.asset')}</p>}
      </div>
    </section>
  );
}
