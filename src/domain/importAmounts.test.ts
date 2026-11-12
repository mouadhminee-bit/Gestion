/**
 * Import CSV — format des nombres détecté au niveau du fichier, puis lecture des montants.
 * Jamais de conversion silencieuse dans un autre ordre de grandeur : un montant ambigu n'est lu
 * qu'une fois la convention établie (détectée sur assez de montants, ou choisie).
 */
import { describe, expect, it } from 'vitest';
import { amountEvidence, detectNumberFormat, MIN_FORMAT_EVIDENCE, normalizeImportAmount, parseImportAmountWithFormat, type ImportNumberFormat } from './importAmounts';
import { parseImportAmount } from './csv';

const read = (raw: string, format: ImportNumberFormat | null, currency = 'MAD') => {
  const r = parseImportAmountWithFormat(raw, currency, format);
  return r.ok ? r.value : `!${r.issue}`;
};

describe('indice de format d\'un montant isolé', () => {
  it.each([
    // Cas de la mission.
    ['1.500', 'ambiguous'],
    ['1,500', 'ambiguous'],
    ['180.000', 'ambiguous'],
    ['180,000', 'ambiguous'],
    ['0.500', 'ambiguous'],
    ['0,500', 'ambiguous'],
    ['1.500,00', 'decimalComma'],
    ['1,500.00', 'decimalPoint'],
    ['1 200,00', 'decimalComma'],
    ['1,200.00', 'decimalPoint'],
    ['245,30', 'decimalComma'],
    ['245.30', 'decimalPoint'],
    ['-245,30', 'decimalComma'],
    ['-245.30', 'decimalPoint'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'invalid'],
    ['n/a', 'invalid'],
    // Autres formes.
    ['1500', 'neutral'],
    ['-45', 'neutral'],
    ['1 200', 'neutral'],
    ['1.234.567', 'decimalComma'], // point répété : milliers
    ['1,234,567', 'decimalPoint'],
    ['12,5', 'decimalComma'],
    ['12.5', 'decimalPoint'],
    ['1,2345', 'decimalComma'],
    ['(45,00)', 'decimalComma'],
    ['12,50 DH', 'decimalComma'],
    ['MAD 99', 'neutral'],
    ['45-', 'neutral'],
    ['1.', 'invalid'],
  ])('« %s » → %s', (raw, evidence) => expect(amountEvidence(raw)).toBe(evidence));

  it('habillage retiré : devise, parenthèses comptables, signe final', () => {
    expect(normalizeImportAmount('(45,00)')).toBe('-45,00');
    expect(normalizeImportAmount('12,50 DH')).toBe('12,50');
    expect(normalizeImportAmount('MAD 99')).toBe('99');
    expect(normalizeImportAmount('45-')).toBe('-45');
    expect(normalizeImportAmount('+12')).toBe('12');
    expect(normalizeImportAmount('')).toBeNull();
  });
});

describe('lecture : formats bancaires courants (inchangés)', () => {
  it.each([
    ['1.500,00', 150_000],
    ['1,500.00', 150_000],
    ['1 200,00', 120_000],
    ['1 200,00', 120_000],
    ['1,200.00', 120_000],
    ['-245,30', -24_530],
    ['-245.30', -24_530],
    ['245,30', 24_530],
    ['245.30', 24_530],
    ['1500', 150_000],
    ['-45', -4_500],
    ['(45,00)', -4_500],
    ['12,50 DH', 1_250],
    ['45-', -4_500],
  ])('« %s » → %i, sans format fixé (la forme suffit)', (raw, minor) => expect(read(raw, null)).toBe(minor));

  it('montants vides et cellules de texte', () => {
    expect(read('', null)).toBeNull();
    expect(read('', 'decimalComma')).toBeNull();
    expect(read('abc', null)).toBe('!invalid');
    expect(read('abc', 'decimalPoint')).toBe('!invalid');
    expect(read('n/a', 'decimalComma')).toBe('!invalid');
  });
});

describe('validation stricte des caractères : rien n\'est supprimé en silence', () => {
  const FORMATS = [null, 'decimalComma', 'decimalPoint'] as const;

  it.each([
    // Notation scientifique : jamais interprétée.
    ['1e5'],
    ['1E+05'],
    ['1E5'],
    ['1.5e3'],
    ['2,5E-3'],
    // Lettres au milieu, avant ou après le nombre.
    ['abc123'],
    ['12abc34'],
    ['123abc'],
    ['REF 123'],
    ['12 DH 50'],
    ['1,5x'],
    ['1 2a'],
    ['Infinity'],
    ['NaN'],
    ['0x10'],
    // Devise inconnue, collée à d'autres lettres, ou répétée.
    ['MADX 5'],
    ['5 XDH'],
    ['5 EURO'],
    ['MAD 5 EUR'],
    ['€€ 5'],
    ['5 € €'],
    // Symboles inconnus.
    ['12#'],
    ['1/2'],
    ['12%'],
    ['~12'],
    // Signe mal placé ou en double ; parenthèses combinées à un signe.
    ['--45'],
    ['+-45'],
    ['+−45'],
    ['-−45'],
    ['MAD --5'],
    ['(+45)'],
    ['45--'],
    ['4-5'],
    ['(-45)'],
    ['-(45)'],
    ['(45)-'],
    ['(45'],
    ['45)'],
    // Devise hors des parenthèses : non reconnu (comme avant ; les parenthèses entourent la cellule).
    ['(45,00) DH'],
    ['DH (45,00)'],
    // Chiffres arabes et persans : non pris en charge dans l'import CSV.
    ['١٢٣'],
    ['۱۲۳'],
  ])('« %s » : refusé explicitement, dans toutes les conventions', (raw) => {
    expect(amountEvidence(raw)).toBe('invalid');
    for (const f of FORMATS) expect(read(raw, f), `${raw} / ${f}`).toBe('!invalid');
  });

  it.each([
    ['MAD 1 200,00', 120_000],
    ['1 200,00 MAD', 120_000],
    ['mad 1 200,00', 120_000],
    ['1.200,00', 120_000],
    ['1,200.00', 120_000],
    ['-245,30', -24_530],
    ['−245,30', -24_530],
    ['(45,00)', -4_500],
    ['(MAD 45,00)', -4_500],
    ['-MAD 12,00', -1_200],
    ['MAD -12,00', -1_200],
    ['12,00 MAD-', -1_200],
    ['12,50 dh', 1_250],
    ['DH12,50', 1_250],
    ['€5', 500],
    ['$1,500.00', 150_000],
    ['CA$ 10', 1_000],
    ['E£ 10', 1_000],
    ['10 FCFA', 1_000],
    ['CHF 1\'200.50', 120_050],
    ['+12', 1_200],
  ])('« %s » → %i : signe, devise reconnue et parenthèses à leur place', (raw, minor) => expect(read(raw, null)).toBe(minor));

  it('montants refusés : jamais comptés comme preuve d\'un format', () => {
    expect(detectNumberFormat(['1e5', 'abc123', '12abc34', '1.5e3', '1,5x'])).toMatchObject({ status: 'notNeeded', format: null, votes: { decimalComma: 0, decimalPoint: 0 }, ambiguous: 0 });
  });

  it('montants acceptés : formats déjà validés relus à l\'identique avec la convention fixée', () => {
    expect(read('MAD 1 200,00', 'decimalComma')).toBe(120_000);
    expect(read('1.200,00', 'decimalComma')).toBe(120_000);
    expect(read('1,200.00', 'decimalPoint')).toBe(120_000);
    expect(read('-245,30', 'decimalComma')).toBe(-24_530);
    expect(read('(45,00)', 'decimalComma')).toBe(-4_500);
  });
});

describe('lecture : montants ambigus', () => {
  it.each([['1.500'], ['1,500'], ['180.000'], ['180,000'], ['0.500'], ['0,500']])('« %s » sans format établi : non lu (choix requis)', (raw) => expect(read(raw, null)).toBe('!unresolved'));

  it.each([
    // [valeur, virgule décimale, point décimal]
    ['1.500', 150_000, 150], // 1 500 DH ou 1,50 DH selon la convention, jamais devinée
    ['1,500', 150, 150_000],
    ['180.000', 18_000_000, 18_000],
    ['180,000', 18_000, 18_000_000],
    ['0.500', '!ambiguous', 50], // en virgule décimale, « 0.500 » n'est pas des milliers (B1) : refusé
    ['0,500', 50, '!ambiguous'],
  ])('« %s » : %s en virgule décimale, %s en point décimal', (raw, comma, point) => {
    expect(read(raw, 'decimalComma')).toBe(comma);
    expect(read(raw, 'decimalPoint')).toBe(point);
  });

  it('format fixé : un montant de l\'autre convention est refusé, jamais converti', () => {
    expect(read('1,500.00', 'decimalComma')).toBe('!ambiguous');
    expect(read('245.30', 'decimalComma')).toBe('!ambiguous');
    expect(read('1.500,00', 'decimalPoint')).toBe('!ambiguous');
    expect(read('245,30', 'decimalPoint')).toBe('!ambiguous');
  });

  it('décimales au-delà de la devise : seulement des zéros, jamais d\'arrondi', () => {
    expect(read('1,2345', 'decimalComma')).toBe('!precision');
    expect(read('1,2300', 'decimalComma')).toBe(123);
    expect(read('12,345', 'decimalComma')).toBe('!precision');
    expect(read('1.500', 'decimalPoint', 'TND')).toBe(1_500); // trois décimales en TND
    expect(read('1.500', 'decimalComma', 'JPY')).toBe(1_500);
    expect(read('12,5', 'decimalComma', 'JPY')).toBe('!precision');
  });
});

describe('détection au niveau du fichier', () => {
  it(`convention prouvée par au moins ${MIN_FORMAT_EVIDENCE} montants, sans contradiction : retenue, montants ambigus résolus`, () => {
    const file = ['-245,30', '12,00', '1 200,00', '1.500', '-45'];
    const d = detectNumberFormat(file);
    expect(d).toMatchObject({ status: 'detected', format: 'decimalComma', votes: { decimalComma: 3, decimalPoint: 0 }, ambiguous: 1 });
    expect(file.map((v) => read(v, d.format))).toEqual([-24_530, 1_200, 120_000, 150_000, -4_500]);
    const en = detectNumberFormat(['-245.30', '1,200.00', '9.99', '1,500']);
    expect(en).toMatchObject({ status: 'detected', format: 'decimalPoint' });
    expect(read('1,500', en.format)).toBe(150_000);
  });

  it('jamais de conclusion à partir d\'un ou deux exemples quand des montants restent ambigus', () => {
    expect(detectNumberFormat(['12,50', '1.500'])).toMatchObject({ status: 'uncertain', format: null });
    expect(detectNumberFormat(['12,50', '3,20', '1.500'])).toMatchObject({ status: 'uncertain', format: null });
    expect(detectNumberFormat(['1.500', '180.000'])).toMatchObject({ status: 'uncertain', format: null, votes: { decimalComma: 0, decimalPoint: 0 }, ambiguous: 2, samples: { ambiguous: '1.500' } });
    expect(detectNumberFormat(['1.500'])).toMatchObject({ status: 'uncertain', format: null });
  });

  it('conventions mélangées : conflit, aucun format retenu', () => {
    const d = detectNumberFormat(['245,30', '245.30', '1.500']);
    expect(d).toMatchObject({ status: 'conflict', format: null, samples: { decimalComma: '245,30', decimalPoint: '245.30' } });
    // Même avec une majorité écrasante : le conflit est signalé.
    expect(detectNumberFormat(['1,00', '2,00', '3,00', '4,00', '5.50']).status).toBe('conflict');
  });

  it('aucun montant ambigu : pas de choix nécessaire', () => {
    expect(detectNumberFormat(['1500', '-45', ''])).toMatchObject({ status: 'notNeeded', format: null });
    expect(detectNumberFormat(['-245,30', '1 200,00', 'abc', '-45'])).toMatchObject({ status: 'notNeeded', format: 'decimalComma' });
    expect(detectNumberFormat([])).toMatchObject({ status: 'notNeeded', format: null });
  });

  it('propriété : un fichier écrit dans une convention n\'est jamais lu dans un autre ordre de grandeur', () => {
    const values = [0, 5, 50, 1_250, 24_530, 100_000, 150_000, 1_234_567, 18_000_000, 123_456_789];
    const write = (minor: number, f: ImportNumberFormat, grouped: boolean, decimals: boolean) => {
      const n = new Intl.NumberFormat(f === 'decimalComma' ? 'de-DE' : 'en-US', { useGrouping: grouped, minimumFractionDigits: decimals ? 2 : 0, maximumFractionDigits: decimals ? 2 : 0 });
      return n.format((decimals ? minor : minor - (minor % 100)) / 100);
    };
    for (const f of ['decimalComma', 'decimalPoint'] as ImportNumberFormat[]) {
      for (const grouped of [true, false]) {
        for (const decimals of [true, false]) {
          const file = values.map((v) => write(v, f, grouped, decimals));
          const expected = values.map((v) => (decimals ? v : v - (v % 100)));
          const d = detectNumberFormat(file);
          // Jamais l'autre convention.
          expect(d.format === null || d.format === f, `${f} ${grouped} ${decimals}`).toBe(true);
          file.forEach((raw, i) => {
            const r = read(raw, d.format);
            if (typeof r === 'number') expect(r, `${f} « ${raw} »`).toBe(expected[i]);
            else expect(['!unresolved'], `${f} « ${raw} »`).toContain(r); // lu exactement, ou en attente du choix
          });
          // Avec la convention choisie explicitement : tout est lu exactement.
          file.forEach((raw, i) => expect(read(raw, f), `${f} choisi « ${raw} »`).toBe(expected[i]));
        }
      }
    }
  });

  it('ancien décodage (parseImportAmount) inchangé, non utilisé par l\'assistant d\'import', () => {
    expect(parseImportAmount('-1 234,56', 'MAD')).toBe(-123456);
    expect(parseImportAmount('1.500', 'MAD')).toBe(150);
  });
});
