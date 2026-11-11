/**
 * Représentation monétaire exacte.
 *
 * Tous les montants sont stockés en ENTIERS exprimés dans l'unité monétaire
 * minimale de leur devise (centimes pour MAD/EUR/USD, unité pour JPY,
 * millièmes pour TND/KWD...). Aucun calcul n'est fait en virgule flottante
 * sur des montants décimaux : les additions/soustractions se font sur des
 * entiers (exactes jusqu'à 2^53, soit ~90 000 milliards de DH).
 *
 * Règles d'arrondi :
 *  - saisie : le texte est converti en unités minimales sans passer par un float
 *    (parsing de chaînes) ; au-delà du nombre de décimales de la devise, arrondi
 *    au plus proche, demi vers l'extérieur (0,005 → 0,01).
 *  - pourcentages / conversions de devises : le résultat est arrondi à l'unité
 *    minimale la plus proche, demi vers l'extérieur (Math.round symétrique).
 */

import { t } from '@/i18n/core';

export type CurrencyCode = string;

export interface CurrencyInfo {
  code: CurrencyCode;
  name: string;
  decimals: number;
  /** Symbole court utilisé par défaut à l'affichage. */
  symbol: string;
}

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'MAD', name: 'Dirham marocain', decimals: 2, symbol: 'DH' },
  { code: 'EUR', name: 'Euro', decimals: 2, symbol: '€' },
  { code: 'USD', name: 'Dollar américain', decimals: 2, symbol: '$' },
  { code: 'GBP', name: 'Livre sterling', decimals: 2, symbol: '£' },
  { code: 'CHF', name: 'Franc suisse', decimals: 2, symbol: 'CHF' },
  { code: 'CAD', name: 'Dollar canadien', decimals: 2, symbol: 'CA$' },
  { code: 'AED', name: 'Dirham des Émirats', decimals: 2, symbol: 'AED' },
  { code: 'SAR', name: 'Riyal saoudien', decimals: 2, symbol: 'SAR' },
  { code: 'XOF', name: 'Franc CFA (BCEAO)', decimals: 0, symbol: 'FCFA' },
  { code: 'TND', name: 'Dinar tunisien', decimals: 3, symbol: 'DT' },
  { code: 'DZD', name: 'Dinar algérien', decimals: 2, symbol: 'DA' },
  { code: 'EGP', name: 'Livre égyptienne', decimals: 2, symbol: 'E£' },
  { code: 'JPY', name: 'Yen japonais', decimals: 0, symbol: '¥' },
  { code: 'CNY', name: 'Yuan chinois', decimals: 2, symbol: '¥' },
  { code: 'TRY', name: 'Livre turque', decimals: 2, symbol: '₺' },
  { code: 'KWD', name: 'Dinar koweïtien', decimals: 3, symbol: 'KD' },
];

const CURRENCY_MAP = new Map(CURRENCIES.map((c) => [c.code, c]));

export function currencyInfo(code: CurrencyCode): CurrencyInfo {
  return CURRENCY_MAP.get(code) ?? { code, name: code, decimals: 2, symbol: code };
}

export function currencyDecimals(code: CurrencyCode): number {
  return currencyInfo(code).decimals;
}

export function isKnownCurrency(code: string): boolean {
  return CURRENCY_MAP.has(code);
}

/** Arrondi symétrique (demi vers l'extérieur) à l'entier le plus proche. */
export function roundHalfAwayFromZero(value: number): number {
  const r = Math.round(Math.abs(value) + Number.EPSILON * Math.abs(value));
  return value < 0 ? -r : r;
}

/**
 * Convertit une chaîne saisie par l'utilisateur en unités minimales.
 * Accepte : "1234", "1 234,56", "1.234,56", "1,234.56", "-12.5", "(12,50)", "12,5 DH".
 * Retourne null si la chaîne n'est pas un montant valide.
 */
export function parseAmount(input: string, currency: CurrencyCode = 'MAD'): number | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Supprime symboles monétaires et espaces (y compris insécables).
  s = s.replace(/[\s  ]/g, '').replace(/[A-Za-z€$£¥₺]+\.?/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^[0-9.,']+$/.test(s)) return null;
  s = s.replace(/'/g, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart: string;
  let fracPart = '';
  if (lastComma >= 0 && lastDot >= 0) {
    // Le dernier séparateur rencontré est le séparateur décimal.
    const decSep = lastComma > lastDot ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    const [i, f = ''] = s.split(decSep);
    if (s.split(decSep).length > 2) return null;
    intPart = i.split(thouSep).join('');
    fracPart = f;
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = s.split(sep);
    if (parts.length > 2) {
      // "1.234.567" ou "1,234,567" : séparateurs de milliers uniquement.
      if (parts.slice(1).every((p) => p.length === 3)) {
        intPart = parts.join('');
      } else return null;
    } else {
      const [i, f] = parts;
      // "1,234" ambigu : groupe de 3 chiffres après une virgule ET partie entière <= 3 chiffres
      // est traité comme décimal pour la virgule (usage FR), comme milliers pour le point
      // uniquement si la devise n'a pas 3 décimales... On privilégie l'interprétation décimale.
      intPart = i;
      fracPart = f;
    }
  } else {
    intPart = s;
  }
  if (intPart === '') intPart = '0';
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) return null;

  const decimals = currencyDecimals(currency);
  let minor = BigInt(intPart) * 10n ** BigInt(decimals);
  if (fracPart) {
    const kept = fracPart.slice(0, decimals).padEnd(decimals, '0');
    minor += BigInt(kept || '0');
    const next = fracPart.charAt(decimals);
    if (next && Number(next) >= 5) minor += 1n;
  }
  const n = Number(minor);
  if (!Number.isSafeInteger(n)) return null;
  return negative ? -n : n;
}

// ---------------------------------------------------------------------------
// Saisie d'un montant selon la locale (formulaires)
// ---------------------------------------------------------------------------
//
// `parseAmount` (ci-dessus) reste réservé aux fichiers importés : il interprète « 1.500 » comme
// 1,50 sans connaître la convention de l'utilisateur. Dans un formulaire, la locale active est
// connue : `parseAmountInput` suit SES séparateurs, n'interprète jamais en silence une saisie qui
// pourrait se lire de deux façons (elle est refusée avec le code `ambiguous`), n'arrondit jamais
// (`precision`) et calcule en BigInt sur les chaînes (aucun flottant).

/** Motif de refus d'une saisie : jamais convertie en silence. */
export type AmountInputIssue = 'invalid' | 'ambiguous' | 'precision' | 'tooLarge';
/** `value` null : champ vide. */
export type AmountInputResult = { ok: true; value: number | null } | { ok: false; issue: AmountInputIssue };

export interface AmountSeparators {
  /** Séparateur décimal de la locale : '.', ',' ou '٫'. */
  decimal: string;
  /** Séparateur de milliers de la locale ; les espaces (insécables compris) sont ramenés à ' '. */
  group: string;
  /** Taille du groupe le plus à droite (3) et des groupes suivants (2 en groupement indien). */
  primary: number;
  secondary: number;
}

const separatorsCache = new Map<string, AmountSeparators>();
const FALLBACK_SEPARATORS: AmountSeparators = { decimal: ',', group: '.', primary: 3, secondary: 3 };

/** Séparateurs effectivement utilisés par `Intl.NumberFormat` pour la locale (ceux de l'affichage). */
export function amountSeparators(locale: string): AmountSeparators {
  const cached = separatorsCache.get(locale);
  if (cached) return cached;
  let result = FALLBACK_SEPARATORS;
  try {
    const parts = new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 1 }).formatToParts(1234567890.5);
    const decimal = parts.find((p) => p.type === 'decimal')?.value;
    const groupRaw = parts.find((p) => p.type === 'group')?.value;
    const ints = parts.filter((p) => p.type === 'integer').map((p) => p.value.length);
    if (decimal && groupRaw && ints.length >= 3) {
      const group = /\s/.test(groupRaw) || groupRaw === ' ' ? ' ' : groupRaw === '’' ? "'" : groupRaw;
      result = { decimal, group, primary: ints[ints.length - 1], secondary: ints[ints.length - 2] };
    }
  } catch {
    /* locale inconnue : convention par défaut de l'application (fr-MA) */
  }
  separatorsCache.set(locale, result);
  return result;
}

/** Chiffres arabes-indiens (U+0660…) et persans (U+06F0…) ramenés aux chiffres latins. */
function latinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) & 0xf));
}

/**
 * Regroupement des milliers valide : soit des groupes de 3 chiffres, soit le groupement de la locale
 * (indien : 3 puis 2). Le premier groupe compte 1 à 3 chiffres (1 à `secondary` en groupement indien).
 */
function validGrouping(groups: string[], sep: AmountSeparators): boolean {
  if (groups.some((g) => !/^\d+$/.test(g))) return false;
  if (groups.length === 1) return true;
  // Un nombre groupé ne commence jamais par 0 (« 0.500 », « 000.015 » ne sont pas des milliers) : B1.
  if (!/^[1-9]/.test(groups[0])) return false;
  const matches = (primary: number, secondary: number) =>
    groups[groups.length - 1].length === primary &&
    groups.slice(1, -1).every((g) => g.length === secondary) &&
    groups[0].length >= 1 &&
    groups[0].length <= secondary;
  return matches(3, 3) || matches(sep.primary, sep.secondary);
}

/** Le texte peut-il précéder un groupe de milliers (« 180 », « 1.234 ») ? Pas « » ni « 0 ». */
function thousandsPrefix(intText: string): boolean {
  return /^[1-9]/.test(intText);
}

/**
 * Convertit une saisie de formulaire en unités minimales selon la locale `locale` et la devise.
 *  - « 180.000 » en fr-MA (point = milliers) → 180 000,00 ; « 180,50 » → 180,50.
 *  - Un séparateur qui pourrait être décimal OU de milliers (« 180.50 » en fr-MA, « 180.000 » en
 *    en-US, « 1,500.50 » en fr-MA…) est refusé (`ambiguous`) : jamais d'écart d'un facteur 10 à 1 000.
 *  - Trop de décimales pour la devise : refusé (`precision`), jamais arrondi.
 *  - Espaces, espaces insécables, apostrophes et « ٬ » : séparateurs de milliers (groupes contrôlés).
 *  - Chiffres arabes-indiens et persans acceptés ; signe « - », « − » ou « + » en tête.
 */
export function parseAmountInput(input: string, currency: CurrencyCode, locale: string): AmountInputResult {
  const refuse = (issue: AmountInputIssue): AmountInputResult => ({ ok: false, issue });
  const decimals = currencyDecimals(currency);
  const sep = amountSeparators(locale);
  let s = latinDigits(String(input ?? ''))
    .replace(/[\s\u00a0\u202f\u2009]+/g, ' ')
    .replace(/’/g, "'")
    .trim();
  if (!s) return { ok: true, value: null };
  let negative = false;
  if (/^[-−+]/.test(s)) {
    negative = s[0] !== '+';
    s = s.slice(1).trim();
  }
  if (!s || /[^0-9.,' ٫٬]/.test(s) || !/\d$/.test(s)) return refuse('invalid');

  const count = (c: string) => s.split(c).length - 1;
  const dots = count('.');
  const commas = count(',');
  const segments = s.split(/[ '٬.,٫]/);
  // Séparateur décimal retenu (null : nombre entier).
  let decimalChar: string | null = null;

  if (s.includes('٫')) {
    // Séparateur décimal arabe : jamais de milliers, jamais mêlé aux séparateurs latins.
    if (count('٫') > 1 || dots || commas) return refuse('ambiguous');
    decimalChar = '٫';
  } else if (dots && commas) {
    // Les deux séparateurs : le dernier est décimal (une seule fois), l'autre groupe les milliers.
    const last = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    if (count(last) > 1) return refuse('invalid');
    // Ordre contraire à la convention de la locale (« 1,500.50 » en fr-MA) : lecture incertaine.
    if ((sep.decimal === '.' || sep.decimal === ',') && last !== sep.decimal) return refuse('ambiguous');
    decimalChar = last;
  } else if (dots || commas) {
    const c = dots ? '.' : ',';
    const n = dots + commas;
    const after = s.slice(s.lastIndexOf(c) + 1);
    if (c === sep.decimal) {
      // Séparateur décimal de la locale, répété : milliers à l'étrangère (« 1.234.567 » en en-US) ?
      if (n > 1) return refuse(validGrouping(segments, sep) ? 'ambiguous' : 'invalid');
      decimalChar = c;
    } else if (c === sep.group) {
      // Séparateur de milliers de la locale : groupes valides. Sinon, un séparateur unique derrière un
      // entier écrit normalement (« 180.50 », « 0.500 » en fr-MA) peut aussi être une décimale :
      // ambiguous ; zéros superflus (« 000.015 », « 01.500 ») ou séparateurs répétés : invalid.
      if (!validGrouping(segments, sep)) {
        const plainInteger = /^(0|[1-9]\d*)?$/.test(s.slice(0, s.lastIndexOf(c)).replace(/[ '٬]/g, ''));
        return refuse(n === 1 && plainInteger ? 'ambiguous' : 'invalid');
      }
    } else if (n === 1) {
      // Séparateur étranger à la locale (« . » en fr-FR) : décimal s'il ne peut pas grouper des milliers.
      if (after.length === 3 && thousandsPrefix(s.slice(0, s.lastIndexOf(c)))) return refuse('ambiguous');
      decimalChar = c;
    }
    // Séparateur étranger répété (« 1.234.567 » en fr-FR) : milliers, contrôlés ci-dessous.
  }

  // Partie entière (milliers contrôlés : un seul type de séparateur) et partie décimale.
  const cut = decimalChar ? s.lastIndexOf(decimalChar) : -1;
  const intText = cut >= 0 ? s.slice(0, cut) : s;
  const fracText = cut >= 0 ? s.slice(cut + 1) : '';
  if (!/^\d*$/.test(fracText)) return refuse('invalid');
  // Trois chiffres après le séparateur, derrière un début de nombre valide : peut-être des milliers.
  if (fracText.length > decimals) return refuse(fracText.length === 3 && decimalChar !== '٫' && thousandsPrefix(intText) ? 'ambiguous' : 'precision');
  const groups = intText === '' ? ['0'] : intText.split(/[ '٬.,]/);
  if (new Set(intText.replace(/\d/g, '')).size > 1 || !validGrouping(groups, sep)) return refuse('invalid');

  const minor = BigInt(groups.join('')) * 10n ** BigInt(decimals) + (fracText ? BigInt(fracText.padEnd(decimals, '0')) : 0n);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return refuse('tooLarge');
  const n = Number(minor);
  return { ok: true, value: negative && n !== 0 ? -n : n };
}

/** Texte de saisie d'un montant : chiffres latins, séparateur décimal de la locale, sans milliers. */
export function formatAmountInput(minor: number, currency: CurrencyCode, locale: string): string {
  const d = currencyDecimals(currency);
  const plain = toPlainString(minor, currency, amountSeparators(locale).decimal);
  // « 1500,00 » → « 1500 » : une partie décimale nulle n'est pas réécrite.
  return d && /^0+$/.test(plain.slice(-d)) ? plain.slice(0, -(d + 1)) : plain;
}

/** Exemple de saisie conforme à la locale et à la devise (« 1.234,56 » en fr-MA, « 1,234.56 » en en-US). */
export function amountInputExample(locale: string, currency: CurrencyCode): string {
  const d = currencyDecimals(currency);
  const sep = amountSeparators(locale);
  const group = sep.group === ' ' ? '\u00a0' : sep.group;
  return `1${group}234${d ? sep.decimal + '56789'.slice(0, d) : ''}`;
}

/** Message d'erreur d'une saisie refusée, avec un exemple au format de la locale. */
export function amountIssueMessage(issue: AmountInputIssue, locale: string, currency: CurrencyCode): string {
  const example = amountInputExample(locale, currency);
  if (issue === 'ambiguous') return t('money.input.ambiguous', { example });
  if (issue === 'precision') return t('money.input.precision', { decimals: currencyDecimals(currency), example });
  if (issue === 'tooLarge') return t('money.input.tooLarge');
  return t('money.input.invalid', { example });
}

/** Valeur décimale (pour affichage / graphiques uniquement, jamais pour calculer). */
export function toMajor(minor: number, currency: CurrencyCode): number {
  return minor / 10 ** currencyDecimals(currency);
}

/** Convertit une valeur décimale en unités minimales (arrondi symétrique). */
export function fromMajor(major: number, currency: CurrencyCode): number {
  return roundHalfAwayFromZero(major * 10 ** currencyDecimals(currency));
}

/** Représentation texte non localisée (ex: pour les champs de saisie et le CSV) : "1234.56". */
export function toPlainString(minor: number, currency: CurrencyCode, decimalSep = '.'): string {
  const d = currencyDecimals(currency);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const s = String(abs).padStart(d + 1, '0');
  const int = d ? s.slice(0, -d) : s;
  const frac = d ? s.slice(-d) : '';
  return (neg ? '-' : '') + int + (d ? decimalSep + frac : '');
}

export interface FormatMoneyOptions {
  locale?: string;
  /** "symbol" → DH, "code" → MAD */
  display?: 'symbol' | 'code';
  signDisplay?: 'auto' | 'always' | 'exceptZero' | 'never';
  compact?: boolean;
  hideDecimals?: boolean;
}

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = locale + JSON.stringify(opts);
  let f = nfCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, opts);
    } catch {
      f = new Intl.NumberFormat('fr-FR', opts);
    }
    nfCache.set(key, f);
  }
  return f;
}

/** Formate un montant en unités minimales selon la locale. */
export function formatMoney(minor: number, currency: CurrencyCode, options: FormatMoneyOptions = {}): string {
  const { locale = 'fr-MA', display = 'symbol', signDisplay = 'auto', compact = false, hideDecimals = false } = options;
  const info = currencyInfo(currency);
  const major = toMajor(minor, currency);
  const digits = hideDecimals || compact ? 0 : info.decimals;
  const formatted = nf(locale, {
    minimumFractionDigits: compact ? 0 : digits,
    maximumFractionDigits: compact ? 1 : digits,
    notation: compact ? 'compact' : 'standard',
    signDisplay,
  }).format(major);
  const unit = display === 'code' ? info.code : info.symbol;
  // Les symboles $, €, £ se placent selon l'usage local ; on garde un format uniforme "montant unité"
  // pour faciliter la comparaison visuelle des colonnes de chiffres.
  return `${formatted} ${unit}`;
}

export function formatNumber(value: number, locale = 'fr-MA', maxFractionDigits = 0): string {
  return nf(locale, { maximumFractionDigits: maxFractionDigits }).format(value);
}

export function formatPercent(ratio: number | null, locale = 'fr-MA', digits = 1, minDigits = 0): string {
  if (ratio == null || !Number.isFinite(ratio)) return t('common.notComputable');
  return nf(locale, { style: 'percent', minimumFractionDigits: minDigits, maximumFractionDigits: digits }).format(ratio);
}

/** Pourcentage d'un montant (ex: 15 % de 1000,00) arrondi à l'unité minimale. */
export function percentOf(minor: number, percent: number): number {
  return roundHalfAwayFromZero((minor * percent) / 100);
}

/** Ratio sécurisé : null si le dénominateur est nul. */
export function safeRatio(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return numerator / denominator;
}

export function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Montants groupés par devise lorsqu'aucune conversion n'est possible. */
export type MoneyBag = Record<CurrencyCode, number>;

export function addToBag(bag: MoneyBag, currency: CurrencyCode, minor: number): MoneyBag {
  bag[currency] = (bag[currency] ?? 0) + minor;
  return bag;
}
