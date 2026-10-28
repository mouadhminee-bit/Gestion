import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { InfoTip } from './Tooltip';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  info?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
  /** Délai d'apparition (ms) pour l'animation en cascade. */
  delay?: number;
}

export function Card({ title, subtitle, info, actions, padded = true, delay, className, children, style, ...rest }: CardProps) {
  return (
    <section
      className={cn('card animate-fade-up', padded && 'p-4 sm:p-5', className)}
      style={delay != null ? { animationDelay: `${delay}ms`, ...style } : style}
      {...rest}
    >
      {(title || actions) && (
        <header className={cn('mb-4 flex items-start justify-between gap-3', !padded && 'px-4 pt-4 sm:px-5 sm:pt-5')}>
          <div className="min-w-0">
            {title && (
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                {title}
                {info && <InfoTip>{info}</InfoTip>}
              </h2>
            )}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between animate-fade-in">
      <div className="min-w-0">
        {eyebrow && <div className="label mb-1.5">{eyebrow}</div>}
        <h1 className="display text-2xl font-semibold sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
