/**
 * Import CSV — format des nombres déterminé au niveau du FICHIER, puis lecture des montants.
 *
 * Un montant isolé comme « 1.500 » se lit 1,50 (point décimal) ou 1 500 (point des milliers) : sa
 * convention ne peut pas être devinée seule, et la locale de l'interface ne dit rien de celle du
 * fichier (export d'une banque étrangère, d'un tableur réglé autrement…). Trois étapes distinctes :
 *
 *  1. Indice (`amountEvidence`) : ce que la forme d'UN montant prouve, sans rien supposer.
 *     - les deux séparateurs (« 1.500,00 », « 1,500.00 ») : le dernier est décimal ;
 *     - un séparateur répété (« 1.234.567 ») : il groupe les milliers, l'autre serait décimal ;
 *     - un séparateur suivi de 1, 2 ou au moins 4 chiffres (« 245,30 », « 12.5 ») : il est décimal ;
 *     - un séparateur unique suivi d'exactement 3 chiffres (« 1.500 », « 0,500 ») : AMBIGU ;
 *     - aucun séparateur (« 1500 », « -45 ») : lisible dans les deux conventions (neutre).
 *  2. Détection (`detectNumberFormat`) sur tous les montants du fichier : conflit si des montants
 *     prouvent les deux conventions ; format retenu si au moins `MIN_FORMAT_EVIDENCE` montants le
 *     prouvent sans contradiction ; sinon, s'il reste des montants ambigus, le format doit être
 *     CHOISI par l'utilisateur (jamais déduit d'un ou deux exemples, ni de la locale).
 *  3. Lecture (`parseImportAmountWithFormat`) : une fois le format fixé, `parseAmountInput` (le
 *     parseur des formulaires, en précision entière) avec une locale de référence de ce format ;
 *     un montant incompatible avec le format est refusé, jamais converti dans un autre ordre de
 *     grandeur. Sans format fixé, seuls les montants non ambigus sont lus.
 */
import { CURRENCIES, parseAmountInput, currencyDecimals, type AmountInputIssue, type CurrencyCode } from './money';

/** Convention des nombres d'un fichier : séparateur décimal virgule (« 1.234,56 ») ou point (« 1,234.56 »). */
export type ImportNumberFormat = 'decimalComma' | 'decimalPoint';
export const IMPORT_NUMBER_FORMATS: ImportNumberFormat[] = ['decimalComma', 'decimalPoint'];

/** Locale de référence de chaque convention pour `parseAmountInput` (point / virgule des milliers). */
const FORMAT_LOCALE: Record<ImportNumberFormat, string> = { decimalComma: 'de-DE', decimalPoint: 'en-US' };
const DECIMAL_CHAR: Record<ImportNumberFormat, string> = { decimalComma: ',', decimalPoint: '.' };

/** Nombre minimal de montants prouvant une convention pour la retenir sans confirmation. */
export const MIN_FORMAT_EVIDENCE = 3;

export type AmountEvidence = ImportNumberFormat | 'ambiguous' | 'neutral' | 'empty' | 'invalid';

/**
 * Devises reconnues dans une cellule de montant : codes et symboles des devises de l'application
 * (`CURRENCIES` : « MAD », « DH », « EUR », « € », « CA$ »…), en début ou en fin de montant, en
 * majuscules ou minuscules. Le plus long d'abord (« CA$ » avant « $ », « E£ » avant « £ »).
 */
const CURRENCY_TOKENS = [...new Set(CURRENCIES.flatMap((c) => [c.code, c.symbol]))].sort((a, b) => b.length - a.length);
const TOKENS = CURRENCY_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
/** Code ou symbole en tête, non collé à une autre lettre (« MADX 5 » n'est pas « MAD »). */
const LEADING_CURRENCY = new RegExp(`^(?:${TOKENS})(?![\\p{L}])`, 'iu');
/** Code ou symbole en fin, non collé à une autre lettre. */
const TRAILING_CURRENCY = new RegExp(`(?<![\\p{L}])(?:${TOKENS})$`, 'iu');

/**
 * Montant d'un fichier débarrassé de son habillage, élément par élément, chacun à sa place :
 *  - un signe (« - », « − », « + ») en tête, avant ou après la devise, ou un « - » final (« 45- ») ;
 *  - un code ou symbole de devise reconnu (`CURRENCY_TOKENS`), en tête ou en fin (« MAD 1 200,00 »,
 *    « 12,50 DH », « € 5 ») ;
 *  - des parenthèses comptables autour de toute la cellule (« (45,00) » = −45,00), sans autre signe.
 * Rien n'est jamais supprimé d'autre : une lettre, un symbole inconnu, un signe mal placé ou en
 * double restent dans le texte renvoyé, que `amountEvidence` refuse alors (« 1e5 », « 1E+05 »,
 * « abc123 », « 12abc34 », « (-45) »). Pas de notation scientifique.
 * null : cellule vide.
 */
export function normalizeImportAmount(raw: string): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let sign: '-' | '+' | null = null;
  let currency = false;
  let paren = false;
  const parens = () => {
    const m = /^\((.*)\)$/.exec(s);
    if (m) {
      paren = true;
      s = m[1].trim();
    }
  };
  const leadingSign = () => {
    if (!paren && sign === null && /^[-−+]/.test(s)) {
      sign = s[0] === '+' ? '+' : '-';
      s = s.slice(1).trim();
    }
  };
  const trailingMinus = () => {
    if (!paren && sign === null && s.endsWith('-')) {
      sign = '-';
      s = s.slice(0, -1).trim();
    }
  };
  const leadingCurrency = () => {
    const m = currency ? null : LEADING_CURRENCY.exec(s);
    if (m) {
      currency = true;
      s = s.slice(m[0].length).trim();
    }
  };
  const trailingCurrency = () => {
    const m = currency ? null : TRAILING_CURRENCY.exec(s);
    if (m) {
      currency = true;
      s = s.slice(0, m.index).trim();
    }
  };
  // « (45,00) », « (MAD 45,00) », « -MAD 12 », « MAD -12 », « 12,00 DH- »… Les parenthèses entourent
  // toute la cellule (comme avant) : « (45,00) DH » reste refusé.
  parens();
  leadingSign();
  leadingCurrency();
  leadingSign();
  trailingMinus();
  trailingCurrency();
  trailingMinus();
  // Signe resté dans le nombre (« +-45 », « (-45) », « MAD --5 ») : la cellule est renvoyée telle
  // quelle, avec ses signes et parenthèses, pour être refusée — jamais lue comme « -45 ».
  if (/^[-−+]/.test(s)) return String(raw).trim();
  return (paren !== (sign === '-') ? '-' : '') + s;
}

/** Ce que la forme d'un montant prouve sur la convention du fichier (voir l'en-tête). */
export function amountEvidence(raw: string): AmountEvidence {
  const n = normalizeImportAmount(raw);
  if (n === null) return 'empty';
  const s = n.replace(/^-/, '');
  if (!/^[\d.,'\s  ]+$/.test(s) || !/\d/.test(s) || !/\d$/.test(s)) return 'invalid';
  const dots = s.split('.').length - 1;
  const commas = s.split(',').length - 1;
  if (!dots && !commas) return 'neutral';
  if (dots && commas) return s.lastIndexOf('.') > s.lastIndexOf(',') ? 'decimalPoint' : 'decimalComma';
  const c = dots ? '.' : ',';
  if (dots + commas > 1) return c === '.' ? 'decimalComma' : 'decimalPoint'; // séparateur répété : milliers
  const after = s.slice(s.lastIndexOf(c) + 1);
  if (after.length === 3) return 'ambiguous';
  return c === '.' ? 'decimalPoint' : 'decimalComma';
}

export interface NumberFormatDetection {
  /**
   * detected : convention prouvée par assez de montants, sans contradiction ;
   * notNeeded : aucun montant ambigu ni conflit (chaque montant se lit seul) ;
   * uncertain : montants ambigus et preuves insuffisantes → choix requis ;
   * conflict : les deux conventions sont prouvées → choix requis.
   */
  status: 'detected' | 'notNeeded' | 'uncertain' | 'conflict';
  /** Format retenu automatiquement (detected ; notNeeded si une convention est prouvée). */
  format: ImportNumberFormat | null;
  /** Nombre de montants prouvant chaque convention. */
  votes: Record<ImportNumberFormat, number>;
  ambiguous: number;
  /** Exemples tirés du fichier (premier montant de chaque catégorie), pour l'expliquer. */
  samples: Partial<Record<ImportNumberFormat | 'ambiguous', string>>;
}

export function detectNumberFormat(values: string[]): NumberFormatDetection {
  const votes: Record<ImportNumberFormat, number> = { decimalComma: 0, decimalPoint: 0 };
  const samples: NumberFormatDetection['samples'] = {};
  let ambiguous = 0;
  for (const v of values) {
    const e = amountEvidence(v);
    if (e === 'decimalComma' || e === 'decimalPoint') {
      votes[e]++;
      samples[e] ??= v.trim();
    } else if (e === 'ambiguous') {
      ambiguous++;
      samples.ambiguous ??= v.trim();
    }
  }
  const proven = IMPORT_NUMBER_FORMATS.filter((f) => votes[f] > 0);
  if (proven.length > 1) return { status: 'conflict', format: null, votes, ambiguous, samples };
  const only = proven[0] ?? null;
  if (only && votes[only] >= MIN_FORMAT_EVIDENCE) return { status: 'detected', format: only, votes, ambiguous, samples };
  if (ambiguous === 0) return { status: 'notNeeded', format: only, votes, ambiguous, samples };
  return { status: 'uncertain', format: null, votes, ambiguous, samples };
}

/** `unresolved` : montant ambigu alors qu'aucun format n'est fixé (choix requis). */
export type ImportAmountIssue = AmountInputIssue | 'unresolved';
export type ImportAmountResult = { ok: true; value: number | null } | { ok: false; issue: ImportAmountIssue };

/**
 * Lit un montant de fichier. `format` : convention fixée (détectée ou choisie) ; null : aucune, et
 * seuls les montants dont la forme suffit (neutres ou prouvant eux-mêmes leur convention) sont lus.
 * Au-delà des décimales de la devise, seuls des zéros sont admis (« 1.500 » en point décimal = 1,50) :
 * jamais d'arrondi. Toujours en unités minimales entières (BigInt dans `parseAmountInput`).
 */
export function parseImportAmountWithFormat(raw: string, currency: CurrencyCode, format: ImportNumberFormat | null): ImportAmountResult {
  const n = normalizeImportAmount(raw);
  if (n === null) return { ok: true, value: null };
  const evidence = amountEvidence(raw);
  if (evidence === 'invalid') return { ok: false, issue: 'invalid' };
  let used: ImportNumberFormat;
  if (format) used = format;
  else if (evidence === 'ambiguous') return { ok: false, issue: 'unresolved' };
  else used = evidence === 'neutral' ? 'decimalPoint' : (evidence as ImportNumberFormat);
  // Convention fixée : décimales au-delà de la devise admises seulement si ce sont des zéros.
  const dec = DECIMAL_CHAR[used];
  const d = currencyDecimals(currency);
  let text = n;
  const cut = text.lastIndexOf(dec);
  const other = dec === ',' ? '.' : ',';
  if (cut >= 0 && text.indexOf(dec) === cut && !text.slice(cut + 1).includes(other)) {
    const frac = text.slice(cut + 1);
    if (/^\d+$/.test(frac) && frac.length > d) {
      // Séparateur décimal du format : des décimales en trop non nulles sont refusées, jamais arrondies.
      if (!/^0+$/.test(frac.slice(d))) return { ok: false, issue: 'precision' };
      text = d ? text.slice(0, cut + 1 + d) : text.slice(0, cut);
    }
  }
  const r = parseAmountInput(text, currency, FORMAT_LOCALE[used]);
  return r.ok ? r : { ok: false, issue: r.issue };
}

/** Exemple d'écriture d'une convention (« 1.234,56 » / « 1,234.56 »), pour l'interface. */
export function numberFormatExample(format: ImportNumberFormat): string {
  return format === 'decimalComma' ? '1.234,56' : '1,234.56';
}
