/**
 * États d'interface mémorisés (sessionStorage / localStorage) et restauration.
 *
 * Ces préférences de confort contiennent des IDENTIFIANTS (compte, catégorie) et le mois
 * affiché. Les identifiants étant propres à chaque jeu de données, ils deviennent
 * invalides après une restauration : les filtres masqueraient alors toutes les données.
 *
 *  - `resetUiStateAfterRestore(month)` : efface les états incompatibles et positionne le
 *    mois affiché (appelé après chaque restauration réussie) ;
 *  - `monthAfterRestore(transactions, today)` : mois cohérent avec les données restaurées ;
 *  - `dropUnknownIds(filters, ctx)` : filet permanent — un filtre visant un identifiant
 *    inexistant est ignoré à l'affichage.
 */
import type { ID, Transaction } from '@/domain/types';
import type { ISODate, MonthKey } from '@/domain/dates';
import { monthKey } from '@/domain/dates';

export const MONTH_KEY = 'nexora.month';
export const LAST_ACCOUNT_KEY = 'nexora.lastAccount';

/** Clés de `sessionStorage` effacées après une restauration (hors mois, repositionné). */
export const SESSION_KEYS_RESET_ON_RESTORE = ['nexora.tx-filters', 'nexora.analytics', 'nexora.analytics.recurringTab'] as const;
/** Clés de `localStorage` effacées après une restauration. */
export const LOCAL_KEYS_RESET_ON_RESTORE = [LAST_ACCOUNT_KEY] as const;

/**
 * Mois à afficher après restauration : le mois courant s'il contient des opérations,
 * sinon le mois de la dernière opération passée (à défaut, la plus récente), sinon le
 * mois courant.
 */
export function monthAfterRestore(transactions: Pick<Transaction, 'date'>[], today: ISODate): MonthKey {
  const current = monthKey(today);
  if (!transactions.length) return current;
  let latestPast = '';
  let latest = '';
  for (const t of transactions) {
    if (t.date.slice(0, 7) === current) return current;
    if (t.date > latest) latest = t.date;
    if (t.date <= today && t.date > latestPast) latestPast = t.date;
  }
  return (latestPast || latest).slice(0, 7);
}

export function resetUiStateAfterRestore(month: MonthKey): void {
  try {
    for (const k of SESSION_KEYS_RESET_ON_RESTORE) sessionStorage.removeItem(k);
    sessionStorage.setItem(MONTH_KEY, month);
  } catch {
    /* stockage indisponible : rien à réinitialiser */
  }
  try {
    for (const k of LOCAL_KEYS_RESET_ON_RESTORE) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** Ignore les filtres de compte / catégorie dont l'identifiant n'existe pas (ou plus). */
export function dropUnknownIds<F extends { accountId: string; categoryId: string }>(f: F, ctx: { accounts: Map<ID, unknown>; categories: Map<ID, unknown> }): F {
  const accountOk = !f.accountId || ctx.accounts.has(f.accountId);
  const categoryOk = !f.categoryId || ctx.categories.has(f.categoryId);
  if (accountOk && categoryOk) return f;
  return { ...f, accountId: accountOk ? f.accountId : '', categoryId: categoryOk ? f.categoryId : '' };
}
