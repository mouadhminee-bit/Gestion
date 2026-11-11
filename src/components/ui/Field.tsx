import { forwardRef, useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AmountInputIssue, CurrencyCode } from '@/domain/money';
import { amountIssueMessage, currencyInfo, formatAmountInput, parseAmountInput } from '@/domain/money';
import { useOptionalApp } from '@/app/AppContext';
import { getLang } from '@/i18n/core';
import { languageInfo } from '@/i18n/languages';

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

/** Locale des formats numériques hors AppProvider (accueil) : celle que l'application retiendra par défaut. */
function defaultNumberLocale(): string {
  const lang = getLang();
  return lang === 'fr' ? 'fr-MA' : languageInfo(lang).locale;
}

/**
 * Saisie monétaire : clavier décimal sur mobile, conversion exacte en unités minimales (sans
 * flottant), selon les séparateurs de la LOCALE ACTIVE (`settings.locale`, ou `locale`).
 * `value` / `onChange` en unités minimales.
 *
 * Une saisie refusée (`invalid`, `ambiguous` : « 180.50 » en fr-MA, `precision`, `tooLarge`) n'est
 * jamais convertie ni effacée : `onChange(null)`, le texte reste tel quel, le champ est marqué
 * invalide et le motif est signalé — par un message sous le champ (`showIssue`, par défaut) ou par
 * `onIssue` lorsque l'appelant affiche lui-même l'erreur. À la sortie du champ, une saisie acceptée
 * est réécrite à partir de la valeur (« 180.000 » → « 180000 » en fr-MA) : la valeur retenue est
 * visible. Un `onBlur` / `onFocus` fourni par l'appelant est appelé en plus, jamais à sa place.
 */
export function MoneyInput({
  value,
  onChange,
  currency,
  locale: localeProp,
  invalid,
  allowNegative,
  onIssue,
  showIssue = true,
  className,
  size = 'md',
  onBlur,
  onFocus,
  ...rest
}: {
  value: number | null;
  onChange: (minor: number | null) => void;
  currency: CurrencyCode;
  /** Locale des séparateurs (par défaut : celle des réglages). */
  locale?: string;
  invalid?: boolean;
  allowNegative?: boolean;
  /** Motif de refus de la saisie en cours (null : saisie vide ou acceptée). */
  onIssue?: (issue: AmountInputIssue | null) => void;
  /** Affiche le motif de refus sous le champ (false : l'appelant l'affiche lui-même). */
  showIssue?: boolean;
  size?: 'md' | 'xl';
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size'>) {
  const app = useOptionalApp();
  const locale = localeProp ?? app?.settings.locale ?? defaultNumberLocale();
  const issueId = useId();
  const toText = (v: number | null) => (v == null ? '' : formatAmountInput(v, currency, locale));
  /** Valeur retenue pour un texte (null : vide ou refusé). */
  const valueOf = (txt: string): number | null => {
    const r = parseAmountInput(txt, currency, locale);
    if (!r.ok || r.value === null) return null;
    return r.value < 0 && !allowNegative ? Math.abs(r.value) : r.value;
  };
  const [text, setText] = useState(() => toText(value));
  const [focused, setFocused] = useState(false);
  /** Saisie refusée qui vient d'être transmise (onChange(null)) : la valeur que l'écran en déduit
   * (souvent 0 ou « vide ») ne doit pas remplacer le texte refusé, qui reste visible et signalé. */
  const refusedEmit = useRef(false);
  const parsed = parseAmountInput(text, currency, locale);
  const issue = parsed.ok ? null : parsed.issue;
  // Motif transmis à l'appelant ; levé si le champ disparaît (le formulaire n'est plus bloqué par lui).
  const reported = useRef<AmountInputIssue | null>(null);
  const report = (next: AmountInputIssue | null) => {
    if (reported.current === next) return;
    reported.current = next;
    onIssue?.(next);
  };
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => () => reportRef.current(null), []);
  useEffect(() => {
    // Valeur modifiée par l'écran juste après une saisie refusée (ex. vide → 0) : texte refusé conservé.
    if (refusedEmit.current && issue !== null) {
      refusedEmit.current = false;
      return;
    }
    refusedEmit.current = false;
    // Valeur changée de l'extérieur (formulaire réinitialisé, valeur calculée…) : texte resynchronisé.
    if (valueOf(text) !== value) {
      setText(toText(value));
      report(null);
    }
  }, [value, currency, locale]);
  const shown = showIssue && issue !== null && !focused;
  const symbol = currencyInfo(currency).symbol;
  return (
    <>
      <div className={cn('relative', className)}>
        <input
          inputMode="decimal"
          autoComplete="off"
          className={cn(
            'input num pe-14',
            size === 'xl' && 'h-16 rounded-2xl text-3xl font-semibold display',
            (invalid || (issue !== null && !focused)) && 'input-error',
          )}
          value={text}
          aria-invalid={invalid || issue !== null || undefined}
          aria-describedby={shown ? issueId : undefined}
          onChange={(e) => {
            // Chiffres (latins, arabes-indiens, persans), séparateurs et signe ; le reste est ignoré.
            const t = e.target.value.replace(/[^0-9\u0660-\u0669\u06f0-\u06f9.,\s'’+\u2212\u066b\u066c-]/g, '');
            setText(t);
            const r = parseAmountInput(t, currency, locale);
            refusedEmit.current = !r.ok;
            report(r.ok ? null : r.issue);
            onChange(t.trim() === '' ? null : valueOf(t));
          }}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            refusedEmit.current = false;
            // Saisie acceptée : réécrite à partir de la valeur retenue ; saisie refusée : conservée.
            if (issue === null) setText(toText(value));
            onBlur?.(e);
          }}
        />
        <span className={cn('pointer-events-none absolute end-3.5 top-1/2 -translate-y-1/2 text-sm font-medium text-muted', size === 'xl' && 'text-lg')}>{symbol}</span>
      </div>
      {shown && (
        <p id={issueId} role="alert" data-testid="money-input-issue" data-issue={issue} className="text-xs text-negative">
          {amountIssueMessage(issue, locale, currency)}
        </p>
      )}
    </>
  );
}

/**
 * Montants refusés dans un formulaire (A1) : un écran qui enregistre par un bouton, et qui remplace
 * un montant vide par 0 ou « aucun », ne doit pas enregistrer cette valeur tant qu'une saisie de
 * montant est refusée (ambiguë, non valide…). `track(clé)` se passe en `onIssue` de chaque
 * `MoneyInput` ; `blocked` est vrai tant qu'une saisie est refusée (le champ démonté se retire seul).
 */
export function useAmountGuard() {
  const [refused, setRefused] = useState<Record<string, true>>({});
  return useMemo(
    () => ({
      track: (key: string) => (issue: AmountInputIssue | null) =>
        setRefused((all) => {
          if (!!issue === !!all[key]) return all;
          const next = { ...all };
          if (issue) next[key] = true;
          else delete next[key];
          return next;
        }),
      blocked: Object.keys(refused).length > 0,
    }),
    [refused],
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
