import { useMemo, useState } from 'react';
import { CalendarClock, Check, CircleCheckBig, CircleSlash, Link2, ListPlus, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, CategoryIcon, EmptyState } from '@/components/ui/Misc';
import { Dialog, useConfirm } from '@/components/ui/Dialog';
import { Field, Input, MoneyInput, Segmented, Select, Switch, Textarea } from '@/components/ui/Field';
import { InfoTip } from '@/components/ui/Tooltip';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { ValidationError } from '@/data/repository';
import type { CustomUnit, Frequency, RecurringRule } from '@/domain/types';
import { FREQUENCY_LABELS } from '@/domain/types';
import type { OccurrenceView } from '@/domain/calc/recurring';
import { listOccurrences, monthlyEquivalent, nextOccurrence } from '@/domain/calc/recurring';
import { addDays, formatLongDate } from '@/domain/dates';
import { cn } from '@/lib/cn';
import { LinkOccurrenceDialog } from '@/features/recurring/LinkOccurrenceDialog';
import { occurrenceBadge } from '@/features/recurring/status';
import { t, td } from '@/i18n/core';

type Form = Omit<RecurringRule, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { id?: string };

export default function Recurring() {
  const { data, ctx, fmt, today, repo, settings, uiLocale } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [pay, setPay] = useState<{ o: OccurrenceView; date: string; amount: number | null; accountId: string } | null>(null);
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming');
  const [linking, setLinking] = useState<OccurrenceView | null>(null);

  const window = view === 'upcoming' ? { start: addDays(today, -30), end: addDays(today, 60) } : { start: addDays(today, -180), end: today };
  const occ = useMemo(() => {
    const list = listOccurrences(data.recurringRules, data.occurrences, data.transactions, window, today, { convert: ctx.convert });
    return view === 'upcoming' ? list.filter((o) => o.dueDate >= today || o.status === 'overdue' || o.status === 'partial') : list.reverse();
  }, [data, ctx, today, view]);

  const monthlyOut = data.recurringRules.filter((r) => r.active && r.kind === 'expense').reduce((a, r) => a + (ctx.convert(monthlyEquivalent(r), r.currency, today) ?? 0), 0);
  const monthlyIn = data.recurringRules.filter((r) => r.active && r.kind === 'income').reduce((a, r) => a + (ctx.convert(monthlyEquivalent(r), r.currency, today) ?? 0), 0);

  const newForm = (): Form => ({ kind: 'expense', label: '', amount: 0, currency: settings.baseCurrency, accountId: data.accounts.find((a) => !a.archived)?.id ?? '', categoryId: null, subcategoryId: null, payee: '', frequency: 'monthly', customInterval: 1, customUnit: 'month', startDate: today, endDate: undefined, active: true, notes: '' });

  async function save() {
    if (!form) return;
    try {
      await repo.saveRecurringRule({ ...form, endDate: form.endDate || undefined });
      toast.success(t('rec.saved'));
      setForm(null);
    } catch (e) {
      if (e instanceof ValidationError) setErrors(e.fields);
      toast.error(errorMessage(e));
    }
  }

  async function confirmPay() {
    if (!pay || !pay.amount) return;
    try {
      await repo.markOccurrencePaid(pay.o.rule.id, pay.o.dueDate, { date: pay.date, amount: pay.amount, accountId: pay.accountId });
      toast.success(t('rec.paid'));
      setPay(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function reset(o: OccurrenceView) {
    const st = data.occurrences.find((s) => s.id === o.id);
    let deleteTx = false;
    if (st?.transactionId) {
      deleteTx = await confirm({ title: t('rec.reset.title'), message: t('rec.reset.message'), confirmLabel: t('rec.reset.confirm') });
    }
    await repo.resetOccurrence(o.rule.id, o.dueDate, deleteTx);
    toast.info(t('rec.resetDone'));
  }

  async function removeRule(r: Form) {
    if (!r.id) return;
    if (!(await confirm({ title: t('rec.delete.title', { label: r.label }), message: t('rec.delete.message'), confirmLabel: t('common.delete') }))) return;
    await repo.deleteRecurringRule(r.id);
    toast.success(t('rec.deleted'));
    setForm(null);
  }

  const catsFor = (kind: 'expense' | 'income') => data.categories.filter((c) => c.kind === kind && !c.parentId && !c.archived);

  return (
    <div>
      <PageHeader
        eyebrow={t('navGroup.gestion')}
        title={t('rec.title')}
        description={t('rec.description')}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErrors({}); setForm(newForm()); }} disabled={!data.accounts.length}>{t('rec.new')}</Button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="!p-4"><div className="label flex items-center gap-1">{t('rec.chargesMonth')} <InfoTip>{t('rec.chargesMonthInfo')}</InfoTip></div><div className="display mt-1 text-xl font-semibold num">{fmt.money(monthlyOut)}</div></Card>
        <Card className="!p-4"><div className="label">{t('rec.incomeMonth')}</div><div className="display mt-1 text-xl font-semibold num text-positive">{fmt.money(monthlyIn)}</div></Card>
        <Card className="!p-4"><div className="label">{t('rec.overdue')}</div><div className="display mt-1 text-xl font-semibold num">{listOccurrences(data.recurringRules, data.occurrences, data.transactions, { start: addDays(today, -30), end: today }, today).filter((o) => o.status === 'overdue').length}</div></Card>
        <Card className="!p-4"><div className="label">{t('rec.activeRules')}</div><div className="display mt-1 text-xl font-semibold num">{data.recurringRules.filter((r) => r.active).length}</div></Card>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        <Card className="xl:col-span-3" title={t('rec.schedule')} actions={<Segmented size="sm" value={view} onChange={setView} options={[{ value: 'upcoming', label: t('rec.view.upcoming') }, { value: 'past', label: t('rec.view.past') }]} />}>
          {occ.length === 0 ? (
            <EmptyState icon={<CalendarClock className="h-5 w-5" />} title={t('rec.noOccurrence')} description={t('rec.noOccurrenceHint')} />
          ) : (
            <ul className="divide-y divide-line/5">
              {occ.map((o) => {
                const cat = o.rule.categoryId ? ctx.categories.get(o.rule.categoryId) : undefined;
                const st = occurrenceBadge(o);
                const early = o.paidDate && o.paidDate < o.dueDate && (o.status === 'paid' || o.status === 'partial');
                return (
                  <li key={o.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <CategoryIcon icon={cat?.icon ?? 'Repeat'} color={cat?.color} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{o.rule.label}</div>
                      <div className="text-xs text-muted">{formatLongDate(o.dueDate, uiLocale)} · {ctx.accounts.get(o.rule.accountId)?.name}</div>
                      {o.status === 'partial' && <div className="num text-xs text-warning">{t('rec.partialInfo', { paid: fmt.money(o.paid, o.rule.currency), expected: fmt.money(o.expected, o.rule.currency), remaining: fmt.money(o.remaining, o.rule.currency) })}</div>}
                      {o.settled && <div className="num text-xs text-muted">{t('rec.settledInfo', { amount: fmt.money(o.expected - o.paid, o.rule.currency) })}</div>}
                      {early && <div className="text-xs text-muted">{t('rec.paidEarly', { date: fmt.date(o.paidDate!) })}</div>}
                    </div>
                    <div className="text-end">
                      <div className={cn('num text-sm font-semibold', o.rule.kind === 'income' && 'text-positive')}>{fmt.money(o.rule.kind === 'income' ? o.rule.amount : -o.rule.amount, o.rule.currency, { sign: true })}</div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <div className="flex w-full flex-wrap justify-end gap-1 sm:w-auto">
                      {(o.status === 'upcoming' || o.status === 'overdue' || o.status === 'partial') && (
                        <Button size="sm" variant="outline" icon={<Check className="h-3.5 w-3.5" />} onClick={() => setPay({ o, date: o.dueDate <= today ? today : o.dueDate, amount: o.remaining, accountId: o.rule.accountId })}>{t('rec.markPaid')}</Button>
                      )}
                      {o.status === 'matched' && o.transactionId && (
                        <Button size="sm" variant="outline" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => repo.linkOccurrence(o.rule.id, o.dueDate, o.transactionId!).then(() => toast.success(t('rec.linked')), (e) => toast.error(errorMessage(e)))}>{t('rec.link')}</Button>
                      )}
                      {o.status !== 'skipped' && (
                        <Button size="sm" variant="ghost" icon={<ListPlus className="h-3.5 w-3.5" />} onClick={() => setLinking(o)}>{t('rec.linkExisting')}</Button>
                      )}
                      {o.status === 'partial' && (
                        <Button size="sm" variant="ghost" icon={<CircleCheckBig className="h-3.5 w-3.5" />} onClick={() => repo.settleOccurrence(o.rule.id, o.dueDate).then(() => toast.info(t('rec.settledDone')), (e) => toast.error(errorMessage(e)))}>{t('rec.settle')}</Button>
                      )}
                      {(o.status === 'upcoming' || o.status === 'overdue') && (
                        <Button size="sm" variant="ghost" icon={<CircleSlash className="h-3.5 w-3.5" />} onClick={() => repo.skipOccurrence(o.rule.id, o.dueDate).then(() => toast.info(t('rec.skipped')))}>{t('rec.skip')}</Button>
                      )}
                      {(o.status === 'paid' || o.status === 'partial' || o.status === 'skipped') && (
                        <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => reset(o)}>{t('common.cancel')}</Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="xl:col-span-2" title={t('rec.rules')}>
          {data.recurringRules.length === 0 ? (
            <EmptyState title={t('rec.noRule')} />
          ) : (
            <ul className="space-y-1">
              {data.recurringRules.map((r) => {
                const cat = r.categoryId ? ctx.categories.get(r.categoryId) : undefined;
                const next = nextOccurrence(r, today);
                return (
                  <li key={r.id} className={cn('flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2/60', !r.active && 'opacity-50')}>
                    <CategoryIcon icon={cat?.icon ?? 'Repeat'} color={cat?.color} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{r.label}</div>
                      <div className="text-[11px] text-muted">
                        {FREQUENCY_LABELS[r.frequency]}{r.frequency === 'custom' ? t('rec.every', { count: r.customInterval ?? 1, unit: td(`rec.unitShort.${r.customUnit ?? 'day'}`) }) : ''} · {r.active ? (next ? t('rec.next', { date: fmt.date(next) }) : t('rec.ended')) : t('rec.disabled')}
                      </div>
                    </div>
                    <div className={cn('num text-sm font-semibold', r.kind === 'income' && 'text-positive')}>{fmt.money(r.amount, r.currency)}</div>
                    <Button size="icon-sm" variant="ghost" aria-label={t('rec.editName', { label: r.label })} onClick={() => { setErrors({}); setForm({ ...r }); }}><Pencil className="h-3.5 w-3.5" /></Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <LinkOccurrenceDialog occurrence={linking} onClose={() => setLinking(null)} />

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)} title={form?.id ? t('rec.edit') : t('rec.new')} size="lg"
        footer={<>
          {form?.id && <Button variant="danger" className="me-auto" icon={<Trash2 className="h-4 w-4" />} onClick={() => removeRule(form)}>{t('common.delete')}</Button>}
          <Button variant="ghost" onClick={() => setForm(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save}>{t('common.save')}</Button>
        </>}>
        {form && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('common.type')} className="sm:col-span-2"><Segmented value={form.kind} onChange={(v) => setForm({ ...form, kind: v, categoryId: null, subcategoryId: null })} options={[{ value: 'expense', label: t('rec.kind.expense') }, { value: 'income', label: t('rec.kind.income') }]} className="w-full" /></Field>
            <Field label={t('common.label')} required error={errors.label}><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={t('rec.labelPlaceholder')} data-autofocus /></Field>
            <Field label={t('common.amount')} required error={errors.amount}><MoneyInput value={form.amount || null} onChange={(v) => setForm({ ...form, amount: v ?? 0 })} currency={ctx.accounts.get(form.accountId)?.currency ?? settings.baseCurrency} /></Field>
            <Field label={t('common.account')} error={errors.accountId}>
              <Select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>{data.accounts.filter((a) => !a.archived || a.id === form.accountId).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</Select>
            </Field>
            <Field label={t('common.category')}>
              <Select value={form.categoryId ?? ''} onChange={(e) => setForm({ ...form, categoryId: e.target.value || null, subcategoryId: null })}>
                <option value="">—</option>
                {catsFor(form.kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label={t('rec.frequency')}>
              <Select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}>{Object.entries(FREQUENCY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            </Field>
            {form.frequency === 'custom' ? (
              <Field label={t('rec.everyLabel')} error={errors.customInterval}>
                <div className="flex gap-2">
                  <Input type="number" min={1} value={form.customInterval ?? 1} onChange={(e) => setForm({ ...form, customInterval: Number(e.target.value) })} className="w-24" />
                  <Select value={form.customUnit} onChange={(e) => setForm({ ...form, customUnit: e.target.value as CustomUnit })}><option value="day">{t('rec.unit.day')}</option><option value="week">{t('rec.unit.week')}</option><option value="month">{t('rec.unit.month')}</option><option value="year">{t('rec.unit.year')}</option></Select>
                </div>
              </Field>
            ) : <div className="hidden sm:block" />}
            <Field label={t('rec.firstDate')} error={errors.startDate} hint={t('rec.firstDateHint')}><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label={t('rec.endDate')} error={errors.endDate}><Input type="date" value={form.endDate ?? ''} onChange={(e) => setForm({ ...form, endDate: e.target.value || undefined })} /></Field>
            <Field label={t('rec.payee')}><Input value={form.payee ?? ''} onChange={(e) => setForm({ ...form, payee: e.target.value })} /></Field>
            <div className="flex items-end"><Switch checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label={t('rec.active')} /></div>
            <Field label={t('common.notes')} className="sm:col-span-2"><Textarea value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="min-h-[60px]" /></Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!pay} onOpenChange={(o) => !o && setPay(null)} title={t('rec.confirm.title')} description={pay ? t('rec.confirm.subtitle', { label: pay.o.rule.label, date: fmt.date(pay.o.dueDate) }) : ''} size="sm"
        footer={<><Button variant="ghost" onClick={() => setPay(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={confirmPay} disabled={!pay?.amount}>{t('rec.confirm.create')}</Button></>}>
        {pay && (
          <div className="space-y-4">
            <p className="text-xs text-muted">{t('rec.confirm.hint')}</p>
            <Field label={t('rec.amountPaid')}><MoneyInput value={pay.amount} onChange={(v) => setPay({ ...pay, amount: v })} currency={pay.o.rule.currency} data-autofocus /></Field>
            <Field label={t('rec.paymentDate')}><Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
            <Field label={t('common.account')}><Select value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })}>{data.accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}
