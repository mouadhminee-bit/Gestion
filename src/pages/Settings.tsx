import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Database, Download, FileUp, FlaskConical, Lock, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, CategoryIcon } from '@/components/ui/Misc';
import { Dialog, useConfirm } from '@/components/ui/Dialog';
import { Field, Input, Segmented, Select, Switch } from '@/components/ui/Field';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { accountsCSV, budgetsCSV, download, transactionsCSV } from '@/features/export';
import { generateDemoData } from '@/data/demo';
import { downloadText } from '@/domain/csv';
import { CURRENCIES, currencyInfo } from '@/domain/money';
import { localeOptions, TIME_ZONES } from '@/domain/settings';
import type { Category, CategoryKind, ExpenseNature, UserSettings } from '@/domain/types';
import type { DateFormat } from '@/domain/dates';
import { COLOR_SWATCHES, ICON_NAMES } from '@/lib/icons';
import { cn } from '@/lib/cn';
import { t, td } from '@/i18n/core';
import { languageInfo } from '@/i18n/languages';
import { currencyName } from '@/i18n/labels';
import { LanguageSelect } from '@/components/ui/LanguageSelect';
import { useI18n } from '@/i18n/I18nProvider';

/** Nom du jour (0 = dimanche) dans la langue de l'interface. */
function weekday(day: 0 | 1, locale: string): string {
  const name = new Date(Date.UTC(2024, 0, 7 + day)).toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' });
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}

const SECTIONS = ['profile', 'regional', 'display', 'notifications', 'categories', 'rates', 'data', 'privacy'] as const;

export default function Settings() {
  const { settings, repo, data, ctx, today, fmt, uiLocale } = useApp();
  const { lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const location = useLocation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(settings.displayName);
  const [thresholds, setThresholds] = useState(settings.budgetAlertThresholds.join(', '));

  useEffect(() => {
    const id = location.hash.replace('#', '');
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash]);

  const update = async (patch: Partial<UserSettings>, msg = t('set.saved')) => {
    await repo.updateSettings(patch);
    toast.success(msg);
  };

  async function exportBackup() {
    const backup = await repo.exportBackup();
    downloadText(`${t('set.backupFile')}-${today}.json`, JSON.stringify(backup, null, 2), 'application/json');
    toast.success(t('set.backupExported'));
  }

  async function restore(file: File) {
    if (file.size > 50 * 1024 * 1024) return toast.error(t('set.fileTooBig'));
    try {
      const parsed = JSON.parse(await file.text());
      if (!(await confirm({ title: t('set.restore.title'), message: t('set.restore.message', { file: file.name, date: parsed?.exportedAt ? new Date(parsed.exportedAt).toLocaleString(uiLocale) : t('set.unknownDate') }), confirmLabel: t('set.restore.confirm') }))) return;
      await repo.restoreBackup(parsed);
      toast.success(t('set.restored'));
    } catch (e) {
      toast.error(e instanceof SyntaxError ? t('set.badJson') : errorMessage(e));
    }
  }

  async function resetDemo() {
    if (!(await confirm({ title: t('set.resetDemo.title'), message: t('set.resetDemo.message'), confirmLabel: t('set.resetDemo.confirm') }))) return;
    await repo.replaceWithSnapshot(generateDemoData(repo.userId, today, settings.displayName || 'Sara'));
    toast.success(t('set.resetDemo.done'));
  }

  async function startEmpty() {
    if (!(await confirm({ title: t('set.empty.title'), message: t('set.empty.message'), confirmLabel: t('set.empty.confirm') }))) return;
    await repo.resetToEmpty({ displayName: settings.displayName, theme: settings.theme, locale: settings.locale, language: settings.language, baseCurrency: settings.baseCurrency, onboarded: true, timeZone: settings.timeZone, dateFormat: settings.dateFormat, currencyDisplay: settings.currencyDisplay });
    toast.success(t('set.empty.done'));
  }

  async function deleteAll() {
    if (!(await confirm({ title: t('set.deleteAll.title'), message: t('set.deleteAll.message'), confirmLabel: t('set.deleteAll.confirm') }))) return;
    await repo.clearUserData();
    try {
      localStorage.removeItem('nexora.lastAccount');
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  }

  return (
    <div>
      <PageHeader eyebrow={t('set.eyebrow')} title={t('nav.settings')} description={t('set.description')} />
      <nav className="no-print mb-5 flex gap-1.5 overflow-x-auto pb-1" aria-label={t('set.sections')}>
        {SECTIONS.map((id) => <a key={id} href={`#/settings#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }} className="shrink-0 rounded-full border border-line/15 px-3 py-1.5 text-xs text-muted hover:text-fg">{td(`set.sec.${id}`)}</a>)}
      </nav>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card id="profile" title={t('set.sec.profile')}>
          <div className="flex items-end gap-2">
            <Field label={t('set.displayName')} className="flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Button variant="outline" onClick={() => update({ displayName: name.trim() })} disabled={name === settings.displayName}>{t('common.save')}</Button>
          </div>
          <p className="mt-3 text-xs text-muted">{t('set.localMode')}</p>
        </Card>

        <Card id="regional" title={t('set.regional')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.baseCurrency')} hint={t('set.baseCurrencyHint')}>
              <Select value={settings.baseCurrency} onChange={(e) => update({ baseCurrency: e.target.value }, t('set.baseCurrencyChanged'))}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {currencyName(c.code, lang)}</option>)}
              </Select>
            </Field>
            <Field label={t('settings.language')} hint={t('set.languageHint')}>
              <LanguageSelect onChanged={(next) => repo.updateSettings({ language: next, locale: next === 'fr' ? 'fr-MA' : languageInfo(next).locale })} />
            </Field>
            <Field label={t('settings.numberFormats')}>
              <Select value={settings.locale} onChange={(e) => update({ locale: e.target.value })}>{localeOptions(lang).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select>
            </Field>
            <Field label={t('set.timeZone')}>
              <Select value={settings.timeZone} onChange={(e) => update({ timeZone: e.target.value })}>{TIME_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</Select>
            </Field>
            <Field label={t('set.dateFormat')}>
              <Select value={settings.dateFormat} onChange={(e) => update({ dateFormat: e.target.value as DateFormat })}>
                <option value="DD/MM/YYYY">{t('set.dateFormat.dmy')}</option>
                <option value="MM/DD/YYYY">{t('set.dateFormat.mdy')}</option>
                <option value="YYYY-MM-DD">{t('set.dateFormat.ymd')}</option>
              </Select>
            </Field>
            <Field label={t('set.weekStart')}>
              <Select value={settings.weekStartsOn} onChange={(e) => update({ weekStartsOn: Number(e.target.value) as 0 | 1 })}><option value={1}>{weekday(1, uiLocale)}</option><option value={0}>{weekday(0, uiLocale)}</option></Select>
            </Field>
          </div>
          <p className="mt-3 text-xs text-muted">{t('set.preview', { money: fmt.money(1234567), date: fmt.date(today) })}</p>
        </Card>

        <Card id="display" title={t('set.sec.display')}>
          <Field label={t('set.theme')}><Segmented value={settings.theme} onChange={(v) => update({ theme: v })} options={[{ value: 'dark', label: t('set.theme.dark') }, { value: 'light', label: t('set.theme.light') }]} /></Field>
          <div className="mt-3"><Field label={t('set.currencySymbol')}><Segmented value={settings.currencyDisplay} onChange={(v) => update({ currencyDisplay: v })} options={[{ value: 'symbol', label: t('set.currencySymbol.symbol', { value: currencyInfo(settings.baseCurrency).symbol }) }, { value: 'code', label: t('set.currencySymbol.code', { value: settings.baseCurrency }) }]} /></Field></div>
          <div className="mt-2 border-t border-line/10 pt-2">
            <Switch checked={settings.privacyMode} onChange={(v) => update({ privacyMode: v })} label={t('set.privacy')} description={t('set.privacy.description')} />
          </div>
        </Card>

        <Card id="notifications" title={t('set.notifications')}>
          <Switch checked={settings.notifyBudgets} onChange={(v) => update({ notifyBudgets: v })} label={t('set.notif.budgets')} description={t('set.notif.budgets.description')} />
          <Switch checked={settings.notifyBills} onChange={(v) => update({ notifyBills: v })} label={t('set.notif.bills')} description={t('set.notif.bills.description')} />
          <Switch checked={settings.notifyDebts} onChange={(v) => update({ notifyDebts: v })} label={t('set.notif.debts')} description={t('set.notif.debts.description')} />
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label={t('set.billDays')}>
              <Input type="number" min={1} max={60} value={settings.billReminderDays} onChange={(e) => update({ billReminderDays: Math.min(60, Math.max(1, Number(e.target.value) || 7)) })} />
            </Field>
            <Field label={t('set.thresholds')}>
              <div className="flex gap-2">
                <Input value={thresholds} onChange={(e) => setThresholds(e.target.value)} inputMode="numeric" />
                <Button variant="outline" onClick={() => {
                  const list = [...new Set(thresholds.split(/[,; ]+/).map(Number).filter((n) => n > 0 && n <= 200))].sort((a, b) => a - b);
                  if (!list.length) return toast.error(t('set.thresholds.error'));
                  setThresholds(list.join(', '));
                  update({ budgetAlertThresholds: list });
                }}>{t('set.ok')}</Button>
              </div>
            </Field>
          </div>
          <p className="mt-2 text-xs text-muted">{t('set.notif.note')}</p>
        </Card>
      </div>

      <CategoriesManager />

      <RatesManager />

      <Card id="data" className="mt-5" title={<span className="flex items-center gap-1.5"><Database className="h-4 w-4" /> {t('set.data')}</span>}>
        <div className="grid gap-5 lg:grid-cols-3">
          <div>
            <div className="label mb-2">{t('set.backup')}</div>
            <div className="flex flex-col gap-2">
              <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportBackup}>{t('set.exportBackup')}</Button>
              <Button variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>{t('set.restoreBackup')}</Button>
              <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) restore(f); e.target.value = ''; }} />
              <p className="text-xs text-muted">{t('set.backupNote')}</p>
            </div>
          </div>
          <div>
            <div className="label mb-2">{t('set.csvExports')}</div>
            <div className="flex flex-col gap-2">
              <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download('nexora-transactions.csv', transactionsCSV(data.transactions, ctx.categories, ctx.accounts))}>{t('set.allTransactions')}</Button>
              <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download('nexora-comptes.csv', accountsCSV(data, today))}>{t('set.accountsBalances')}</Button>
              <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download('nexora-budgets.csv', budgetsCSV(data.budgets, ctx.categories))}>{t('set.budgets')}</Button>
              <Link to="/import"><Button variant="outline" className="w-full" icon={<FileUp className="h-4 w-4" />}>{t('set.importCsv')}</Button></Link>
            </div>
          </div>
          <div>
            <div className="label mb-2">{t('set.reset')}</div>
            <div className="flex flex-col gap-2">
              <Button variant="outline" icon={<FlaskConical className="h-4 w-4" />} onClick={resetDemo}>{t('set.resetDemo')}</Button>
              <Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={startEmpty}>{t('set.startEmpty')}</Button>
              <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={deleteAll}>{t('set.deleteAll')}</Button>
              {settings.demoMode && <Badge tone="warning" className="self-start">{t('set.demoActive')}</Badge>}
            </div>
          </div>
        </div>
      </Card>

      <Card id="privacy" className="mt-5" title={<span className="flex items-center gap-1.5"><Lock className="h-4 w-4" /> {t('set.security')}</span>}>
        <ul className="grid gap-2 text-sm text-muted md:grid-cols-2">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <li key={n}>• <b className="text-fg">{td(`set.sec${n}.title`)}</b>{td(`set.sec${n}.text`)}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------------------

type CatForm = { id?: string; name: string; kind: CategoryKind; nature?: ExpenseNature; parentId: string | null; icon: string; color: string };

function CategoriesManager() {
  const { data, repo } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [form, setForm] = useState<CatForm | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const tops = useMemo(() => data.categories.filter((c) => c.kind === kind && !c.parentId && (showArchived || !c.archived)).sort((a, b) => a.order - b.order), [data.categories, kind, showArchived]);
  const childrenOf = (id: string) => data.categories.filter((c) => c.parentId === id && (showArchived || !c.archived)).sort((a, b) => a.order - b.order);

  async function save() {
    if (!form) return;
    try {
      if (form.id) await repo.updateCategory(form.id, { name: form.name.trim(), icon: form.icon, color: form.color, nature: form.nature });
      else await repo.createCategory({ name: form.name.trim(), kind: form.kind, nature: form.nature, parentId: form.parentId, icon: form.icon, color: form.color, archived: false, order: 9999 });
      toast.success(t('cat.saved'));
      setForm(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function move(list: Category[], index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((c) => c.id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    await repo.reorderCategories(ids);
  }

  async function remove(c: Category) {
    const usage = await repo.categoryUsage(c.id);
    if (usage > 0) {
      if (await confirm({ title: t('cat.used.title', { name: c.name }), message: t('cat.used.message', { count: usage }), confirmLabel: t('common.archive'), danger: false })) {
        await repo.updateCategory(c.id, { archived: true });
        toast.success(t('cat.archived'));
      }
      return;
    }
    if (!(await confirm({ title: t('cat.delete.title', { name: c.name }), message: t('cat.delete.message'), confirmLabel: t('common.delete') }))) return;
    try {
      await repo.deleteCategory(c.id);
      toast.success(t('cat.deleted'));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const row = (c: Category, list: Category[], i: number, sub = false) => (
    <li key={c.id} className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-2 py-1.5 hover:bg-surface-2/60', sub && 'ms-6 sm:ms-8', c.archived && 'opacity-50')}>
      <CategoryIcon icon={c.icon} color={c.color} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
      {c.archived && <Badge>{t('cat.archivedBadge')}</Badge>}
      {!sub && c.kind === 'expense' && <Badge tone={c.nature === 'fixed' ? 'violet' : 'cyan'}>{c.nature === 'fixed' ? t('cat.fixed') : t('cat.variable')}</Badge>}
      <div className="ms-auto flex shrink-0">
        <Button size="icon-sm" variant="ghost" aria-label={t('cat.up')} onClick={() => move(list, i, -1)} disabled={i === 0}><ArrowUp className="h-3.5 w-3.5" /></Button>
        <Button size="icon-sm" variant="ghost" aria-label={t('cat.down')} onClick={() => move(list, i, 1)} disabled={i === list.length - 1}><ArrowDown className="h-3.5 w-3.5" /></Button>
        {!sub && <Button size="icon-sm" variant="ghost" aria-label={t('cat.addSub')} onClick={() => setForm({ name: '', kind: c.kind, nature: c.nature, parentId: c.id, icon: c.icon, color: c.color })}><Plus className="h-3.5 w-3.5" /></Button>}
        <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setForm({ id: c.id, name: c.name, kind: c.kind, nature: c.nature, parentId: c.parentId, icon: c.icon, color: c.color })}><Pencil className="h-3.5 w-3.5" /></Button>
        {c.archived ? (
          <Button size="icon-sm" variant="ghost" aria-label={t('common.reactivate')} onClick={() => repo.updateCategory(c.id, { archived: false })}><ArchiveRestore className="h-3.5 w-3.5" /></Button>
        ) : (
          <Button size="icon-sm" variant="ghost" aria-label={t('cat.archiveOrDelete')} onClick={() => remove(c)}><Archive className="h-3.5 w-3.5" /></Button>
        )}
      </div>
    </li>
  );

  return (
    <Card id="categories" className="mt-5" title={t('set.sec.categories')} subtitle={t('cat.subtitle')}
      actions={<Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setForm({ name: '', kind, nature: kind === 'expense' ? 'variable' : undefined, parentId: null, icon: 'CircleDot', color: COLOR_SWATCHES[0] })}>{t('cat.new')}</Button>}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented value={kind} onChange={setKind} options={[{ value: 'expense', label: t('cat.kind.expense') }, { value: 'income', label: t('cat.kind.income') }, { value: 'savings', label: t('cat.kind.savings') }]} />
        <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" className="accent-[rgb(var(--primary))]" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t('cat.showArchived')}</label>
      </div>
      {kind === 'savings' && <p className="mb-2 text-xs text-muted">{t('cat.savingsNote')}</p>}
      <div className="grid gap-x-6 lg:grid-cols-2">
        {tops.map((c, i) => (
          <ul key={c.id} className="min-w-0">
            {row(c, tops, i)}
            {childrenOf(c.id).map((s, j, arr) => row(s, arr, j, true))}
          </ul>
        ))}
      </div>
      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)} title={form?.id ? t('cat.edit') : form?.parentId ? t('cat.newSub') : t('cat.newCat')} size="sm"
        footer={<><Button variant="ghost" onClick={() => setForm(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={save} disabled={!form?.name.trim()}>{t('common.save')}</Button></>}>
        {form && (
          <div className="space-y-4">
            <Field label={t('common.name')} required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-autofocus maxLength={60} /></Field>
            {form.kind === 'expense' && !form.parentId && (
              <Field label={t('cat.nature')}><Segmented value={form.nature ?? 'variable'} onChange={(v) => setForm({ ...form, nature: v })} options={[{ value: 'fixed', label: t('cat.nature.fixed') }, { value: 'variable', label: t('cat.nature.variable') }]} className="w-full" /></Field>
            )}
            <Field label={t('common.icon')}>
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {ICON_NAMES.map((n) => <button key={n} type="button" aria-label={n} aria-pressed={form.icon === n} onClick={() => setForm({ ...form, icon: n })} className={cn('rounded-lg', form.icon === n && 'ring-2 ring-cyan')}><CategoryIcon icon={n} color={form.color} size="sm" /></button>)}
              </div>
            </Field>
            <Field label={t('common.color')}>
              <div className="flex flex-wrap gap-2">{COLOR_SWATCHES.map((c) => <button key={c} type="button" aria-label={c} onClick={() => setForm({ ...form, color: c })} className={cn('h-7 w-7 rounded-full ring-offset-2 ring-offset-surface', form.color === c && 'ring-2 ring-fg')} style={{ background: c }} />)}</div>
            </Field>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Taux de change
// ---------------------------------------------------------------------------

function RatesManager() {
  const { data, repo, settings, today, fmt } = useApp();
  const toast = useToast();
  const used = new Set(data.accounts.map((a) => a.currency).filter((c) => c !== settings.baseCurrency));
  const [base, setBase] = useState([...used][0] ?? 'EUR');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(today);
  async function add() {
    const r = Number(rate.replace(',', '.'));
    try {
      await repo.saveRate(base, settings.baseCurrency, r, date);
      toast.success(t('rate.saved'));
      setRate('');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  const rates = [...data.rates].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <Card id="rates" className="mt-5" title={t('set.sec.rates')} subtitle={t('rate.subtitle')}>
      {used.size > 0 && <p className="mb-3 text-xs text-muted">{t('rate.used', { list: [...used].join(', ') })}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:items-end">
        <Field label={t('rate.oneUnit')}>
          <Select value={base} onChange={(e) => setBase(e.target.value)}>{CURRENCIES.filter((c) => c.code !== settings.baseCurrency).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select>
        </Field>
        <Field label={`= … ${settings.baseCurrency}`}><Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="10,85" /></Field>
        <Field label={t('rate.valueDate')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Button variant="primary" onClick={add} disabled={!rate}>{t('common.add')}</Button>
      </div>
      {rates.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead><tr className="text-start text-xs text-muted"><th className="py-1">{t('common.date')}</th><th>{t('rate.pair')}</th><th className="text-end">{t('rate.rate')}</th><th /></tr></thead>
          <tbody className="divide-y divide-line/5">
            {rates.map((r) => (
              <tr key={r.id}><td className="py-1.5">{fmt.date(r.date)}</td><td>1 {r.base} = {r.quote}</td><td className="text-end num">{r.rate.toLocaleString(settings.locale, { maximumFractionDigits: 6 })}</td><td className="text-end"><Button size="icon-sm" variant="ghost" aria-label={t('rate.delete')} onClick={() => repo.deleteRate(r.id)}><Trash2 className="h-3.5 w-3.5" /></Button></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
