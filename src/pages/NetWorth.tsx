import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { Landmark, PenLine, Plus, Trash2, TrendingDown, TrendingUp } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState } from '@/components/ui/Misc';
import { Dialog, useConfirm } from '@/components/ui/Dialog';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { Tooltip } from '@/components/ui/Tooltip';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { ChartTooltip, LegendDot, NoData, SERIES, useChart } from '@/components/charts/ChartKit';
import { ASSET_CLASS_LABELS, computeNetWorth, latestValuation, netWorthHistory, type AssetClass } from '@/domain/calc/networth';
import { addMonthsToKey, formatMonthShort, monthKey } from '@/domain/dates';
import { CURRENCIES } from '@/domain/money';
import type { Asset, AssetType } from '@/domain/types';
import { ASSET_TYPE_LABELS } from '@/domain/types';
import { cn } from '@/lib/cn';
import { t } from '@/i18n/core';

const CLASS_COLORS: Record<AssetClass, string> = {
  liquidity: '#41E7F5',
  savings: '#25D9A0',
  investment: '#5271FF',
  real_estate: '#9B7BFF',
  vehicle: '#FFBF69',
  receivable: '#F472B6',
  other: '#94A3B8',
};

export default function NetWorth() {
  const { data, ctx, fmt, today, repo, settings, uiLocale } = useApp();
  const chart = useChart();
  const toast = useToast();
  const confirm = useConfirm();
  const [assetForm, setAssetForm] = useState<{ id?: string; name: string; type: AssetType; currency: string; linkedAccountId?: string; notes?: string; value: number | null; date: string } | null>(null);
  const [valForm, setValForm] = useState<{ asset: Asset; value: number | null; date: string; note: string } | null>(null);

  const nw = useMemo(() => computeNetWorth(ctx, data, today), [ctx, data, today]);
  const history = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, i) => addMonthsToKey(monthKey(today), i - 11));
    return netWorthHistory(ctx, data, months, today);
  }, [ctx, data, today]);
  const prev = history[history.length - 2];
  const variation = prev ? nw.netWorth - prev.netWorth : null;
  const classes = (Object.keys(nw.byClass) as AssetClass[]).filter((k) => nw.byClass[k] > 0).map((k) => ({ name: ASSET_CLASS_LABELS[k], value: nw.byClass[k], color: CLASS_COLORS[k] }));
  const share = (k: AssetClass[]) => (nw.totalAssets > 0 ? k.reduce((a, c) => a + nw.byClass[c], 0) / nw.totalAssets : null);

  async function saveAsset() {
    if (!assetForm) return;
    try {
      const { value, date, id, ...rest } = assetForm;
      await repo.saveAsset({ ...rest, id, archived: false, linkedAccountId: rest.linkedAccountId || undefined }, !id && value != null ? { date, value } : undefined);
      toast.success(t('nw.assetSaved'));
      setAssetForm(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function saveValuation() {
    if (!valForm || valForm.value == null) return;
    try {
      await repo.addValuation(valForm.asset.id, valForm.date, valForm.value, valForm.note || undefined);
      toast.success(t('nw.valuationSaved'));
      setValForm(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={t('nw.eyebrow')}
        title={t('nav.netWorth')}
        description={t('nw.description')}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAssetForm({ name: '', type: 'real_estate', currency: settings.baseCurrency, value: null, date: today })}>{t('nw.addAsset')}</Button>}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={t('nw.netWorth')} info={t('nw.netWorthInfo')}>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className={cn('display text-4xl font-semibold num', nw.netWorth < 0 && 'text-negative')}>{fmt.money(nw.netWorth)}</div>
              {variation != null && (
                <div className={cn('mt-1 inline-flex items-center gap-1 text-xs', variation >= 0 ? 'text-positive' : 'text-negative')}>
                  {variation >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                  {fmt.money(variation, undefined, { sign: true })} <span className="text-muted">{t('nw.sinceEndOf', { month: fmt.month(prev.month) })}</span>
                </div>
              )}
            </div>
            <div><div className="label">{t('nw.assets')}</div><div className="num font-semibold text-positive">{fmt.money(nw.totalAssets)}</div></div>
            <div><div className="label">{t('nw.liabilities')}</div><div className="num font-semibold text-negative">{fmt.money(nw.totalLiabilities)}</div></div>
            <div><div className="label">{t('nw.liquidity')}</div><div className="num font-semibold">{fmt.percent(share(['liquidity']), 0)}</div></div>
            <div><div className="label">{t('nw.investments')}</div><div className="num font-semibold">{fmt.percent(share(['investment']), 0)}</div></div>
          </div>
          {Object.keys(nw.unconverted).length > 0 && <p className="mt-2 text-xs text-warning">{t('nw.unconverted', { list: Object.entries(nw.unconverted).map(([c, v]) => fmt.money(v, c)).join(' · ') })}</p>}
          <div className="mt-5 h-56">
            <ResponsiveContainer>
              <AreaChart data={history.map((h) => ({ name: formatMonthShort(h.month, uiLocale), nw: chart.major(h.netWorth), assets: chart.major(h.assets), liabilities: chart.major(h.liabilities) }))}>
                <defs><linearGradient id="g-nw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={SERIES.violet} stopOpacity={0.4} /><stop offset="1" stopColor={SERIES.violet} stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid vertical={false} stroke={SERIES.grid} />
                <XAxis dataKey="name" {...chart.axis} />
                <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(48)} domain={['auto', 'auto']} />
                <RTooltip content={<ChartTooltip valueFormatter={chart.money} />} />
                <Area type="monotone" dataKey="nw" name={t('nw.netWorth')} stroke={SERIES.violet} strokeWidth={2.5} fill="url(#g-nw)" isAnimationActive={chart.animate} animationDuration={chart.duration} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[11px] text-muted">{t('nw.historyNote')}</p>
        </Card>

        <Card title={t('nw.allocation')}>
          {classes.length ? (
            <>
              <div className="mx-auto h-44 w-44">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={classes} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="100%" paddingAngle={2} stroke="none" isAnimationActive={chart.animate} animationDuration={chart.duration}>
                      {classes.map((c) => <Cell key={c.name} fill={c.color} />)}
                    </Pie>
                    <RTooltip content={<ChartTooltip valueFormatter={(v) => fmt.money(v)} />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 space-y-2">{classes.map((c) => <LegendDot key={c.name} color={c.color} label={c.name} value={`${fmt.money(c.value, undefined, { compact: true })} · ${fmt.percent(c.value / nw.totalAssets, 0)}`} />)}</div>
            </>
          ) : <NoData>{t('nw.noValuedAsset')}</NoData>}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title={t('nw.assets')} subtitle={t('nw.lines', { count: nw.assets.length })}>
          <ul className="divide-y divide-line/5">
            {nw.assets.sort((a, b) => b.value - a.value).map((l) => (
              <li key={l.source + l.id} className="flex items-center gap-3 py-2.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CLASS_COLORS[l.cls as AssetClass] }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {l.name}
                    {l.manual && (
                      <Tooltip content={l.valuationDate ? t('nw.manualValueOn', { date: fmt.date(l.valuationDate) }) : t('nw.manualValue')}>
                        <span tabIndex={0}><Badge tone="warning" icon={<PenLine className="h-3 w-3" />}>{t('nw.estimate')}</Badge></span>
                      </Tooltip>
                    )}
                  </div>
                  <div className="text-xs text-muted">{ASSET_CLASS_LABELS[l.cls as AssetClass]}{l.currency !== settings.baseCurrency ? ` · ${fmt.money(l.nativeValue, l.currency)}` : ''}</div>
                </div>
                <div className="num text-sm font-semibold">{fmt.money(l.value)}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t('nw.liabilities')} subtitle={t('nw.liabilitiesSubtitle')}>
          {nw.liabilities.length === 0 ? <p className="py-6 text-center text-sm text-muted">{t('nw.noLiability')}</p> : (
            <ul className="divide-y divide-line/5">
              {nw.liabilities.map((l) => (
                <li key={l.id} className="flex items-center justify-between py-2.5">
                  <span className="text-sm font-medium">{l.name}</span>
                  <span className="num text-sm font-semibold text-negative">−{fmt.money(l.value)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-5" title={t('nw.manualAssets')} info={t('nw.manualAssetsInfo')}>
        {data.assets.length === 0 ? (
          <EmptyState icon={<Landmark className="h-5 w-5" />} title={t('nw.empty.title')} description={t('nw.empty.description')} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data.assets.map((a) => {
              const last = latestValuation(data.valuations, a.id, today);
              const vals = data.valuations.filter((v) => v.assetId === a.id).sort((x, y) => y.date.localeCompare(x.date));
              return (
                <div key={a.id} className="rounded-2xl border border-line/10 bg-surface-2/40 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{a.name}</div>
                      <div className="mt-0.5 text-xs text-muted">{ASSET_TYPE_LABELS[a.type]}{a.linkedAccountId ? ` · ${t('nw.values', { name: ctx.accounts.get(a.linkedAccountId)?.name ?? '' })}` : ''}</div>
                    </div>
                    <div className="text-end">
                      <div className="num font-semibold">{last ? fmt.money(last.value, a.currency) : '—'}</div>
                      <div className="text-[11px] text-muted">{last ? t('nw.asOf', { date: fmt.date(last.date) }) : t('nw.notValued')}</div>
                    </div>
                  </div>
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-muted hover:text-fg">{t('nw.valuationHistory', { count: vals.length })}</summary>
                    <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                      {vals.map((v) => (
                        <li key={v.id} className="flex items-center justify-between gap-2">
                          <span className="text-muted">{fmt.date(v.date)}{v.note ? ` · ${v.note}` : ''}</span>
                          <span className="flex items-center gap-1 num">{fmt.money(v.value, a.currency)}
                            <button aria-label={t('nw.deleteValuation')} className="text-muted hover:text-negative" onClick={() => repo.deleteValuation(v.id)}><Trash2 className="h-3 w-3" /></button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setValForm({ asset: a, value: last?.value ?? null, date: today, note: '' })}>{t('nw.newValuation')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setAssetForm({ id: a.id, name: a.name, type: a.type, currency: a.currency, linkedAccountId: a.linkedAccountId, notes: a.notes, value: null, date: today })}>{t('common.edit')}</Button>
                    <Button size="sm" variant="ghost" aria-label={t('nw.deleteAsset')} onClick={async () => { if (await confirm({ title: t('nw.deleteAsset.title', { name: a.name }), message: t('nw.deleteAsset.message'), confirmLabel: t('common.delete') })) { await repo.deleteAsset(a.id); toast.success(t('nw.assetDeleted')); } }}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Dialog open={!!assetForm} onOpenChange={(o) => !o && setAssetForm(null)} title={assetForm?.id ? t('nw.editAsset') : t('nw.newAsset')} size="md"
        footer={<><Button variant="ghost" onClick={() => setAssetForm(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={saveAsset} disabled={!assetForm?.name.trim()}>{t('common.save')}</Button></>}>
        {assetForm && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('common.name')} required className="sm:col-span-2"><Input value={assetForm.name} onChange={(e) => setAssetForm({ ...assetForm, name: e.target.value })} placeholder={t('nw.namePlaceholder')} data-autofocus /></Field>
            <Field label={t('common.type')}><Select value={assetForm.type} onChange={(e) => setAssetForm({ ...assetForm, type: e.target.value as AssetType })}>{Object.entries(ASSET_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label={t('common.currency')}><Select value={assetForm.currency} onChange={(e) => setAssetForm({ ...assetForm, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select></Field>
            <Field label={t('nw.linkedAccount')} className="sm:col-span-2" hint={t('nw.linkedAccountHint')}>
              <Select value={assetForm.linkedAccountId ?? ''} onChange={(e) => setAssetForm({ ...assetForm, linkedAccountId: e.target.value || undefined })}>
                <option value="">{t('nw.notLinked')}</option>
                {data.accounts.filter((a) => a.currency === assetForm.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>
            {!assetForm.id && (
              <>
                <Field label={t('nw.estimatedValue')}><MoneyInput value={assetForm.value} onChange={(v) => setAssetForm({ ...assetForm, value: v })} currency={assetForm.currency} /></Field>
                <Field label={t('nw.valuationDate')}><Input type="date" value={assetForm.date} onChange={(e) => setAssetForm({ ...assetForm, date: e.target.value })} /></Field>
              </>
            )}
            <Field label={t('common.notes')} className="sm:col-span-2"><Textarea value={assetForm.notes ?? ''} onChange={(e) => setAssetForm({ ...assetForm, notes: e.target.value })} className="min-h-[60px]" /></Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!valForm} onOpenChange={(o) => !o && setValForm(null)} title={t('nw.newValuation')} description={valForm?.asset.name} size="sm"
        footer={<><Button variant="ghost" onClick={() => setValForm(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={saveValuation} disabled={valForm?.value == null}>{t('common.save')}</Button></>}>
        {valForm && (
          <div className="space-y-4">
            <Field label={t('nw.estimatedValue')} hint={t('nw.manualHint')}><MoneyInput value={valForm.value} onChange={(v) => setValForm({ ...valForm, value: v })} currency={valForm.asset.currency} data-autofocus /></Field>
            <Field label={t('common.date')}><Input type="date" value={valForm.date} onChange={(e) => setValForm({ ...valForm, date: e.target.value })} /></Field>
            <Field label={t('nw.sourceNote')}><Input value={valForm.note} onChange={(e) => setValForm({ ...valForm, note: e.target.value })} placeholder={t('nw.sourcePlaceholder')} /></Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}
