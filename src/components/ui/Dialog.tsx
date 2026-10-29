import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';
import { t } from '@/i18n/core';

/**
 * Fenêtre modale accessible (focus piégé, Échap, aria). Sur mobile, elle s'affiche
 * en panneau inférieur (bottom sheet) pour rester utilisable au pouce.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' };
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-[60] bg-[rgb(4_7_15/0.6)] backdrop-blur-sm animate-fade-in" />
        <RD.Content
          className={cn(
            'fixed z-[70] flex max-h-[92dvh] w-full flex-col border border-line/15 bg-surface shadow-2xl outline-none',
            'inset-x-0 bottom-0 rounded-t-3xl animate-slide-up',
            'sm:inset-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:rounded-3xl sm:animate-scale-in',
            widths[size],
          )}
          onOpenAutoFocus={(e) => {
            // Laisse le contenu choisir son autofocus (ex: champ montant).
            const el = (e.target as HTMLElement)?.querySelector?.('[data-autofocus]') as HTMLElement | null;
            if (el) {
              e.preventDefault();
              el.focus();
            }
          }}
        >
          <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line/30 sm:hidden" aria-hidden />
          <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-4 sm:px-6 sm:pt-5">
            <div className="min-w-0">
              <RD.Title className="display text-lg font-semibold">{title}</RD.Title>
              {description ? <RD.Description className="mt-0.5 text-sm text-muted">{description}</RD.Description> : <RD.Description className="sr-only">{typeof title === 'string' ? title : t('common.window')}</RD.Description>}
            </div>
            <RD.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('common.close')}>
                <X className="h-4 w-4" />
              </Button>
            </RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2 sm:px-6">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line/10 px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:px-6">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

// ---------------------------------------------------------------------------
// Confirmation des opérations destructrices
// ---------------------------------------------------------------------------

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(v: boolean) => void>();
  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const close = (v: boolean) => {
    resolver.current?.(v);
    setOpts(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!opts}
        onOpenChange={(o) => !o && close(false)}
        title={opts?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant={opts?.danger === false ? 'primary' : 'danger'} onClick={() => close(true)} data-autofocus>
              {opts?.confirmLabel ?? t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="text-sm text-muted">{opts?.message}</div>
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}
