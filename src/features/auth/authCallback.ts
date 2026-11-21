/**
 * Retour d'un lien d'authentification (Plan directeur V1, V3.2 ; V3.7) — mode Cloud.
 *
 * Le lien de confirmation (flux PKCE) revient sur l'application avec `?code=…` ; en cas d'échec,
 * le service ajoute `error`, `error_code` et `error_description` (requête et/ou fragment). Le SDK
 * échange le code à son initialisation (`auth.initialize()`), à condition de trouver dans ce
 * navigateur le vérificateur enregistré à l'inscription.
 *
 * Ce module lit l'adresse AVANT l'initialisation, puis la nettoie AVANT le montage du HashRouter :
 * aucun paramètre d'authentification n'est jamais interprété comme une route (`#error=…`), aucun
 * code ne reste dans l'adresse (historique, partage).
 *
 * Cas traités (message affiché sur l'écran de connexion) :
 *  - code échangé : session ouverte, aucun message ;
 *  - code NON échangé (lien ouvert dans un autre navigateur : pas de vérificateur) : le service a
 *    normalement déjà confirmé l'adresse, mais ce n'est pas démontrable ici → « session non ouverte
 *    dans ce navigateur ; connectez-vous (la connexion aboutira si l'adresse est confirmée) » ;
 *  - lien expiré, déjà utilisé ou code refusé → « lien invalide ou expiré ; connectez-vous si
 *    l'adresse est déjà confirmée ».
 */
import type { AuthMessageKey } from '@/data/cloud/auth';

/** Paramètres d'authentification que le service ajoute à la requête de l'adresse de retour. */
const AUTH_QUERY_PARAMS = ['code', 'error', 'error_code', 'error_description'] as const;

export type AuthCallbackKind = 'none' | 'code' | 'error' | 'tokens';

export interface AuthCallback {
  readonly kind: AuthCallbackKind;
}

/** Paramètres du fragment s'il ne s'agit PAS d'une route du HashRouter (`#/…`). */
function hashParams(hash: string): URLSearchParams | null {
  const h = hash.replace(/^#/, '');
  if (!h || h.startsWith('/')) return null;
  return new URLSearchParams(h);
}

/** Nature du retour d'authentification présent dans `href` (lu avant l'initialisation du SDK). */
export function readAuthCallback(href: string): AuthCallback {
  const url = new URL(href);
  const q = url.searchParams;
  const f = hashParams(url.hash);
  const get = (k: string) => q.get(k) ?? f?.get(k) ?? null;
  if (get('error') || get('error_code') || get('error_description')) return { kind: 'error' };
  if (q.has('code')) return { kind: 'code' };
  if (get('access_token') || get('refresh_token')) return { kind: 'tokens' };
  return { kind: 'none' };
}

/** Adresse sans paramètre d'authentification ; un fragment qui n'est pas une route devient `#/`. */
export function cleanAuthCallbackHref(href: string): string {
  const url = new URL(href);
  for (const k of AUTH_QUERY_PARAMS) url.searchParams.delete(k);
  if (hashParams(url.hash)) url.hash = '#/';
  return url.toString();
}

/** Message à afficher après l'initialisation, selon le retour lu et l'issue de l'échange. */
export function authCallbackNotice(callback: AuthCallback, initError: unknown, codeStillInUrl: boolean): AuthMessageKey | undefined {
  if (callback.kind === 'none') return undefined;
  if (callback.kind === 'error' || initError) return 'auth.link.invalid';
  if (callback.kind === 'code' && codeStillInUrl) return 'auth.link.noSession';
  return undefined;
}
