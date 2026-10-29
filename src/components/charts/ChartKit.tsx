/**
 * Utilitaires communs aux graphiques (Recharts) : couleurs issues des jetons du
 * thème, infobulle stylée, formatage des axes respectant le mode confidentialité.
 * Les graphiques reçoivent toujours des montants en unités minimales calculés par
 * le domaine ; la conversion en décimal ne sert qu'à l'affichage.
 */
import { useMemo, type ReactNode } from 'react';
import { useApp } from '@/app/AppContext';
import { fromMajor, toMajor } from '@/domain/money';
import { t } from '@/i18n/core';

export const SERIES = {
  income: 'rgb(var(--positive))',
  expense: 'rgb(var(--negative))',
  primary: 'rgb(var(--primary))',
  cyan: 'rgb(var(--cyan))',
  violet: 'rgb(var(--violet))',
  warning: 'rgb(var(--warning))',
  muted: 'rgb(var(--muted))',
  grid: 'rgb(var(--chart-grid) / 0.12)',
};

export function useChart() {
  const { fmt, settings } = useApp();
  return useMemo(() => {
    const cur = settings.baseCurrency;
    return {
      /** Valeur décimale pour l'axe (Recharts) à partir d'unités minimales. */
      major: (minor: number) => toMajor(minor, cur),
      axisMoney: (major: number) => (fmt.hidden ? '•••' : new Intl.NumberFormat(settings.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(major)),
      money: (major: number) => fmt.money(fromMajor(major, cur), cur),
      percent: (r: number) => fmt.percent(r, 0),
      duration: 700,
      animate: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
      axis: { stroke: 'rgb(var(--muted))', fontSize: 11, tickLine: false, axisLine: false } as const,
    };
  }, [fmt, settings.baseCurrency, settings.locale]);
}

interface TooltipPayload {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

export function ChartTooltip({ active, payload, label, valueFormatter, labelFormatter }: { active?: boolean; payload?: TooltipPayload[]; label?: ReactNode; valueFormatter: (v: number, key?: string) => string; labelFormatter?: (l: ReactNode) => ReactNode }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line/15 bg-surface-3/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      {label != null && <div className="mb-1.5 font-medium text-fg">{labelFormatter ? labelFormatter(label) : label}</div>}
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
              {p.name}
            </span>
            <span className="num font-semibold text-fg">{typeof p.value === 'number' ? valueFormatter(p.value, String(p.dataKey)) : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LegendDot({ color, label, value }: { color: string; label: ReactNode; value?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
      <span className="flex min-w-0 items-center gap-2 text-muted">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate">{label}</span>
      </span>
      {value != null && <span className="num shrink-0 font-medium text-fg">{value}</span>}
    </div>
  );
}

export function NoData({ children = t('common.noChartData'), height = 200 }: { children?: ReactNode; height?: number }) {
  return (
    <div className="flex items-center justify-center rounded-xl border border-dashed border-line/20 px-4 text-center text-xs text-muted" style={{ height }}>
      {children}
    </div>
  );
}
