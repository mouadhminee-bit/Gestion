/**
 * Decision Lab — résultats d'une comparaison (étape E5.5).
 *
 * Tout ce qui est affiché provient du snapshot (résultats figés du moteur E3, même référence, mêmes
 * mois pour toutes les variantes) ou, pour la comparaison en cours, du détail mensuel du moteur
 * (`live`). Aucun calcul financier ici : les valeurs sont lues et mises en forme ; l'écart entre
 * variantes est « variante − A » (`comparisonIndicators`). Aucune variante n'est qualifiée : les
 * écarts sont affichés sans couleur de jugement.
 */
import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Info } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { ChartTooltip, LegendDot, SERIES, useChart } from '@/components/charts/ChartKit';
import { MAX_HORIZON_MONTHS, type DecisionResult } from '@/domain/calc/decision';
import { formatMonthShort } from '@/domain/dates';
import { cn } from '@/lib/cn';
import { t, td } from '@/i18n/core';
import type { DecisionSnapshot } from './snapshot';
import { simulationNotices } from './simulationRun';
import { comparisonIndicators, comparisonRows, VARIANT_IDS, variantLabel, type ComparisonRow, type Indicator } from './comparisonRun';

/** Couleur et tracé de chaque variante (A à D) : distincts même sans la couleur. */
const VARIANT_STYLE = [
  { color: SERIES.cyan, dash: undefined },
  { color: SERIES.violet, dash: '8 3' },
  { color: SERIES.warning, dash: '2 3' },
  { color: SERIES.primary, dash: '10 3 2 3' },
] as const;

/** Isole un montant inséré dans une phrase (ordre correct en arabe, hébreu, persan). */
const isolate = (s: string) => `⁨${s}⁩`;

type SeriesKey = 'cash' | 'netWorth' | 'extra';

export function ComparisonResults({ snapshot, live }: { snapshot: DecisionSnapshot; live?: DecisionResult[] }) {
  const { fmt, settings, uiLocale } = useApp();
  const chart = useChart();
  const [table, setTable] = useState(false);
  const [tableSeries, setTableSeries] = useState<SeriesKey>('cash');
  const cur = settings.baseCurrency;
  const money = (v: number) => fmt.money(v, cur);
  const signed = (v: number) => fmt.money(v, cur, { sign: true });
  const signedInt = useMemo(() => new Intl.NumberFormat(settings.locale, { signDisplay: 'exceptZero', maximumFractionDigits: 0 }), [settings.locale]);
  const horizon = snapshot.hypotheses.horizonMonths;
  const kind = snapshot.hypotheses.variants[0].decision.kind;
  const labels = snapshot.results.variants.map((_, k) => variantLabel(snapshot, k));
  const rows = useMemo(() => comparisonRows(snapshot), [snapshot]);
  const indicators = useMemo(() => comparisonIndicators(snapshot), [snapshot]);
  const notices = useMemo(() => snapshot.results.variants.map((_, k) => simulationNotices(snapshot, k)), [snapshot]);
  const noEffect = notices.flatMap((list, k) => (list.some((n) => n.code === 'noEffect' || n.code === 'noEffectAfterHorizon') ? [`${VARIANT_IDS[k]} · ${labels[k]}`] : []));
  const monthLabel = (r: ComparisonRow) => (r.monthKey ? formatMonthShort(r.monthKey, uiLocale) : String(r.month));

  // Séries supplémentaires du moteur (comparaison en cours uniquement) : solde du compte dédié ou dette.
  const extra =
    live && (kind === 'goal' || kind === 'investment')
      ? { key: 'dl.res.chart.assets', values: live.map((r) => r.months.map((m) => m.assets)) }
      : live && kind === 'purchase' && snapshot.hypotheses.variants.some((v) => v.decision.kind === 'purchase' && v.decision.loan)
        ? { key: 'dl.res.chart.debt', values: live.map((r) => r.months.map((m) => m.liabilities)) }
        : null;

  /** Valeur d'un indicateur pour une variante ; null = sans objet (libellé selon l'indicateur). */
  const valueText = (ind: Indicator, x: number | null): string => {
    if (x === null) {
      if (ind.key === 'firstNegativeCashMonth') return t('dl.res.never');
      if (ind.key === 'goalReachedMonth' || ind.key === 'goalToReach') return t('dl.res.goal.notReached', { max: MAX_HORIZON_MONTHS });
      if (ind.key.startsWith('loan')) return t('dl.cmp.noLoan');
      return '—';
    }
    return ind.unit === 'money' ? money(x) : String(x);
  };
  const diffText = (ind: Indicator, k: number): string => {
    const d = ind.differences[k];
    if (!ind.comparable) return t('dl.cmp.notComparable');
    if (ind.outOfRange[k]) return t('dl.cmp.diffOutOfRange');
    return d === null ? '—' : ind.unit === 'money' ? signed(d) : signedInt.format(d);
  };
  /** Période propre à la valeur d'une variante (durée du crédit, mois d'atteinte, échéance). */
  const periodText = (ind: Indicator, k: number): string | null => {
    const p = ind.periods?.[k];
    if (p === null || p === undefined || ind.values[k] === null) return null;
    if (ind.key === 'goalToReach') return t('dl.cmp.period.reach', { month: p });
    if (ind.key === 'goalShortfall') return t('dl.cmp.period.deadline', { month: p });
    return t('dl.cmp.period.loan', { months: p });
  };

  const lineChart = (testId: string, title: string, values: number[][], reference?: number[]) => {
    const series = [
      ...(reference ? [{ key: 'ref', name: t('dl.res.series.without'), color: SERIES.muted, dash: '5 4' as string | undefined, values: reference, width: 1.5 }] : []),
      ...values.map((vals, k) => ({ key: `v${k}`, name: `${VARIANT_IDS[k]} · ${labels[k]}`, color: VARIANT_STYLE[k].color, dash: VARIANT_STYLE[k].dash as string | undefined, values: vals, width: 2 })),
    ];
    return (
      <figure data-testid={testId} className="min-w-0">
        <figcaption className="mb-2 text-sm font-semibold">{title}</figcaption>
        {/* Graphique numérique : toujours de gauche à droite (axes lisibles en arabe, hébreu, persan). */}
        <div className="h-60" role="img" aria-label={title} dir="ltr">
          <ResponsiveContainer>
            <LineChart data={rows.map((r, i) => ({ name: r.month, ...Object.fromEntries(series.map((s) => [s.key, chart.major(s.values[i])])) }))}>
              <CartesianGrid vertical={false} stroke={SERIES.grid} />
              <XAxis dataKey="name" {...chart.axis} minTickGap={24} />
              <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(48)} domain={['auto', 'auto']} />
              <RTooltip content={<ChartTooltip valueFormatter={chart.money} labelFormatter={(l) => (rows[Number(l)] ? `${t('dl.res.table.month')} ${l} · ${monthLabel(rows[Number(l)])}` : l)} />} />
              {series.map((s) => (
                <Line key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} dot={false} isAnimationActive={chart.animate} animationDuration={chart.duration} />
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
  };

  const tableColumns: { key: SeriesKey; label: string; ref: ((r: ComparisonRow) => number) | null; value: (r: ComparisonRow, k: number) => number }[] = [
    { key: 'cash', label: t('dl.res.cash'), ref: (r) => r.refCash, value: (r, k) => r.cash[k] },
    { key: 'netWorth', label: t('dl.res.netWorth'), ref: (r) => r.refNetWorth, value: (r, k) => r.netWorth[k] },
    ...(extra ? [{ key: 'extra' as const, label: td(extra.key), ref: null, value: (r: ComparisonRow, k: number) => extra.values[k][r.month] }] : []),
  ];
  const shown = tableColumns.find((c) => c.key === tableSeries) ?? tableColumns[0];

  return (
    <section data-testid="dl-cmp-results" className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">{t('dl.cmp.res.title', { months: horizon })}</h3>
        <p className="mt-1 text-xs text-muted">{t('dl.cmp.res.common', { kind: td(`dl.kind.${kind}`) })}</p>
      </div>

      {/* Synthèse par variante : écarts par rapport à la situation sans décision, avertissements. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {snapshot.results.variants.map((v, k) => (
          <article key={v.id} data-testid="dl-cmp-summary" data-variant={VARIANT_IDS[k]} className="space-y-2 rounded-2xl border border-line/10 bg-surface-2/40 p-4 text-sm">
            <h4 className="flex items-center gap-2 font-semibold">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: VARIANT_STYLE[k].color }} aria-hidden />
              <span>{VARIANT_IDS[k]}</span>
              <span aria-hidden>·</span>
              <bdi className="min-w-0 break-words">{labels[k]}</bdi>
            </h4>
            <p>{t('dl.res.summary.cash', { months: horizon, delta: isolate(signed(v.endOfHorizon.cashDelta)) })}</p>
            <p>{t('dl.res.summary.netWorth', { months: horizon, delta: isolate(signed(v.endOfHorizon.netWorthDelta)) })}</p>
            <p>{t('dl.res.summary.lowest', { amount: isolate(money(v.lowestCash.value)), month: v.lowestCash.month })}</p>
            {notices[k].length > 0 && (
              <ul data-testid="dl-cmp-notices" className="space-y-1.5 pt-1">
                {notices[k].map((n) => (
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
          </article>
        ))}
      </div>

      {/* Indicateurs : une carte par indicateur (lisible sur mobile), une ligne par variante. */}
      <div>
        <h4 className="text-sm font-semibold">{t('dl.cmp.ind.title')}</h4>
        <p data-testid="dl-cmp-sign-rule" className="mt-1 text-xs text-muted">
          {t('dl.cmp.signRule', { base: isolate(`${VARIANT_IDS[0]} · ${labels[0]}`) })}
        </p>
        {/* Variante sans effet dans l'horizon (A4) : ses écarts ne traduisent aucun avantage. */}
        {noEffect.length > 0 && (
          <p role="alert" data-testid="dl-cmp-no-effect" className="mt-2 flex gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span>{t('dl.cmp.noEffect', { variants: isolate(noEffect.join(', ')) })}</span>
          </p>
        )}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {indicators.map((ind) => (
            <div key={ind.key} data-testid="dl-cmp-indicator" data-indicator={ind.key} className="rounded-2xl border border-line/10 p-3">
              <div className="mb-2 text-xs font-semibold">{td(`dl.cmp.ind.${ind.key}`)}</div>
              <table className="w-full text-xs">
                <thead className="sr-only">
                  <tr>
                    <th>{t('dl.cmp.variant')}</th>
                    <th>{t('dl.cmp.value')}</th>
                    <th>{t('dl.cmp.diff')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ind.values.map((x, k) => (
                    <tr key={k} data-variant={VARIANT_IDS[k]} className="border-t border-line/5 first:border-t-0">
                      <th scope="row" className="py-1 pe-2 text-start font-medium">
                        <span className="me-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: VARIANT_STYLE[k].color }} aria-hidden />
                        {VARIANT_IDS[k]}
                      </th>
                      <td className={cn('num py-1 text-end font-semibold', ind.unit === 'money' && x !== null && x < 0 && 'text-negative')}>
                        <bdi data-testid="dl-cmp-value">{valueText(ind, x)}</bdi>
                        {periodText(ind, k) && (
                          <span data-testid="dl-cmp-period" className="block text-[10px] font-normal text-muted">
                            {periodText(ind, k)}
                          </span>
                        )}
                      </td>
                      <td className="num py-1 ps-2 text-end text-muted">
                        {k === 0 ? (
                          <span className="text-[10px] uppercase tracking-wide">{t('dl.cmp.baseShort')}</span>
                        ) : (
                          <bdi data-testid="dl-cmp-diff" title={ind.comparable ? t('dl.cmp.diffTitle', { letter: VARIANT_IDS[k] }) : t('dl.cmp.periodsDiffer')}>
                            {diffText(ind, k)}
                          </bdi>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!ind.comparable && (
                <p data-testid="dl-cmp-periods-differ" className="mt-1.5 text-[11px] text-muted">
                  {t('dl.cmp.periodsDiffer')}
                </p>
              )}
            </div>
          ))}
        </div>
        {kind === 'goal' && snapshot.hypotheses.variants.some((v) => v.decision.kind === 'goal' && v.decision.mode !== (snapshot.hypotheses.variants[0].decision as { mode?: string }).mode) && (
          <p data-testid="dl-cmp-mixed-modes" className="mt-2 text-xs text-muted">
            {t('dl.cmp.mixedModes')}
          </p>
        )}
      </div>

      {/* Trajectoires : une valeur par mois calculé par le moteur, sans interpolation. */}
      <p className="text-xs text-muted">{t('dl.res.axis', { currency: cur })}</p>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {lineChart('dl-cmp-chart-cash', t('dl.res.chart.cash'), snapshot.results.variants.map((_, k) => rows.map((r) => r.cash[k])), rows.map((r) => r.refCash))}
        {lineChart('dl-cmp-chart-networth', t('dl.res.chart.netWorth'), snapshot.results.variants.map((_, k) => rows.map((r) => r.netWorth[k])), rows.map((r) => r.refNetWorth))}
        {extra && lineChart('dl-cmp-chart-extra', td(extra.key), extra.values)}
      </div>

      <div>
        <Button variant="ghost" size="sm" aria-expanded={table} onClick={() => setTable(!table)}>
          {t('dl.res.table.show')}
        </Button>
        {table && (
          <div className="mt-2 space-y-2">
            {tableColumns.length > 1 && (
              <Segmented<SeriesKey> size="sm" value={shown.key} onChange={setTableSeries} options={tableColumns.map((c) => ({ value: c.key, label: c.label }))} />
            )}
            <div className="max-h-80 overflow-auto rounded-xl border border-line/10">
              <table data-testid="dl-cmp-table" data-series={shown.key} className="w-full text-xs">
                <caption className="sr-only">{shown.label}</caption>
                <thead className="sticky top-0 bg-surface-2">
                  <tr className="text-muted">
                    <th className="sticky start-0 z-10 bg-surface-2 px-2 py-1.5 text-start font-medium">{t('dl.res.table.month')}</th>
                    {shown.ref && <th className="px-2 py-1.5 text-end font-medium">{t('dl.res.series.without')}</th>}
                    {labels.map((l, k) => (
                      <th key={k} className="px-2 py-1.5 text-end font-medium">
                        {VARIANT_IDS[k]} · <bdi>{l}</bdi>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.month} className="border-t border-line/5">
                      <td className="sticky start-0 whitespace-nowrap bg-surface px-2 py-1">
                        {r.month}
                        {r.monthKey && <span className="text-muted"> · {monthLabel(r)}</span>}
                      </td>
                      {[...(shown.ref ? [shown.ref(r)] : []), ...labels.map((_, k) => shown.value(r, k))].map((x, i) => (
                        <td key={i} className={cn('num whitespace-nowrap px-2 py-1 text-end', x < 0 && 'text-negative')}>
                          <bdi>{money(x)}</bdi>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div data-testid="dl-cmp-limits" className="rounded-xl bg-surface-2/60 p-3 text-xs text-muted">
        <div className="mb-1 font-semibold text-fg">{t('dl.res.limits.title')}</div>
        <p>{t('dl.res.limits.text')}</p>
        <p className="mt-1">{t('dl.cmp.limits.text')}</p>
        {kind === 'purchase' && <p className="mt-1">{t('dl.res.limits.asset')}</p>}
        {!live && <p className="mt-1">{t('dl.cmp.limits.saved')}</p>}
      </div>
    </section>
  );
}
