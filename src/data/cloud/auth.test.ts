/**
 * V2.5 — outils d'authentification (`cloud/auth.ts`) : messages d'erreur, délais, saisie.
 * Erreurs construites avec les classes réelles du SDK ; aucun accès réseau.
 */
import { describe, expect, it, vi } from 'vitest';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, AuthUnknownError } from '@supabase/supabase-js';
import { AuthTimeoutError, authMessageKey, checkCredentials, isTransientAuthError, withTimeout } from './auth';
import fr from '@/i18n/locales/fr';

describe('V2.5 — messages d’erreur d’authentification', () => {
  it.each([
    ['invalid_credentials', 400, 'auth.err.invalidCredentials'],
    ['email_not_confirmed', 400, 'auth.err.emailNotConfirmed'],
    ['weak_password', 422, 'auth.err.weakPassword'],
    ['email_address_invalid', 400, 'auth.err.emailInvalid'],
    ['email_address_not_authorized', 400, 'auth.err.emailNotAuthorized'],
    ['user_already_exists', 422, 'auth.err.userExists'],
    ['email_exists', 422, 'auth.err.userExists'],
    ['signup_disabled', 422, 'auth.err.signupDisabled'],
    ['over_request_rate_limit', 429, 'auth.err.rateLimit'],
    ['over_email_send_rate_limit', 429, 'auth.err.rateLimit'],
    ['code_inconnu', 429, 'auth.err.rateLimit'],
    ['code_inconnu', 400, 'auth.err.unknown'],
  ])('code « %s » (HTTP %i) → %s', (code, status, key) => {
    expect(authMessageKey(new AuthApiError('message brut du serveur', status, code))).toBe(key);
  });

  it('ancienne réponse sans code : « Invalid login credentials » reconnu', () => {
    expect(authMessageKey(new AuthApiError('Invalid login credentials', 400, undefined))).toBe('auth.err.invalidCredentials');
  });

  it('réseau, délai, erreur serveur : messages transitoires', () => {
    expect(authMessageKey(new AuthRetryableFetchError('Failed to fetch', 0))).toBe('auth.err.network');
    expect(authMessageKey(new TypeError('Failed to fetch'))).toBe('auth.err.network');
    expect(authMessageKey(new AuthApiError('upstream', 503, 'unexpected_failure'))).toBe('auth.err.network');
    expect(authMessageKey(new AuthTimeoutError())).toBe('auth.err.timeout');
    expect(isTransientAuthError(new AuthRetryableFetchError('x', 0))).toBe(true);
    expect(isTransientAuthError(new AuthTimeoutError())).toBe(true);
    expect(isTransientAuthError(new AuthApiError('Session not found', 403, 'session_not_found'))).toBe(false);
    expect(isTransientAuthError(new AuthSessionMissingError())).toBe(false);
  });

  it('erreur inconnue : message générique, jamais le texte brut (qui peut contenir l’adresse)', () => {
    const raw = 'Email address "personne@exemple.invalid" is something';
    for (const e of [new AuthUnknownError(raw, null), new Error(raw), raw, null, undefined, 42]) {
      const key = authMessageKey(e);
      expect(key).toBe('auth.err.unknown');
      expect(fr[key]).not.toContain('personne@');
    }
  });

  it('chaque clé produite existe dans le dictionnaire source', () => {
    const keys = new Set<string>();
    for (const code of ['invalid_credentials', 'email_not_confirmed', 'weak_password', 'email_address_invalid', 'email_address_not_authorized', 'user_already_exists', 'signup_disabled', 'over_request_rate_limit', 'x'])
      keys.add(authMessageKey(new AuthApiError('m', 400, code)));
    keys.add(authMessageKey(new AuthTimeoutError()));
    keys.add(authMessageKey(new AuthRetryableFetchError('m', 0)));
    for (const k of keys) expect(fr).toHaveProperty([k]);
  });
});

describe('V2.5 — délai maximal des appels', () => {
  it('rejette avec AuthTimeoutError si la promesse ne se résout pas à temps', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise(() => {}), 1000);
      vi.advanceTimersByTime(1000);
      await expect(pending).rejects.toBeInstanceOf(AuthTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transmet le résultat ou l’erreur d’une promesse qui aboutit à temps', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('refus')), 1000)).rejects.toThrow('refus');
  });
});

describe('V2.5 — contrôle de saisie', () => {
  it.each([
    ['', 'motdepasse', 'auth.err.required'],
    ['a@b.co', '', 'auth.err.required'],
    ['   ', 'x', 'auth.err.required'],
    ['sans-arobase', 'x', 'auth.err.emailInvalid'],
    ['a@b', 'x', 'auth.err.emailInvalid'],
    ['a b@c.de', 'x', 'auth.err.emailInvalid'],
    ['test@exemple.invalid', 'x', null],
    [' test@exemple.invalid ', 'x', null],
  ])('« %s » / « %s » → %s', (email, password, key) => {
    expect(checkCredentials(email, password)).toBe(key);
  });
});
