import { describe, expect, it } from 'vitest';
import { detectDateFormat, detectDelimiter, parseCSV, parseDateWithFormat, parseImportAmount, toCSV } from './csv';
import { findDuplicates, isPotentialDuplicate, labelSimilarity } from './duplicates';

describe('CSV', () => {
  it('détecte le séparateur et gère les guillemets', () => {
    const text = 'Date;Libellé;Montant\n01/03/2026;"Courses; marché";-120,50\n02/03/2026;"Dit ""bonjour""";15\n';
    expect(detectDelimiter(text)).toBe(';');
    const rows = parseCSV(text);
    expect(rows).toEqual([
      ['Date', 'Libellé', 'Montant'],
      ['01/03/2026', 'Courses; marché', '-120,50'],
      ['02/03/2026', 'Dit "bonjour"', '15'],
    ]);
  });

  it('gère BOM, CRLF et virgule', () => {
    const rows = parseCSV('﻿a,b\r\n1,"x\ny"\r\n');
    expect(rows).toEqual([['a', 'b'], ['1', 'x\ny']]);
  });

  it('aller-retour export → import, avec neutralisation des formules', () => {
    const csv = toCSV([['Libellé', 'Montant'], ['=SUM(A1)', '-12.50'], ['Café; thé', '3']]);
    const rows = parseCSV(csv);
    expect(rows[1]).toEqual(["'=SUM(A1)", '-12.50']);
    expect(rows[2][0]).toBe('Café; thé');
  });

  it('normalise les dates', () => {
    expect(parseDateWithFormat('05/03/2026', 'DD/MM/YYYY')).toBe('2026-03-05');
    expect(parseDateWithFormat('03/05/2026', 'MM/DD/YYYY')).toBe('2026-03-05');
    expect(parseDateWithFormat('2026-03-05', 'YYYY-MM-DD')).toBe('2026-03-05');
    expect(parseDateWithFormat('05.03.2026', 'DD.MM.YYYY')).toBe('2026-03-05');
    expect(parseDateWithFormat('29/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseDateWithFormat('2026-03-05T10:00:00', 'YYYY-MM-DD')).toBe('2026-03-05');
    expect(detectDateFormat(['13/01/2026', '25/02/2026'])).toBe('DD/MM/YYYY');
    expect(detectDateFormat(['01/13/2026', '02/25/2026'])).toBe('MM/DD/YYYY');
    expect(detectDateFormat(['2026-01-13'])).toBe('YYYY-MM-DD');
  });

  it('normalise les montants (séparateurs décimaux courants)', () => {
    expect(parseImportAmount('-1 234,56', 'MAD')).toBe(-123456);
    expect(parseImportAmount('1,234.56', 'MAD')).toBe(123456);
    expect(parseImportAmount('(45.00)', 'MAD')).toBe(-4500);
    expect(parseImportAmount('', 'MAD')).toBeNull();
    expect(parseImportAmount('n/a', 'MAD')).toBeNull();
  });
});

describe('Doublons potentiels', () => {
  const base = { accountId: 'a', direction: 'out' as const, amount: 12050, date: '2026-03-05', label: 'CB MARJANE CASA 0412' };
  it('détecte un doublon proche', () => {
    expect(isPotentialDuplicate(base, { ...base, date: '2026-03-06', label: 'Marjane Casa' })).toBe(true);
  });
  it('ignore montant, compte ou dates différents', () => {
    expect(isPotentialDuplicate(base, { ...base, amount: 12051 })).toBe(false);
    expect(isPotentialDuplicate(base, { ...base, accountId: 'b' })).toBe(false);
    expect(isPotentialDuplicate(base, { ...base, date: '2026-03-09' })).toBe(false);
    expect(isPotentialDuplicate(base, { ...base, label: 'Pharmacie Atlas' })).toBe(false);
  });
  it('similarité de libellés', () => {
    expect(labelSimilarity('Café de la Corniche', 'cafe de la corniche')).toBe(1);
    expect(labelSimilarity('Uber', 'Taxi')).toBe(0);
  });
  it('associe chaque candidat à un existant', () => {
    const res = findDuplicates([base, { ...base, amount: 1 }], [{ ...base, id: 'x' }]);
    expect(res[0]?.id).toBe('x');
    expect(res[1]).toBeUndefined();
  });
});
