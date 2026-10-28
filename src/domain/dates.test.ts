import { describe, expect, it } from 'vitest';
import { addMonths, daysInMonth, formatDate, isLeapYear, isValidISODate, monthsBetweenCeil, previousPeriod, todayISO } from './dates';

describe('dates', () => {
  it('années bissextiles', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('validation des dates limites', () => {
    expect(isValidISODate('2024-02-29')).toBe(true);
    expect(isValidISODate('2026-02-29')).toBe(false);
    expect(isValidISODate('2026-04-31')).toBe(false);
    expect(isValidISODate('2026-13-01')).toBe(false);
    expect(isValidISODate('26-01-01')).toBe(false);
  });

  it('ajout de mois borné à la fin du mois, sans dérive', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('format JJ/MM/AAAA', () => {
    expect(formatDate('2026-10-05')).toBe('05/10/2026');
    expect(formatDate('2026-10-05', 'MM/DD/YYYY')).toBe('10/05/2026');
  });

  it('période précédente', () => {
    expect(previousPeriod({ start: '2026-03-01', end: '2026-03-31' })).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(previousPeriod({ start: '2026-01-01', end: '2026-03-31' })).toEqual({ start: '2025-10-01', end: '2025-12-31' });
    expect(previousPeriod({ start: '2026-03-10', end: '2026-03-19' })).toEqual({ start: '2026-02-28', end: '2026-03-09' });
  });

  it('mois restants (arrondi supérieur)', () => {
    expect(monthsBetweenCeil('2026-10-28', '2027-10-28')).toBe(12);
    expect(monthsBetweenCeil('2026-10-28', '2027-10-29')).toBe(13);
    expect(monthsBetweenCeil('2026-10-28', '2026-10-01')).toBe(0);
  });

  it('aujourd’hui dans le fuseau Africa/Casablanca', () => {
    // 23h30 UTC le 31/12 → déjà le 01/01 à Casablanca (UTC+1).
    expect(todayISO('Africa/Casablanca', new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(todayISO('UTC', new Date('2026-12-31T23:30:00Z'))).toBe('2026-12-31');
  });
});
