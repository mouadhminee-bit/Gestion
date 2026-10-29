import { useMemo, useState } from 'react';
import { Copy, Download, Pencil, PieChart, Plus, Trash2 } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, CategoryIcon, EmptyState, ProgressBar, ProgressRing } from '@/components/ui/Misc';
import { Dialog, useConfirm } from '@/components/ui/Dialog';
import { Field, Input, MoneyInput, Select } from '@/components/ui/Field';
import { InfoTip } from '@/components/ui/Tooltip';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { useMonthData } from '@/features/hooks';
import { budgetsCSV, download } from '@/features/export';
import type { BudgetLine } from '@/domain/calc/budgets';
import { computeBudgetLine, monthTiming, spentForBudget } from '@/domain/calc/budgets';
import { summarizePeriod } from '@/domain/calc/ledger';
import { addMonthsToKey, monthPeriod, formatMonthShort } from '@/domain/dates';
import type { Budget, ID } from '@/domain/types';
import { cn } from '@/lib/cn';
import { t } from '@/i18n/core';

const STATUS: Record<BudgetLine['status'], { tone: 'positive' | 'warning' | 'negative' | 'neutral'; label: string }> = {
  ok: { tone: 'positive', get label() { return t('budget.status.ok'); } },
  warning: { tone: 'warning', get label() { return t('budget.status.warning'); } },
  danger: { tone: 'warning', get label() { return t('budget.status.danger'); } },
  over: { tone: 'negative', get label() { return t('budget.status.over'); } },
  none: { tone: 'neutral', get label() { return t('budget.status.none'); } },
};

interface EditState {
  categoryId: ID | null;
  amount: number | null;
  follow: number;
  thresholds: string;
  existing?: Budget;
}

export default function Budgets() {
  const { data, ctx, fmt, month, today, repo, settings, uiLocale } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const md = useMonthData(month);
  const [edit, setEdit] = useState<EditState | null>(null);
  const timing = monthTiming(month, today);
  const { overview, summary } = md;

  const budgetedIds = new Set(data.budgets.filter((b) => b.month === month).map((b) => b.categoryId));
  const candidates = data.categories.filter((c) => c.kind === 'expense' && !c.archived && !budgetedIds.has(c.id));

  // Historique : 6 derniers mois, budget vs réel par catégorie (mêmes fonctions de calcul).
  const history = useMemo(() => {
    const months = Array.from({ length: 6 }, (_, i) => addMonthsToKey(month, i - 5));
    const rows = new Map<ID | null, { name: string; cells: { planned: number | null; spent: number }[] }>();
    months.forEach((m, idx) => {
      const s = summarizePeriod(ctx, data.transactions, monthPeriod(m));
      for (const b of data.budgets.filter((x) => x.month === m)) {
        const key = b.categoryId;
        const name = key ? ctx.categories.get(key)?.name ?? '—' : 'Budget global';
        if (!rows.has(key)) rows.set(key, { name, cells: months.map(() => ({ planned: null, spent: 0 })) });
        rows.get(key)!.cells[idx] = { planned: b.amount, spent: spentForBudget(s, b, ctx.categories) };
      }
    });
    return { months, rows: [...rows.entries()].sort((a, b) => (a[0] === null ? -1 : b[0] === null ? 1 : a[1].name.localeCompare(b[1].name))) };
  }, [ctx, data, month]);

  async function save() {
    if (!edit || edit.amount == null) return;
    const thresholds = edit.thresholds.split(/[,; ]+/).map(Number).filter((n) => n > 0 && n <= 200);
    try {
      await repo.setBudget(month, edit.categoryId, edit.amount, settings.baseCurrency, { applyToFollowingMonths: edit.follow, alertThresholds: thresholds.length ? thresholds : undefined });
      toast.success(edit.follow ? t('budget.savedFollowing', { month: fmt.month(month), count: edit.follow }) : t('budget.saved'));
      setEdit(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function copyPrevious() {
    const prev = addMonthsToKey(month, -1);
    const n = await repo.copyBudgets(prev, month, false);
    if (n) toast.success(t('budget.copied', { count: n, month: fmt.month(prev) }));
    else toast.info(t('budget.nothingToCopy', { month: fmt.month(prev) }));
  }

  async function remove(b: Budget) {
    if (!(await confirm({ title: t('budget.delete.title'), message: t('budget.delete.message', { month: fmt.month(month) }), confirmLabel: t('common.delete') }))) return;
    await repo.deleteBudget(b.id);
    toast.success(t('budget.deleted'));
  }

  const openEdit = (categoryId: ID | null, existing?: Budget) => setEdit({ categoryId, amount: existing?.amount ?? null, follow: 0, thresholds: (existing?.alertThresholds ?? []).join(', '), existing });
  const global = overview.global;
  const consumption = overview.reference > 0 ? summary.expenses / overview.reference : null;

  return (
    <div>
      <PageHeader
        eyebrow={t('navGroup.pilotage')}
        title={t('nav.budgets')}
        description={t('budget.description', { month: fmt.month(month) })}
        actions={
          <>
            <Button variant="outline" icon={<Copy className="h-4 w-4" />} onClick={copyPrevious}>{t('budget.copyPrev')}</Button>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download('nexora-budgets.csv', budgetsCSV(data.budgets, ctx.categories))} disabled={!data.budgets.length}>{t('common.csv')}</Button>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => openEdit(candidates[0]?.id ?? null)} disabled={!candidates.length}>{t('budget.new')}</Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1" title={t('budget.overview')} info={t('budget.overviewInfo')}>
          {overview.referenceSource === 'none' ? (
            <EmptyState icon={<PieChart className="h-5 w-5" />} title={t('budget.noneMonth')} description={t('budget.noneMonthHint')} action={<Button variant="primary" size="sm" onClick={() => openEdit(null)}>{t('budget.defineGlobal')}</Button>} />
          ) : (
            <div className="flex flex-col items-center text-center">
              <ProgressRing value={Math.min(1, consumption ?? 0)} size={150} stroke={11} color={consumption != null && consumption > 1 ? 'rgb(var(--negative))' : consumption != null && consumption > 0.9 ? 'rgb(var(--warning))' : 'rgb(var(--cyan))'}>
                <div>
                  <div className="display text-2xl font-semibold num">{fmt.percent(consumption, 0)}</div>
                  <div className="text-[11px] text-muted">{t('budget.consumed')}</div>
                </div>
              </ProgressRing>
              <div className="mt-4 grid w-full grid-cols-2 gap-3 text-start">
                <div className="rounded-xl bg-surface-2/60 p-3">
                  <div className="label">{t('budget.available')}</div>
                  <div className={cn('num mt-1 font-semibold', (overview.available ?? 0) < 0 && 'text-negative')}>{fmt.money(overview.available ?? 0)}</div>
                </div>
                <div className="rounded-xl bg-surface-2/60 p-3">
                  <div className="label">{t('budget.reference')}</div>
                  <div className="num mt-1 font-semibold">{fmt.money(overview.reference)}</div>
                  <div className="text-[10px] text-muted">{overview.referenceSource === 'global' ? t('budget.global') : t('budget.sumCategories')}</div>
                </div>
                <div className="rounded-xl bg-surface-2/60 p-3">
                  <div className="label">{t('budget.spent')}</div>
                  <div className="num mt-1 font-semibold">{fmt.money(summary.expenses)}</div>
                </div>
                <div className="rounded-xl bg-surface-2/60 p-3">
                  <div className="label flex items-center gap-1">{t('budget.unbudgeted')} <InfoTip>{t('budget.unbudgetedInfo')}</InfoTip></div>
                  <div className="num mt-1 font-semibold">{fmt.money(overview.unbudgetedSpent)}</div>
                </div>
              </div>
              <div className="mt-3 flex w-full gap-2">
                <Button size="sm" variant="outline" className="flex-1" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => openEdit(null, global?.budget)}>
                  {global ? t('budget.editGlobal') : t('budget.defineGlobal')}
                </Button>
                {global && <Button size="sm" variant="ghost" aria-label={t('budget.deleteGlobal')} onClick={() => remove(global.budget)}><Trash2 className="h-3.5 w-3.5" /></Button>}
              </div>
              {md.forecast && md.forecast.budgetReference != null && (
                <p className="mt-3 text-start text-xs text-muted">
                  {t('budget.projection')} <b className="num text-fg">{fmt.money(md.forecast.projectedExpenses)}</b>{' '}
                  {md.forecast.projectedBudgetOverrun! > 0 ? <span className="text-negative">{t('budget.overrunEstimated', { amount: fmt.money(md.forecast.projectedBudgetOverrun!) })}</span> : <span className="text-positive">{t('budget.withinBudget')}</span>} {t('budget.estimateNote')}
                </p>
              )}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2" title={t('budget.byCategory')} subtitle={timing.isCurrent ? t('budget.dayOf', { day: timing.elapsed, total: timing.total, pct: Math.round((timing.elapsed / timing.total) * 100) }) : timing.isPast ? t('budget.monthClosed') : t('budget.monthFuture')}>
          {overview.lines.length === 0 ? (
            <EmptyState title={t('budget.noCategory')} description={t('budget.noCategoryHint')} action={<Button size="sm" variant="primary" onClick={() => openEdit(candidates[0]?.id ?? null)} disabled={!candidates.length}>{t('common.add')}</Button>} />
          ) : (
            <ul className="space-y-1">
              {overview.lines.map((l, i) => {
                const st = l.status === 'danger' && (l.consumption ?? 0) >= 1 ? { tone: 'warning' as const, label: t('budget.status.reached') } : STATUS[l.status];
                return (
                  <li key={l.budget.id} className="group rounded-xl p-2.5 transition hover:bg-surface-2/60 animate-fade-up" style={{ animationDelay: `${i * 30}ms` }}>
                    <div className="flex items-center gap-3">
                      <CategoryIcon icon={l.category?.icon} color={l.category?.color} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium">{l.category?.parentId ? `${ctx.categories.get(l.category.parentId)?.name} · ` : ''}{l.category?.name ?? t('common.deletedCategory')}</span>
                            <Badge tone={st.tone}>{st.label}</Badge>
                          </div>
                          <div className="shrink-0 text-end text-sm num">
                            <span className="font-semibold">{fmt.money(l.spent)}</span>
                            <span className="text-muted"> / {fmt.money(l.planned)}</span>
                          </div>
                        </div>
                        <ProgressBar value={l.consumption ?? (l.spent > 0 ? 2 : 0)} tone="auto" className="mt-2" label={t('budget.consumption', { name: l.category?.name ?? '' })} />
                        {timing.isCurrent && l.planned > 0 && <div className="relative h-0"><span className="absolute -top-2 h-2 w-px bg-fg/50" style={{ insetInlineStart: `${(timing.elapsed / timing.total) * 100}%` }} title={t('budget.monthProgress')} /></div>}
                        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted">
                          <span>{t('budget.remaining')} <b className={cn('num', l.remaining < 0 ? 'text-negative' : 'text-fg')}>{fmt.money(l.remaining)}</b></span>
                          <span>{t('budget.consumedLabel')} <b className="num text-fg">{fmt.percent(l.consumption, 0)}</b></span>
                          <span>{t('budget.variance')} <b className={cn('num', l.variance > 0 ? 'text-negative' : 'text-positive')}>{fmt.money(l.variance, undefined, { sign: true })}</b> ({fmt.percent(l.variancePct, 0)})</span>
                          {l.projected != null && timing.isCurrent && <span>{t('budget.projection')} <b className={cn('num', l.projected > l.planned ? 'text-warning' : 'text-fg')}>{fmt.money(l.projected)}</b></span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                        <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => openEdit(l.budget.categoryId, l.budget)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button size="icon-sm" variant="ghost" aria-label={t('common.delete')} onClick={() => remove(l.budget)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-5" title={t('budget.history')} subtitle={t('budget.historySubtitle')} padded>
        {history.rows.length === 0 ? (
          <p className="text-sm text-muted">{t('budget.noHistory')}</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-start text-muted">
                  <th className="py-2 pe-3 font-medium">{t('common.category')}</th>
                  {history.months.map((m) => <th key={m} className="px-2 py-2 text-end font-medium">{formatMonthShort(m, uiLocale)} {m.slice(2, 4)}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/5">
                {history.rows.map(([key, row]) => (
                  <tr key={key ?? 'global'}>
                    <td className="py-2 pe-3 font-medium">{row.name}</td>
                    {row.cells.map((c, i) => {
                      const line = c.planned == null ? null : computeBudgetLine({ amount: c.planned } as Budget, null, c.spent, monthTiming(history.months[i], today), []);
                      return (
                        <td key={i} className="px-2 py-2 text-end num">
                          {c.planned == null ? <span className="text-muted/50">—</span> : (
                            <span className={cn(line!.status === 'over' ? 'text-negative' : 'text-fg')}>
                              {fmt.money(c.spent, undefined, { compact: true })}<span className="text-muted"> / {fmt.money(c.planned, undefined, { compact: true })}</span>
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog
        open={!!edit}
        onOpenChange={(o) => !o && setEdit(null)}
        title={edit?.existing ? t('budget.edit') : t('budget.new')}
        description={fmt.month(month)}
        size="sm"
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={save} disabled={edit?.amount == null}>{t('common.save')}</Button></>}
      >
        {edit && (
          <div className="space-y-4">
            <Field label={t('budget.scope')}>
              <Select value={edit.categoryId ?? ''} disabled={!!edit.existing} onChange={(e) => setEdit({ ...edit, categoryId: e.target.value || null })}>
                {(!budgetedIds.has(null) || edit.categoryId === null) && <option value="">{t('budget.globalMonthly')}</option>}
                {data.categories.filter((c) => c.kind === 'expense' && (!budgetedIds.has(c.id) || c.id === edit.categoryId)).map((c) => (
                  <option key={c.id} value={c.id}>{c.parentId ? `↳ ${ctx.categories.get(c.parentId)?.name} · ` : ''}{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('budget.planned')} required hint={t('budget.plannedHint')}>
              <MoneyInput value={edit.amount} onChange={(v) => setEdit({ ...edit, amount: v })} currency={settings.baseCurrency} data-autofocus />
            </Field>
            <Field label={t('budget.applyFollowing')}>
              <Select value={edit.follow} onChange={(e) => setEdit({ ...edit, follow: Number(e.target.value) })}>
                <option value={0}>{t('budget.thisMonthOnly')}</option>
                <option value={2}>{t('budget.plusMonths', { count: 2 })}</option>
                <option value={5}>{t('budget.plusMonths', { count: 5 })}</option>
                <option value={11}>{t('budget.plusYear')}</option>
              </Select>
            </Field>
            <Field label={t('budget.thresholds')} hint={t('budget.thresholdsHint', { values: settings.budgetAlertThresholds.join(', ') })}>
              <Input value={edit.thresholds} onChange={(e) => setEdit({ ...edit, thresholds: e.target.value })} placeholder="50, 75, 90, 100" inputMode="numeric" />
            </Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}
