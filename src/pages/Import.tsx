/**
 * Assistant d'import CSV :
 * 1 fichier → 2 aperçu → 3 colonnes → 4 dates → 5 montants → 6 catégories →
 * 7 erreurs (corrigeables) → 8 doublons potentiels → 9 confirmation → 10 rapport.
 * Les étapes 4-5 et 7-8 partagent un écran pour rester rapides.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, FileUp, Upload } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Misc';
import { Field, Input, Segmented, Select } from '@/components/ui/Field';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/cn';
import type { Delimiter, ImportDateFormat } from '@/domain/csv';
import { detectDateFormat, detectDelimiter, IMPORT_DATE_FORMATS, parseCSV, parseDateWithFormat, parseImportAmount } from '@/domain/csv';
import { findDuplicates, normalizeLabel } from '@/domain/duplicates';
import { parseAmount, toPlainString } from '@/domain/money';
import type { TransactionDraft } from '@/domain/validation';
import type { ImportBatch } from '@/domain/types';
import { t as tr, td } from '@/i18n/core';

const STEPS = ['file', 'columns', 'formats', 'categories', 'check', 'report'] as const;

type ColKey = 'date' | 'label' | 'amount' | 'debit' | 'credit' | 'category' | 'payee' | 'notes';
const COL_KEYS: ColKey[] = ['date', 'label', 'amount', 'debit', 'credit', 'category', 'payee', 'notes'];
/** Format de date affiché avec les lettres de la langue (ex. JJ/MM/AAAA en français). */
const displayFormat = (f: string) => f.replace(/[DMY]/g, (c) => td(`imp.letter.${c}`));

interface Row {
  idx: number;
  include: boolean;
  date: string | null;
  label: string;
  amount: number | null; // signé : < 0 dépense, > 0 revenu
  catRaw: string;
  payee: string;
  notes: string;
  errors: string[];
  duplicate?: string;
}

function guessColumns(header: string[]): Partial<Record<ColKey, number>> {
  const n = header.map((h) => normalizeLabel(h));
  /** En-tête exact dans la langue active (ex. un export CSV de NEXORA), sinon motifs français/anglais. */
  const find = (re: RegExp, localized?: string) => {
    const l = localized ? normalizeLabel(localized) : '';
    let i = l ? n.findIndex((h) => h === l) : -1;
    if (i < 0) i = n.findIndex((h) => re.test(h));
    return i >= 0 ? i : undefined;
  };
  return {
    date: find(/date|jour/, tr('csv.date')),
    label: find(/libelle|description|label|intitule|operation|memo/, tr('csv.label')),
    amount: find(/^montant|amount|somme|valeur/, tr('csv.amount')),
    debit: find(/debit|sortie|depense/, tr('imp.col.debit')),
    credit: find(/credit|entree|recette/, tr('imp.col.credit')),
    category: find(/categor/, tr('csv.category')),
    payee: find(/beneficiaire|commercant|tiers|payee|marchand/, tr('csv.payee')),
    notes: find(/note|commentaire/, tr('csv.notes')),
  };
}

export default function Import() {
  const { data, ctx, fmt, repo, settings } = useApp();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [delimiter, setDelimiter] = useState<Delimiter>(';');
  const [hasHeader, setHasHeader] = useState(true);
  const [cols, setCols] = useState<Partial<Record<ColKey, number>>>({});
  const [amountMode, setAmountMode] = useState<'signed' | 'split' | 'all_expenses'>('signed');
  const [dateFormat, setDateFormat] = useState<ImportDateFormat>('DD/MM/YYYY');
  const [accountId, setAccountId] = useState(data.accounts.find((a) => !a.archived)?.id ?? '');
  const [catMap, setCatMap] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportBatch | null>(null);
  const [filter, setFilter] = useState<'all' | 'errors' | 'duplicates'>('all');

  const account = ctx.accounts.get(accountId);
  const currency = account?.currency ?? settings.baseCurrency;
  const table = useMemo(() => (text ? parseCSV(text, delimiter) : []), [text, delimiter]);
  const header = hasHeader ? table[0] ?? [] : (table[0] ?? []).map((_, i) => tr('imp.column', { n: i + 1 }));
  const body = hasHeader ? table.slice(1) : table;
  const width = Math.max(0, ...table.slice(0, 20).map((r) => r.length));

  async function onFile(file: File) {
    if (file.size > 5 * 1024 * 1024) return toast.error(tr('imp.tooBig'));
    if (!/\.(csv|txt|tsv)$/i.test(file.name) && !/text|csv/.test(file.type)) return toast.error(tr('imp.badFormat'));
    let content = await file.text();
    // Repli Windows-1252 si l'UTF-8 produit des caractères de remplacement.
    if (content.includes('�')) content = new TextDecoder('windows-1252').decode(await file.arrayBuffer());
    const d = detectDelimiter(content);
    const t = parseCSV(content, d);
    if (t.length < 1) return toast.error(tr('imp.empty'));
    setFileName(file.name);
    setText(content);
    setDelimiter(d);
    const guessed = guessColumns(t[0]);
    setCols(guessed);
    setAmountMode(guessed.amount == null && (guessed.debit != null || guessed.credit != null) ? 'split' : 'signed');
    if (guessed.date != null) setDateFormat(detectDateFormat(t.slice(1).map((r) => r[guessed.date!] ?? '')));
    setStep(1);
  }

  function amountOf(r: string[]): number | null {
    if (amountMode === 'split') {
      const d = cols.debit != null ? parseImportAmount(r[cols.debit] ?? '', currency) : null;
      const c = cols.credit != null ? parseImportAmount(r[cols.credit] ?? '', currency) : null;
      if (d == null && c == null) return null;
      return (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0);
    }
    const v = cols.amount != null ? parseImportAmount(r[cols.amount] ?? '', currency) : null;
    if (v == null) return null;
    return amountMode === 'all_expenses' ? -Math.abs(v) : v;
  }

  const rawCategories = useMemo(() => {
    if (cols.category == null) return [];
    return [...new Set(body.map((r) => (r[cols.category!] ?? '').trim()).filter(Boolean))].slice(0, 200);
  }, [body, cols.category]);

  function goCategories() {
    const map: Record<string, string> = { ...catMap };
    for (const raw of rawCategories) {
      if (map[raw]) continue;
      const n = normalizeLabel(raw);
      const match = data.categories.find((c) => !c.archived && c.kind !== 'savings' && normalizeLabel(c.name) === n) ?? data.categories.find((c) => !c.archived && c.kind !== 'savings' && n && (normalizeLabel(c.name).includes(n) || n.includes(normalizeLabel(c.name))));
      map[raw] = match ? (match.parentId ? match.parentId + '|' + match.id : match.id) : '';
    }
    setCatMap(map);
    setStep(3);
  }

  function buildRows() {
    const built: Row[] = body.map((r, idx) => {
      const date = cols.date != null ? parseDateWithFormat(r[cols.date] ?? '', dateFormat) : null;
      const amount = amountOf(r);
      const errors: string[] = [];
      if (!date) errors.push(tr('imp.err.date'));
      if (amount == null) errors.push(tr('imp.err.amount'));
      else if (amount === 0) errors.push(tr('imp.err.zero'));
      return {
        idx,
        include: errors.length === 0,
        date,
        label: (cols.label != null ? r[cols.label] : '')?.slice(0, 140) ?? '',
        amount,
        catRaw: cols.category != null ? (r[cols.category] ?? '').trim() : '',
        payee: cols.payee != null ? r[cols.payee] ?? '' : '',
        notes: cols.notes != null ? r[cols.notes] ?? '' : '',
        errors,
      };
    });
    setRows(markDuplicates(built));
    setStep(4);
  }

  function markDuplicates(list: Row[]): Row[] {
    const existing = data.transactions.filter((t) => t.accountId === accountId);
    const cands = list.map((r) => ({ accountId, amount: Math.abs(r.amount ?? 0), direction: (r.amount ?? 0) < 0 ? ('out' as const) : ('in' as const), date: r.date ?? '1900-01-01', label: r.label }));
    const dups = findDuplicates(cands, existing);
    const seen = new Map<string, number>();
    return list.map((r, i) => {
      if (r.errors.length) return { ...r, duplicate: undefined };
      const key = `${r.date}|${r.amount}|${normalizeLabel(r.label)}`;
      const inFile = seen.get(key);
      seen.set(key, i);
      const d = dups[i];
      const duplicate = d ? tr('imp.dup.existing', { label: d.label, date: fmt.date(d.date) }) : inFile != null ? tr('imp.dup.inFile', { n: inFile + 1 }) : undefined;
      return { ...r, duplicate, include: r.include && !duplicate };
    });
  }

  function updateRow(i: number, patch: Partial<Pick<Row, 'date' | 'label' | 'amount' | 'include'>>) {
    setRows((list) => {
      const next = [...list];
      const r = { ...next[i], ...patch };
      r.errors = [];
      if (!r.date) r.errors.push(tr('imp.err.date'));
      if (r.amount == null) r.errors.push(tr('imp.err.amount'));
      else if (r.amount === 0) r.errors.push(tr('imp.err.zero'));
      if (r.errors.length) r.include = false;
      else if (patch.include === undefined && list[i].errors.length) r.include = true;
      next[i] = r;
      return next;
    });
  }

  function categoryFor(r: Row): { categoryId: string | null; subcategoryId: string | null } {
    const income = (r.amount ?? 0) > 0;
    const mapped = r.catRaw ? catMap[r.catRaw] : '';
    if (mapped) {
      const [a, b] = mapped.split('|');
      const cat = ctx.categories.get(a);
      if (cat && cat.kind === (income ? 'income' : 'expense')) return { categoryId: a, subcategoryId: b ?? null };
    }
    const fallback = data.categories.find((c) => c.key === (income ? 'other_income' : 'other_expense') && !c.archived) ?? data.categories.find((c) => !c.parentId && !c.archived && c.kind === (income ? 'income' : 'expense'));
    return { categoryId: fallback?.id ?? null, subcategoryId: null };
  }

  async function runImport() {
    const selected = rows.filter((r) => r.include && !r.errors.length);
    const drafts: TransactionDraft[] = selected.map((r) => ({
      type: (r.amount ?? 0) > 0 ? 'income' : 'expense',
      amount: Math.abs(r.amount!),
      label: r.label || (r.payee ? r.payee : tr('imp.defaultLabel')),
      date: r.date!,
      ...categoryFor(r),
      accountId,
      payee: r.payee || undefined,
      notes: r.notes || undefined,
      tags: ['import'],
      status: 'cleared',
    }));
    setBusy(true);
    try {
      const batch = await repo.importTransactions({ fileName, rowCount: rows.length, importedCount: drafts.length, skippedCount: rows.length - drafts.length, accountId }, drafts);
      setReport(batch);
      setStep(5);
      toast.success(tr('imp.done', { count: drafts.length }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const errorsCount = rows.filter((r) => r.errors.length).length;
  const dupCount = rows.filter((r) => r.duplicate).length;
  const includeCount = rows.filter((r) => r.include && !r.errors.length).length;
  const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => (filter === 'errors' ? r.errors.length > 0 : filter === 'duplicates' ? !!r.duplicate : true));
  const colsValid = cols.date != null && (amountMode === 'split' ? cols.debit != null || cols.credit != null : cols.amount != null);
  const previewParsed = body.slice(0, 6).map((r) => ({ date: cols.date != null ? parseDateWithFormat(r[cols.date] ?? '', dateFormat) : null, raw: cols.date != null ? r[cols.date] : '', amount: amountOf(r) }));

  return (
    <div>
      <PageHeader eyebrow={tr('imp.eyebrow')} title={tr('imp.title')} description={tr('imp.description')} actions={<Link to="/transactions"><Button variant="ghost" icon={<ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />}>{tr('nav.transactions')}</Button></Link>} />

      <ol className="mb-5 flex gap-1 overflow-x-auto pb-1">
        {STEPS.map((s, i) => (
          <li key={s} className={cn('flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs', i === step ? 'border-primary/50 bg-primary/15 text-fg' : i < step ? 'border-positive/30 text-positive' : 'border-line/15 text-muted')}>
            <span className="num font-semibold">{i + 1}</span> {td(`imp.step.${s}`)}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <Field label={tr('imp.account')} hint={tr('imp.account.hint')}>
                <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{data.accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</Select>
              </Field>
              <label className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-line/25 px-6 py-12 text-center transition hover:border-primary/50 hover:bg-primary/5">
                <Upload className="h-8 w-8 text-primary" />
                <span className="text-sm font-medium">{tr('imp.choose')}</span>
                <span className="text-xs text-muted">{tr('imp.choose.hint')}</span>
                <input type="file" accept=".csv,.txt,.tsv,text/csv" className="sr-only" disabled={!accountId} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
              </label>
            </div>
            <div className="rounded-2xl bg-surface-2/50 p-4 text-sm text-muted">
              <div className="mb-2 font-medium text-fg">{tr('imp.accepted')}</div>
              <ul className="space-y-1.5 text-xs">
                <li>• {tr('imp.accepted.dates')}</li>
                <li>• {tr('imp.accepted.amounts')}</li>
                <li>• {tr('imp.accepted.columns')}</li>
                <li>• {tr('imp.accepted.encoding')}</li>
              </ul>
              <pre className="mt-3 overflow-x-auto rounded-xl bg-surface/80 p-3 text-[11px] leading-relaxed" dir="ltr">{tr('imp.sample')}</pre>
            </div>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card title={tr('imp.preview', { file: fileName })} subtitle={tr('imp.rowsDetected', { count: body.length })}>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <Field label={tr('imp.delimiter')}><Select value={delimiter} onChange={(e) => setDelimiter(e.target.value as Delimiter)}><option value=";">{tr('imp.delim.semicolon')}</option><option value=",">{tr('imp.delim.comma')}</option><option value={'\t'}>{tr('imp.delim.tab')}</option><option value="|">{tr('imp.delim.pipe')}</option></Select></Field>
            <label className="flex h-11 items-center gap-2 text-sm"><input type="checkbox" className="accent-[rgb(var(--primary))]" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> {tr('imp.hasHeader')}</label>
          </div>
          <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="min-w-full text-xs">
              <thead>
                <tr>{Array.from({ length: width }, (_, i) => <th key={i} className="whitespace-nowrap border-b border-line/15 px-2 py-2 text-start font-medium text-muted">{header[i] ?? tr('imp.column', { n: i + 1 })}</th>)}</tr>
              </thead>
              <tbody>{body.slice(0, 6).map((r, i) => <tr key={i}>{Array.from({ length: width }, (_, j) => <td key={j} className="whitespace-nowrap border-b border-line/5 px-2 py-1.5">{r[j]}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="mt-5">
            <div className="label mb-2">{tr('imp.mapping')}</div>
            <div className="mb-3"><Segmented value={amountMode} onChange={setAmountMode} options={[{ value: 'signed', label: tr('imp.mode.signed') }, { value: 'split', label: tr('imp.mode.split') }, { value: 'all_expenses', label: tr('imp.mode.allExpenses') }]} /></div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {COL_KEYS.filter((k) => (amountMode === 'split' ? k !== 'amount' : k !== 'debit' && k !== 'credit')).map((k) => (
                <Field key={k} label={td(`imp.col.${k}`)}>
                  <Select value={cols[k] ?? ''} onChange={(e) => setCols({ ...cols, [k]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                    <option value="">{tr('imp.ignore')}</option>
                    {Array.from({ length: width }, (_, i) => <option key={i} value={i}>{header[i] ?? tr('imp.column', { n: i + 1 })}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
          </div>
          <div className="mt-5 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}>{tr('common.back')}</Button>
            <Button variant="primary" disabled={!colsValid} icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />} onClick={() => { if (cols.date != null) setDateFormat(detectDateFormat(body.map((r) => r[cols.date!] ?? ''))); setStep(2); }}>{tr('imp.continue')}</Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title={tr('imp.normalize')}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={tr('imp.dateFormat')} hint={tr('imp.dateFormat.hint')}>
              <Select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as ImportDateFormat)}>{IMPORT_DATE_FORMATS.map((f) => <option key={f} value={f}>{displayFormat(f)}</option>)}</Select>
            </Field>
            <Field label={tr('imp.amounts')} hint={tr('imp.amounts.hint', { currency })}>
              <div className="flex h-11 items-center text-sm text-muted">{tr('imp.decimalAuto')}</div>
            </Field>
          </div>
          <table className="mt-4 w-full text-xs">
            <thead><tr className="text-start text-muted"><th className="py-1.5">{tr('imp.th.raw')}</th><th>{tr('imp.th.date')}</th><th className="text-end">{tr('imp.th.amount')}</th></tr></thead>
            <tbody className="divide-y divide-line/5">
              {previewParsed.map((p, i) => (
                <tr key={i}><td className="py-1.5">{p.raw}</td><td className={cn(!p.date && 'text-negative')}>{p.date ? fmt.date(p.date) : tr('imp.invalid')}</td><td className={cn('text-end num', p.amount == null ? 'text-negative' : p.amount > 0 ? 'text-positive' : '')}>{p.amount == null ? tr('imp.invalid') : fmt.money(p.amount, currency, { sign: true, force: true })}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="mt-5 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>{tr('common.back')}</Button>
            <Button variant="primary" icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />} onClick={goCategories}>{tr('imp.continue')}</Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card title={tr('imp.catMapping')} subtitle={rawCategories.length ? tr('imp.catsFound', { count: rawCategories.length }) : tr('imp.noCatColumn')}>
          {rawCategories.length === 0 ? (
            <p className="text-sm text-muted">{tr('imp.noCat.text')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {rawCategories.map((raw) => (
                <div key={raw} className="flex items-center gap-3 rounded-xl bg-surface-2/50 p-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm">{raw}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted rtl:-scale-x-100" />
                  <Select className="max-w-[220px]" value={catMap[raw] ?? ''} onChange={(e) => setCatMap({ ...catMap, [raw]: e.target.value })}>
                    <option value="">{tr('imp.otherDefault')}</option>
                    <optgroup label={tr('common.expenses')}>{data.categories.filter((c) => c.kind === 'expense' && !c.archived).map((c) => <option key={c.id} value={c.parentId ? `${c.parentId}|${c.id}` : c.id}>{c.parentId ? `↳ ${c.name}` : c.name}</option>)}</optgroup>
                    <optgroup label={tr('common.income')}>{data.categories.filter((c) => c.kind === 'income' && !c.archived && !c.parentId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
                  </Select>
                </div>
              ))}
              <p className="text-xs text-muted md:col-span-2">{tr('imp.catRule')}</p>
            </div>
          )}
          <div className="mt-5 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)}>{tr('common.back')}</Button>
            <Button variant="primary" icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />} onClick={buildRows}>{tr('imp.checkRows')}</Button>
          </div>
        </Card>
      )}

      {step === 4 && (
        <Card title={tr('imp.step.check')} subtitle={tr('imp.check.subtitle')}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="positive">{tr('imp.toImport', { count: includeCount })}</Badge>
            {errorsCount > 0 && <Badge tone="negative">{tr('imp.inError', { count: errorsCount })}</Badge>}
            {dupCount > 0 && <Badge tone="warning">{tr('imp.dups', { count: dupCount })}</Badge>}
            <Segmented size="sm" className="ms-auto" value={filter} onChange={setFilter} options={[{ value: 'all', label: tr('common.allF') }, { value: 'errors', label: tr('imp.filter.errors') }, { value: 'duplicates', label: tr('imp.filter.duplicates') }]} />
          </div>
          <div className="-mx-4 max-h-[60vh] overflow-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="sticky top-0 z-[1] bg-surface"><tr className="text-start text-muted"><th className="w-8 py-2" /><th>{tr('common.date')}</th><th>{tr('common.label')}</th><th className="text-end">{tr('imp.th.amountIn', { currency })}</th><th className="ps-3">{tr('common.status')}</th></tr></thead>
              <tbody className="divide-y divide-line/5">
                {visible.slice(0, 500).map(({ r, i }) => (
                  <tr key={r.idx} className={cn(r.errors.length ? 'bg-negative/5' : r.duplicate ? 'bg-warning/5' : '')}>
                    <td className="py-1"><input type="checkbox" aria-label={tr('imp.importRow', { n: r.idx + 1 })} className="accent-[rgb(var(--primary))]" checked={r.include} disabled={r.errors.length > 0} onChange={(e) => updateRow(i, { include: e.target.checked })} /></td>
                    <td className="pe-2"><Input type="date" className="h-8 w-[150px] text-xs" value={r.date ?? ''} onChange={(e) => updateRow(i, { date: e.target.value || null })} /></td>
                    <td className="pe-2"><Input className="h-8 text-xs" value={r.label} onChange={(e) => updateRow(i, { label: e.target.value })} /></td>
                    <td className="pe-2"><Input className="h-8 w-[120px] text-end text-xs num" defaultValue={r.amount == null ? '' : toPlainString(r.amount, currency, ',')} onBlur={(e) => updateRow(i, { amount: parseAmount(e.target.value, currency) })} /></td>
                    <td className="ps-3">
                      {r.errors.length ? <span className="text-negative">{r.errors.join(', ')}</span> : r.duplicate ? <span className="inline-flex items-center gap-1 text-warning"><AlertTriangle className="h-3 w-3" />{r.duplicate}</span> : <span className="text-positive">{tr('imp.ok')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length > 500 && <p className="py-2 text-center text-xs text-muted">{tr('imp.limited')}</p>}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" onClick={() => setStep(3)}>{tr('common.back')}</Button>
            {account && rows.some((r) => r.include && r.date && r.date < account.initialBalanceDate) && (
              <p className="w-full text-xs text-muted">
                {tr('imp.beforeInitial', { account: account.name, date: fmt.date(account.initialBalanceDate) })}
              </p>
            )}
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted">{tr('imp.destination')} <b className="text-fg">{account?.name}</b></span>
              <Button variant="primary" loading={busy} disabled={!includeCount} icon={<FileUp className="h-4 w-4" />} onClick={runImport}>{tr('imp.importN', { count: includeCount })}</Button>
            </div>
          </div>
        </Card>
      )}

      {step === 5 && report && (
        <Card>
          <div className="flex flex-col items-center py-6 text-center">
            <CheckCircle2 className="h-12 w-12 text-positive" />
            <h2 className="display mt-3 text-xl font-semibold">{tr('imp.finished')}</h2>
            <dl className="mt-5 grid grid-cols-3 gap-6 text-sm">
              <div><dt className="label">{tr('imp.read')}</dt><dd className="num text-lg font-semibold">{report.rowCount}</dd></div>
              <div><dt className="label">{tr('imp.imported')}</dt><dd className="num text-lg font-semibold text-positive">{report.importedCount}</dd></div>
              <div><dt className="label">{tr('imp.skipped')}</dt><dd className="num text-lg font-semibold">{report.skippedCount}</dd></div>
            </dl>
            <p className="mt-4 max-w-md text-xs text-muted">{tr('imp.finished.note')}</p>
            <div className="mt-6 flex gap-2">
              <Button variant="outline" onClick={() => { setStep(0); setRows([]); setText(''); setReport(null); }}>{tr('imp.another')}</Button>
              <Link to="/transactions"><Button variant="primary">{tr('imp.seeTransactions')}</Button></Link>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
