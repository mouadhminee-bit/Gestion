import { Languages } from 'lucide-react';
import { LANGUAGES, type Lang } from '@/i18n/languages';
import { useI18n } from '@/i18n/I18nProvider';
import { t } from '@/i18n/core';
import { Select } from './Field';

/** Sélecteur de langue (noms dans leur propre langue). `onChanged` permet de persister le choix. */
export function LanguageSelect({ onChanged, className }: { onChanged?: (lang: Lang) => void | Promise<void>; className?: string }) {
  const { lang, changeLanguage } = useI18n();
  return (
    <div className={className}>
      <label className="sr-only" htmlFor="nx-language">{t('settings.language')}</label>
      <div className="relative">
        <Languages className="pointer-events-none absolute start-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <Select
          id="nx-language"
          value={lang}
          className="ps-9"
          onChange={async (e) => {
            const next = e.target.value as Lang;
            await onChanged?.(next);
            await changeLanguage(next);
          }}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code} lang={l.code} dir={l.dir}>
              {l.name}
              {l.code !== lang ? ` — ${l.english}` : ''}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
