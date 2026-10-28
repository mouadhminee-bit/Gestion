import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { iconFor } from '@/lib/icons';
import { useApp } from '@/app/AppContext';
import type { CurrencyCode } from '@/domain/money';

export type Tone = 'neutral' | 'primary' | 'positive' | 'negative' | 'warning' | 'cyan' | 'violet';

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-surface-3/70 text-muted border-line/15',
  primary: 'bg-primary/15 text-primary border-primary/25',
  positive: 'bg-positive/12 text-positive border-positive/25',
  negative: 'bg-negative/12 text-negative border-negative/25',
  warning: 'bg-warning/12 text-warning border-warning/25',
  cyan: 'bg-cyan/12 text-cyan border-cyan/25',
  violet: 'bg-violet/15 text-violet border-violet/25',
};

export function Badge({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', toneClasses[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

/** Montant formaté (masqué en mode confidentialité), coloré selon le signe si demandé. */
export function Amount({
  value,
  currency,
  sign,
  colored,
  className,
  compact,
}: {
  value: number;
  currency?: CurrencyCode;
  sign?: boolean;
  colored?: boolean;
  className?: string;
  compact?: boolean;
}) {
  const { fmt } = useApp();
  return (
    <span className={cn('num whitespace-nowrap', colored && (value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : 'text-muted'), className)}>
      {fmt.money(value, currency, { sign, compact })}
    </span>
  );
}

/** Montant animé (interpolation douce lors des mises à jour). */
export function AnimatedAmount({ value, currency, className }: { value: number; currency?: CurrencyCode; className?: string }) {
  const { fmt } = useApp();
  const [display, setDisplay] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from.current === value) {
      setDisplay(value);
      from.current = value;
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / 650);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(a + (value - a) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value]);
  return <span className={cn('num', className)}>{fmt.money(display, currency)}</span>;
}

export function ProgressBar({ value, tone = 'primary', className, label }: { value: number; tone?: Tone | 'auto'; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(1, value));
  const auto = value > 1 ? 'negative' : value >= 0.9 ? 'warning' : 'positive';
  const t = tone === 'auto' ? auto : tone;
  const colors: Record<string, string> = {
    primary: 'from-primary to-violet',
    positive: 'from-positive to-cyan',
    negative: 'from-negative to-warning',
    warning: 'from-warning to-negative',
    cyan: 'from-cyan to-primary',
    violet: 'from-violet to-primary',
    neutral: 'from-muted to-muted',
  };
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-surface-3/80', className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
      <div className={cn('h-full rounded-full bg-gradient-to-r transition-[width] duration-700 ease-out', colors[t])} style={{ width: `${v * 100}%` }} />
    </div>
  );
}

function glowOf(color: string): string {
  if (color.startsWith('rgb(var(')) return color.replace('))', ') / 0.45)');
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}73`;
  return color;
}

export function ProgressRing({ value, size = 64, stroke = 6, color = 'rgb(var(--cyan))', children, label }: { value: number; size?: number; stroke?: number; color?: string; children?: ReactNode; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(v));
    return () => cancelAnimationFrame(id);
  }, [v]);
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} role="img" aria-label={label ?? `${Math.round(v * 100)} %`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--surface-3))" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - shown)}
          style={{ transition: 'stroke-dashoffset 900ms cubic-bezier(0.2,0.8,0.2,1)', filter: `drop-shadow(0 0 6px ${glowOf(color)})` }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-2xl border border-dashed border-line/20 px-6 py-10 text-center', className)}>
      {icon && <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">{icon}</div>}
      <div className="text-sm font-semibold">{title}</div>
      {description && <p className="mt-1 max-w-sm text-xs text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function CategoryIcon({ icon, color, size = 'md', className }: { icon?: string; color?: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const Icon = iconFor(icon);
  const dims = { sm: 'h-7 w-7 rounded-lg', md: 'h-9 w-9 rounded-xl', lg: 'h-11 w-11 rounded-2xl' }[size];
  const iconSize = { sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-5 w-5' }[size];
  const c = color ?? '#94A3B8';
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center', dims, className)} style={{ backgroundColor: `${c}1f`, color: c, boxShadow: `inset 0 0 0 1px ${c}33` }}>
      <Icon className={iconSize} aria-hidden />
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />;
}

export function Stat({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="label">{label}</div>
      <div className="mt-1 truncate text-base font-semibold num">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function DemoBadge() {
  return (
    <Badge tone="warning" className="uppercase tracking-wide">
      Données fictives
    </Badge>
  );
}
