import { useMemo, useState } from 'react';
import { CalendarDays, Coins, Link2, Pencil, Plus, Target, Trash2 } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, CategoryIcon, EmptyState, ProgressBar, ProgressRing } from '@/components/ui/Misc';
import { Dialog, useConfirm } from '@/components/ui/Dialog';
import { Field, Input, MoneyInput, Segmented, Select, Switch, Textarea } from '@/components/ui/Field';
import { InfoTip } from '@/components/ui/Tooltip';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { useBalances } from '@/features/hooks';
import { ValidationError } from '@/data/repository';
import type { GoalPriority, GoalStatus, SavingsGoal } from '@/domain/types';
import { computeGoalProgress, GOAL_STATE_LABELS, type GoalState } from '@/domain/calc/goals';
import { COLOR_SWATCHES, ICON_NAMES } from '@/lib/icons';
import { cn } from '@/lib/cn';
import { t } from '@/i18n/core';
import { lazyLabels } from '@/i18n/labels';

type Form = Omit<SavingsGoal, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { id?: string };

const STATE_TONE: Record<GoalState, 'positive' | 'warning' | 'negative' | 'cyan' | 'neutral'> = {
  achieved: 'positive',
  on_track: 'cyan',
  behind: 'warning',
  overdue: 'negative',
  no_deadline: 'neutral',
  no_plan: 'neutral',
};

const PRIORITY: Record<GoalPriority, string> = lazyLabels('goal.priority', ['high', 'medium', 'low']);

export default function Goals() {
  const { data, fmt, today, repo, settings, ctx } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const balances = useBalances();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [contrib, setContrib] = useState<{ goal: SavingsGoal; amount: number | null; date: string; note: string; withdraw: boolean } | null>(null);
  const [filter, setFilter] = useState<'active' | 'all'>('active');

  const goals = data.goals.filter((g) => (filter === 'active' ? g.status === 'active' || g.status === 'paused' : true));
  const progress = useMemo(() => new Map(data.goals.map((g) => [g.id, computeGoalProgress(g, today, g.linkedAccountId ? balances.get(g.linkedAccountId) : undefined)])), [data.goals, today, balances]);
  const totals = useMemo(() => {
    let target = 0, saved = 0, monthly = 0;
    for (const g of data.goals.filter((x) => x.status === 'active')) {
      target += g.targetAmount;
      saved += Math.min(progress.get(g.id)!.saved, g.targetAmount);
      monthly += g.monthlyContribution ?? 0;
    }
    return { target, saved, monthly };
  }, [data.goals, progress]);

  const newForm = (): Form => ({ name: '', description: '', targetAmount: 0, currency: settings.baseCurrency, savedAmount: 0, targetDate: undefined, priority: 'medium', linkedAccountId: undefined, trackLinkedAccount: false, monthlyContribution: undefined, status: 'active', icon: 'Target', color: COLOR_SWATCHES[data.goals.length % COLOR_SWATCHES.length] });

  async function save() {
    if (!form) return;
    try {
      await repo.saveGoal({ ...form, linkedAccountId: form.linkedAccountId || undefined, trackLinkedAccount: !!form.linkedAccountId && form.trackLinkedAccount });
      toast.success(t('goal.saved'));
      setForm(null);
    } catch (e) {
      if (e instanceof ValidationError) setErrors(e.fields);
      toast.error(errorMessage(e));
    }
  }

  async function saveContribution() {
    if (!contrib || !contrib.amount) return;
    try {
      await repo.addGoalContribution(contrib.goal.id, contrib.withdraw ? -contrib.amount : contrib.amount, contrib.date, contrib.note || undefined);
      toast.success(contrib.withdraw ? t('goal.withdrawn') : t('goal.contributed'));
      setContrib(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(g: SavingsGoal) {
    if (!(await confirm({ title: t('goal.delete.title', { name: g.name }), message: t('goal.delete.message'), confirmLabel: t('common.delete') }))) return;
    await repo.deleteGoal(g.id);
    toast.success(t('goal.deleted'));
    setForm(null);
  }

  return (
    <div>
      <PageHeader
        eyebrow={t('navGroup.gestion')}
        title={t('goal.title')}
        description={t('goal.description')}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErrors({}); setForm(newForm()); }}>{t('goal.new')}</Button>}
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card padded className="!p-4"><div className="label">{t('goal.savedActive')}</div><div className="display mt-1 text-2xl font-semibold num">{fmt.money(totals.saved)}</div><ProgressBar className="mt-2" value={totals.target ? totals.saved / totals.target : 0} tone="cyan" /></Card>
        <Card padded className="!p-4"><div className="label">{t('goal.totalTargets')}</div><div className="display mt-1 text-2xl font-semibold num">{fmt.money(totals.target)}</div><div className="mt-1 text-xs text-muted">{t('goal.remainingAmount', { amount: fmt.money(Math.max(0, totals.target - totals.saved)) })}</div></Card>
        <Card padded className="!p-4"><div className="label flex items-center gap-1">{t('goal.plannedContributions')} <InfoTip>{t('goal.plannedContributionsInfo')}</InfoTip></div><div className="display mt-1 text-2xl font-semibold num">{fmt.money(totals.monthly)}<span className="text-sm font-normal text-muted">{t('goal.perMonth')}</span></div></Card>
      </div>

      <div className="mb-4"><Segmented value={filter} onChange={setFilter} options={[{ value: 'active', label: t('goal.filter.active') }, { value: 'all', label: t('goal.filter.all') }]} /></div>

      {goals.length === 0 ? (
        <EmptyState icon={<Target className="h-5 w-5" />} title={t('goal.empty')} description={t('goal.emptyHint')} action={<Button variant="primary" onClick={() => setForm(newForm())}>{t('dash.createGoal')}</Button>} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {goals.map((g, i) => {
            const p = progress.get(g.id)!;
            const linked = g.linkedAccountId ? ctx.accounts.get(g.linkedAccountId) : undefined;
            return (
              <div key={g.id} className="card flex flex-col p-5 animate-fade-up" style={{ animationDelay: `${i * 40}ms` }}>
                <div className="flex items-start gap-4">
                  <ProgressRing value={p.progressCapped} size={84} stroke={7} color={g.color}>
                    <div className="text-center">
                      <div className="text-sm font-semibold num">{p.progress == null ? '—' : `${Math.round(p.progressCapped * 100)}%`}</div>
                      {p.progress != null && p.progress > 1 && <div className="text-[9px] text-positive num">{t('goal.realPct', { pct: Math.round(p.progress * 100) })}</div>}
                    </div>
                  </ProgressRing>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <CategoryIcon icon={g.icon} color={g.color} size="sm" />
                      <h3 className="truncate font-semibold">{g.name}</h3>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Badge tone={STATE_TONE[p.state]}>{GOAL_STATE_LABELS[p.state]}</Badge>
                      <Badge>{t('goal.priorityBadge', { level: PRIORITY[g.priority] })}</Badge>
                      {g.status === 'paused' && <Badge tone="warning">{t('goal.paused')}</Badge>}
                    </div>
                    <div className="mt-2 text-sm num"><b>{fmt.money(p.saved)}</b> <span className="text-muted">/ {fmt.money(g.targetAmount)}</span></div>
                  </div>
                </div>
                {g.description && <p className="mt-3 text-xs text-muted">{g.description}</p>}
                <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <dt className="text-muted">{t('goal.remaining')}</dt><dd className="text-end num font-medium">{fmt.money(p.remaining)}</dd>
                  <dt className="text-muted">{t('goal.targetDate')}</dt><dd className="text-end">{g.targetDate ? t('goal.monthsLeft', { date: fmt.date(g.targetDate), count: p.monthsLeft ?? 0 }) : '—'}</dd>
                  <dt className="text-muted flex items-center gap-1">{t('goal.requiredMonthly')} <InfoTip>{t('goal.requiredMonthlyInfo')}</InfoTip></dt><dd className="text-end num font-medium">{p.requiredMonthly != null ? fmt.money(p.requiredMonthly) : '—'}</dd>
                  <dt className="text-muted">{t('goal.plannedMonthly')}</dt><dd className="text-end num">{g.monthlyContribution != null ? fmt.money(g.monthlyContribution) : '—'}</dd>
                  {p.contributionGap != null && <><dt className="text-muted">{t('goal.gap')}</dt><dd className={cn('text-end num font-medium', p.contributionGap >= 0 ? 'text-positive' : 'text-warning')}>{fmt.money(p.contributionGap, undefined, { sign: true })}</dd></>}
                  {p.projectedDate && p.state !== 'achieved' && <><dt className="text-muted">{t('goal.estimated')}</dt><dd className="text-end">{fmt.date(p.projectedDate)}</dd></>}
                </dl>
                {linked && (
                  <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
                    <Link2 className="h-3 w-3" /> {t(g.trackLinkedAccount ? 'goal.tracks' : 'goal.linked', { name: linked.name })}
                  </p>
                )}
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  {!g.trackLinkedAccount && g.status !== 'archived' && (
                    <Button size="sm" variant="outline" icon={<Coins className="h-3.5 w-3.5" />} onClick={() => setContrib({ goal: g, amount: g.monthlyContribution ?? null, date: today, note: '', withdraw: false })}>{t('goal.allocate')}</Button>
                  )}
                  <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setErrors({}); setForm({ ...g }); }}>{t('common.edit')}</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={form?.id ? t('goal.edit') : t('goal.new')}
        size="lg"
        footer={<>
          {form?.id && <Button variant="danger" className="me-auto" icon={<Trash2 className="h-4 w-4" />} onClick={() => remove(form as SavingsGoal)}>{t('common.delete')}</Button>}
          <Button variant="ghost" onClick={() => setForm(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save}>{t('common.save')}</Button>
        </>}
      >
        {form && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('common.name')} required error={errors.name} className="sm:col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('goal.namePlaceholder')} data-autofocus /></Field>
            <Field label={t('goal.target')} required error={errors.targetAmount}><MoneyInput value={form.targetAmount || null} onChange={(v) => setForm({ ...form, targetAmount: v ?? 0 })} currency={form.currency} /></Field>
            <Field label={t('goal.alreadySaved')} error={errors.savedAmount} hint={form.trackLinkedAccount ? t('goal.ignoredTracking') : undefined}><MoneyInput value={form.savedAmount} onChange={(v) => setForm({ ...form, savedAmount: v ?? 0 })} currency={form.currency} disabled={form.trackLinkedAccount} /></Field>
            <Field label={t('goal.targetDateOptional')} error={errors.targetDate}><Input type="date" value={form.targetDate ?? ''} onChange={(e) => setForm({ ...form, targetDate: e.target.value || undefined })} /></Field>
            <Field label={t('goal.monthlyWanted')}><MoneyInput value={form.monthlyContribution ?? null} onChange={(v) => setForm({ ...form, monthlyContribution: v ?? undefined })} currency={form.currency} /></Field>
            <Field label={t('goal.priority')}><Segmented value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} options={[{ value: 'high', label: PRIORITY.high }, { value: 'medium', label: PRIORITY.medium }, { value: 'low', label: PRIORITY.low }]} className="w-full" /></Field>
            <Field label={t('common.status')}><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as GoalStatus })}><option value="active">{t('goal.status.active')}</option><option value="paused">{t('goal.status.paused')}</option><option value="achieved">{t('goal.status.achieved')}</option><option value="archived">{t('goal.status.archived')}</option></Select></Field>
            <Field label={t('goal.linkedAccount')} className="sm:col-span-2" hint={t('goal.linkedAccountHint')}>
              <Select value={form.linkedAccountId ?? ''} onChange={(e) => setForm({ ...form, linkedAccountId: e.target.value || undefined, trackLinkedAccount: e.target.value ? form.trackLinkedAccount : false })}>
                <option value="">{t('common.none')}</option>
                {data.accounts.filter((a) => !a.archived && a.currency === form.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>
            {form.linkedAccountId && <div className="sm:col-span-2"><Switch checked={form.trackLinkedAccount} onChange={(v) => setForm({ ...form, trackLinkedAccount: v })} label={t('goal.trackSwitch')} description={t('goal.trackSwitchHint')} /></div>}
            <Field label={t('common.description')} className="sm:col-span-2"><Textarea value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} className="min-h-[60px]" /></Field>
            <Field label={t('common.icon')} className="sm:col-span-2">
              <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {ICON_NAMES.map((n) => <button key={n} type="button" aria-label={n} aria-pressed={form.icon === n} onClick={() => setForm({ ...form, icon: n })} className={cn('rounded-xl', form.icon === n && 'ring-2 ring-cyan')}><CategoryIcon icon={n} color={form.color} size="sm" /></button>)}
              </div>
            </Field>
            <Field label={t('common.color')} className="sm:col-span-2">
              <div className="flex flex-wrap gap-2">{COLOR_SWATCHES.map((c) => <button key={c} type="button" aria-label={c} onClick={() => setForm({ ...form, color: c })} className={cn('h-7 w-7 rounded-full ring-offset-2 ring-offset-surface', form.color === c && 'ring-2 ring-fg')} style={{ background: c }} />)}</div>
            </Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!contrib} onOpenChange={(o) => !o && setContrib(null)} title={contrib ? t('goal.allocation', { name: contrib.goal.name }) : ''} description={t('goal.allocationHint')} size="sm"
        footer={<><Button variant="ghost" onClick={() => setContrib(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={saveContribution} disabled={!contrib?.amount}>{t('common.save')}</Button></>}>
        {contrib && (
          <div className="space-y-4">
            <Segmented value={contrib.withdraw ? 'out' : 'in'} onChange={(v) => setContrib({ ...contrib, withdraw: v === 'out' })} options={[{ value: 'in', label: t('goal.add') }, { value: 'out', label: t('goal.withdraw') }]} className="w-full" />
            <Field label={t('common.amount')} required><MoneyInput value={contrib.amount} onChange={(v) => setContrib({ ...contrib, amount: v })} currency={contrib.goal.currency} data-autofocus /></Field>
            <Field label={t('common.date')}><Input type="date" value={contrib.date} onChange={(e) => setContrib({ ...contrib, date: e.target.value })} /></Field>
            <Field label={t('common.note')}><Input value={contrib.note} onChange={(e) => setContrib({ ...contrib, note: e.target.value })} /></Field>
            <History goalId={contrib.goal.id} />
          </div>
        )}
      </Dialog>
    </div>
  );
}

function History({ goalId }: { goalId: string }) {
  const { data, fmt } = useApp();
  const list = data.goalContributions.filter((c) => c.goalId === goalId).sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) return null;
  return (
    <div>
      <div className="label mb-1.5 flex items-center gap-1"><CalendarDays className="h-3 w-3" /> {t('goal.history')}</div>
      <ul className="max-h-40 divide-y divide-line/5 overflow-y-auto text-xs">
        {list.map((c) => (
          <li key={c.id} className="flex justify-between py-1.5"><span className="text-muted">{fmt.date(c.date)} {c.note ? `· ${c.note}` : ''}</span><span className={cn('num font-medium', c.amount < 0 && 'text-warning')}>{fmt.money(c.amount, undefined, { sign: true })}</span></li>
        ))}
      </ul>
    </div>
  );
}
