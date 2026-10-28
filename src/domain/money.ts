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

export function formatPercent(ratio: number | null, locale = 'fr-MA', digits = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return 'Non calculable';
  return nf(locale, { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: digits }).format(ratio);
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
