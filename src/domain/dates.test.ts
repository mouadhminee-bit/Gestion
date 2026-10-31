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

  describe('aujourd’hui dans un fuseau donné', () => {
    // Les décalages réels d'un fuseau (ex. Africa/Casablanca) évoluent avec les données
    // tzdata de l'environnement : aucun test ne fige un décalage supposé pour une zone
    // géographique. Le changement de jour est vérifié sur des zones à décalage fixe.
    const instant = new Date('2026-12-31T23:30:00Z');

    it('change de jour à minuit local (zones à décalage fixe)', () => {
      expect(todayISO('UTC', instant)).toBe('2026-12-31');
      // Etc/GMT-1 = UTC+1 en permanence (signe POSIX inversé).
      expect(todayISO('Etc/GMT-1', instant)).toBe('2027-01-01');
      // Etc/GMT+5 = UTC-5 en permanence.
      expect(todayISO('Etc/GMT+5', new Date('2027-01-01T03:00:00Z'))).toBe('2026-12-31');
      expect(todayISO('Etc/GMT+5', new Date('2027-01-01T05:00:00Z'))).toBe('2027-01-01');
    });

    it('Africa/Casablanca : date locale = UTC + décalage réel de la zone à cet instant', () => {
      // Décalage lu dans les règles de fuseau de l'environnement, puis date attendue
      // calculée arithmétiquement (indépendant de l'hypothèse UTC+0 / UTC+1).
      const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Casablanca', timeZoneName: 'longOffset' })
        .formatToParts(instant)
        .find((p) => p.type === 'timeZoneName')!.value; // « GMT », « GMT+01:00 »…
      const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name)!;
      const offsetMin = m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
      const expected = new Date(instant.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
      expect(todayISO('Africa/Casablanca', instant)).toBe(expected);
    });

    it('Africa/Casablanca : à midi UTC, même date quel que soit le décalage', () => {
      expect(todayISO('Africa/Casablanca', new Date('2026-12-31T12:00:00Z'))).toBe('2026-12-31');
      expect(todayISO('Africa/Casablanca', new Date('2026-06-15T12:00:00Z'))).toBe('2026-06-15');
    });
  });
});
