import { describe, expect, it } from 'vitest';
import { formatMoney, formatPercent, fromMajor, parseAmount, percentOf, roundHalfAwayFromZero, toPlainString } from './money';

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
