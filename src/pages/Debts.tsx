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
      toast.success('Engagement enregistré.');
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
      toast.success('Remboursement enregistré, solde restant mis à jour.');
      setPayment(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(d: { id?: string; label: string }) {
    if (!d.id) return;
    if (!(await confirm({ title: `Supprimer « ${d.label} » ?`, message: 'L’engagement, ses remboursements et les opérations bancaires liées seront supprimés ; les soldes des comptes seront recalculés.', confirmLabel: 'Supprimer' }))) return;
    await repo.deleteDebt(d.id);
    toast.success('Engagement supprimé.');
    setForm(null);
  }

  return (
    <div>
      <PageHeader
        eyebrow="Gestion"
        title="Dettes & créances"
        description="Le remboursement du principal réduit un engagement : ce n’est pas une dépense de consommation. Seuls les intérêts sont comptés en dépense (ou en revenu pour une créance)."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErrors({}); setForm(newForm()); }}>Nouvel engagement</Button>}
      />
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="!p-4"><div className="label">Je dois (restant)</div><div className="display mt-1 text-2xl font-semibold num text-negative">{fmt.money(totals.owe)}</div></Card>
        <Card className="!p-4"><div className="label">On me doit (restant)</div><div className="display mt-1 text-2xl font-semibold num text-positive">{fmt.money(totals.owed)}</div></Card>
        <Card className="!p-4"><div className="label">Engagements en retard</div><div className={cn('display mt-1 text-2xl font-semibold num', totals.overdue && 'text-warning')}>{totals.overdue}</div></Card>
      </div>
      <div className="mb-4"><Segmented value={tab} onChange={setTab} options={[{ value: 'active', label: 'En cours' }, { value: 'settled', label: 'Soldés / archivés' }]} /></div>

      {list.length === 0 ? (
        <EmptyState icon={<HandCoins className="h-5 w-5" />} title="Aucun engagement" description="Crédit, prêt à un proche, somme empruntée, remboursement attendu…" />
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
                      <Badge tone={payable ? 'negative' : 'positive'}>{payable ? 'Je dois' : 'On me doit'}</Badge>
                      <Badge>{DEBT_TYPE_LABELS[d.type]}</Badge>
                      {st.overdue && <Badge tone="warning">En retard</Badge>}
                      {st.settled && <Badge tone="positive">Soldé</Badge>}
                    </div>
                    {d.counterparty && <div className="mt-1.5 text-xs text-muted">Contrepartie : {d.counterparty}</div>}
                  </div>
                  <Button size="icon-sm" variant="ghost" aria-label="Modifier" onClick={() => { setErrors({}); setForm({ ...d, createOrigin: false }); }}><Pencil className="h-3.5 w-3.5" /></Button>
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <div className="label">Restant</div>
                    <div className="display text-2xl font-semibold num">{fmt.money(st.remaining, d.currency)}</div>
                  </div>
                  <div className="text-right text-xs text-muted">sur {fmt.money(d.principal, d.currency)}<br />{fmt.percent(st.progress, 0)} remboursé</div>
                </div>
                <ProgressBar className="mt-2" value={st.progress ?? 0} tone={payable ? 'violet' : 'positive'} />
                <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
                  <dt className="text-muted">Début</dt><dd className="text-right">{fmt.date(d.startDate)}</dd>
                  <dt className="text-muted">Échéance</dt><dd className={cn('text-right', st.overdue && 'text-warning')}>{d.dueDate ? fmt.date(d.dueDate) : '—'}</dd>
                  {d.interestRate != null && <><dt className="text-muted">Taux annuel</dt><dd className="text-right">{d.interestRate.toLocaleString(settings.locale)} %</dd></>}
                  {d.installmentAmount != null && <><dt className="text-muted">Échéance prévue</dt><dd className="text-right num">{fmt.money(d.installmentAmount, d.currency)} / {d.installmentFrequency === 'monthly' ? 'mois' : d.installmentFrequency === 'quarterly' ? 'trimestre' : 'an'}</dd></>}
                  <dt className="text-muted">Intérêts payés</dt><dd className="text-right num">{fmt.money(st.paidInterest, d.currency)}</dd>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  {!st.settled && <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setPayment({ debt: d, principal: d.installmentAmount ? Math.min(d.installmentAmount, st.remaining) : null, interest: 0, date: today, accountId: data.accounts.find((a) => !a.archived && a.currency === d.currency)?.id ?? '', note: '' })}>{payable ? 'Ajouter un remboursement' : 'Enregistrer un encaissement'}</Button>}
                  <Button size="sm" variant="ghost" icon={<Receipt className="h-3.5 w-3.5" />} onClick={() => setDetail(d)}>Historique ({st.paymentCount})</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)} title={form?.id ? 'Modifier l’engagement' : 'Nouvel engagement'} size="lg"
        footer={<>
          {form?.id && <Button variant="danger" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} onClick={() => remove(form)}>Supprimer</Button>}
          <Button variant="ghost" onClick={() => setForm(null)}>Annuler</Button>
          <Button variant="primary" onClick={save}>Enregistrer</Button>
        </>}>
        {form && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Libellé" required error={errors.label}><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Ex : Crédit auto" data-autofocus /></Field>
            <Field label="Type">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as DebtType })}>
                {Object.entries(DEBT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v} — {DEBT_TYPE_DIRECTION[k as DebtType] === 'payable' ? 'je dois' : 'on me doit'}</option>)}
              </Select>
            </Field>
            <Field label="Montant initial (principal)" required error={errors.principal}><MoneyInput value={form.principal || null} onChange={(v) => setForm({ ...form, principal: v ?? 0 })} currency={form.currency} /></Field>
            <Field label="Devise"><Select value={form.currency} disabled={!!form.id} onChange={(e) => setForm({ ...form, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select></Field>
            <Field label="Date de début" error={errors.startDate}><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label="Date d’échéance (facultatif)"><Input type="date" value={form.dueDate ?? ''} onChange={(e) => setForm({ ...form, dueDate: e.target.value || undefined })} /></Field>
            <Field label="Contrepartie"><Input value={form.counterparty ?? ''} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} placeholder="Banque, personne…" /></Field>
            <Field label="Taux d’intérêt annuel (%, informatif)"><Input inputMode="decimal" value={form.interestRate ?? ''} onChange={(e) => { const v = parseFloat(e.target.value.replace(',', '.')); setForm({ ...form, interestRate: Number.isFinite(v) ? v : undefined }); }} /></Field>
            <Field label="Montant d’échéance (facultatif)"><MoneyInput value={form.installmentAmount ?? null} onChange={(v) => setForm({ ...form, installmentAmount: v ?? undefined })} currency={form.currency} /></Field>
            <Field label="Fréquence des échéances"><Select value={form.installmentFrequency ?? 'monthly'} onChange={(e) => setForm({ ...form, installmentFrequency: e.target.value as Debt['installmentFrequency'] })}><option value="monthly">Mensuelle</option><option value="quarterly">Trimestrielle</option><option value="annual">Annuelle</option></Select></Field>
            {form.id && <Field label="Statut"><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Debt['status'] })}><option value="active">En cours</option><option value="settled">Soldé</option><option value="archived">Archivé</option></Select></Field>}
            {!form.id && (
              <div className="sm:col-span-2 rounded-xl border border-line/10 bg-surface-2/50 p-3">
                <Switch checked={form.createOrigin} onChange={(v) => setForm({ ...form, createOrigin: v })} label={DEBT_TYPE_DIRECTION[form.type] === 'payable' ? 'L’argent emprunté a été versé sur un de mes comptes' : 'L’argent prêté est sorti d’un de mes comptes'} description="Crée le mouvement correspondant (ni revenu ni dépense) : le patrimoine net reste inchangé." />
                {form.createOrigin && (
                  <Select className="mt-2" value={form.originAccountId ?? ''} onChange={(e) => setForm({ ...form, originAccountId: e.target.value })}>
                    {data.accounts.filter((a) => !a.archived && a.currency === form.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                )}
              </div>
            )}
            <Field label="Notes" className="sm:col-span-2"><Textarea value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="min-h-[60px]" /></Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!payment} onOpenChange={(o) => !o && setPayment(null)} title={payment?.debt.direction === 'payable' ? 'Remboursement' : 'Encaissement'} description={payment?.debt.label} size="sm"
        footer={<><Button variant="ghost" onClick={() => setPayment(null)}>Annuler</Button><Button variant="primary" onClick={savePayment}>Enregistrer</Button></>}>
        {payment && (
          <div className="space-y-4">
            <Field label={<span className="inline-flex items-center gap-1">Part de principal <InfoTip>Réduit le montant restant dû. N’est pas une dépense de consommation.</InfoTip></span>}><MoneyInput value={payment.principal} onChange={(v) => setPayment({ ...payment, principal: v })} currency={payment.debt.currency} data-autofocus /></Field>
            <Field label={<span className="inline-flex items-center gap-1">Part d’intérêts <InfoTip>Comptée en dépense (catégorie « Échéances de crédit ») pour une dette, en revenu pour une créance.</InfoTip></span>}><MoneyInput value={payment.interest} onChange={(v) => setPayment({ ...payment, interest: v })} currency={payment.debt.currency} /></Field>
            <Field label="Date"><Input type="date" value={payment.date} onChange={(e) => setPayment({ ...payment, date: e.target.value })} /></Field>
            <Field label="Compte concerné" hint="Laissez vide si le paiement ne passe pas par un compte suivi.">
              <Select value={payment.accountId} onChange={(e) => setPayment({ ...payment, accountId: e.target.value })}>
                <option value="">Aucun compte</option>
                {data.accounts.filter((a) => !a.archived && a.currency === payment.debt.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>
            <Field label="Note"><Input value={payment.note} onChange={(e) => setPayment({ ...payment, note: e.target.value })} /></Field>
            <p className="text-xs text-muted">Restant actuel : <b className="num">{fmt.money(statuses.get(payment.debt.id)!.remaining, payment.debt.currency)}</b></p>
          </div>
        )}
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)} title={`Historique — ${detail?.label ?? ''}`} size="md">
        {detail && (() => {
          const pays = data.debtPayments.filter((p) => p.debtId === detail.id).sort((a, b) => b.date.localeCompare(a.date));
          if (!pays.length) return <p className="py-6 text-center text-sm text-muted">Aucun remboursement enregistré.</p>;
          return (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted"><th className="py-2">Date</th><th className="text-right">Principal</th><th className="text-right">Intérêts</th><th className="pl-2">Compte</th><th /></tr></thead>
              <tbody className="divide-y divide-line/5">
                {pays.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2">{fmt.date(p.date)}</td>
                    <td className="text-right num">{fmt.money(p.principal, detail.currency)}</td>
                    <td className="text-right num">{fmt.money(p.interest, detail.currency)}</td>
                    <td className="pl-2 text-muted">{p.accountId ? ctx.accounts.get(p.accountId)?.name : p.note ?? '—'}</td>
                    <td className="text-right"><Button size="icon-sm" variant="ghost" aria-label="Supprimer ce remboursement" onClick={async () => { if (await confirm({ title: 'Supprimer ce remboursement ?', message: 'Le restant dû et le solde du compte lié seront recalculés.', confirmLabel: 'Supprimer' })) { await repo.deleteDebtPayment(p.id); toast.success('Remboursement supprimé.'); } }}><Trash2 className="h-3.5 w-3.5" /></Button></td>
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
