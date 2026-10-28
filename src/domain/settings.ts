import type { UserSettings } from './types';
import { DEFAULT_THRESHOLDS } from './calc/budgets';

export const LOCAL_USER_ID = 'local-user';

export const LOCALES = [
  { value: 'fr-MA', label: 'Français (Maroc)' },
  { value: 'fr-FR', label: 'Français (France)' },
  { value: 'fr-BE', label: 'Français (Belgique)' },
  { value: 'fr-CA', label: 'Français (Canada)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'ar-MA', label: 'العربية (المغرب) — formats' },
];

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
    language: 'fr',
    locale: 'fr-MA',
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
