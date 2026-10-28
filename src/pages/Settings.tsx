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
import { CURRENCIES } from '@/domain/money';
import { LOCALES, TIME_ZONES } from '@/domain/settings';
import type { Category, CategoryKind, ExpenseNature, UserSettings } from '@/domain/types';
import type { DateFormat } from '@/domain/dates';
import { COLOR_SWATCHES, ICON_NAMES } from '@/lib/icons';
import { cn } from '@/lib/cn';

const SECTIONS = [
  ['profile', 'Profil'],
  ['regional', 'Régional'],
  ['display', 'Affichage & confidentialité'],
  ['notifications', 'Notifications'],
  ['categories', 'Catégories'],
  ['rates', 'Taux de change'],
  ['data', 'Données'],
  ['privacy', 'Sécurité'],
] as const;

export default function Settings() {
  const { settings, repo, data, ctx, today, fmt } = useApp();
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

  const update = async (patch: Partial<UserSettings>, msg = 'Préférence enregistrée.') => {
    await repo.updateSettings(patch);
    toast.success(msg);
  };

  async function exportBackup() {
    const backup = await repo.exportBackup();
    downloadText(`nexora-sauvegarde-${today}.json`, JSON.stringify(backup, null, 2), 'application/json');
    toast.success('Sauvegarde exportée. Conservez ce fichier en lieu sûr : il contient vos données financières en clair.');
  }

  async function restore(file: File) {
    if (file.size > 50 * 1024 * 1024) return toast.error('Fichier trop volumineux.');
    try {
      const parsed = JSON.parse(await file.text());
      if (!(await confirm({ title: 'Restaurer cette sauvegarde ?', message: `Toutes les données actuelles seront remplacées par celles du fichier « ${file.name} » (exporté le ${parsed?.exportedAt ? new Date(parsed.exportedAt).toLocaleString(settings.locale) : 'date inconnue'}).`, confirmLabel: 'Restaurer' }))) return;
      await repo.restoreBackup(parsed);
      toast.success('Sauvegarde restaurée.');
    } catch (e) {
      toast.error(e instanceof SyntaxError ? 'Fichier JSON illisible.' : errorMessage(e));
    }
  }

  async function resetDemo() {
    if (!(await confirm({ title: 'Réinitialiser le jeu de démonstration ?', message: 'Toutes les données actuelles seront remplacées par le jeu de démonstration fictif (6 mois).', confirmLabel: 'Réinitialiser' }))) return;
    await repo.replaceWithSnapshot(generateDemoData(repo.userId, today, settings.displayName || 'Sara'));
    toast.success('Jeu de démonstration réinitialisé.');
  }

  async function startEmpty() {
    if (!(await confirm({ title: 'Repartir de zéro ?', message: 'Toutes les opérations, comptes, budgets et objectifs seront supprimés. Les catégories initiales et vos préférences d’affichage sont conservées. Pensez à exporter une sauvegarde avant.', confirmLabel: 'Tout effacer' }))) return;
    await repo.resetToEmpty({ displayName: settings.displayName, theme: settings.theme, locale: settings.locale, baseCurrency: settings.baseCurrency, onboarded: true, timeZone: settings.timeZone, dateFormat: settings.dateFormat, currencyDisplay: settings.currencyDisplay });
    toast.success('Espace vierge prêt. Créez votre premier compte.');
  }

  async function deleteAll() {
    if (!(await confirm({ title: 'Supprimer définitivement toutes les données ?', message: 'Toutes vos données NEXORA stockées dans ce navigateur seront effacées, y compris les préférences. Cette action est irréversible.', confirmLabel: 'Supprimer tout' }))) return;
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
      <PageHeader eyebrow="Système" title="Paramètres" description="Préférences, catégories, taux de change et gestion de vos données." />
      <nav className="no-print mb-5 flex gap-1.5 overflow-x-auto pb-1" aria-label="Sections">
        {SECTIONS.map(([id, label]) => <a key={id} href={`#/settings#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }} className="shrink-0 rounded-full border border-line/15 px-3 py-1.5 text-xs text-muted hover:text-fg">{label}</a>)}
      </nav>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card id="profile" title="Profil">
          <div className="flex items-end gap-2">
            <Field label="Prénom affiché" className="flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Button variant="outline" onClick={() => update({ displayName: name.trim() })} disabled={name === settings.displayName}>Enregistrer</Button>
          </div>
          <p className="mt-3 text-xs text-muted">Mode local : un seul profil par navigateur, sans compte en ligne.</p>
        </Card>

        <Card id="regional" title="Paramètres régionaux">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Devise principale" hint="Devise des totaux et budgets. Les comptes dans d’autres devises nécessitent un taux de change.">
              <Select value={settings.baseCurrency} onChange={(e) => update({ baseCurrency: e.target.value }, 'Devise principale modifiée.')}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
              </Select>
            </Field>
            <Field label="Langue" hint="Seul le français est disponible pour l’instant.">
              <Select value={settings.language} onChange={(e) => update({ language: e.target.value as 'fr' })}>
                <option value="fr">Français</option>
                <option value="en" disabled>English (bientôt)</option>
              </Select>
            </Field>
            <Field label="Formats numériques">
              <Select value={settings.locale} onChange={(e) => update({ locale: e.target.value })}>{LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select>
            </Field>
            <Field label="Fuseau horaire">
              <Select value={settings.timeZone} onChange={(e) => update({ timeZone: e.target.value })}>{TIME_ZONES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
            </Field>
            <Field label="Format de date">
              <Select value={settings.dateFormat} onChange={(e) => update({ dateFormat: e.target.value as DateFormat })}>
                <option value="DD/MM/YYYY">JJ/MM/AAAA</option>
                <option value="MM/DD/YYYY">MM/JJ/AAAA</option>
                <option value="YYYY-MM-DD">AAAA-MM-JJ</option>
              </Select>
            </Field>
            <Field label="Premier jour de la semaine">
              <Select value={settings.weekStartsOn} onChange={(e) => update({ weekStartsOn: Number(e.target.value) as 0 | 1 })}><option value={1}>Lundi</option><option value={0}>Dimanche</option></Select>
            </Field>
          </div>
          <p className="mt-3 text-xs text-muted">Aperçu : {fmt.money(1234567)} · {fmt.date(today)} · période budgétaire : mois civil.</p>
        </Card>

        <Card id="display" title="Affichage & confidentialité">
          <Field label="Thème"><Segmented value={settings.theme} onChange={(v) => update({ theme: v })} options={[{ value: 'dark', label: 'Sombre' }, { value: 'light', label: 'Clair' }]} /></Field>
          <div className="mt-3"><Field label="Symbole monétaire"><Segmented value={settings.currencyDisplay} onChange={(v) => update({ currencyDisplay: v })} options={[{ value: 'symbol', label: 'Symbole (DH)' }, { value: 'code', label: 'Code (MAD)' }]} /></Field></div>
          <div className="mt-2 border-t border-line/10 pt-2">
            <Switch checked={settings.privacyMode} onChange={(v) => update({ privacyMode: v })} label="Masquer les montants" description="Masque les montants dans toutes les vues (utile en public). Ce n’est pas un chiffrement : les données restent lisibles dans le stockage du navigateur." />
          </div>
        </Card>

        <Card id="notifications" title="Notifications & alertes">
          <Switch checked={settings.notifyBudgets} onChange={(v) => update({ notifyBudgets: v })} label="Alertes budgétaires" description="Lorsqu’un seuil de consommation est atteint (une seule fois par seuil et par mois)." />
          <Switch checked={settings.notifyBills} onChange={(v) => update({ notifyBills: v })} label="Échéances récurrentes" description="Échéances à venir et échéances passées non marquées." />
          <Switch checked={settings.notifyDebts} onChange={(v) => update({ notifyDebts: v })} label="Dettes et créances" description="Engagements en retard ou proches de l’échéance." />
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Anticipation des échéances (jours)">
              <Input type="number" min={1} max={60} value={settings.billReminderDays} onChange={(e) => update({ billReminderDays: Math.min(60, Math.max(1, Number(e.target.value) || 7)) })} />
            </Field>
            <Field label="Seuils budgétaires par défaut (%)">
              <div className="flex gap-2">
                <Input value={thresholds} onChange={(e) => setThresholds(e.target.value)} inputMode="numeric" />
                <Button variant="outline" onClick={() => {
                  const list = [...new Set(thresholds.split(/[,; ]+/).map(Number).filter((n) => n > 0 && n <= 200))].sort((a, b) => a - b);
                  if (!list.length) return toast.error('Indiquez au moins un seuil entre 1 et 200.');
                  setThresholds(list.join(', '));
                  update({ budgetAlertThresholds: list });
                }}>OK</Button>
              </div>
            </Field>
          </div>
          <p className="mt-2 text-xs text-muted">Les notifications sont affichées dans l’application (cloche). Aucune notification push ni e-mail n’est envoyée.</p>
        </Card>
      </div>

      <CategoriesManager />

      <RatesManager />

      <Card id="data" className="mt-5" title={<span className="flex items-center gap-1.5"><Database className="h-4 w-4" /> Données</span>}>
        <div className="grid gap-5 lg:grid-cols-3">
          <div>
            <div className="label mb-2">Sauvegarde</div>
            <div className="flex flex-col gap-2">
              <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportBackup}>Exporter une sauvegarde (JSON)</Button>
              <Button variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>Restaurer une sauvegarde</Button>
              <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) restore(f); e.target.value = ''; }} />
              <p className="text-xs text-muted">Les justificatifs (pièces jointes) ne sont pas inclus dans la sauvegarde JSON.</p>
            </div>
          </div>
          <div>
            <div className="label mb-2">Exports CSV</div>
            <div className="flex flex-col gap-2">
              <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download('nexora-transactions.csv', transactionsCSV(data.transactions, ctx.categories, ctx.accounts))}>Toutes les transactions</Button>
              <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download('nexora-comptes.csv', accountsCSV(data, today))}>Comptes et soldes</Button>
              <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => download('nexora-budgets.csv', budgetsCSV(data.budgets, ctx.categories))}>Budgets</Button>
              <Link to="/import"><Button variant="outline" className="w-full" icon={<FileUp className="h-4 w-4" />}>Importer un relevé CSV</Button></Link>
            </div>
          </div>
          <div>
            <div className="label mb-2">Réinitialisation</div>
            <div className="flex flex-col gap-2">
              <Button variant="outline" icon={<FlaskConical className="h-4 w-4" />} onClick={resetDemo}>Réinitialiser le jeu de démonstration</Button>
              <Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={startEmpty}>Repartir de zéro (espace vierge)</Button>
              <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={deleteAll}>Supprimer toutes les données</Button>
              {settings.demoMode && <Badge tone="warning" className="self-start">Données de démonstration actives</Badge>}
            </div>
          </div>
        </div>
      </Card>

      <Card id="privacy" className="mt-5" title={<span className="flex items-center gap-1.5"><Lock className="h-4 w-4" /> Sécurité & confidentialité</span>}>
        <ul className="grid gap-2 text-sm text-muted md:grid-cols-2">
          <li>• <b className="text-fg">Stockage local</b> : vos données sont enregistrées dans IndexedDB, dans ce navigateur uniquement. Elles ne sont envoyées à aucun serveur.</li>
          <li>• <b className="text-fg">Pas de chiffrement au repos</b> : toute personne ayant accès à cette session du navigateur peut lire les données. Verrouillez votre appareil.</li>
          <li>• <b className="text-fg">Effacement</b> : vider les données du site dans le navigateur supprime définitivement NEXORA. Exportez régulièrement des sauvegardes.</li>
          <li>• <b className="text-fg">Aucune connexion bancaire</b> : NEXORA ne demande jamais d’identifiants bancaires ; aucune synchronisation automatique n’est simulée.</li>
          <li>• <b className="text-fg">Mode confidentialité</b> : masque l’affichage des montants, sans les chiffrer.</li>
          <li>• <b className="text-fg">Mode cloud</b> : architecture prévue (Supabase + Row Level Security), non activée dans cette version — voir la documentation.</li>
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
      toast.success('Catégorie enregistrée.');
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
      if (await confirm({ title: `« ${c.name} » est utilisée`, message: `Elle apparaît dans ${usage} élément(s) de l’historique (opérations, budgets, récurrences). Pour garder vos anciennes opérations compréhensibles, elle sera archivée plutôt que supprimée.`, confirmLabel: 'Archiver', danger: false })) {
        await repo.updateCategory(c.id, { archived: true });
        toast.success('Catégorie archivée.');
      }
      return;
    }
    if (!(await confirm({ title: `Supprimer « ${c.name} » ?`, message: 'Catégorie inutilisée : elle sera supprimée définitivement (avec ses sous-catégories inutilisées).', confirmLabel: 'Supprimer' }))) return;
    try {
      await repo.deleteCategory(c.id);
      toast.success('Catégorie supprimée.');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const row = (c: Category, list: Category[], i: number, sub = false) => (
    <li key={c.id} className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-2 py-1.5 hover:bg-surface-2/60', sub && 'ml-6 sm:ml-8', c.archived && 'opacity-50')}>
      <CategoryIcon icon={c.icon} color={c.color} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
      {c.archived && <Badge>Archivée</Badge>}
      {!sub && c.kind === 'expense' && <Badge tone={c.nature === 'fixed' ? 'violet' : 'cyan'}>{c.nature === 'fixed' ? 'Fixe' : 'Variable'}</Badge>}
      <div className="ml-auto flex shrink-0">
        <Button size="icon-sm" variant="ghost" aria-label="Monter" onClick={() => move(list, i, -1)} disabled={i === 0}><ArrowUp className="h-3.5 w-3.5" /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="Descendre" onClick={() => move(list, i, 1)} disabled={i === list.length - 1}><ArrowDown className="h-3.5 w-3.5" /></Button>
        {!sub && <Button size="icon-sm" variant="ghost" aria-label="Ajouter une sous-catégorie" onClick={() => setForm({ name: '', kind: c.kind, nature: c.nature, parentId: c.id, icon: c.icon, color: c.color })}><Plus className="h-3.5 w-3.5" /></Button>}
        <Button size="icon-sm" variant="ghost" aria-label="Modifier" onClick={() => setForm({ id: c.id, name: c.name, kind: c.kind, nature: c.nature, parentId: c.parentId, icon: c.icon, color: c.color })}><Pencil className="h-3.5 w-3.5" /></Button>
        {c.archived ? (
          <Button size="icon-sm" variant="ghost" aria-label="Réactiver" onClick={() => repo.updateCategory(c.id, { archived: false })}><ArchiveRestore className="h-3.5 w-3.5" /></Button>
        ) : (
          <Button size="icon-sm" variant="ghost" aria-label="Archiver ou supprimer" onClick={() => remove(c)}><Archive className="h-3.5 w-3.5" /></Button>
        )}
      </div>
    </li>
  );

  return (
    <Card id="categories" className="mt-5" title="Catégories" subtitle="Une catégorie utilisée n’est jamais supprimée : elle est archivée pour garder l’historique lisible."
      actions={<Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setForm({ name: '', kind, nature: kind === 'expense' ? 'variable' : undefined, parentId: null, icon: 'CircleDot', color: COLOR_SWATCHES[0] })}>Nouvelle</Button>}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Dépenses' }, { value: 'income', label: 'Revenus' }, { value: 'savings', label: 'Épargne & patrimoine' }]} />
        <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" className="accent-[rgb(var(--primary))]" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Afficher les archivées</label>
      </div>
      {kind === 'savings' && <p className="mb-2 text-xs text-muted">Ces catégories qualifient des transferts vers l’épargne ou l’investissement : elles ne sont jamais comptées comme des dépenses de consommation.</p>}
      <div className="grid gap-x-6 lg:grid-cols-2">
        {tops.map((c, i) => (
          <ul key={c.id} className="min-w-0">
            {row(c, tops, i)}
            {childrenOf(c.id).map((s, j, arr) => row(s, arr, j, true))}
          </ul>
        ))}
      </div>
      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)} title={form?.id ? 'Modifier la catégorie' : form?.parentId ? 'Nouvelle sous-catégorie' : 'Nouvelle catégorie'} size="sm"
        footer={<><Button variant="ghost" onClick={() => setForm(null)}>Annuler</Button><Button variant="primary" onClick={save} disabled={!form?.name.trim()}>Enregistrer</Button></>}>
        {form && (
          <div className="space-y-4">
            <Field label="Nom" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-autofocus maxLength={60} /></Field>
            {form.kind === 'expense' && !form.parentId && (
              <Field label="Nature"><Segmented value={form.nature ?? 'variable'} onChange={(v) => setForm({ ...form, nature: v })} options={[{ value: 'fixed', label: 'Charge fixe' }, { value: 'variable', label: 'Dépense variable' }]} className="w-full" /></Field>
            )}
            <Field label="Icône">
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {ICON_NAMES.map((n) => <button key={n} type="button" aria-label={n} aria-pressed={form.icon === n} onClick={() => setForm({ ...form, icon: n })} className={cn('rounded-lg', form.icon === n && 'ring-2 ring-cyan')}><CategoryIcon icon={n} color={form.color} size="sm" /></button>)}
              </div>
            </Field>
            <Field label="Couleur">
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
      toast.success('Taux enregistré.');
      setRate('');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  const rates = [...data.rates].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <Card id="rates" className="mt-5" title="Taux de change" subtitle="Saisis manuellement et datés. Sans taux, les montants en devises étrangères sont affichés séparément et exclus des totaux.">
      {used.size > 0 && <p className="mb-3 text-xs text-muted">Devises utilisées par vos comptes : {[...used].join(', ')}.</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:items-end">
        <Field label="1 unité de">
          <Select value={base} onChange={(e) => setBase(e.target.value)}>{CURRENCIES.filter((c) => c.code !== settings.baseCurrency).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select>
        </Field>
        <Field label={`= … ${settings.baseCurrency}`}><Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="10,85" /></Field>
        <Field label="Date de valeur"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Button variant="primary" onClick={add} disabled={!rate}>Ajouter</Button>
      </div>
      {rates.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="py-1">Date</th><th>Paire</th><th className="text-right">Taux</th><th /></tr></thead>
          <tbody className="divide-y divide-line/5">
            {rates.map((r) => (
              <tr key={r.id}><td className="py-1.5">{fmt.date(r.date)}</td><td>1 {r.base} = {r.quote}</td><td className="text-right num">{r.rate.toLocaleString(settings.locale, { maximumFractionDigits: 6 })}</td><td className="text-right"><Button size="icon-sm" variant="ghost" aria-label="Supprimer le taux" onClick={() => repo.deleteRate(r.id)}><Trash2 className="h-3.5 w-3.5" /></Button></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
