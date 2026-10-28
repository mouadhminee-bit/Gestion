import type { CurrencyCode } from '../money';
import { currencyDecimals, roundHalfAwayFromZero } from '../money';
import type { ISODate } from '../dates';
import type { ExchangeRate } from '../types';

export interface ResolvedRate {
  rate: number;
  date: ISODate;
  /** Taux obtenu en inversant une cotation quote→base. */
  inverted: boolean;
}

/**
 * Taux identifié le plus récent dont la date est ≤ `asOf`.
 * Cherche d'abord la paire directe, puis la paire inverse (1 / taux).
 * Aucun taux n'est inventé : sans cotation datée, la conversion est impossible.
 */
export function findRate(rates: ExchangeRate[], from: CurrencyCode, to: CurrencyCode, asOf: ISODate): ResolvedRate | null {
  if (from === to) return { rate: 1, date: asOf, inverted: false };
  let best: ResolvedRate | null = null;
  for (const r of rates) {
    if (r.date > asOf || !(r.rate > 0)) continue;
    let candidate: ResolvedRate | null = null;
    if (r.base === from && r.quote === to) candidate = { rate: r.rate, date: r.date, inverted: false };
    else if (r.base === to && r.quote === from) candidate = { rate: 1 / r.rate, date: r.date, inverted: true };
    if (!candidate) continue;
    // À date égale, on privilégie la cotation directe.
    if (!best || candidate.date > best.date || (candidate.date === best.date && best.inverted && !candidate.inverted)) {
      best = candidate;
    }
  }
  return best;
}

/** Convertit un montant en unités minimales d'une devise à une autre. null si aucun taux. */
export function convertMinor(
  minor: number,
  from: CurrencyCode,
  to: CurrencyCode,
  asOf: ISODate,
  rates: ExchangeRate[],
): number | null {
  if (from === to) return minor;
  const r = findRate(rates, from, to, asOf);
  if (!r) return null;
  const scale = 10 ** (currencyDecimals(to) - currencyDecimals(from));
  return roundHalfAwayFromZero(minor * r.rate * scale);
}

export type Converter = (minor: number, currency: CurrencyCode, date: ISODate) => number | null;

export function makeConverter(base: CurrencyCode, rates: ExchangeRate[]): Converter {
  return (minor, currency, date) => convertMinor(minor, currency, base, date, rates);
}
