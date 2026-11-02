// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { LAST_ACCOUNT_KEY, MONTH_KEY, SESSION_KEYS_RESET_ON_RESTORE, dropUnknownIds, monthAfterRestore, resetUiStateAfterRestore } from './uiState';

describe('états d’interface après restauration', () => {
  it('monthAfterRestore : mois courant s’il a des opérations, sinon dernier mois passé, sinon le plus récent', () => {
    expect(monthAfterRestore([], '2026-10-15')).toBe('2026-10');
    expect(monthAfterRestore([{ date: '2026-10-01' }, { date: '2025-01-01' }], '2026-10-15')).toBe('2026-10');
    expect(monthAfterRestore([{ date: '2026-03-31' }, { date: '2025-12-01' }, { date: '2027-01-01' }], '2026-10-15')).toBe('2026-03');
    expect(monthAfterRestore([{ date: '2027-02-01' }, { date: '2027-01-01' }], '2026-10-15')).toBe('2027-02');
  });

  it('dropUnknownIds : ignore un compte / une catégorie inexistant(e), conserve le reste', () => {
    const ctx = { accounts: new Map([['a1', {}]]), categories: new Map([['c1', {}]]) };
    const f = { accountId: 'a1', categoryId: 'c1', q: 'loyer' };
    expect(dropUnknownIds(f, ctx)).toBe(f);
    expect(dropUnknownIds({ ...f, accountId: 'ancien' }, ctx)).toEqual({ ...f, accountId: '' });
    expect(dropUnknownIds({ ...f, categoryId: 'ancienne' }, ctx)).toEqual({ ...f, categoryId: '' });
    expect(dropUnknownIds({ accountId: '', categoryId: '' }, ctx)).toEqual({ accountId: '', categoryId: '' });
  });

  it('resetUiStateAfterRestore : efface filtres, onglet et dernier compte ; positionne le mois ; ne touche pas aux autres clés', () => {
    for (const k of SESSION_KEYS_RESET_ON_RESTORE) sessionStorage.setItem(k, '{"accountId":"x"}');
    sessionStorage.setItem(MONTH_KEY, '2030-01');
    sessionStorage.setItem('autre', 'conservé');
    localStorage.setItem(LAST_ACCOUNT_KEY, 'x');
    localStorage.setItem('nexora.theme', 'dark');
    resetUiStateAfterRestore('2026-03');
    for (const k of SESSION_KEYS_RESET_ON_RESTORE) expect(sessionStorage.getItem(k)).toBeNull();
    expect(sessionStorage.getItem(MONTH_KEY)).toBe('2026-03');
    expect(sessionStorage.getItem('autre')).toBe('conservé');
    expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBeNull();
    expect(localStorage.getItem('nexora.theme')).toBe('dark');
    expect(SESSION_KEYS_RESET_ON_RESTORE).toEqual(['nexora.tx-filters', 'nexora.analytics', 'nexora.analytics.recurringTab']);
  });
});
