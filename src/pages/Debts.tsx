import { useMemo, useState } from 'react';
import { HandCoins, Pencil, Plus, Receipt, Trash2 } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState, ProgressBar } from '@/components/ui/Misc';
import { Dialog, useConfirm } from '@/components/ui/Dialog';
import { Field, Input, MoneyInput, Segmented, Select, Switch, Textarea } from '@/components/ui/Field';
import { InfoTip } from '@/components/ui/Tooltip';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { ValidationError } from '@/data/repository';
import { CURRENCIES } from '@/domain/money';
import type { Debt, DebtType } from '@/domain/types';
import { DEBT_TYPE_DIRECTION, DEBT_TYPE_LABELS } from '@/domain/types';
import { computeDebtStatus } from '@/domain/calc/debts';
import { cn } from '@/lib/cn';
import { t, td } from '@/i18n/core';

type Form = Omit<Debt, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { id?: string; originAccountId?: string; createOrigin: boolean };

export default function Debts() {
  const { data, ctx, fmt, today, repo, settings } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [payment, setPayment] = useState<{ debt: Debt; principal: number | null; interest: number | null; date: string; accountId: string; note: string } | null>(null);
  const [detail, setDetail] = useState<Debt | null>(null);
  const [tab, setTab] = useState<'active' | 'settled'>('active');

  const statuses = useMemo(() => new Map(data.debts.map((d) => [d.id, computeDebtStatus(d, data.debtPayments, today)])), [data.debts, data.debtPayments, today]);
  const list = data.debts.filter((d) => (tab === 'active' ? d.status === 'active' : d.status !== 'active'));
  const totals = useMemo(() => {
    let owe = 0, owed = 0, overdue = 0;
    for (const d of data.debts) {
      if (d.status !== 'active') continue;
      const st = statuses.get(d.id)!;
      const v = ctx.convert(st.remaining, d.currency, today) ?? 0;
      if (d.direction === 'payable') owe += v;
      else owed += v;
      if (st.overdue) overdue++;
    }
    return { owe, owed, overdue };
  }, [data.debts, statuses, ctx, today]);

  const newForm = (): Form => ({ label: '', type: 'loan', direction: 'payable', principal: 0, currency: settings.baseCurrency, startDate: today, dueDate: undefined, counterparty: '', interestRate: undefined, installmentAmount: undefined, installmentFrequency: 'monthly', status: 'active', notes: '', createOrigin: false, originAccountId: data.accounts.find((a) => !a.archived)?.id });

  async function save() {
    if (!form) return;
    try {
      const { createOrigin, originAccountId, id, ...rest } = form;
      const payload = { ...rest, direction: DEBT_TYPE_DIRECTION[form.type], dueDate: form.dueDate || undefined };
      if (id) await repo.updateDebt(id, payload);
      else await repo.createDebt(payload, createOrigin && originAccountId ? { accountId: originAccountId, date: form.startDate } : undefined);
      toast.success(t('debt.saved'));
      setForm(null);
    } catch (e) {
      if (e instanceof ValidationError) setErrors(e.fields);
      toast.error(errorMessage(e));
    }
  }

  async function savePayment() {
    if (!payment) return;
    try {
      await repo.addDebtPayment(payment.debt.id, { date: payment.date, principal: payment.principal ?? 0, interest: payment.interest ?? 0, accountId: payment.accountId || undefined, note: payment.note || undefined });
      toast.success(t('debt.paymentSaved'));
      setPayment(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(d: { id?: string; label: string }) {
    if (!d.id) return;
    if (!(await confirm({ title: t('debt.delete.title', { label: d.label }), message: t('debt.delete.message'), confirmLabel: t('common.delete') }))) return;
    await repo.deleteDebt(d.id);
    toast.success(t('debt.deleted'));
    setForm(null);
  }

  return (
    <div>
      <PageHeader
        eyebrow={t('navGroup.gestion')}
        title={t('nav.debts')}
        description={t('debt.description')}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErrors({}); setForm(newForm()); }}>{t('debt.new')}</Button>}
      />
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="!p-4"><div className="label">{t('debt.iOwe')}</div><div className="display mt-1 text-2xl font-semibold num text-negative">{fmt.money(totals.owe)}</div></Card>
        <Card className="!p-4"><div className="label">{t('debt.owedToMe')}</div><div className="display mt-1 text-2xl font-semibold num text-positive">{fmt.money(totals.owed)}</div></Card>
        <Card className="!p-4"><div className="label">{t('debt.overdueCount')}</div><div className={cn('display mt-1 text-2xl font-semibold num', totals.overdue && 'text-warning')}>{totals.overdue}</div></Card>
      </div>
      <div className="mb-4"><Segmented value={tab} onChange={setTab} options={[{ value: 'active', label: t('debt.tab.active') }, { value: 'settled', label: t('debt.tab.settled') }]} /></div>

      {list.length === 0 ? (
        <EmptyState icon={<HandCoins className="h-5 w-5" />} title={t('debt.empty')} description={t('debt.emptyHint')} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((d, i) => {
            const st = statuses.get(d.id)!;
            const payable = d.direction === 'payable';
            return (
              <div key={d.id} className="card p-5 animate-fade-up" style={{ animationDelay: `${i * 40}ms` }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{d.label}</h3>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge tone={payable ? 'negative' : 'positive'}>{payable ? t('debt.badge.payable') : t('debt.badge.receivable')}</Badge>
                      <Badge>{DEBT_TYPE_LABELS[d.type]}</Badge>
                      {st.overdue && <Badge tone="warning">{t('debt.badge.overdue')}</Badge>}
                      {st.settled && <Badge tone="positive">{t('debt.badge.settled')}</Badge>}
                    </div>
                    {d.counterparty && <div className="mt-1.5 text-xs text-muted">{t('debt.counterpartyValue', { name: d.counterparty })}</div>}
                  </div>
                  <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => { setErrors({}); setForm({ ...d, createOrigin: false }); }}><Pencil className="h-3.5 w-3.5" /></Button>
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <div className="label">{t('debt.remaining')}</div>
                    <div className="display text-2xl font-semibold num">{fmt.money(st.remaining, d.currency)}</div>
                  </div>
                  <div className="text-right text-xs text-muted">{t('debt.ofPrincipal', { amount: fmt.money(d.principal, d.currency) })}<br />{t('debt.repaidPct', { pct: fmt.percent(st.progress, 0) })}</div>
                </div>
                <ProgressBar className="mt-2" value={st.progress ?? 0} tone={payable ? 'violet' : 'positive'} />
                <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
                  <dt className="text-muted">{t('debt.start')}</dt><dd className="text-right">{fmt.date(d.startDate)}</dd>
                  <dt className="text-muted">{t('debt.due')}</dt><dd className={cn('text-right', st.overdue && 'text-warning')}>{d.dueDate ? fmt.date(d.dueDate) : '—'}</dd>
                  {d.interestRate != null && <><dt className="text-muted">{t('debt.annualRate')}</dt><dd className="text-right">{fmt.percent(d.interestRate / 100, 2)}</dd></>}
                  {d.installmentAmount != null && <><dt className="text-muted">{t('debt.plannedInstallment')}</dt><dd className="text-right num">{fmt.money(d.installmentAmount, d.currency)} / {td(`debt.per.${d.installmentFrequency ?? 'monthly'}`)}</dd></>}
                  <dt className="text-muted">{t('debt.paidInterest')}</dt><dd className="text-right num">{fmt.money(st.paidInterest, d.currency)}</dd>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  {!st.settled && <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setPayment({ debt: d, principal: d.installmentAmount ? Math.min(d.installmentAmount, st.remaining) : null, interest: 0, date: today, accountId: data.accounts.find((a) => !a.archived && a.currency === d.currency)?.id ?? '', note: '' })}>{payable ? t('debt.addRepayment') : t('debt.addCollection')}</Button>}
                  <Button size="sm" variant="ghost" icon={<Receipt className="h-3.5 w-3.5" />} onClick={() => setDetail(d)}>{t('debt.historyCount', { count: st.paymentCount })}</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)} title={form?.id ? t('debt.edit') : t('debt.new')} size="lg"
        footer={<>
          {form?.id && <Button variant="danger" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} onClick={() => remove(form)}>{t('common.delete')}</Button>}
          <Button variant="ghost" onClick={() => setForm(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save}>{t('common.save')}</Button>
        </>}>
        {form && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('common.label')} required error={errors.label}><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={t('debt.labelPlaceholder')} data-autofocus /></Field>
            <Field label={t('common.type')}>
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as DebtType })}>
                {Object.entries(DEBT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v} — {DEBT_TYPE_DIRECTION[k as DebtType] === 'payable' ? t('debt.dirPayable') : t('debt.dirReceivable')}</option>)}
              </Select>
            </Field>
            <Field label={t('debt.principal')} required error={errors.principal}><MoneyInput value={form.principal || null} onChange={(v) => setForm({ ...form, principal: v ?? 0 })} currency={form.currency} /></Field>
            <Field label={t('common.currency')}><Select value={form.currency} disabled={!!form.id} onChange={(e) => setForm({ ...form, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select></Field>
            <Field label={t('debt.startDate')} error={errors.startDate}><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label={t('debt.dueDate')}><Input type="date" value={form.dueDate ?? ''} onChange={(e) => setForm({ ...form, dueDate: e.target.value || undefined })} /></Field>
            <Field label={t('debt.counterparty')}><Input value={form.counterparty ?? ''} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} placeholder={t('debt.counterpartyPlaceholder')} /></Field>
            <Field label={t('debt.rate')}><Input inputMode="decimal" value={form.interestRate ?? ''} onChange={(e) => { const v = parseFloat(e.target.value.replace(',', '.')); setForm({ ...form, interestRate: Number.isFinite(v) ? v : undefined }); }} /></Field>
            <Field label={t('debt.installment')}><MoneyInput value={form.installmentAmount ?? null} onChange={(v) => setForm({ ...form, installmentAmount: v ?? undefined })} currency={form.currency} /></Field>
            <Field label={t('debt.installmentFrequency')}><Select value={form.installmentFrequency ?? 'monthly'} onChange={(e) => setForm({ ...form, installmentFrequency: e.target.value as Debt['installmentFrequency'] })}><option value="monthly">{t('debt.freq.monthly')}</option><option value="quarterly">{t('debt.freq.quarterly')}</option><option value="annual">{t('debt.freq.annual')}</option></Select></Field>
            {form.id && <Field label={t('common.status')}><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Debt['status'] })}><option value="active">{t('debt.status.active')}</option><option value="settled">{t('debt.status.settled')}</option><option value="archived">{t('debt.status.archived')}</option></Select></Field>}
            {!form.id && (
              <div className="sm:col-span-2 rounded-xl border border-line/10 bg-surface-2/50 p-3">
                <Switch checked={form.createOrigin} onChange={(v) => setForm({ ...form, createOrigin: v })} label={DEBT_TYPE_DIRECTION[form.type] === 'payable' ? t('debt.origin.payable') : t('debt.origin.receivable')} description={t('debt.originHint')} />
                {form.createOrigin && (
                  <Select className="mt-2" value={form.originAccountId ?? ''} onChange={(e) => setForm({ ...form, originAccountId: e.target.value })}>
                    {data.accounts.filter((a) => !a.archived && a.currency === form.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                )}
              </div>
            )}
            <Field label={t('common.notes')} className="sm:col-span-2"><Textarea value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="min-h-[60px]" /></Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!payment} onOpenChange={(o) => !o && setPayment(null)} title={payment?.debt.direction === 'payable' ? t('debt.repayment') : t('debt.collection')} description={payment?.debt.label} size="sm"
        footer={<><Button variant="ghost" onClick={() => setPayment(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={savePayment}>{t('common.save')}</Button></>}>
        {payment && (
          <div className="space-y-4">
            <Field label={<span className="inline-flex items-center gap-1">{t('debt.principalPart')} <InfoTip>{t('debt.principalPartInfo')}</InfoTip></span>}><MoneyInput value={payment.principal} onChange={(v) => setPayment({ ...payment, principal: v })} currency={payment.debt.currency} data-autofocus /></Field>
            <Field label={<span className="inline-flex items-center gap-1">{t('debt.interestPart')} <InfoTip>{t('debt.interestPartInfo')}</InfoTip></span>}><MoneyInput value={payment.interest} onChange={(v) => setPayment({ ...payment, interest: v })} currency={payment.debt.currency} /></Field>
            <Field label={t('common.date')}><Input type="date" value={payment.date} onChange={(e) => setPayment({ ...payment, date: e.target.value })} /></Field>
            <Field label={t('debt.account')} hint={t('debt.accountHint')}>
              <Select value={payment.accountId} onChange={(e) => setPayment({ ...payment, accountId: e.target.value })}>
                <option value="">{t('debt.noAccount')}</option>
                {data.accounts.filter((a) => !a.archived && a.currency === payment.debt.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>
            <Field label={t('common.note')}><Input value={payment.note} onChange={(e) => setPayment({ ...payment, note: e.target.value })} /></Field>
            <p className="text-xs text-muted">{t('debt.currentRemaining')} <b className="num">{fmt.money(statuses.get(payment.debt.id)!.remaining, payment.debt.currency)}</b></p>
          </div>
        )}
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)} title={t('debt.history', { label: detail?.label ?? '' })} size="md">
        {detail && (() => {
          const pays = data.debtPayments.filter((p) => p.debtId === detail.id).sort((a, b) => b.date.localeCompare(a.date));
          if (!pays.length) return <p className="py-6 text-center text-sm text-muted">{t('debt.noPayment')}</p>;
          return (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted"><th className="py-2">{t('common.date')}</th><th className="text-right">{t('debt.principalCol')}</th><th className="text-right">{t('debt.interestCol')}</th><th className="pl-2">{t('common.account')}</th><th /></tr></thead>
              <tbody className="divide-y divide-line/5">
                {pays.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2">{fmt.date(p.date)}</td>
                    <td className="text-right num">{fmt.money(p.principal, detail.currency)}</td>
                    <td className="text-right num">{fmt.money(p.interest, detail.currency)}</td>
                    <td className="pl-2 text-muted">{p.accountId ? ctx.accounts.get(p.accountId)?.name : p.note ?? '—'}</td>
                    <td className="text-right"><Button size="icon-sm" variant="ghost" aria-label={t('debt.deletePayment')} onClick={async () => { if (await confirm({ title: t('debt.deletePayment.title'), message: t('debt.deletePayment.message'), confirmLabel: t('common.delete') })) { await repo.deleteDebtPayment(p.id); toast.success(t('debt.paymentDeleted')); } }}><Trash2 className="h-3.5 w-3.5" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })()}
      </Dialog>
    </div>
  );
}
