/**
 * Langues disponibles. `locale` = formats numériques proposés par défaut lors du
 * choix de la langue (modifiables ensuite dans Paramètres → Régional).
 */
export const LANGUAGES = [
  { code: 'fr', name: 'Français', english: 'French', dir: 'ltr', locale: 'fr-MA' },
  { code: 'en', name: 'English', english: 'English', dir: 'ltr', locale: 'en-US' },
  { code: 'ar', name: 'العربية', english: 'Arabic', dir: 'rtl', locale: 'ar-MA' },
  { code: 'es', name: 'Español', english: 'Spanish', dir: 'ltr', locale: 'es-ES' },
  { code: 'pt', name: 'Português', english: 'Portuguese', dir: 'ltr', locale: 'pt-PT' },
  { code: 'de', name: 'Deutsch', english: 'German', dir: 'ltr', locale: 'de-DE' },
  { code: 'it', name: 'Italiano', english: 'Italian', dir: 'ltr', locale: 'it-IT' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch', dir: 'ltr', locale: 'nl-NL' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish', dir: 'ltr', locale: 'tr-TR' },
  { code: 'ru', name: 'Русский', english: 'Russian', dir: 'ltr', locale: 'ru-RU' },
  { code: 'uk', name: 'Українська', english: 'Ukrainian', dir: 'ltr', locale: 'uk-UA' },
  { code: 'pl', name: 'Polski', english: 'Polish', dir: 'ltr', locale: 'pl-PL' },
  { code: 'ro', name: 'Română', english: 'Romanian', dir: 'ltr', locale: 'ro-RO' },
  { code: 'sv', name: 'Svenska', english: 'Swedish', dir: 'ltr', locale: 'sv-SE' },
  { code: 'el', name: 'Ελληνικά', english: 'Greek', dir: 'ltr', locale: 'el-GR' },
  { code: 'cs', name: 'Čeština', english: 'Czech', dir: 'ltr', locale: 'cs-CZ' },
  { code: 'he', name: 'עברית', english: 'Hebrew', dir: 'rtl', locale: 'he-IL' },
  { code: 'fa', name: 'فارسی', english: 'Persian', dir: 'rtl', locale: 'fa-IR' },
  { code: 'hi', name: 'हिन्दी', english: 'Hindi', dir: 'ltr', locale: 'hi-IN' },
  { code: 'zh', name: '简体中文', english: 'Chinese (Simplified)', dir: 'ltr', locale: 'zh-CN' },
  { code: 'ja', name: '日本語', english: 'Japanese', dir: 'ltr', locale: 'ja-JP' },
  { code: 'ko', name: '한국어', english: 'Korean', dir: 'ltr', locale: 'ko-KR' },
  { code: 'id', name: 'Bahasa Indonesia', english: 'Indonesian', dir: 'ltr', locale: 'id-ID' },
  { code: 'vi', name: 'Tiếng Việt', english: 'Vietnamese', dir: 'ltr', locale: 'vi-VN' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['code'];

export function isLang(v: unknown): v is Lang {
  return LANGUAGES.some((l) => l.code === v);
}

export function languageInfo(code: Lang) {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}
