import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

type ToastKind = 'success' | 'error' | 'info' | 'warning';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: ReactNode;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  success: (m: ReactNode, action?: ToastItem['action']) => void;
  error: (m: ReactNode) => void;
  info: (m: ReactNode) => void;
  warning: (m: ReactNode) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);
let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, message: ReactNode, action?: ToastItem['action']) => {
      const id = ++counter;
      setItems((l) => [...l.slice(-3), { id, kind, message, action }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 6500 : 4000);
    },
    [dismiss],
  );
  const api: ToastApi = {
    success: (m, a) => push('success', m, a),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
    warning: (m) => push('warning', m),
  };
  const icons = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };
  const tones = { success: 'text-positive', error: 'text-negative', info: 'text-cyan', warning: 'text-warning' };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-[90] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:pr-6">
        {items.map((t) => {
          const Icon = icons[t.kind];
          return (
            <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-line/15 bg-surface-3/95 px-4 py-3 text-sm shadow-2xl backdrop-blur animate-fade-up">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tones[t.kind])} aria-hidden />
              <div className="min-w-0 flex-1">{t.message}</div>
              {t.action && (
                <button className="shrink-0 text-xs font-semibold text-cyan hover:underline" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>
                  {t.action.label}
                </button>
              )}
              <button aria-label="Fermer" className="shrink-0 text-muted hover:text-fg" onClick={() => dismiss(t.id)}>
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast hors ToastProvider');
  return v;
}

/** Message d'erreur lisible pour l'utilisateur, sans détails techniques sensibles. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.name === 'ValidationError') return e.message;
  if (e instanceof Error && /QuotaExceeded/i.test(e.name + e.message)) return 'Espace de stockage du navigateur insuffisant.';
  if (e instanceof Error && e.message && e.message.length < 160) return e.message;
  return 'Une erreur inattendue est survenue. Vos données n’ont pas été modifiées.';
}
