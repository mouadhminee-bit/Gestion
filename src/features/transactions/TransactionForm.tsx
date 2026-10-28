/**
 * Saisie rapide d'une opération : type → montant → catégorie → compte → date → enregistrer.
 * Valeurs par défaut intelligentes (dernier compte utilisé, aujourd'hui), raccourcis
 * de catégories fréquentes, détails avancés repliés (divulgation progressive).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChevronDown, Paperclip, RotateCcw, Scale, Trash2, AlertTriangle, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApp } from '@/app/AppContext';
import { Dialog, useConfirm } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field, Input, MoneyInput, Segmented, Select, Textarea } from '@/components/ui/Field';
import { CategoryIcon } from '@/components/ui/Misc';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/cn';
import type { Category, ID, Transaction } from '@/domain/types';
import { PAYMENT_METHOD_LABELS } from '@/domain/types';
import type { EditableTransactionType, TransactionDraft, ValidationErrors } from '@/domain/validation';
import { hasErrors, validateTransactionDraft } from '@/domain/validation';
import { addDays } from '@/domain/dates';
import { findDuplicates } from '@/domain/duplicates';
import { ValidationError } from '@/data/repository';

type OpenArgs = { mode: 'create'; type?: EditableTransactionType; preset?: Partial<TransactionDraft> } | { mode: 'edit'; id: ID };

const FormCtx = createContext<(args?: OpenArgs) => void>(() => {});

export function useTransactionForm() {
  return useContext(FormCtx);
}

const LAST_ACCOUNT_KEY = 'nexora.lastAccount';

export function TransactionFormProvider({ children }: { children: ReactNode }) {
  const [args, setArgs] = useState<OpenArgs | null>(null);
  const open = useCallback((a: OpenArgs = { mode: 'create' }) => setArgs(a), []);
  // Raccourci clavier « N » : nouvelle opération (hors champs de saisie).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (el.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      setArgs({ mode: 'create' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <FormCtx.Provider value={open}>
      {children}
      {args && <TransactionDialog key={JSON.stringify(args)} args={args} onClose={() => setArgs(null)} onReopen={(a) => setArgs(a)} />}
    </FormCtx.Provider>
  );
}

const TYPE_OPTIONS: { value: EditableTransactionType; label: ReactNode; tone: string }[] = [
  { value: 'expense', label: <span className="inline-flex items-center gap-1"><ArrowUpRight className="h-3.5 w-3.5" />Dépense</span>, tone: 'text-negative' },
  { value: 'income', label: <span className="inline-flex items-center gap-1"><ArrowDownLeft className="h-3.5 w-3.5" />Revenu</span>, tone: 'text-positive' },
  { value: 'transfer', label: <span className="inline-flex items-center gap-1"><ArrowLeftRight className="h-3.5 w-3.5" />Transfert</span>, tone: 'text-cyan' },
  { value: 'refund', label: <span className="inline-flex items-center gap-1"><RotateCcw className="h-3.5 w-3.5" />Rembours.</span>, tone: 'text-positive' },
  { value: 'adjustment', label: <span className="inline-flex items-center gap-1"><Scale className="h-3.5 w-3.5" />Ajust.</span>, tone: 'text-warning' },
];

function draftFromGroup(group: Transaction[]): TransactionDraft {
  const main = group.find((t) => t.direction === 'out' && t.type === 'transfer') ?? group[0];
  const counter = group.find((t) => t !== main);
  return {
    type: main.type as EditableTransactionType,
    amount: main.amount,
    direction: main.direction,
    label: main.label,
    date: main.date,
    categoryId: main.categoryId,
    subcategoryId: main.subcategoryId,
    accountId: main.accountId,
    toAccountId: counter?.accountId ?? null,
    toAmount: counter?.amount ?? null,
    paymentMethod: main.paymentMethod,
    payee: main.payee ?? '',
    notes: main.notes ?? '',
    tags: main.tags,
    status: main.status,
    refundOfId: main.refundOfId,
  };
}

function TransactionDialog({ args, onClose, onReopen }: { args: OpenArgs; onClose: () => void; onReopen: (a: OpenArgs) => void }) {
  const { data, repo, today, ctx, fmt } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const editing = args.mode === 'edit' ? data.transactions.find((t) => t.id === args.id) : undefined;
  const group = useMemo(
    () => (editing?.transferId ? data.transactions.filter((t) => t.transferId === editing.transferId) : editing ? [editing] : []),
    [editing, data.transactions],
  );
  const activeAccounts = data.accounts.filter((a) => !a.archived);
  const defaultAccount = (() => {
    try {
      const last = localStorage.getItem(LAST_ACCOUNT_KEY);
      if (last && activeAccounts.some((a) => a.id === last)) return last;
    } catch {
      /* ignore */
    }
    return activeAccounts.find((a) => a.type === 'bank')?.id ?? activeAccounts[0]?.id ?? null;
  })();

  const [draft, setDraft] = useState<TransactionDraft>(() => {
    if (editing) return draftFromGroup(group);
    const type = (args.mode === 'create' && args.type) || 'expense';
    return {
      type,
      amount: null,
      direction: 'out',
      label: '',
      date: today,
      categoryId: null,
      subcategoryId: null,
      accountId: defaultAccount,
      toAccountId: null,
      toAmount: null,
      paymentMethod: 'card',
      payee: '',
      notes: '',
      tags: [],
      status: 'cleared',
      ...(args.mode === 'create' ? args.preset : {}),
    };
  });
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [showMore, setShowMore] = useState(!!editing && !!(editing.notes || editing.tags.length || editing.payee));
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [dupAck, setDupAck] = useState(false);
  const [tagText, setTagText] = useState(draft.tags.join(', '));

  const set = <K extends keyof TransactionDraft>(k: K, v: TransactionDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const account = draft.accountId ? ctx.accounts.get(draft.accountId) : undefined;
  const toAccount = draft.toAccountId ? ctx.accounts.get(draft.toAccountId) : undefined;
  const currency = account?.currency ?? data.settings.baseCurrency;
  const crossCurrency = draft.type === 'transfer' && account && toAccount && account.currency !== toAccount.currency;

  const catKind = draft.type === 'income' ? 'income' : draft.type === 'transfer' ? 'savings' : 'expense';
  const allowedCats = data.categories.filter((c) => c.kind === catKind && !c.parentId && (!c.archived || c.id === draft.categoryId));
  const subcats = data.categories.filter((c) => c.parentId && c.parentId === draft.categoryId && (!c.archived || c.id === draft.subcategoryId));

  // Catégories fréquentes (90 derniers jours) pour ce type.
  const frequent = useMemo(() => {
    const since = addDays(today, -90);
    const counts = new Map<ID, number>();
    for (const t of data.transactions) {
      if (t.date < since || !t.categoryId || t.type !== draft.type) continue;
      counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
    }
    // À fréquence égale (ex : nouvel utilisateur), les dépenses courantes (variables) passent avant les charges fixes.
    const variableFirst = (c: Category) => (c.nature === 'fixed' ? 1 : 0);
    const ranked = allowedCats.filter((c) => !c.archived).sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || variableFirst(a) - variableFirst(b) || a.order - b.order);
    return ranked.slice(0, 6);
  }, [data.transactions, draft.type, data.categories]);

  const recentExpenses = useMemo(
    () => (draft.type === 'refund' ? data.transactions.filter((t) => t.type === 'expense' && (!draft.categoryId || t.categoryId === draft.categoryId)).slice(0, 30) : []),
    [draft.type, draft.categoryId, data.transactions],
  );

  const duplicate = useMemo(() => {
    if (editing || !draft.amount || !draft.accountId || draft.type === 'transfer') return undefined;
    const direction = draft.type === 'expense' ? 'out' : draft.type === 'adjustment' ? draft.direction ?? 'out' : 'in';
    return findDuplicates([{ accountId: draft.accountId, amount: draft.amount, date: draft.date, direction, label: draft.label || (draft.categoryId ? ctx.categories.get(draft.categoryId)?.name ?? '' : '') }], data.transactions)[0];
  }, [editing, draft, data.transactions, ctx.categories]);

  const isDebtTx = editing?.type === 'debt';

  async function save(again = false) {
    const d: TransactionDraft = {
      ...draft,
      tags: tagText.split(',').map((t) => t.trim()).filter(Boolean),
      label: draft.label.trim() || (draft.categoryId ? ctx.categories.get(draft.subcategoryId ?? draft.categoryId)?.name ?? '' : '') || (draft.type === 'adjustment' ? 'Ajustement de solde' : ''),
    };
    const v = validateTransactionDraft(d, {
      accounts: ctx.accounts,
      categories: ctx.categories,
      existing: editing ? { accountIds: group.flatMap((t) => [t.accountId]), categoryIds: group.flatMap((t) => [t.categoryId, t.subcategoryId].filter(Boolean) as ID[]) } : undefined,
    });
    if (hasErrors(v)) {
      setErrors(v);
      if (v.notes || v.tags || v.payee) setShowMore(true);
      return;
    }
    if (duplicate && !dupAck) {
      setDupAck(true);
      return;
    }
    setSaving(true);
    try {
      const records = editing ? await repo.updateTransaction(editing.id, d) : await repo.createTransaction(d);
      if (file) await repo.addAttachment(records[0].id, file);
      try {
        if (d.accountId) localStorage.setItem(LAST_ACCOUNT_KEY, d.accountId);
      } catch {
        /* ignore */
      }
      toast.success(editing ? 'Opération modifiée.' : `${d.type === 'transfer' ? 'Transfert' : 'Opération'} enregistré${d.type === 'transfer' ? '' : 'e'} : ${fmt.money(d.amount!, currency)}`);
      if (again) onReopen({ mode: 'create', type: d.type, preset: { accountId: d.accountId, date: d.date } });
      else onClose();
    } catch (e) {
      if (e instanceof ValidationError) setErrors(e.fields as ValidationErrors);
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editing) return;
    const ok = await confirm({
      title: 'Supprimer cette opération ?',
      message: editing.transferId ? 'Les deux mouvements du transfert seront supprimés et les soldes recalculés.' : 'Cette action est définitive. Les soldes et indicateurs seront recalculés.',
      confirmLabel: 'Supprimer',
    });
    if (!ok) return;
    try {
      await repo.deleteTransactions([editing.id]);
      toast.success('Opération supprimée.');
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function openAttachment() {
    if (!editing?.attachmentId) return;
    const att = await repo.getAttachment(editing.attachmentId);
    if (!att) return;
    const url = URL.createObjectURL(att.blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  if (args.mode === 'edit' && !editing) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title="Opération introuvable" size="sm">
        <p className="text-sm text-muted">Cette opération a été supprimée.</p>
      </Dialog>
    );
  }

  if (isDebtTx && editing) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title={editing.label} description="Opération liée à une dette ou une créance" size="sm"
        footer={<Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={remove}>Supprimer</Button>}>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt className="text-muted">Montant</dt><dd className="text-right num">{fmt.money(editing.amount, editing.currency)}</dd>
          <dt className="text-muted">dont intérêts</dt><dd className="text-right num">{fmt.money(editing.interestAmount ?? 0, editing.currency)}</dd>
          <dt className="text-muted">Date</dt><dd className="text-right">{fmt.date(editing.date)}</dd>
          <dt className="text-muted">Compte</dt><dd className="text-right">{ctx.accounts.get(editing.accountId)?.name}</dd>
        </dl>
        <p className="mt-4 rounded-xl bg-surface-2 p-3 text-xs text-muted">
          Le principal n'est ni un revenu ni une dépense : seuls les intérêts sont comptabilisés. Gérez cet engagement depuis le module{' '}
          <Link to="/debts" onClick={onClose} className="text-cyan underline">Dettes & créances</Link>.
        </p>
      </Dialog>
    );
  }

  const footer = (
    <>
      {editing && (
        <Button variant="danger" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} onClick={remove}>
          <span className="hidden sm:inline">Supprimer</span>
        </Button>
      )}
      {!editing && (
        <Button variant="ghost" onClick={() => save(true)} disabled={saving}>
          Enregistrer + nouveau
        </Button>
      )}
      <Button variant="primary" loading={saving} onClick={() => save(false)} className="min-w-[140px]">
        {dupAck && duplicate ? 'Enregistrer quand même' : editing ? 'Enregistrer' : 'Ajouter'}
      </Button>
    </>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={editing ? 'Détail de l’opération' : 'Nouvelle opération'} size="md" footer={footer}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
      >
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <Segmented
            value={draft.type}
            onChange={(t) => {
              setDraft((d) => ({ ...d, type: t, categoryId: null, subcategoryId: null, direction: t === 'adjustment' ? d.direction ?? 'out' : d.direction }));
              setErrors({});
            }}
            options={TYPE_OPTIONS}
            className="w-full min-w-[460px] sm:min-w-0"
            size="sm"
          />
        </div>

        <Field label={draft.type === 'transfer' ? 'Montant débité' : 'Montant'} error={errors.amount} required>
          <MoneyInput value={draft.amount} onChange={(v) => set('amount', v)} currency={currency} size="xl" invalid={!!errors.amount} data-autofocus placeholder="0" aria-label="Montant" />
        </Field>

        {draft.type === 'adjustment' && (
          <Field label="Sens de la correction" error={errors.direction}>
            <Segmented value={draft.direction ?? 'out'} onChange={(v) => set('direction', v)} options={[{ value: 'in', label: 'Augmenter le solde' }, { value: 'out', label: 'Diminuer le solde' }]} className="w-full" />
          </Field>
        )}

        {draft.type !== 'adjustment' && (
          <Field label={draft.type === 'transfer' ? 'Affectation (facultatif)' : draft.type === 'refund' ? 'Catégorie remboursée' : 'Catégorie'} error={errors.categoryId} required={draft.type === 'expense' || draft.type === 'income'}>
            {frequent.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {frequent.map((c) => (
                  <CategoryChip key={c.id} c={c} active={draft.categoryId === c.id} onClick={() => setDraft((d) => ({ ...d, categoryId: d.categoryId === c.id ? null : c.id, subcategoryId: null }))} />
                ))}
              </div>
            )}
            <div className={cn('grid gap-2', subcats.length ? 'grid-cols-2' : 'grid-cols-1')}>
              <Select value={draft.categoryId ?? ''} onChange={(e) => setDraft((d) => ({ ...d, categoryId: e.target.value || null, subcategoryId: null }))} invalid={!!errors.categoryId} aria-label="Catégorie">
                <option value="">{draft.type === 'transfer' ? 'Aucune' : 'Choisir…'}</option>
                {catKind === 'expense' ? (
                  <>
                    <optgroup label="Dépenses fixes">{allowedCats.filter((c) => c.nature === 'fixed').map((c) => <option key={c.id} value={c.id}>{c.name}{c.archived ? ' (archivée)' : ''}</option>)}</optgroup>
                    <optgroup label="Dépenses variables">{allowedCats.filter((c) => c.nature !== 'fixed').map((c) => <option key={c.id} value={c.id}>{c.name}{c.archived ? ' (archivée)' : ''}</option>)}</optgroup>
                  </>
                ) : (
                  allowedCats.map((c) => <option key={c.id} value={c.id}>{c.name}{c.archived ? ' (archivée)' : ''}</option>)
                )}
              </Select>
              {subcats.length > 0 && (
                <Select value={draft.subcategoryId ?? ''} onChange={(e) => set('subcategoryId', e.target.value || null)} aria-label="Sous-catégorie" invalid={!!errors.subcategoryId}>
                  <option value="">Sous-catégorie…</option>
                  {subcats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
            </div>
          </Field>
        )}

        <div className={cn('grid gap-3', draft.type === 'transfer' ? 'sm:grid-cols-2' : 'grid-cols-1')}>
          <Field label={draft.type === 'transfer' ? 'Depuis le compte' : 'Compte'} error={errors.accountId} required>
            <Select value={draft.accountId ?? ''} onChange={(e) => set('accountId', e.target.value || null)} invalid={!!errors.accountId}>
              <option value="">Choisir…</option>
              {data.accounts.filter((a) => !a.archived || a.id === draft.accountId).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
            </Select>
          </Field>
          {draft.type === 'transfer' && (
            <Field label="Vers le compte" error={errors.toAccountId} required>
              <Select value={draft.toAccountId ?? ''} onChange={(e) => set('toAccountId', e.target.value || null)} invalid={!!errors.toAccountId}>
                <option value="">Choisir…</option>
                {data.accounts.filter((a) => (!a.archived || a.id === draft.toAccountId) && a.id !== draft.accountId).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
              </Select>
            </Field>
          )}
        </div>
        {crossCurrency && (
          <Field label={`Montant crédité (${toAccount!.currency})`} error={errors.toAmount} hint="Devises différentes : indiquez le montant réellement reçu (le taux implicite est conservé dans l’historique)." required>
            <MoneyInput value={draft.toAmount ?? null} onChange={(v) => set('toAmount', v)} currency={toAccount!.currency} invalid={!!errors.toAmount} />
          </Field>
        )}
        {draft.type === 'transfer' && (
          <p className="rounded-xl border border-cyan/20 bg-cyan/5 px-3 py-2 text-xs text-muted">
            Un transfert entre vos comptes n’est ni un revenu ni une dépense : il diminue le compte source et augmente le compte destination.
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Date" error={errors.date} required>
            <div className="flex gap-1.5">
              <Input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} invalid={!!errors.date} className="flex-1" />
              <Button size="sm" variant={draft.date === today ? 'secondary' : 'ghost'} className="h-11" onClick={() => set('date', today)}>Auj.</Button>
              <Button size="sm" variant={draft.date === addDays(today, -1) ? 'secondary' : 'ghost'} className="h-11" onClick={() => set('date', addDays(today, -1))}>Hier</Button>
            </div>
          </Field>
          <Field label="Libellé" error={errors.label} hint={!draft.label && draft.categoryId ? `Par défaut : ${ctx.categories.get(draft.subcategoryId ?? draft.categoryId)?.name}` : undefined}>
            <Input value={draft.label} onChange={(e) => set('label', e.target.value)} placeholder="Ex : Courses Marjane" maxLength={140} />
          </Field>
        </div>

        {account && draft.date < account.initialBalanceDate && (
          <p className="rounded-xl border border-line/15 bg-surface-2/60 px-3 py-2 text-xs text-muted">
            Date antérieure au solde initial de « {account.name} » ({fmt.date(account.initialBalanceDate)}) : l’opération est comptée dans les revenus/dépenses de sa période, mais ne modifie pas le solde actuel (déjà inclus dans le solde initial).
          </p>
        )}

        {draft.type === 'adjustment' && (
          <Field label="Justification" error={errors.notes} required>
            <Textarea value={draft.notes ?? ''} onChange={(e) => set('notes', e.target.value)} placeholder="Ex : écart constaté avec le relevé bancaire du 30/09" invalid={!!errors.notes} />
          </Field>
        )}

        {duplicate && (
          <div role="alert" className="flex gap-2.5 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            <div>
              <div className="font-semibold text-warning">Doublon potentiel</div>
              <div className="mt-0.5 text-muted">
                « {duplicate.label} » du {fmt.date(duplicate.date)} ({fmt.money(duplicate.amount, duplicate.currency)}) sur le même compte.
                {dupAck ? ' Cliquez à nouveau pour enregistrer quand même.' : ''}
              </div>
            </div>
          </div>
        )}

        <button type="button" onClick={() => setShowMore((v) => !v)} className="flex w-full items-center justify-between rounded-xl px-1 py-1 text-xs font-medium text-muted hover:text-fg" aria-expanded={showMore}>
          Plus de détails (bénéficiaire, mode de paiement, étiquettes, notes, justificatif)
          <ChevronDown className={cn('h-4 w-4 transition', showMore && 'rotate-180')} />
        </button>
        {showMore && (
          <div className="grid grid-cols-1 gap-3 animate-fade-in sm:grid-cols-2">
            <Field label="Bénéficiaire / commerçant">
              <Input value={draft.payee ?? ''} onChange={(e) => set('payee', e.target.value)} placeholder="Ex : Supermarché" />
            </Field>
            <Field label="Mode de paiement">
              <Select value={draft.paymentMethod ?? ''} onChange={(e) => set('paymentMethod', (e.target.value || undefined) as TransactionDraft['paymentMethod'])}>
                <option value="">—</option>
                {Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Statut">
              <Segmented value={draft.status} onChange={(v) => set('status', v)} options={[{ value: 'cleared', label: 'Effectuée' }, { value: 'pending', label: 'En attente' }]} className="w-full" />
            </Field>
            <Field label="Étiquettes" hint="Séparées par des virgules" error={errors.tags}>
              <Input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="vacances, travail" />
            </Field>
            {draft.type === 'refund' && (
              <Field label="Dépense d’origine (facultatif)" className="sm:col-span-2">
                <Select value={draft.refundOfId ?? ''} onChange={(e) => set('refundOfId', e.target.value || undefined)}>
                  <option value="">—</option>
                  {recentExpenses.map((t) => <option key={t.id} value={t.id}>{fmt.date(t.date)} · {t.label} · {fmt.money(t.amount, t.currency)}</option>)}
                </Select>
              </Field>
            )}
            {draft.type !== 'adjustment' && (
              <Field label="Notes" className="sm:col-span-2" error={errors.notes}>
                <Textarea value={draft.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
              </Field>
            )}
            <Field label="Justificatif (image ou PDF, 5 Mo max)" className="sm:col-span-2" hint="Stocké localement dans votre navigateur.">
              <div className="flex flex-wrap items-center gap-2">
                {editing?.attachmentId && (
                  <>
                    <Button size="sm" variant="outline" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={openAttachment}>Ouvrir le justificatif</Button>
                    <Button size="sm" variant="ghost" onClick={() => repo.removeAttachment(editing.id).then(() => toast.info('Justificatif retiré.'))}>Retirer</Button>
                  </>
                )}
                <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line/25 px-3 text-xs font-medium hover:bg-surface-2">
                  <Paperclip className="h-3.5 w-3.5" />
                  {file ? file.name : editing?.attachmentId ? 'Remplacer' : 'Joindre un fichier'}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </label>
              </div>
            </Field>
            {editing && (
              <p className="text-[11px] text-muted sm:col-span-2">
                Créée le {new Date(editing.createdAt).toLocaleString(data.settings.locale)} · modifiée le {new Date(editing.updatedAt).toLocaleString(data.settings.locale)}
                {editing.importBatchId ? ' · importée' : ''}
                {editing.recurringRuleId ? ' · issue d’un paiement récurrent' : ''}
              </p>
            )}
          </div>
        )}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function CategoryChip({ c, active, onClick }: { c: Category; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-xs font-medium transition',
        active ? 'border-primary/60 bg-primary/15 text-fg' : 'border-line/15 bg-surface-2/60 text-muted hover:text-fg hover:border-line/30',
      )}
    >
      <CategoryIcon icon={c.icon} color={c.color} size="sm" className="h-5 w-5 rounded-full" />
      {c.name}
    </button>
  );
}
