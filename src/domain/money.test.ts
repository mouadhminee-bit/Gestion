import { describe, expect, it } from 'vitest';
import { amountInputExample, amountSeparators, formatAmountInput, formatMoney, formatPercent, fromMajor, parseAmount, parseAmountInput, percentOf, roundHalfAwayFromZero, toPlainString } from './money';
import { LOCALE_CODES } from './settings';

describe('parseAmount — saisie exacte en unités minimales', () => {
  it.each([
    ['1234', 123400],
    ['1 234,56', 123456],
    ['1 234,56', 123456],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['12,5', 1250],
    ['12.5', 1250],
    ['0,1', 10],
    ['-45,90', -4590],
    ['(12,50)', -1250],
    ['12,50 DH', 1250],
    ['MAD 99', 9900],
    ['1.234.567', 123456700],
    ['0,005', 1], // arrondi demi vers l'extérieur
    ['0,004', 0],
  ])('%s → %d', (input, expected) => {
    expect(parseAmount(input, 'MAD')).toBe(expected);
  });

  it('rejette les saisies invalides', () => {
    expect(parseAmount('', 'MAD')).toBeNull();
    expect(parseAmount('abc', 'MAD')).toBeNull();
    expect(parseAmount('1,2,3', 'MAD')).toBeNull();
    expect(parseAmount('12-3', 'MAD')).toBeNull();
  });

  it('respecte le nombre de décimales de la devise', () => {
    expect(parseAmount('1500', 'JPY')).toBe(1500);
    expect(parseAmount('12,345', 'TND')).toBe(12345);
    expect(parseAmount('10', 'XOF')).toBe(10);
  });

  it('évite les erreurs de virgule flottante (0,1 + 0,2)', () => {
    const a = parseAmount('0,1', 'MAD')!;
    const b = parseAmount('0,2', 'MAD')!;
    expect(a + b).toBe(parseAmount('0,3', 'MAD'));
  });
});

describe('formatage', () => {
  it('formate en MAD avec DH ou MAD', () => {
    expect(formatMoney(123456, 'MAD', { locale: 'fr-MA' }).replace(/\s/g, ' ')).toMatch(/1.234,56 DH/);
    expect(formatMoney(123456, 'MAD', { locale: 'fr-MA', display: 'code' })).toMatch(/MAD$/);
  });
  it('gère zéro et négatifs', () => {
    expect(formatMoney(0, 'MAD', { locale: 'fr-FR' })).toMatch(/^0,00/);
    expect(formatMoney(-1050, 'MAD', { locale: 'fr-FR' })).toMatch(/^-10,50/);
  });
  it('respecte la locale', () => {
    expect(formatMoney(123456, 'USD', { locale: 'en-US' })).toBe('1,234.56 $');
  });
  it('taux non calculable', () => {
    expect(formatPercent(null)).toBe('Non calculable');
  });
  it('représentation brute', () => {
    expect(toPlainString(-5, 'MAD')).toBe('-0.05');
    expect(toPlainString(123456, 'MAD', ',')).toBe('1234,56');
    expect(toPlainString(1500, 'JPY')).toBe('1500');
  });
});

describe('arrondis', () => {
  it('demi vers l’extérieur', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(1.005 * 100)).toBe(101);
  });
  it('pourcentage d’un montant', () => {
    expect(percentOf(90000, 15)).toBe(13500);
    expect(percentOf(333, 50)).toBe(167);
  });
  it('fromMajor', () => {
    expect(fromMajor(10.86, 'MAD')).toBe(1086);
  });
});

// ---------------------------------------------------------------------------
// A1 — saisie d'un montant selon la locale active
// ---------------------------------------------------------------------------

const read = (text: string, locale: string, currency = 'MAD') => {
  const r = parseAmountInput(text, currency, locale);
  return r.ok ? r.value : `!${r.issue}`;
};

describe('parseAmountInput — fr-MA (point = milliers, virgule = décimale)', () => {
  // Cas obligatoires de la mission A1 (résultat attendu en centimes).
  it.each([
    ['180.000', 18_000_000],
    ['180.000,50', 18_000_050],
    ['1.500.000,75', 150_000_075],
    ['180,50', 18_050],
    ['0,01', 1],
    ['0', 0],
  ])('« %s » → %i', (text, minor) => expect(read(text, 'fr-MA')).toBe(minor));

  it.each([
    ['', null],
    ['   ', null],
    ['-12,5', -1_250],
    ['- 12', -1_200],
    ['−7,25', -725],
    ['+3', 300],
    ['-0', 0],
    ['180 000', 18_000_000],
    ['180\u00a0000,50', 18_000_050],
    ['180\u202f000', 18_000_000],
    ['1 500 000,75', 150_000_075],
    [',50', 50],
    ['007', 700],
    ['١٨٠٫٥٠', 18_050],
    ['90071992547409,91', Number.MAX_SAFE_INTEGER],
  ])('« %s » → %s', (text, expected) => expect(read(text, 'fr-MA')).toBe(expected));

  it.each([
    ['180.50', 'ambiguous'], // décimale saisie avec un point ?
    ['1.5', 'ambiguous'],
    ['180,500', 'ambiguous'], // milliers saisis avec une virgule ?
    ['1,500.50', 'ambiguous'], // ordre des séparateurs de l'anglais
    ['1..5', 'invalid'],
    ['1,,5', 'invalid'],
    ['1,2,3', 'invalid'],
    ['1.23.456', 'invalid'],
    ['1 50', 'invalid'],
    ['1 234.567,89', 'invalid'], // deux séparateurs de milliers différents
    ['12,5 0', 'invalid'],
    ['12-', 'invalid'],
    ['1e5', 'invalid'],
    ['abc', 'invalid'],
    ['-', 'invalid'],
    ['180.', 'invalid'],
    ['12,5000', 'precision'],
    ['0,0001', 'precision'],
    ['90071992547409,92', 'tooLarge'],
    ['99999999999999999999', 'tooLarge'],
  ])('« %s » refusé : %s', (text, issue) => expect(read(text, 'fr-MA')).toBe(`!${issue}`));
});

describe('parseAmountInput — autres conventions prises en charge', () => {
  it.each([
    // Anglais : virgule = milliers, point = décimale.
    ['en-US', '180,000', 18_000_000],
    ['en-US', '180,000.50', 18_000_050],
    ['en-US', '1,500,000.75', 150_000_075],
    ['en-US', '180.50', 18_050],
    ['en-US', '0.01', 1],
    ['en-GB', '1,234', 123_400],
    ['en-US', '1 234.56', 123_456],
    // Allemand : comme fr-MA.
    ['de-DE', '180.000', 18_000_000],
    ['de-DE', '180.000,50', 18_000_050],
    ['de-DE', '180,50', 18_050],
    // Espace (insécable) pour les milliers.
    ['fr-FR', '180 000,50', 18_000_050],
    ['fr-FR', '12.50', 1_250], // point étranger à la locale, 2 chiffres : décimal sans ambiguïté
    ['fr-FR', '180.000,50', 18_000_050],
    ['fr-FR', '1.234.567', 123_456_700],
    ['ru-RU', '1 500 000,75', 150_000_075],
    // Apostrophe (Suisse).
    ['de-CH', "1'234.56", 123_456],
    ['de-CH', '1’234.56', 123_456],
    ['fr-CH', "1'234,56", 123_456],
    ['de-CH', '180,50', 18_050],
    // Groupement indien.
    ['hi-IN', '12,34,567.50', 123_456_750],
    ['hi-IN', '1,234,567', 123_456_700],
    ['hi-IN', '1,23,456', 12_345_600],
    // Chiffres et séparateurs arabes, persans.
    ['ar-SA', '١٢٣٤٫٥٦', 123_456],
    ['ar-SA', '١٬٢٣٤٫٥٦', 123_456],
    ['ar-SA', '1234.56', 123_456],
    ['ar-SA', '1,234.56', 123_456],
    ['fa-IR', '۱۲۳۴٫۵', 123_450],
    ['ar-MA', '180.000,50', 18_000_050],
  ])('%s : « %s » → %i', (locale, text, minor) => expect(read(text, locale)).toBe(minor));

  it.each([
    ['en-US', '180.000', 'ambiguous'],
    ['en-US', '180,50', 'ambiguous'],
    ['en-US', '1.500,50', 'ambiguous'],
    ['en-US', '1.234.567', 'ambiguous'],
    ['de-DE', '180.50', 'ambiguous'],
    ['fr-FR', '180.000', 'ambiguous'],
    ['de-CH', '180,000', 'ambiguous'],
    ['ar-SA', '180.000', 'ambiguous'],
    ['ar-SA', '1234٫5.6', 'ambiguous'],
    ['hi-IN', '1.234.567', 'ambiguous'],
    ['en-US', '0.001', 'precision'],
  ])('%s : « %s » refusé : %s', (locale, text, issue) => expect(read(text, locale)).toBe(`!${issue}`));

  it('devises sans décimales et à trois décimales : aucune décimale perdue ni inventée', () => {
    expect(read('1.500', 'fr-MA', 'JPY')).toBe(1_500);
    expect(read('12,5', 'fr-MA', 'JPY')).toBe('!precision');
    expect(read('1,500', 'fr-MA', 'TND')).toBe(1_500);
    expect(read('1.500', 'fr-MA', 'TND')).toBe(1_500_000);
    expect(read('1.500', 'en-US', 'TND')).toBe(1_500);
    expect(read('1.500', 'fr-FR', 'TND')).toBe('!ambiguous');
    expect(read('1,5000', 'fr-MA', 'TND')).toBe('!precision');
  });

  it('séparateurs lus dans Intl pour chacune des 34 locales proposées', () => {
    for (const locale of LOCALE_CODES) {
      const s = amountSeparators(locale);
      expect(s.decimal, locale).not.toBe(s.group);
      expect([3], locale).toContain(s.primary);
      expect([2, 3], locale).toContain(s.secondary);
    }
    expect(amountInputExample('fr-MA', 'MAD')).toBe('1.234,56');
    expect(amountInputExample('en-US', 'MAD')).toBe('1,234.56');
    expect(amountInputExample('fr-FR', 'MAD')).toBe('1\u00a0234,56');
    expect(amountInputExample('fr-MA', 'JPY')).toBe('1.234');
    expect(amountInputExample('fr-MA', 'TND')).toBe('1.234,567');
  });
});

describe('parseAmountInput — cohérence affichage / saisie, jamais d\'écart d\'un facteur 10, 100 ou 1 000', () => {
  const VALUES = [0, 1, 5, 50, 99, 100, 1_250, 18_050, 123_456, 1_500_000, 18_000_000, 18_000_050, 150_000_075, 100_000_000, 123_456_789_012];
  /** Écritures d'un montant dans une locale : affichage de l'application (groupé), sans milliers, entier seul. */
  const writings = (minor: number, locale: string): string[] => {
    const major = minor / 100; // affichage uniquement : valeurs exactes au centime dans ce domaine
    const out = [
      new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(major),
      new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(major),
      formatMoney(minor, 'MAD', { locale }).replace(/\s*DH$/, ''),
    ];
    if (minor % 100 === 0) out.push(new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(major), new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: false }).format(major));
    return out;
  };

  it('un montant affiché par l\'application, ressaisi tel quel, redonne exactement la même valeur (34 locales)', () => {
    for (const locale of LOCALE_CODES) for (const v of VALUES) for (const w of writings(v, locale)) expect(read(w, locale), `${locale} « ${w} »`).toBe(v);
  });

  it('la réécriture du champ (formatAmountInput) se relit à l\'identique, y compris aux bornes', () => {
    for (const locale of LOCALE_CODES) {
      for (const v of [...VALUES, -1, -150_050, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) expect(read(formatAmountInput(v, 'MAD', locale), locale), `${locale} ${v}`).toBe(v);
      for (const cur of ['JPY', 'TND']) for (const v of [0, 7, 1_500, 123_456]) expect(read(formatAmountInput(v, cur, locale), locale, cur), `${locale} ${cur} ${v}`).toBe(v);
    }
  });

  it('un montant écrit selon une AUTRE convention est lu exactement ou refusé — jamais converti avec un autre ordre de grandeur', () => {
    let refused = 0;
    let exact = 0;
    for (const writer of LOCALE_CODES) {
      for (const v of VALUES) {
        for (const w of writings(v, writer)) {
          for (const reader of LOCALE_CODES) {
            const r = read(w, reader);
            if (typeof r === 'string') refused++;
            else {
              expect(r, `${writer} « ${w} » lu en ${reader}`).toBe(v);
              exact++;
            }
          }
        }
      }
    }
    // Les deux issues existent : lecture exacte quand la convention est sans équivoque, refus sinon.
    expect(exact).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it('import de fichiers (parseAmount) inchangé : hors du périmètre de la saisie selon la locale', () => {
    expect(parseAmount('1.500', 'MAD')).toBe(150);
    expect(parseAmount('1,234.56', 'MAD')).toBe(123456);
    expect(parseAmount('(12,50)', 'MAD')).toBe(-1250);
  });
});

// ---------------------------------------------------------------------------
// B1 — un groupe de milliers ne commence jamais par 0
// ---------------------------------------------------------------------------

describe('B1 — premier groupe nul : jamais lu comme des milliers', () => {
  it.each([
    // Un seul séparateur derrière un entier écrit normalement : aussi lisible comme décimale → ambiguous.
    ['0.500', 'fr-MA', 'ambiguous'], // 0,50 voulu ? jamais 500,00
    ['0.050', 'fr-MA', 'ambiguous'], // jamais 50,00
    ['0,500', 'en-US', 'ambiguous'],
    ['0,050', 'en-US', 'ambiguous'],
    ['-0.500', 'fr-MA', 'ambiguous'],
    ['0.500', 'de-DE', 'ambiguous'],
    ['0,500', 'hi-IN', 'ambiguous'],
    // Groupements manifestement incorrects (zéros superflus, séparateurs répétés, espace) → invalid.
    ['000.015', 'fr-MA', 'invalid'],
    ['00.500', 'fr-MA', 'invalid'],
    ['01.500', 'fr-MA', 'invalid'],
    ['0.500.000', 'fr-MA', 'invalid'],
    ['0.500,25', 'fr-MA', 'invalid'],
    ['0,500,000', 'en-US', 'invalid'],
    ['0,500.25', 'en-US', 'invalid'],
    ['0 500', 'fr-FR', 'invalid'],
    ['0 500,25', 'fr-FR', 'invalid'],
    ["0'500", 'de-CH', 'invalid'],
    ['0.500.000', 'fr-FR', 'invalid'], // séparateur étranger répété
    ['0.500.000', 'en-US', 'invalid'], // séparateur décimal répété
    ['٠٬٥٠٠', 'ar-SA', 'invalid'],
  ])('« %s » (%s) refusé : %s', (text, locale, issue) => expect(read(text, locale)).toBe(`!${issue}`));

  it.each([
    // Groupements valides : inchangés.
    ['1.500', 'fr-MA', 150_000],
    ['12.500', 'fr-MA', 1_250_000],
    ['180.000', 'fr-MA', 18_000_000],
    ['1.500.000,75', 'fr-MA', 150_000_075],
    ['10.000', 'fr-MA', 1_000_000],
    ['100.000', 'fr-MA', 10_000_000],
    ['1,500', 'en-US', 150_000],
    ['12,500', 'en-US', 1_250_000],
    ['180,000.50', 'en-US', 18_000_050],
    ['1,00,000', 'hi-IN', 10_000_000],
    // Séparateurs décimaux valides, avec 0 en partie entière : inchangés.
    ['0,50', 'fr-MA', 50],
    ['0,05', 'fr-MA', 5],
    ['0,5', 'fr-MA', 50],
    ['-0,25', 'fr-MA', -25],
    ['0.50', 'en-US', 50],
    ['0.05', 'en-US', 5],
    ['0,5', 'fr-FR', 50],
    ['0.5', 'fr-FR', 50], // point étranger, une décimale
    ['٠٫٥٠', 'ar-SA', 50],
    ['0', 'fr-MA', 0],
    ['007', 'fr-MA', 700], // chiffres seuls, sans groupement
  ])('« %s » (%s) → %i (inchangé)', (text, locale, minor) => expect(read(text, locale)).toBe(minor));

  it('les 34 locales : « 0 » + séparateur de milliers + « 500 » refusé ; « 1 » + séparateur + « 500 » = 1 500 ; « 0 » + décimale + « 50 » = 0,50', () => {
    for (const locale of LOCALE_CODES) {
      const sep = amountSeparators(locale);
      const group = sep.group === ' ' ? '\u00a0' : sep.group;
      expect(read(`0${group}500`, locale), `${locale} 0${group}500`).toMatch(/^!(ambiguous|invalid)$/);
      expect(read(`000${group}015`, locale), `${locale} 000${group}015`).toBe('!invalid');
      expect(read(`0${group}500${group}000`, locale), `${locale} 0${group}500${group}000`).toBe('!invalid');
      expect(read(`1${group}500`, locale), `${locale} 1${group}500`).toBe(150_000);
      expect(read(`180${group}000`, locale), `${locale} 180${group}000`).toBe(18_000_000);
      expect(read(`0${sep.decimal}50`, locale), `${locale} 0${sep.decimal}50`).toBe(50);
    }
  });

  it('énumération : aucune saisie acceptée n\'a un groupe de milliers de tête nul (34 locales, toutes les chaînes de 1 à 5 caractères)', () => {
    const alphabet = ['0', '1', '5', '.', ',', ' ', "'"];
    const strings: string[] = [];
    const gen = (prefix: string) => {
      if (prefix) strings.push(prefix);
      if (prefix.length < 5) for (const c of alphabet) gen(prefix + c);
    };
    gen('');
    // En MAD (2 décimales), trois chiffres après un séparateur ne peuvent être qu'un groupe de milliers.
    const leadingZeroGroup = /^0\d*[ .,'][0-9]{3}/;
    let accepted = 0;
    for (const locale of LOCALE_CODES) {
      for (const text of strings) {
        const r = parseAmountInput(text, 'MAD', locale);
        if (!r.ok || r.value === null) continue;
        accepted++;
        expect(leadingZeroGroup.test(text.trim()), `${locale} « ${text} » → ${r.value}`).toBe(false);
      }
    }
    expect(accepted).toBeGreaterThan(10_000); // l'énumération couvre bien des saisies acceptées
  });
});
