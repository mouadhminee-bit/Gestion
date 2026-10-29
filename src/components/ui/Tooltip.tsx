import * as RT from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '@/i18n/core';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RT.Provider delayDuration={200} skipDelayDuration={100}>
      {children}
    </RT.Provider>
  );
}

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          collisionPadding={12}
          className="z-[80] max-w-[280px] rounded-xl border border-line/15 bg-surface-3 px-3 py-2 text-xs leading-relaxed text-fg shadow-xl animate-fade-in"
        >
          {content}
          <RT.Arrow className="fill-[rgb(var(--surface-3))]" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}

/** Icône (i) expliquant un indicateur — accessible au clavier et au toucher. */
export function InfoTip({ children, label = t('common.definition') }: { children: ReactNode; label?: string }) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted/80 transition hover:text-cyan focus-visible:text-cyan"
        onClick={(e) => e.preventDefault()}
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}
