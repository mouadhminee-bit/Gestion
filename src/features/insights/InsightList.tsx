import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, Lightbulb, OctagonAlert, ChevronRight } from 'lucide-react';
import type { Insight } from '@/domain/calc/insights';
import { cn } from '@/lib/cn';
import { Tooltip } from '@/components/ui/Tooltip';
import { t } from '@/i18n/core';

const STYLE = {
  success: { Icon: CheckCircle2, cls: 'text-positive bg-positive/10 border-positive/20' },
  info: { Icon: Info, cls: 'text-cyan bg-cyan/10 border-cyan/20' },
  warning: { Icon: AlertTriangle, cls: 'text-warning bg-warning/10 border-warning/20' },
  danger: { Icon: OctagonAlert, cls: 'text-negative bg-negative/10 border-negative/20' },
};

export function InsightList({ insights, limit }: { insights: Insight[]; limit?: number }) {
  const list = limit ? insights.slice(0, limit) : insights;
  return (
    <ul className="space-y-2">
      {list.map((i, idx) => {
        const { Icon, cls } = STYLE[i.severity];
        const body = (
          <>
            <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border', cls)}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{i.title}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{i.message}</p>
              <Tooltip content={<><b>{t('insight.origin')}</b><br />{i.source}</>}>
                <span tabIndex={0} className="mt-1 inline-flex cursor-help items-center gap-1 text-[11px] text-muted/80 underline decoration-dotted underline-offset-2">
                  <Lightbulb className="h-3 w-3" /> {t('insight.whereFrom')}
                </span>
              </Tooltip>
            </div>
            {i.href && <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-muted opacity-0 transition group-hover:opacity-100 rtl:-scale-x-100" />}
          </>
        );
        return (
          <li key={i.id} className="animate-fade-up" style={{ animationDelay: `${idx * 50}ms` }}>
            {i.href ? (
              <Link to={i.href} className="group flex gap-3 rounded-xl p-2 transition hover:bg-surface-2/70">
                {body}
              </Link>
            ) : (
              <div className="flex gap-3 rounded-xl p-2">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
