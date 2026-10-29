import type { UserSettings } from './types';
import { getLang } from '@/i18n/core';
import { languageInfo } from '@/i18n/languages';
import { DEFAULT_THRESHOLDS } from './calc/budgets';

export const LOCAL_USER_ID = 'local-user';

/** Formats numériques proposés (libellés générés dans la langue de l'interface). */
export const LOCALE_CODES = [
  'fr-MA', 'fr-FR', 'fr-BE', 'fr-CH', 'fr-CA', 'ar-MA', 'ar-SA', 'ar-EG', 'en-US', 'en-GB', 'es-ES', 'es-MX', 'pt-PT', 'pt-BR',
  'de-DE', 'de-CH', 'it-IT', 'nl-NL', 'tr-TR', 'ru-RU', 'uk-UA', 'pl-PL', 'ro-RO', 'sv-SE', 'el-GR', 'cs-CZ', 'he-IL',
  'fa-IR', 'hi-IN', 'zh-CN', 'ja-JP', 'ko-KR', 'id-ID', 'vi-VN',
];

export function localeOptions(uiLang: string): { value: string; label: string }[] {
  let dn: Intl.DisplayNames | null = null;
  try {
    dn = new Intl.DisplayNames([uiLang], { type: 'language' });
  } catch {
    dn = null;
  }
  return LOCALE_CODES.map((value) => {
    let label = value;
    try {
      label = dn?.of(value) ?? value;
    } catch {
      /* code non reconnu */
    }
    const sample = new Intl.NumberFormat(value).format(1234.5);
    return { value, label: `${label.charAt(0).toUpperCase()}${label.slice(1)} — ${sample}` };
  });
}

export const TIME_ZONES = [
  'Africa/Casablanca',
  'Europe/Paris',
  'Europe/Brussels',
  'Europe/London',
  'Africa/Tunis',
  'Africa/Algiers',
  'Africa/Dakar',
  'Africa/Abidjan',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Riyadh',
  'America/Montreal',
  'America/New_York',
  'UTC',
];

export function defaultSettings(userId: string, overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    id: userId,
    userId,
    displayName: '',
    baseCurrency: 'MAD',
    language: getLang(),
    locale: getLang() === 'fr' ? 'fr-MA' : languageInfo(getLang()).locale,
    timeZone: 'Africa/Casablanca',
    dateFormat: 'DD/MM/YYYY',
    weekStartsOn: 1,
    theme: 'dark',
    currencyDisplay: 'symbol',
    privacyMode: false,
    budgetAlertThresholds: [...DEFAULT_THRESHOLDS],
    notifyBudgets: true,
    notifyBills: true,
    notifyDebts: true,
    billReminderDays: 7,
    onboarded: false,
    demoMode: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
