/**
 * Dates calendaires.
 *
 * Les dates métier (date d'une transaction, échéance...) sont stockées sous forme
 * de chaînes ISO "AAAA-MM-JJ" sans heure ni fuseau : une dépense du 31/01 reste
 * au 31/01 quel que soit le fuseau du navigateur. Le fuseau de l'utilisateur
 * (Africa/Casablanca par défaut) n'intervient que pour déterminer « aujourd'hui ».
 * Les mois sont identifiés par "AAAA-MM".
 */

export type ISODate = string; // AAAA-MM-JJ
export type MonthKey = string; // AAAA-MM

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month1: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month1 - 1];
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function makeDate(year: number, month1: number, day: number): ISODate {
  return `${String(year).padStart(4, '0')}-${pad2(month1)}-${pad2(day)}`;
}

export function parseISO(date: ISODate): { y: number; m: number; d: number } {
  const match = ISO_RE.exec(date);
  if (!match) throw new Error(`Date invalide : ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function isValidISODate(date: unknown): date is ISODate {
  if (typeof date !== 'string') return false;
  const match = ISO_RE.exec(date);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Nombre de jours depuis 1970-01-01 (calcul en UTC pour éviter les sauts d'heure). */
export function toDayNumber(date: ISODate): number {
  const { y, m, d } = parseISO(date);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function fromDayNumber(n: number): ISODate {
  const dt = new Date(n * 86_400_000);
  return makeDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromDayNumber(toDayNumber(date) + days);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return toDayNumber(a) - toDayNumber(b);
}

/**
 * Ajoute des mois en conservant le jour d'ancrage, borné à la fin du mois :
 * 31/01 + 1 mois → 28/02 (ou 29/02 les années bissextiles), 31/01 + 2 mois → 31/03.
 * `anchorDay` permet de calculer chaque occurrence depuis la date de départ
 * sans dérive (31 → 28 → 31 et non 31 → 28 → 28).
 */
export function addMonths(date: ISODate, months: number, anchorDay?: number): ISODate {
  const { y, m, d } = parseISO(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(ny, nm));
  return makeDate(ny, nm, day);
}

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

/** Date du jour dans le fuseau donné (Africa/Casablanca par défaut). */
export function todayISO(timeZone = 'Africa/Casablanca', now: Date = new Date()): ISODate {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return makeDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }
}

// ---------------------------------------------------------------------------
// Mois et périodes
// ---------------------------------------------------------------------------

export function monthKey(date: ISODate): MonthKey {
  return date.slice(0, 7);
}

export function monthStart(month: MonthKey): ISODate {
  return `${month}-01`;
}

export function monthEnd(month: MonthKey): ISODate {
  const [y, m] = month.split('-').map(Number);
  return makeDate(y, m, daysInMonth(y, m));
}

export function addMonthsToKey(month: MonthKey, n: number): MonthKey {
  return monthKey(addMonths(monthStart(month), n));
}

export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  let cur = from;
  while (cur <= to && out.length < 600) {
    out.push(cur);
    cur = addMonthsToKey(cur, 1);
  }
  return out;
}

export interface Period {
  start: ISODate; // inclus
  end: ISODate; // inclus
}

export function monthPeriod(month: MonthKey): Period {
  return { start: monthStart(month), end: monthEnd(month) };
}

export function periodDays(p: Period): number {
  return diffDays(p.end, p.start) + 1;
}

export function inPeriod(date: ISODate, p: Period): boolean {
  return date >= p.start && date <= p.end;
}

/** Période précédente de même durée (mois → mois précédent, sinon décalage en jours). */
export function previousPeriod(p: Period): Period {
  const isFullMonth = p.start.endsWith('-01') && p.end === monthEnd(monthKey(p.start));
  if (isFullMonth) return monthPeriod(addMonthsToKey(monthKey(p.start), -1));
  const startMonth = monthKey(p.start);
  const endMonth = monthKey(p.end);
  if (p.start.endsWith('-01') && p.end === monthEnd(endMonth)) {
    const n = monthRange(startMonth, endMonth).length;
    return { start: monthStart(addMonthsToKey(startMonth, -n)), end: monthEnd(addMonthsToKey(startMonth, -1)) };
  }
  const len = periodDays(p);
  return { start: addDays(p.start, -len), end: addDays(p.start, -1) };
}

export function quarterPeriod(year: number, quarter: number): Period {
  const startM = (quarter - 1) * 3 + 1;
  return { start: makeDate(year, startM, 1), end: monthEnd(`${year}-${pad2(startM + 2)}`) };
}

export function yearPeriod(year: number): Period {
  return { start: makeDate(year, 1, 1), end: makeDate(year, 12, 31) };
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';

export function formatDate(date: ISODate | undefined | null, format: DateFormat = 'DD/MM/YYYY'): string {
  if (!date || !isValidISODate(date)) return '—';
  const { y, m, d } = parseISO(date);
  switch (format) {
    case 'MM/DD/YYYY':
      return `${pad2(m)}/${pad2(d)}/${y}`;
    case 'YYYY-MM-DD':
      return date;
    default:
      return `${pad2(d)}/${pad2(m)}/${y}`;
  }
}

/**
 * Les périodes de l’application sont des mois grégoriens : on impose ce calendrier
 * (fa-IR afficherait sinon le calendrier persan, ar-SA l’hégirien…).
 */
export function gregorian(locale: string): string {
  return /-u-.*ca-/.test(locale) ? locale : `${locale}${locale.includes('-u-') ? '' : '-u'}-ca-gregory`;
}

export function formatMonth(month: MonthKey, locale = 'fr-MA', style: 'long' | 'short' = 'long'): string {
  const [y, m] = month.split('-').map(Number);
  const s = new Intl.DateTimeFormat(gregorian(locale), { month: style, year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const FR_SHORT_MONTHS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

export function formatMonthShort(month: MonthKey, locale = 'fr-MA'): string {
  const [y, m] = month.split('-').map(Number);
  // Certaines locales (fr-MA) abrègent juin et juillet de façon ambiguë (« jui. ») : libellés explicites.
  if (locale.startsWith('fr')) return FR_SHORT_MONTHS[m - 1];
  return new Intl.DateTimeFormat(gregorian(locale), { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, 1)))
    .replace('.', '');
}

export function formatLongDate(date: ISODate, locale = 'fr-MA'): string {
  const { y, m, d } = parseISO(date);
  const s = new Intl.DateTimeFormat(gregorian(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Nombre de mois entiers restants entre deux dates (au moins 0), arrondi au supérieur. */
export function monthsBetweenCeil(from: ISODate, to: ISODate): number {
  if (to <= from) return 0;
  const a = parseISO(from);
  const b = parseISO(to);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d > a.d) months += 1;
  return Math.max(months, 0);
}
