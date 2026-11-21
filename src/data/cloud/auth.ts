/**
 * Authentification Cloud (V2.5) : outils communs autour du SDK Supabase.
 *
 *  - `AuthPort` : sous-ensemble EXACT de `supabase.auth` utilisé par l'application
 *    (aucun mécanisme parallèle, aucun jeton manipulé par NEXORA : la session est gérée et
 *    conservée par le SDK) ;
 *  - `withTimeout` : borne chaque appel réseau (aucun chargement interminable) ;
 *  - `authMessageKey` : erreur du SDK → message compréhensible (clé de traduction), sans
 *    jamais reprendre le texte brut du serveur (qui peut contenir l'adresse saisie).
 *
 * Aucune opération sur les données : seules les routes d'authentification sont appelées.
 */
import { isAuthApiError, isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import type { MessageKey } from '@/i18n/core';

/** Méthodes d'authentification utilisées (celles du client Supabase). `initialize` : fin de l'initialisation du SDK, échange du code PKCE compris (V3.7). */
export type AuthPort = Pick<SupabaseClient['auth'], 'initialize' | 'onAuthStateChange' | 'getUser' | 'signInWithPassword' | 'signUp' | 'signOut'>;

/** Délai maximal d'un appel au service d'authentification. */
export const AUTH_TIMEOUT_MS = 15_000;

export type AuthMessageKey = Extract<MessageKey, `auth.${string}`>;

/** Le service n'a pas répondu dans le délai imparti. */
export class AuthTimeoutError extends Error {
  constructor() {
    super('Délai dépassé : le service d’authentification ne répond pas.');
    this.name = 'AuthTimeoutError';
  }
}

/** Rejette avec `AuthTimeoutError` si `promise` n'aboutit pas dans le délai. */
export function withTimeout<T>(promise: Promise<T>, ms: number = AUTH_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Erreur due au réseau ou au délai (la session n'a pas pu être vérifiée, sans être refusée). */
export function isTransientAuthError(e: unknown): boolean {
  if (e instanceof AuthTimeoutError || isAuthRetryableFetchError(e)) return true;
  const status = (e as { status?: unknown } | null)?.status;
  return e instanceof TypeError || status === 0 || (typeof status === 'number' && status >= 500);
}

const BY_CODE: Readonly<Record<string, AuthMessageKey>> = {
  invalid_credentials: 'auth.err.invalidCredentials',
  email_not_confirmed: 'auth.err.emailNotConfirmed',
  weak_password: 'auth.err.weakPassword',
  email_address_invalid: 'auth.err.emailInvalid',
  validation_failed: 'auth.err.emailInvalid',
  email_address_not_authorized: 'auth.err.emailNotAuthorized',
  user_already_exists: 'auth.err.userExists',
  email_exists: 'auth.err.userExists',
  signup_disabled: 'auth.err.signupDisabled',
  email_provider_disabled: 'auth.err.signupDisabled',
  over_request_rate_limit: 'auth.err.rateLimit',
  over_email_send_rate_limit: 'auth.err.rateLimit',
};

/** Message à afficher pour une erreur d'authentification (jamais le texte brut du serveur). */
export function authMessageKey(e: unknown): AuthMessageKey {
  if (e instanceof AuthTimeoutError) return 'auth.err.timeout';
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(BY_CODE, code)) return BY_CODE[code];
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 429) return 'auth.err.rateLimit';
  if (isTransientAuthError(e)) return 'auth.err.network';
  if (isAuthApiError(e) && status === 400 && /invalid login credentials/i.test(e.message)) return 'auth.err.invalidCredentials';
  return 'auth.err.unknown';
}

/** Contrôle minimal avant envoi (le service reste juge de la validité et de la robustesse). */
export function checkCredentials(email: string, password: string): AuthMessageKey | null {
  if (!email.trim() || !password) return 'auth.err.required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'auth.err.emailInvalid';
  return null;
}
