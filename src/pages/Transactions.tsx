import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownUp, Download, FileUp, Filter, Plus, Search, Tags, Trash2, X, Inbox } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { PageHeader, Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, MoneyInput, Select } from '@/components/ui/Field';
import { Badge, EmptyState } from '@/components/ui/Misc';
import { useConfirm, Dialog } from '@/components/ui/Dialog';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { TransactionRow } from '@/features/transactions/TransactionRow';
import { useTransactionForm } from '@/features/transactions/TransactionForm';
import { download, transactionsCSV } from '@/features/export';
import { usePersistentState } from '@/lib/usePersistentState';
import { cn } from '@/lib/cn';
import type { ID, Transaction, TransactionType } from '@/domain/types';
import { TRANSACTION_TYPE_LABELS } from '@/domain/types';
import { summarizePeriod, topCategoryId } from '@/domain/calc/ledger';
import { monthEnd, monthStart, addMonthsToKey, monthKey, formatLongDate } from '@/domain/dates';
import { normalizeLabel } from '@/domain/duplicates';
import { t as tr } from '@/i18n/core';

interface Filters {
  q: string;
  period: 'month' | 'prev' | '3m' | 'year' | 'all' | 'custom';
  from: string;
  to: string;
  categoryId: string;
  accountId: string;
  type: '' | TransactionType;
  min: number | null;
  max: number | null;
  sort: 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
}

const PAGE = 50;

export default function Transactions() {
  const { data, ctx, fmt, today, month, repo, settings, uiLocale } = useApp();
  const openForm = useTransactionForm();
  const confirm = useConfirm();
  const toast = useToast();
  const [f, setF] = usePersistentState<Filters>('tx-filters', { q: '', period: 'month', from: '', to: '', categoryId: '', accountId: '', type: '', min: null, max: null, sort: 'date_desc' });
  const [showFilters, setShowFilters] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  const [recatOpen, setRecatOpen] = useState(false);
  const [recatTarget, setRecatTarget] = useState('');

  const range = useMemo(() => {
    switch (f.period) {
      case 'month':
        return { start: monthStart(month), end: monthEnd(month) };
      case 'prev':
        return { start: monthStart(addMonthsToKey(month, -1)), end: monthEnd(addMonthsToKey(month, -1)) };
      case '3m':
        return { start: monthStart(addMonthsToKey(monthKey(today), -2)), end: today };
      case 'year':
        return { start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31` };
      case 'custom':
        return { start: f.from || '1900-01-01', end: f.to || '2200-12-31' };
      default:
        return { start: '1900-01-01', end: '2200-12-31' };
    }
  }, [f.period, f.from, f.to, month, today]);

  const filtered = useMemo(() => {
    const q = normalizeLabel(f.q);
    const list = data.transactions.filter((t) => {
      if (t.date < range.start || t.date > range.end) return false;
      if (f.accountId && t.accountId !== f.accountId) return false;
      if (f.type && t.type !== f.type) return false;
      if (f.categoryId && t.categoryId !== f.categoryId && t.subcategoryId !== f.categoryId && topCategoryId(ctx, t.categoryId) !== f.categoryId) return false;
      if (f.min != null && t.amount < f.min) return false;
      if (f.max != null && t.amount > f.max) return false;
      if (q) {
        const hay = normalizeLabel(`${t.label} ${t.payee ?? ''} ${t.notes ?? ''} ${t.tags.join(' ')}`);
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sorted = [...list];
    switch (f.sort) {
      case 'date_asc':
        sorted.reverse();
        break;
      case 'amount_desc':
        sorted.sort((a, b) => b.amount - a.amount);
        break;
      case 'amount_asc':
        sorted.sort((a, b) => a.amount - b.amount);
        break;
    }
    return sorted;
  }, [data.transactions, f, range, ctx]);

  const totals = useMemo(() => summarizePeriod(ctx, filtered, range), [ctx, filtered, range]);
  const shown = filtered.slice(0, limit);
  const activeFilters = [f.categoryId, f.accountId, f.type, f.min != null, f.max != null].filter(Boolean).length;
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    setLimit(PAGE);
  };

  // Regroupement par date (tri chronologique uniquement).
  const groups = useMemo(() => {
    if (!f.sort.startsWith('date')) return [{ date: '', items: shown }];
    const out: { date: string; items: Transaction[] }[] = [];
    for (const t of shown) {
      const last = out[out.length - 1];
      if (last && last.date === t.date) last.items.push(t);
      else out.push({ date: t.date, items: [t] });
    }
    return out;
  }, [shown, f.sort]);

  const toggle = (id: ID, v: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (v) n.add(id);
      else n.delete(id);
      return n;
    });

  async function bulkDelete() {
    const ok = await confirm({ title: tr('tx.bulkDelete.title', { count: selected.size }), message: tr('tx.bulkDelete.message'), confirmLabel: tr('common.delete') });
    if (!ok) return;
    try {
      const n = await repo.deleteTransactions([...selected]);
      setSelected(new Set());
      toast.success(tr('tx.bulkDeleted', { count: n }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function bulkRecategorize() {
    if (!recatTarget) return;
    try {
      await repo.recategorize([...selected], recatTarget);
      toast.success(tr('tx.recategorized'));
      setSelected(new Set());
      setRecatOpen(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  function exportCSV() {
    download(`nexora-transactions-${range.start === '1900-01-01' ? tr('tx.exportAll') : range.start + '_' + range.end}.csv`, transactionsCSV(filtered, ctx.categories, ctx.accounts));
    toast.success(tr('tx.exported', { count: filtered.length }));
  }

  const topCats = data.categories.filter((c) => !c.parentId && c.kind !== 'savings');

  return (
    <div>
      <PageHeader
        eyebrow={tr('navGroup.pilotage')}
        title={tr('nav.transactions')}
        description={tr('tx.description')}
        actions={
          <>
            <Link to="/import"><Button variant="outline" icon={<FileUp className="h-4 w-4" />}>{tr('common.import')}</Button></Link>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCSV} disabled={!filtered.length}>{tr('common.exportCsv')}</Button>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => openForm()}>{tr('common.add')}</Button>
          </>
        }
      />

      <Card padded={false} className="mb-4 p-3 sm:p-4">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input value={f.q} onChange={(e) => set('q', e.target.value)} placeholder={tr('tx.search')} className="pl-9" aria-label={tr('common.searchLabel')} />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 lg:flex">
            <Select value={f.period} onChange={(e) => set('period', e.target.value as Filters['period'])} aria-label={tr('common.period')} className="lg:min-w-[150px]">
              <option value="month">{fmt.month(month)}</option>
              <option value="prev">{fmt.month(addMonthsToKey(month, -1))}</option>
              <option value="3m">{tr('tx.last3m')}</option>
              <option value="year">{tr('tx.year', { year: today.slice(0, 4) })}</option>
              <option value="all">{tr('tx.allHistory')}</option>
              <option value="custom">{tr('tx.custom')}</option>
            </Select>
            <Select value={f.sort} onChange={(e) => set('sort', e.target.value as Filters['sort'])} aria-label={tr('common.sort')} className="lg:min-w-[150px]">
              <option value="date_desc">{tr('tx.sort.newest')}</option>
              <option value="date_asc">{tr('tx.sort.oldest')}</option>
              <option value="amount_desc">{tr('tx.sort.amountDesc')}</option>
              <option value="amount_asc">{tr('tx.sort.amountAsc')}</option>
            </Select>
            <Button variant={showFilters || activeFilters ? 'secondary' : 'outline'} icon={<Filter className="h-4 w-4" />} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
              <span className="hidden sm:inline">{tr('common.filters')}</span>
              {activeFilters > 0 && <Badge tone="primary">{activeFilters}</Badge>}
            </Button>
          </div>
        </div>
        {f.period === 'custom' && (
          <div className="mt-2 grid grid-cols-2 gap-2 sm:max-w-md">
            <Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label={tr('common.from')} />
            <Input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label={tr('common.to')} />
          </div>
        )}
        {showFilters && (
          <div className="mt-3 grid grid-cols-2 gap-2 animate-fade-in md:grid-cols-5">
            <Field label={tr('common.category')}>
              <Select value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">{tr('common.allF')}</option>
                {topCats.map((c) => (
                  <optgroup key={c.id} label={c.name}>
                    <option value={c.id}>{tr('tx.allSub', { name: c.name })}</option>
                    {data.categories.filter((s) => s.parentId === c.id).map((s) => <option key={s.id} value={s.id}>↳ {s.name}</option>)}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <Field label={tr('common.account')}>
              <Select value={f.accountId} onChange={(e) => set('accountId', e.target.value)}>
                <option value="">{tr('common.allM')}</option>
                {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.archived ? tr('common.archivedM') : ''}</option>)}
              </Select>
            </Field>
            <Field label={tr('common.type')}>
              <Select value={f.type} onChange={(e) => set('type', e.target.value as Filters['type'])}>
                <option value="">{tr('common.allM')}</option>
                {Object.entries(TRANSACTION_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label={tr('tx.minAmount')}>
              <MoneyInput value={f.min} onChange={(v) => set('min', v)} currency={settings.baseCurrency} />
            </Field>
            <Field label={tr('tx.maxAmount')}>
              <MoneyInput value={f.max} onChange={(v) => set('max', v)} currency={settings.baseCurrency} />
            </Field>
            {activeFilters > 0 && (
              <Button variant="ghost" size="sm" className="col-span-2 justify-self-start md:col-span-5" icon={<X className="h-3.5 w-3.5" />} onClick={() => setF((p) => ({ ...p, categoryId: '', accountId: '', type: '', min: null, max: null }))}>
                {tr('tx.resetFilters')}
              </Button>
            )}
          </div>
        )}
      </Card>

      <div className="mb-3 grid grid-cols-3 gap-2 text-center sm:flex sm:gap-6 sm:text-left">
        <div><div className="label">{tr('tx.operations')}</div><div className="num font-semibold">{filtered.length}</div></div>
        <div><div className="label">{tr('common.income')}</div><div className="num font-semibold text-positive">{fmt.money(totals.income)}</div></div>
        <div><div className="label">{tr('common.expenses')}</div><div className="num font-semibold">{fmt.money(totals.expenses)}</div></div>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-[72px] z-10 mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-surface/95 p-2.5 shadow-lg backdrop-blur animate-fade-in">
          <span className="px-2 text-sm font-medium">{tr('tx.selectedCount', { count: selected.size })}</span>
          <Button size="sm" variant="outline" icon={<Tags className="h-3.5 w-3.5" />} onClick={() => setRecatOpen(true)}>{tr('tx.changeCategory')}</Button>
          <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={bulkDelete}>{tr('common.delete')}</Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>{tr('common.cancel')}</Button>
        </div>
      )}

      <Card padded={false} className="p-2 sm:p-3">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-5 w-5" />}
            title={data.transactions.length ? tr('tx.noMatch') : tr('dash.noTx')}
            description={data.transactions.length ? tr('tx.noMatchHint') : tr('tx.emptyHint')}
            action={<Button variant="primary" onClick={() => openForm()}>{tr('tx.addOperation')}</Button>}
            className="m-2"
          />
        ) : (
          <>
            <div className="flex items-center justify-between px-2 pb-1 pt-1 text-xs text-muted">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[rgb(var(--primary))]"
                  checked={shown.length > 0 && shown.every((t) => selected.has(t.id))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((t) => t.id)) : new Set())}
                />
                {tr('tx.selectAll')}
              </label>
              <span className="flex items-center gap-1"><ArrowDownUp className="h-3 w-3" /> {shown.length} / {filtered.length}</span>
            </div>
            {groups.map((g) => (
              <div key={g.date || 'all'}>
                {g.date && <div className="sticky top-16 z-[5] bg-surface/90 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted backdrop-blur">{formatLongDate(g.date, uiLocale)}</div>}
                <div className="divide-y divide-line/5">
                  {g.items.map((t) => (
                    <TransactionRow key={t.id} t={t} selected={selected.has(t.id)} onSelect={(v) => toggle(t.id, v)} onOpen={() => openForm({ mode: 'edit', id: t.id })} />
                  ))}
                </div>
              </div>
            ))}
            {limit < filtered.length && (
              <div className="flex justify-center p-3">
                <Button variant="outline" onClick={() => setLimit((l) => l + PAGE)}>{tr('tx.loadMore', { count: Math.min(PAGE, filtered.length - limit) })}</Button>
              </div>
            )}
          </>
        )}
      </Card>

      <Dialog open={recatOpen} onOpenChange={setRecatOpen} title={tr('tx.changeCategory')} size="sm" footer={<><Button variant="ghost" onClick={() => setRecatOpen(false)}>{tr('common.cancel')}</Button><Button variant="primary" onClick={bulkRecategorize} disabled={!recatTarget}>{tr('common.apply')}</Button></>}>
        <Field label={tr('tx.newCategory')} hint={tr('tx.recatHint')}>
          <Select value={recatTarget} onChange={(e) => setRecatTarget(e.target.value)}>
            <option value="">{tr('common.choose')}</option>
            {data.categories.filter((c) => !c.archived && c.kind !== 'savings').map((c) => <option key={c.id} value={c.id}>{c.parentId ? '↳ ' : ''}{c.name}</option>)}
          </Select>
        </Field>
      </Dialog>
      <p className={cn('mt-4 text-center text-xs text-muted', !filtered.length && 'hidden')}>{tr('tx.tip.before')} <kbd className="rounded border border-line/30 px-1">N</kbd> {tr('tx.tip.after')}</p>
    </div>
  );
}
