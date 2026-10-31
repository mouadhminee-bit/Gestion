import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Unlink } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { errorMessage, useToast } from '@/components/ui/Toast';
import type { OccurrenceView } from '@/domain/calc/recurring';
import { linkCandidates, listOccurrences } from '@/domain/calc/recurring';
import { formatLongDate } from '@/domain/dates';
import type { ID, Transaction } from '@/domain/types';
import { cn } from '@/lib/cn';
import { t } from '@/i18n/core';

/**
 * Rapprochement manuel : associe une ou plusieurs opérations existantes à une échéance
 * (paiement total, partiel, fractionné ou anticipé). Aucune opération n'est créée et chaque
 * opération garde sa date réelle ; une opération déjà associée ailleurs n'est pas proposée.
 */
export function LinkOccurrenceDialog({ occurrence, onClose }: { occurrence: OccurrenceView | null; onClose: () => void }) {
  const { data, ctx, fmt, repo, today, uiLocale } = useApp();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  const [busy, setBusy] = useState(false);

  // Statut recalculé à chaque modification (association, dissociation) tant que la fenêtre est ouverte.
  const o = useMemo(() => {
    if (!occurrence) return null;
    const rules = data.recurringRules.filter((r) => r.id === occurrence.rule.id);
    return listOccurrences(rules, data.occurrences, data.transactions, { start: occurrence.dueDate, end: occurrence.dueDate }, today, { convert: ctx.convert, includeInactive: true })[0] ?? occurrence;
  }, [occurrence, data, ctx, today]);
  const linked = useMemo(() => (o ? data.transactions.filter((t) => t.recurringRuleId === o.rule.id && t.recurringDueDate === o.dueDate) : []), [o, data.transactions]);
  const candidates = useMemo(() => (o ? linkCandidates(o.rule, o.dueDate, data.transactions).filter((t) => !t.recurringRuleId) : []), [o, data.transactions]);
  if (!o) return null;

  const cur = o.rule.currency;
  const money = (m: number) => fmt.money(m, cur);
  const chosen = candidates.filter((t) => selected.has(t.id)).reduce((a, t) => a + t.amount, 0);
  const after = o.paid + chosen;
  const toggle = (id: ID) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const close = () => { setSelected(new Set()); onClose(); };

  async function confirm() {
    if (!o || !selected.size) return;
    setBusy(true);
    try {
      await repo.linkOccurrence(o.rule.id, o.dueDate, [...selected]);
      toast.success(t('rec.linked'));
      close();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function unlink(tx: Transaction) {
    try {
      await repo.unlinkTransaction(tx.id);
      toast.info(t('rec.unlinkedDone'));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const row = (tx: Transaction, action: ReactNode) => (
    <li key={tx.id} className="flex items-center gap-3 py-2">
      {action}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{tx.label}</span>
        <span className="block text-xs text-muted">{formatLongDate(tx.date, uiLocale)} · {ctx.accounts.get(tx.accountId)?.name}</span>
      </span>
      <span className="num text-sm font-semibold">{money(tx.amount)}</span>
    </li>
  );

  return (
    <Dialog open onOpenChange={(v) => !v && close()} title={t('rec.link.title', { date: formatLongDate(o.dueDate, uiLocale) })} description={t('rec.link.hint')} size="lg"
      footer={<>
        <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={confirm} disabled={!selected.size || busy}>{t('rec.link.confirm')}</Button>
      </>}>
      <div className="space-y-4">
        <div className="rounded-xl bg-surface-2/60 p-3 text-sm">
          <div className="num">{t('rec.link.summary', { expected: money(o.expected), paid: money(o.paid), selected: money(chosen) })}</div>
          <div className={cn('mt-1 text-xs', after > o.expected ? 'text-warning' : after === o.expected ? 'text-positive' : 'text-muted')}>
            {after > o.expected ? t('rec.link.excess', { amount: money(after - o.expected) }) : after === o.expected ? t('rec.link.full') : t('rec.link.remaining', { amount: money(o.expected - after) })}
          </div>
        </div>
        {linked.length > 0 && (
          <section>
            <h3 className="label mb-1">{t('rec.link.current')}</h3>
            <ul className="divide-y divide-line/5">
              {linked.map((tx) => row(tx, <Button size="icon-sm" variant="ghost" aria-label={t('rec.unlink')} title={t('rec.unlink')} onClick={() => unlink(tx)}><Unlink className="h-3.5 w-3.5" /></Button>))}
            </ul>
          </section>
        )}
        <section>
          <h3 className="label mb-1">{t('rec.link.candidates')}</h3>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted">{t('rec.link.none')}</p>
          ) : (
            <ul className="max-h-72 divide-y divide-line/5 overflow-y-auto">
              {candidates.map((tx) => row(tx, <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" aria-label={tx.label} checked={selected.has(tx.id)} onChange={() => toggle(tx.id)} />))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
