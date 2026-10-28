import { useMemo, useState } from 'react';
import { CalendarClock, Check, CircleSlash, Link2, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
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

type Form = Omit<RecurringRule, 'id' | 'userId' | 'createdAt' | 'updatedAt'> & { id?: string };

const STATUS: Record<OccurrenceView['status'], { label: string; tone: 'positive' | 'warning' | 'neutral' | 'cyan' | 'negative' }> = {
  paid: { label: 'Payée', tone: 'positive' },
  matched: { label: 'Paiement détecté', tone: 'cyan' },
  skipped: { label: 'Ignorée', tone: 'neutral' },
  upcoming: { label: 'À venir', tone: 'neutral' },
  overdue: { label: 'En retard', tone: 'negative' },
};

export default function Recurring() {
  const { data, ctx, fmt, today, repo, settings } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [pay, setPay] = useState<{ o: OccurrenceView; date: string; amount: number | null; accountId: string } | null>(null);
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming');

  const window = view === 'upcoming' ? { start: addDays(today, -30), end: addDays(today, 60) } : { start: addDays(today, -180), end: today };
  const occ = useMemo(() => {
    const list = listOccurrences(data.recurringRules, data.occurrences, data.transactions, window, today);
    return view === 'upcoming' ? list.filter((o) => o.dueDate >= today || o.status === 'overdue') : list.reverse();
  }, [data, today, view]);

  const monthlyOut = data.recurringRules.filter((r) => r.active && r.kind === 'expense').reduce((a, r) => a + (ctx.convert(monthlyEquivalent(r), r.currency, today) ?? 0), 0);
  const monthlyIn = data.recurringRules.filter((r) => r.active && r.kind === 'income').reduce((a, r) => a + (ctx.convert(monthlyEquivalent(r), r.currency, today) ?? 0), 0);

  const newForm = (): Form => ({ kind: 'expense', label: '', amount: 0, currency: settings.baseCurrency, accountId: data.accounts.find((a) => !a.archived)?.id ?? '', categoryId: null, subcategoryId: null, payee: '', frequency: 'monthly', customInterval: 1, customUnit: 'month', startDate: today, endDate: undefined, active: true, notes: '' });

  async function save() {
    if (!form) return;
    try {
      await repo.saveRecurringRule({ ...form, endDate: form.endDate || undefined });
      toast.success('Paiement récurrent enregistré. Aucune opération n’a été créée : confirmez chaque échéance lorsqu’elle est payée.');
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
      toast.success('Échéance marquée comme payée : l’opération a été créée.');
      setPay(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function reset(o: OccurrenceView) {
    const st = data.occurrences.find((s) => s.id === o.id);
    let deleteTx = false;
    if (st?.transactionId) {
      deleteTx = await confirm({ title: 'Annuler le paiement ?', message: 'Supprimer aussi l’opération créée lors du paiement ? (Annuler conserve l’opération mais la détache de l’échéance.)', confirmLabel: 'Supprimer l’opération' });
    }
    await repo.resetOccurrence(o.rule.id, o.dueDate, deleteTx);
    toast.info('Statut de l’échéance réinitialisé.');
  }

  async function removeRule(r: Form) {
    if (!r.id) return;
    if (!(await confirm({ title: `Supprimer « ${r.label} » ?`, message: 'Les échéances futures disparaissent. Les opérations déjà payées restent dans l’historique.', confirmLabel: 'Supprimer' }))) return;
    await repo.deleteRecurringRule(r.id);
    toast.success('Paiement récurrent supprimé.');
    setForm(null);
  }

  const catsFor = (kind: 'expense' | 'income') => data.categories.filter((c) => c.kind === kind && !c.parentId && !c.archived);

  return (
    <div>
      <PageHeader
        eyebrow="Gestion"
        title="Factures & paiements récurrents"
        description="Une récurrence décrit des échéances ; elle ne crée jamais d’opération automatiquement. Marquez une échéance comme payée pour enregistrer l’opération réelle."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErrors({}); setForm(newForm()); }} disabled={!data.accounts.length}>Nouvelle récurrence</Button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="!p-4"><div className="label flex items-center gap-1">Charges / mois <InfoTip>Équivalent mensuel moyen des dépenses récurrentes actives (montant × occurrences par an ÷ 12).</InfoTip></div><div className="display mt-1 text-xl font-semibold num">{fmt.money(monthlyOut)}</div></Card>
        <Card className="!p-4"><div className="label">Revenus / mois</div><div className="display mt-1 text-xl font-semibold num text-positive">{fmt.money(monthlyIn)}</div></Card>
        <Card className="!p-4"><div className="label">En retard</div><div className="display mt-1 text-xl font-semibold num">{listOccurrences(data.recurringRules, data.occurrences, data.transactions, { start: addDays(today, -30), end: today }, today).filter((o) => o.status === 'overdue').length}</div></Card>
        <Card className="!p-4"><div className="label">Récurrences actives</div><div className="display mt-1 text-xl font-semibold num">{data.recurringRules.filter((r) => r.active).length}</div></Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-5">
        <Card className="xl:col-span-3" title="Échéancier" actions={<Segmented size="sm" value={view} onChange={setView} options={[{ value: 'upcoming', label: 'À venir (60 j)' }, { value: 'past', label: 'Historique (6 mois)' }]} />}>
          {occ.length === 0 ? (
            <EmptyState icon={<CalendarClock className="h-5 w-5" />} title="Aucune échéance" description="Ajoutez votre loyer, vos abonnements, votre salaire…" />
          ) : (
            <ul className="divide-y divide-line/5">
              {occ.map((o) => {
                const cat = o.rule.categoryId ? ctx.categories.get(o.rule.categoryId) : undefined;
                const st = STATUS[o.status];
                return (
                  <li key={o.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <CategoryIcon icon={cat?.icon ?? 'Repeat'} color={cat?.color} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{o.rule.label}</div>
                      <div className="text-xs text-muted">{formatLongDate(o.dueDate, settings.locale)} · {ctx.accounts.get(o.rule.accountId)?.name}</div>
                    </div>
                    <div className="text-right">
                      <div className={cn('num text-sm font-semibold', o.rule.kind === 'income' && 'text-positive')}>{fmt.money(o.rule.kind === 'income' ? o.rule.amount : -o.rule.amount, o.rule.currency, { sign: true })}</div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <div className="flex w-full justify-end gap-1 sm:w-auto">
                      {(o.status === 'upcoming' || o.status === 'overdue') && (
                        <>
                          <Button size="sm" variant="outline" icon={<Check className="h-3.5 w-3.5" />} onClick={() => setPay({ o, date: o.dueDate <= today ? today : o.dueDate, amount: o.rule.amount, accountId: o.rule.accountId })}>Payée</Button>
                          <Button size="sm" variant="ghost" icon={<CircleSlash className="h-3.5 w-3.5" />} onClick={() => repo.skipOccurrence(o.rule.id, o.dueDate).then(() => toast.info('Échéance ignorée.'))}>Ignorer</Button>
                        </>
                      )}
                      {o.status === 'matched' && o.transactionId && (
                        <Button size="sm" variant="outline" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => repo.linkOccurrence(o.rule.id, o.dueDate, o.transactionId!).then(() => toast.success('Opération existante associée à l’échéance (pas de doublon créé).'))}>Associer</Button>
                      )}
                      {(o.status === 'paid' || o.status === 'skipped') && (
                        <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => reset(o)}>Annuler</Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="xl:col-span-2" title="Récurrences">
          {data.recurringRules.length === 0 ? (
            <EmptyState title="Aucune récurrence" />
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
                        {FREQUENCY_LABELS[r.frequency]}{r.frequency === 'custom' ? ` (tous les ${r.customInterval} ${{ day: 'j', week: 'sem.', month: 'mois', year: 'ans' }[r.customUnit ?? 'day']})` : ''} · {r.active ? (next ? `prochaine le ${fmt.date(next)}` : 'terminée') : 'désactivée'}
                      </div>
                    </div>
                    <div className={cn('num text-sm font-semibold', r.kind === 'income' && 'text-positive')}>{fmt.money(r.amount, r.currency)}</div>
                    <Button size="icon-sm" variant="ghost" aria-label={`Modifier ${r.label}`} onClick={() => { setErrors({}); setForm({ ...r }); }}><Pencil className="h-3.5 w-3.5" /></Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)} title={form?.id ? 'Modifier la récurrence' : 'Nouvelle récurrence'} size="lg"
        footer={<>
          {form?.id && <Button variant="danger" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} onClick={() => removeRule(form)}>Supprimer</Button>}
          <Button variant="ghost" onClick={() => setForm(null)}>Annuler</Button>
          <Button variant="primary" onClick={save}>Enregistrer</Button>
        </>}>
        {form && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type" className="sm:col-span-2"><Segmented value={form.kind} onChange={(v) => setForm({ ...form, kind: v, categoryId: null, subcategoryId: null })} options={[{ value: 'expense', label: 'Dépense récurrente' }, { value: 'income', label: 'Revenu récurrent' }]} className="w-full" /></Field>
            <Field label="Libellé" required error={errors.label}><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Ex : Loyer" data-autofocus /></Field>
            <Field label="Montant" required error={errors.amount}><MoneyInput value={form.amount || null} onChange={(v) => setForm({ ...form, amount: v ?? 0 })} currency={ctx.accounts.get(form.accountId)?.currency ?? settings.baseCurrency} /></Field>
            <Field label="Compte" error={errors.accountId}>
              <Select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>{data.accounts.filter((a) => !a.archived || a.id === form.accountId).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</Select>
            </Field>
            <Field label="Catégorie">
              <Select value={form.categoryId ?? ''} onChange={(e) => setForm({ ...form, categoryId: e.target.value || null, subcategoryId: null })}>
                <option value="">—</option>
                {catsFor(form.kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Fréquence">
              <Select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}>{Object.entries(FREQUENCY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            </Field>
            {form.frequency === 'custom' ? (
              <Field label="Tous les" error={errors.customInterval}>
                <div className="flex gap-2">
                  <Input type="number" min={1} value={form.customInterval ?? 1} onChange={(e) => setForm({ ...form, customInterval: Number(e.target.value) })} className="w-24" />
                  <Select value={form.customUnit} onChange={(e) => setForm({ ...form, customUnit: e.target.value as CustomUnit })}><option value="day">jours</option><option value="week">semaines</option><option value="month">mois</option><option value="year">ans</option></Select>
                </div>
              </Field>
            ) : <div className="hidden sm:block" />}
            <Field label="Date de la première échéance" error={errors.startDate} hint="Fins de mois gérées : un 31 devient le 30 ou le 28/29 selon le mois."><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label="Date de fin (facultatif)" error={errors.endDate}><Input type="date" value={form.endDate ?? ''} onChange={(e) => setForm({ ...form, endDate: e.target.value || undefined })} /></Field>
            <Field label="Bénéficiaire"><Input value={form.payee ?? ''} onChange={(e) => setForm({ ...form, payee: e.target.value })} /></Field>
            <div className="flex items-end"><Switch checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label="Récurrence active" /></div>
            <Field label="Notes" className="sm:col-span-2"><Textarea value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="min-h-[60px]" /></Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!pay} onOpenChange={(o) => !o && setPay(null)} title="Confirmer le paiement" description={pay ? `${pay.o.rule.label} — échéance du ${fmt.date(pay.o.dueDate)}` : ''} size="sm"
        footer={<><Button variant="ghost" onClick={() => setPay(null)}>Annuler</Button><Button variant="primary" onClick={confirmPay} disabled={!pay?.amount}>Créer l’opération</Button></>}>
        {pay && (
          <div className="space-y-4">
            <p className="text-xs text-muted">Une opération réelle sera créée et liée à cette échéance. Ajustez si le montant ou la date diffèrent.</p>
            <Field label="Montant réellement payé"><MoneyInput value={pay.amount} onChange={(v) => setPay({ ...pay, amount: v })} currency={pay.o.rule.currency} data-autofocus /></Field>
            <Field label="Date du paiement"><Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
            <Field label="Compte"><Select value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })}>{data.accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}
