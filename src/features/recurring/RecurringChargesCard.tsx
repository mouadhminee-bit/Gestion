import { useApp } from '@/app/AppContext';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Misc';
import { NoData } from '@/components/charts/ChartKit';
import type { RecurringChargeRow, RecurringChargesReport } from '@/domain/calc/analytics';
import { usePersistentState } from '@/lib/usePersistentState';
import { t } from '@/i18n/core';
import { occurrenceBadge } from './status';

type Tab = 'composition' | 'real' | 'income';

/** Statuts des échéances de la période, regroupés (« Payée ×2 »). */
function StatusBadges({ row }: { row: RecurringChargeRow }) {
  const groups = new Map<string, { tone: ReturnType<typeof occurrenceBadge>['tone']; n: number }>();
  for (const o of row.occurrences) {
    const b = occurrenceBadge(o);
    const g = groups.get(b.label);
    if (g) g.n += 1;
    else groups.set(b.label, { tone: b.tone, n: 1 });
  }
  return (
    <>
      {[...groups].map(([label, g]) => (
        <Badge key={label} tone={g.tone}>{g.n > 1 ? `${label} ×${g.n}` : label}</Badge>
      ))}
    </>
  );
}

/**
 * Charges récurrentes en trois lectures séparées : composition des engagements,
 * décaissements réellement enregistrés, poids dans les revenus perçus.
 */
export function RecurringChargesCard({ report }: { report: RecurringChargesReport }) {
  const { fmt } = useApp();
  const [tab, setTab] = usePersistentState<Tab>('analytics.recurringTab', 'composition');
  const pct = (v: number | null) => fmt.percent(v, 1, true);
  const perMonth = (amount: number, ratio: number | null) => (
    <span className="num shrink-0"><bdi>{fmt.money(amount)}</bdi><span className="text-xs text-muted">{t('an.perMonthShare', { pct: pct(ratio) })}</span></span>
  );

  return (
    <Card title={t('an.recurring')} info={t('an.recurring.info')}>
      {report.rows.length === 0 ? (
        <NoData height={120}>{t('an.noRecurring')}</NoData>
      ) : (
        <>
          <Segmented size="sm" className="mb-3 w-full" value={tab} onChange={setTab} options={[
            { value: 'composition', label: t('an.rc.tab.composition') },
            { value: 'real', label: t('an.rc.tab.real') },
            { value: 'income', label: t('an.rc.tab.income') },
          ]} />

          {tab === 'composition' && (
            <ul className="divide-y divide-line/5 text-sm">
              {report.rows.map((r) => (
                <li key={r.rule.id} className="flex justify-between gap-2 py-2"><span className="truncate">{r.rule.label}</span>{perMonth(r.monthly, r.composition)}</li>
              ))}
              <li className="flex justify-between gap-2 py-2 font-semibold"><span>{t('an.rc.total')}</span>{perMonth(report.monthlyTotal, report.monthlyTotal > 0 ? 1 : null)}</li>
            </ul>
          )}

          {tab === 'real' && (
            <>
              <ul className="divide-y divide-line/5 text-sm">
                {report.rows.map((r) => (
                  <li key={r.rule.id} className="py-2">
                    <div className="flex justify-between gap-2">
                      <span className="truncate">{r.rule.label}</span>
                      <span className="num shrink-0"><bdi>{fmt.money(r.paid)}</bdi><span className="text-xs text-muted"> · <bdi>{pct(r.paidShare)}</bdi></span></span>
                    </div>
                    {(r.occurrences.length > 0 || r.detected > 0) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                        <StatusBadges row={r} />
                        {r.detected > 0 && <span className="num">{t('an.rc.toConfirm', { amount: fmt.money(r.detected) })}</span>}
                        {r.remaining > 0 && <span className="num">{t('an.rc.remaining', { amount: fmt.money(r.remaining) })}</span>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-xl bg-surface-2/60 p-3 text-xs">
                <dt className="text-muted">{t('an.rc.sum.expenses')}</dt><dd className="num text-end"><bdi>{fmt.money(report.expenses)}</bdi></dd>
                <dt className="text-muted">{t('an.rc.sum.paid')}</dt><dd className="num text-end"><bdi>{fmt.money(report.paid)}</bdi> · <bdi>{pct(report.paidShare)}</bdi></dd>
                <dt className="text-muted">{t('an.rc.sum.detected')}</dt><dd className="num text-end"><bdi>{fmt.money(report.detected)}</bdi> · <bdi>{pct(report.detectedShare)}</bdi></dd>
                <dt className="text-muted">{t('an.rc.sum.committed')}</dt><dd className="num text-end"><bdi>{fmt.money(report.committed)}</bdi></dd>
                <dt className="text-muted">{t('an.rc.sum.remaining')}</dt><dd className="num text-end font-semibold"><bdi>{fmt.money(report.remaining)}</bdi></dd>
              </dl>
              {report.coverage != null && report.coverage > 1 && <p className="mt-2 text-xs text-warning">{t('an.rc.over', { pct: pct(report.coverage) })}</p>}
              {report.rows.some((r) => (r.paidShare ?? 0) > 1) && <p className="mt-2 text-xs text-muted">{t('an.rc.refund')}</p>}
            </>
          )}

          {tab === 'income' && (
            <ul className="divide-y divide-line/5 text-sm">
              {report.rows.map((r) => (
                <li key={r.rule.id} className="flex justify-between gap-2 py-2"><span className="truncate">{r.rule.label}</span>{perMonth(r.monthly, r.incomeShare)}</li>
              ))}
              <li className="flex justify-between gap-2 py-2 font-semibold"><span>{t('an.rc.total')}</span>{perMonth(report.monthlyTotal, report.incomeShare)}</li>
              <li className="pt-2 text-xs text-muted">{report.monthlyIncome != null ? t('an.rc.income', { amount: fmt.money(Math.round(report.monthlyIncome)) }) : t('an.rc.noIncome')}</li>
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
