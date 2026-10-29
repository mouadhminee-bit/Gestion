import { ArrowLeftRight, Paperclip, RotateCcw, Scale, HandCoins, Clock } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { CategoryIcon, Badge } from '@/components/ui/Misc';
import { cn } from '@/lib/cn';
import type { Transaction } from '@/domain/types';
import { TRANSACTION_TYPE_LABELS } from '@/domain/types';
import { t as tr } from '@/i18n/core';

export function useTransactionVisual() {
  const { ctx } = useApp();
  return (t: Transaction) => {
    const cat = t.subcategoryId ? ctx.categories.get(t.subcategoryId) : t.categoryId ? ctx.categories.get(t.categoryId) : undefined;
    const parent = t.categoryId ? ctx.categories.get(t.categoryId) : undefined;
    const icon =
      t.type === 'transfer' ? 'transfer' : t.type === 'adjustment' ? 'adjustment' : t.type === 'debt' ? 'debt' : t.type === 'refund' ? 'refund' : cat?.icon ?? parent?.icon;
    return { cat, parent, icon, color: cat?.color ?? parent?.color };
  };
}

const SPECIAL = {
  transfer: { Icon: ArrowLeftRight, color: '#41E7F5' },
  adjustment: { Icon: Scale, color: '#FFBF69' },
  debt: { Icon: HandCoins, color: '#F472B6' },
  refund: { Icon: RotateCcw, color: '#25D9A0' },
} as const;

export function TxIcon({ t }: { t: Transaction }) {
  const visual = useTransactionVisual()(t);
  const special = SPECIAL[visual.icon as keyof typeof SPECIAL];
  if (special) {
    const { Icon, color } = special;
    return (
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: `${color}1f`, color, boxShadow: `inset 0 0 0 1px ${color}33` }}>
        <Icon className="h-4 w-4" />
      </span>
    );
  }
  return <CategoryIcon icon={visual.icon} color={visual.color} />;
}

export function TransactionRow({ t, onOpen, selected, onSelect, showAccount = true }: { t: Transaction; onOpen: () => void; selected?: boolean; onSelect?: (v: boolean) => void; showAccount?: boolean }) {
  const { ctx, fmt } = useApp();
  const visual = useTransactionVisual()(t);
  const account = ctx.accounts.get(t.accountId);
  const counterpart = t.counterpartAccountId ? ctx.accounts.get(t.counterpartAccountId) : undefined;
  const sign = t.direction === 'in' ? 1 : -1;
  const neutral = t.type === 'transfer' || t.type === 'adjustment' || (t.type === 'debt' && !t.interestAmount);
  const subtitle =
    t.type === 'transfer'
      ? tr(t.direction === 'out' ? 'txRow.to' : 'txRow.from', { name: counterpart?.name ?? tr('txRow.deletedAccount') })
      : visual.cat
        ? visual.parent && visual.parent.id !== visual.cat.id
          ? `${visual.parent.name} · ${visual.cat.name}`
          : visual.cat.name
        : TRANSACTION_TYPE_LABELS[t.type];
  return (
    <div className={cn('group flex items-center gap-3 rounded-xl px-2 py-2.5 transition hover:bg-surface-2/70 sm:px-3', selected && 'bg-primary/10')}>
      {onSelect && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={(e) => onSelect(e.target.checked)}
          aria-label={tr('txRow.select', { label: t.label })}
          className="h-4 w-4 shrink-0 accent-[rgb(var(--primary))]"
        />
      )}
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <TxIcon t={t} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{t.label || TRANSACTION_TYPE_LABELS[t.type]}</span>
            {t.status === 'pending' && <Clock className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={tr('txRow.pending')} />}
            {t.attachmentId && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted" aria-label={tr('txRow.attachment')} />}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
            <span className="truncate">{subtitle}</span>
            {showAccount && account && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{account.name}</span>
              </>
            )}
            {t.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} className="hidden sm:inline-flex">#{tag}</Badge>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn('num text-sm font-semibold', neutral ? 'text-fg/80' : sign > 0 ? 'text-positive' : 'text-fg')}>
            {fmt.money(sign * t.amount, t.currency, { sign: true })}
          </div>
          <div className="mt-0.5 text-[11px] text-muted">
            {fmt.date(t.date)}
            {neutral && <span className="ml-1 hidden sm:inline">· {TRANSACTION_TYPE_LABELS[t.type]}</span>}
          </div>
        </div>
      </button>
    </div>
  );
}
