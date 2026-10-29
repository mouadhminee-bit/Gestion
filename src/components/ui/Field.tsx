import { forwardRef, useEffect, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { CurrencyCode } from '@/domain/money';
import { currencyInfo, parseAmount, toPlainString } from '@/domain/money';

export function Field({ label, error, hint, children, className, htmlFor, required }: { label?: ReactNode; error?: string; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string; required?: boolean }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
          {label}
          {required && <span className="ms-0.5 text-negative" aria-hidden>*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-xs text-negative">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted/80">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} className={cn('input', invalid && 'input-error', className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, ...rest }, ref) {
  return <textarea ref={ref} className={cn('input h-auto min-h-[84px] py-2.5', invalid && 'input-error', className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select({ className, invalid, children, ...rest }, ref) {
  return (
    <div className="relative">
      <select ref={ref} className={cn('input appearance-none pe-9', invalid && 'input-error', className)} aria-invalid={invalid || undefined} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
});

/**
 * Saisie monétaire : clavier décimal sur mobile, conversion exacte en unités
 * minimales (sans flottant). `value` / `onChange` en unités minimales.
 */
export function MoneyInput({
  value,
  onChange,
  currency,
  invalid,
  allowNegative,
  className,
  size = 'md',
  ...rest
}: {
  value: number | null;
  onChange: (minor: number | null) => void;
  currency: CurrencyCode;
  invalid?: boolean;
  allowNegative?: boolean;
  size?: 'md' | 'xl';
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size'>) {
  const toText = (v: number | null) => (v == null ? '' : toPlainString(v, currency, ',').replace(/,00$/, ''));
  const [text, setText] = useState(() => toText(value));
  useEffect(() => {
    // Synchronise si la valeur change de l'extérieur.
    const parsed = parseAmount(text, currency);
    if (parsed !== value) setText(toText(value));
  }, [value, currency]);
  const symbol = currencyInfo(currency).symbol;
  return (
    <div className={cn('relative', className)}>
      <input
        inputMode="decimal"
        autoComplete="off"
        className={cn(
          'input num pe-14',
          size === 'xl' && 'h-16 rounded-2xl text-3xl font-semibold display',
          invalid && 'input-error',
        )}
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.,\s -]/g, '');
          setText(t);
          let parsed = parseAmount(t, currency);
          if (parsed != null && parsed < 0 && !allowNegative) parsed = Math.abs(parsed);
          onChange(t.trim() === '' ? null : parsed);
        }}
        onBlur={() => setText(toText(value))}
        {...rest}
      />
      <span className={cn('pointer-events-none absolute end-3.5 top-1/2 -translate-y-1/2 text-sm font-medium text-muted', size === 'xl' && 'text-lg')}>{symbol}</span>
    </div>
  );
}

export function Switch({ checked, onChange, label, description, id }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; id?: string }) {
  const autoId = useId();
  const sid = id ?? autoId;
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <label htmlFor={sid} className="min-w-0 cursor-pointer">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </label>
      <button
        id={sid}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-primary' : 'bg-surface-3 border border-line/20')}
      >
        <span className={cn('absolute top-1/2 h-4.5 w-4.5 -translate-y-1/2 rounded-full bg-white shadow transition-all', checked ? 'start-[22px]' : 'start-[3px]')} style={{ width: 18, height: 18 }} />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; tone?: string }[]; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" className={cn('inline-flex rounded-xl border border-line/15 bg-surface-2/70 p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 whitespace-nowrap rounded-lg font-medium transition',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-xs sm:text-sm',
            value === o.value ? cn('bg-surface-3 text-fg shadow-sm', o.tone) : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
