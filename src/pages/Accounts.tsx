import { useMemo, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { Archive, ArchiveRestore, ArrowLeftRight, Download, Pencil, Plus, Trash2, Wallet, History } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState } from '@/components/ui/Misc';
import { Dialog, useConfirm } from '@/components/ui/Dialog';
import { Field, Input, MoneyInput, Select, Switch, Textarea } from '@/components/ui/Field';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { ChartTooltip, useChart } from '@/components/charts/ChartKit';
import { useBalances } from '@/features/hooks';
import { useTransactionForm } from '@/features/transactions/TransactionForm';
import { TransactionRow } from '@/features/transactions/TransactionRow';
import { accountsCSV, download } from '@/features/export';
import { ValidationError } from '@/data/repository';
import { CURRENCIES, fromMajor, toMajor } from '@/domain/money';
import type { Account, AccountType } from '@/domain/types';
import { ACCOUNT_TYPE_LABELS } from '@/domain/types';
import { accountsInScope, dailyBalanceSeries, totalBalance } from '@/domain/calc/ledger';
import { addDays } from '@/domain/dates';
import { COLOR_SWATCHES } from '@/lib/icons';
import { cn } from '@/lib/cn';
import { getLang, t as tr } from '@/i18n/core';
import { currencyName } from '@/i18n/labels';

type Form = Omit<Account, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { id?: string };

export default function Accounts() {
  const { data, ctx, fmt, today, repo, settings } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const openForm = useTransactionForm();
  const balances = useBalances();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [detail, setDetail] = useState<Account | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const active = data.accounts.filter((a) => !a.archived);
  const archived = data.accounts.filter((a) => a.archived);
  const total = useMemo(() => totalBalance(ctx, accountsInScope(data.accounts), data.transactions, today), [ctx, data, today]);
  const txCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of data.transactions) m.set(t.accountId, (m.get(t.accountId) ?? 0) + 1);
    return m;
  }, [data.transactions]);

  const newForm = (): Form => ({ name: '', type: 'bank', currency: settings.baseCurrency, initialBalance: 0, initialBalanceDate: today, archived: false, includeInTotal: true, color: COLOR_SWATCHES[data.accounts.length % COLOR_SWATCHES.length], description: '', order: data.accounts.length });

  async function save() {
    if (!form) return;
    try {
      if (form.id) await repo.updateAccount(form.id, form);
      else await repo.createAccount(form);
      toast.success(form.id ? tr('acc.edited') : tr('acc.created'));
      setForm(null);
    } catch (e) {
      if (e instanceof ValidationError) setErrors(e.fields);
      toast.error(errorMessage(e));
    }
  }

  async function archive(a: Account, value: boolean) {
    if (value && !(await confirm({ title: tr('acc.archive.title', { name: a.name }), message: tr('acc.archive.message'), confirmLabel: tr('common.archive'), danger: false }))) return;
    await repo.archiveAccount(a.id, value);
    toast.success(value ? tr('acc.archived') : tr('acc.reactivated'));
  }

  async function remove(a: Account) {
    if (!(await confirm({ title: tr('acc.delete.title', { name: a.name }), message: tr('acc.delete.message'), confirmLabel: tr('common.delete') }))) return;
    try {
      await repo.deleteAccount(a.id);
      toast.success(tr('acc.deleted'));
      setForm(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const card = (a: Account, i: number) => {
    const bal = balances.get(a.id) ?? 0;
    return (
      <div key={a.id} className="card group relative overflow-hidden p-4 animate-fade-up sm:p-5" style={{ animationDelay: `${i * 40}ms` }}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${a.color}, transparent)` }} />
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.color }} />
              <span className="truncate font-semibold">{a.name}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge>{ACCOUNT_TYPE_LABELS[a.type]}</Badge>
              <Badge tone="cyan">{a.currency}</Badge>
              {!a.includeInTotal && <Badge tone="warning">{tr('acc.outOfTotal')}</Badge>}
              {a.archived && <Badge>{tr('acc.archivedBadge')}</Badge>}
            </div>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={tr('acc.editName', { name: a.name })} onClick={() => { setErrors({}); setForm({ ...a }); }}><Pencil className="h-3.5 w-3.5" /></Button>
        </div>
        <div className={cn('mt-4 display text-2xl font-semibold num', bal < 0 && 'text-negative')}>{fmt.money(bal, a.currency)}</div>
        <div className="mt-0.5 text-xs text-muted">{tr('acc.stats', { ops: tr('acc.ops', { count: txCount.get(a.id) ?? 0 }), amount: fmt.money(a.initialBalance, a.currency), date: fmt.date(a.initialBalanceDate) })}</div>
        {a.description && <p className="mt-2 line-clamp-2 text-xs text-muted">{a.description}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" icon={<History className="h-3.5 w-3.5" />} onClick={() => setDetail(a)}>{tr('acc.history')}</Button>
          {!a.archived && <Button size="sm" variant="outline" icon={<ArrowLeftRight className="h-3.5 w-3.5" />} onClick={() => openForm({ mode: 'create', type: 'transfer', preset: { accountId: a.id } })}>{tr('acc.transfer')}</Button>}
          <Button size="sm" variant="ghost" icon={a.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />} onClick={() => archive(a, !a.archived)}>{a.archived ? tr('common.reactivate') : tr('common.archive')}</Button>
        </div>
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow={tr('navGroup.gestion')}
        title={tr('nav.accounts')}
        description={tr('acc.description')}
        actions={
          <>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download('nexora-comptes.csv', accountsCSV(data, today))} disabled={!data.accounts.length}>{tr('common.csv')}</Button>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErrors({}); setForm(newForm()); }}>{tr('acc.new')}</Button>
          </>
        }
      />

      <Card className="mb-5" padded>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="label">{tr('acc.totalScope')}</div>
            <div className="display mt-1 text-3xl font-semibold num">{fmt.money(total.total)}</div>
            {Object.keys(total.unconverted).length > 0 && <p className="mt-1 text-xs text-warning">{tr('acc.unconverted', { amounts: Object.entries(total.unconverted).map(([c, v]) => fmt.money(v, c)).join(' · ') })}</p>}
          </div>
          <div className="flex flex-wrap gap-4">
            {Object.entries(total.byCurrency).map(([c, v]) => (
              <div key={c}>
                <div className="label">{tr('acc.totalCurrency', { currency: c })}</div>
                <div className="num font-semibold">{fmt.money(v, c)}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {active.length === 0 ? (
        <EmptyState icon={<Wallet className="h-5 w-5" />} title={tr('acc.noneActive')} description={tr('acc.noneActiveHint')} action={<Button variant="primary" onClick={() => setForm(newForm())}>{tr('acc.create')}</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{active.map(card)}</div>
      )}

      {archived.length > 0 && (
        <div className="mt-6">
          <Button variant="ghost" size="sm" onClick={() => setShowArchived((v) => !v)}>{tr(showArchived ? 'acc.hideArchived' : 'acc.showArchived', { count: archived.length })}</Button>
          {showArchived && <div className="mt-3 grid gap-4 opacity-80 sm:grid-cols-2 xl:grid-cols-3">{archived.map(card)}</div>}
        </div>
      )}

      <Dialog
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={form?.id ? tr('acc.edit') : tr('acc.new')}
        footer={
          <>
            {form?.id && !txCount.get(form.id) && <Button variant="danger" className="me-auto" icon={<Trash2 className="h-4 w-4" />} onClick={() => remove(form as Account)}>{tr('common.delete')}</Button>}
            <Button variant="ghost" onClick={() => setForm(null)}>{tr('common.cancel')}</Button>
            <Button variant="primary" onClick={save}>{tr('common.save')}</Button>
          </>
        }
      >
        {form && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr('common.name')} error={errors.name} required className="sm:col-span-2">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('acc.namePlaceholder')} data-autofocus invalid={!!errors.name} />
            </Field>
            <Field label={tr('common.type')}>
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AccountType })}>
                {Object.entries(ACCOUNT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label={tr('common.currency')} error={errors.currency} hint={form.id && txCount.get(form.id) ? tr('acc.currencyLocked') : undefined}>
              <Select value={form.currency} disabled={!!form.id && !!txCount.get(form.id)} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {currencyName(c.code, getLang())}</option>)}
              </Select>
            </Field>
            <Field label={tr('acc.initialBalance')} error={errors.initialBalance} hint={tr('acc.initialBalanceHint')}>
              <MoneyInput value={form.initialBalance} onChange={(v) => setForm({ ...form, initialBalance: v ?? 0 })} currency={form.currency} allowNegative />
            </Field>
            <Field label={tr('acc.initialDate')} error={errors.initialBalanceDate} hint={tr('acc.initialDateHint')}>
              <Input type="date" value={form.initialBalanceDate} onChange={(e) => setForm({ ...form, initialBalanceDate: e.target.value })} />
            </Field>
            <Field label={tr('common.color')} className="sm:col-span-2">
              <div className="flex flex-wrap gap-2">
                {COLOR_SWATCHES.map((c) => (
                  <button key={c} type="button" aria-label={tr('common.colorValue', { value: c })} aria-pressed={form.color === c} onClick={() => setForm({ ...form, color: c })} className={cn('h-7 w-7 rounded-full ring-offset-2 ring-offset-surface transition', form.color === c && 'ring-2 ring-fg')} style={{ background: c }} />
                ))}
              </div>
            </Field>
            <Field label={tr('acc.descriptionField')} className="sm:col-span-2">
              <Textarea value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} className="min-h-[64px]" />
            </Field>
            <div className="sm:col-span-2">
              <Switch checked={form.includeInTotal} onChange={(v) => setForm({ ...form, includeInTotal: v })} label={tr('acc.includeInTotal')} description={tr('acc.includeInTotalHint')} />
            </div>
          </div>
        )}
      </Dialog>

      {detail && <AccountHistory account={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function AccountHistory({ account, onClose }: { account: Account; onClose: () => void }) {
  const { data, ctx, fmt, today } = useApp();
  const chart = useChart();
  const openForm = useTransactionForm();
  const [limit, setLimit] = useState(40);
  const txs = data.transactions.filter((t) => t.accountId === account.id);
  const series = useMemo(() => {
    const start = addDays(today, -89);
    const ctxNative = { ...ctx, convert: (m: number) => m };
    return dailyBalanceSeries(ctxNative, [account], data.transactions, { start: start < account.initialBalanceDate ? account.initialBalanceDate : start, end: today }).map((d) => ({ date: fmt.date(d.date), v: toMajor(d.balance, account.currency) }));
  }, [account, data.transactions, ctx, today, fmt, chart]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={account.name} description={`${ACCOUNT_TYPE_LABELS[account.type]} · ${account.currency}`} size="lg">
      <div className="mb-4 h-40">
        {series.length > 1 && (
          <ResponsiveContainer>
            <AreaChart data={series}>
              <defs><linearGradient id="g-acc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={account.color} stopOpacity={0.35} /><stop offset="1" stopColor={account.color} stopOpacity={0} /></linearGradient></defs>
              <XAxis dataKey="date" {...chart.axis} minTickGap={40} />
              <YAxis {...chart.axis} tickFormatter={chart.axisMoney} width={chart.yWidth(44)} domain={['auto', 'auto']} />
              <RTooltip content={<ChartTooltip valueFormatter={(v) => fmt.money(fromMajor(v, account.currency), account.currency)} />} />
              <Area dataKey="v" name={tr('common.balance')} stroke={account.color} fill="url(#g-acc)" strokeWidth={2} isAnimationActive={chart.animate} animationDuration={chart.duration} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="label mb-1">{tr('acc.movements', { count: txs.length })}</div>
      {txs.length === 0 ? <p className="py-6 text-center text-sm text-muted">{tr('acc.noMovement')}</p> : (
        <div className="-mx-2 divide-y divide-line/5">
          {txs.slice(0, limit).map((t) => <TransactionRow key={t.id} t={t} showAccount={false} onOpen={() => { onClose(); openForm({ mode: 'edit', id: t.id }); }} />)}
        </div>
      )}
      {limit < txs.length && <div className="mt-2 flex justify-center"><Button variant="outline" size="sm" onClick={() => setLimit((l) => l + 40)}>{tr('common.loadMore')}</Button></div>}
    </Dialog>
  );
}
