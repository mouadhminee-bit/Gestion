/**
 * Barrière d'authentification Cloud (V2.5) : état de session dérivé des événements du SDK.
 *
 *  - `checking` : vérification en cours (aucun accès) — bornée par un délai ;
 *  - `signedOut` : aucun accès hors des écrans d'authentification ;
 *  - `signedIn` : session VÉRIFIÉE par le serveur (`getUser`) ;
 *  - `error` : vérification impossible (réseau, délai) — aucun accès, nouvel essai possible.
 *
 * Une session restaurée (après actualisation) n'est jamais acceptée sur la seule foi du
 * stockage local : elle est vérifiée auprès du service ; refusée → déconnexion locale et
 * retour à l'écran de connexion. Une connexion faite ici (`SIGNED_IN` hors vérification)
 * provient d'une réponse du serveur et vaut vérification.
 *
 * Un seul abonnement `onAuthStateChange`, désabonné au démontage (et à chaque nouvel essai).
 * Aucun appel au SDK dans le rappel (le SDK l'exécute sous son verrou) : la vérification est
 * différée. Aucun jeton n'est lu ni conservé par NEXORA.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AUTH_TIMEOUT_MS, authMessageKey, isTransientAuthError, withTimeout, type AuthMessageKey, type AuthPort } from '@/data/cloud/auth';

export interface CloudUser {
  readonly id: string;
  readonly email: string;
}

export type CloudSessionState =
  | { readonly status: 'checking' }
  | { readonly status: 'signedOut'; readonly notice?: AuthMessageKey }
  | { readonly status: 'signedIn'; readonly user: CloudUser }
  | { readonly status: 'error'; readonly message: AuthMessageKey };

const toUser = (u: { id: string; email?: string | null }): CloudUser => ({ id: u.id, email: u.email ?? '' });

export function useCloudSession(auth: AuthPort, timeoutMs: number = AUTH_TIMEOUT_MS) {
  const [state, setStateRaw] = useState<CloudSessionState>({ status: 'checking' });
  const stateRef = useRef(state);
  const setState = useCallback((s: CloudSessionState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);
  const [attempt, setAttempt] = useState(0);
  /** Déconnexion demandée par l'utilisateur (pas de message « session expirée »). */
  const userSignOut = useRef(false);

  useEffect(() => {
    let active = true;
    let verifying: string | null = null;
    if (stateRef.current.status !== 'checking') setState({ status: 'checking' });
    const guard = setTimeout(() => {
      if (active && stateRef.current.status === 'checking') setState({ status: 'error', message: 'auth.err.timeout' });
    }, timeoutMs);

    async function verify(session: Session) {
      try {
        const { data, error } = await withTimeout(auth.getUser(), timeoutMs);
        if (!active || verifying !== session.user.id) return;
        if (!error && data.user && data.user.id === session.user.id) return setState({ status: 'signedIn', user: toUser(data.user) });
        if (error && isTransientAuthError(error)) return setState({ status: 'error', message: authMessageKey(error) });
        // Session refusée par le service (expirée, révoquée, compte supprimé…).
        userSignOut.current = true;
        await withTimeout(auth.signOut({ scope: 'local' }), timeoutMs).catch(() => undefined);
        if (active) setState({ status: 'signedOut', notice: 'auth.err.sessionExpired' });
      } catch (e) {
        if (active) setState({ status: 'error', message: authMessageKey(e) });
      } finally {
        clearTimeout(guard);
        if (verifying === session.user.id) verifying = null;
      }
    }

    function scheduleVerify(session: Session) {
      if (verifying === session.user.id) return;
      verifying = session.user.id;
      setTimeout(() => void verify(session), 0);
    }

    const { data } = auth.onAuthStateChange((event, session) => {
      if (!active) return;
      const checking = stateRef.current.status === 'checking';
      switch (event) {
        case 'INITIAL_SESSION':
        case 'SIGNED_IN':
          if (!session) {
            if (checking && !verifying) {
              clearTimeout(guard);
              setState({ status: 'signedOut' });
            }
            return;
          }
          if (checking) return scheduleVerify(session);
          if (event === 'SIGNED_IN') setState({ status: 'signedIn', user: toUser(session.user) });
          return;
        case 'SIGNED_OUT': {
          clearTimeout(guard);
          // Le SDK supprime lui-même une session refusée par le serveur (403 session_not_found
          // pendant `getUser`) et émet SIGNED_OUT AVANT de rendre la main : pendant une
          // vérification, c'est une session expirée, pas une déconnexion demandée.
          const duringVerification = verifying !== null;
          verifying = null;
          const expected = userSignOut.current;
          userSignOut.current = false;
          const expired = !expected && (stateRef.current.status === 'signedIn' || duringVerification);
          setState(expired ? { status: 'signedOut', notice: 'auth.err.sessionExpired' } : { status: 'signedOut' });
          return;
        }
        case 'TOKEN_REFRESHED':
        case 'USER_UPDATED':
          if (session && stateRef.current.status === 'signedIn') setState({ status: 'signedIn', user: toUser(session.user) });
          return;
        default:
          return;
      }
    });

    return () => {
      active = false;
      clearTimeout(guard);
      data.subscription.unsubscribe();
    };
  }, [auth, attempt, timeoutMs, setState]);

  /** Nouvel essai après une erreur de vérification. */
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  /**
   * Déconnexion (`scope: 'local'`) : le SDK supprime d'abord la session de cet appareil (événement
   * SIGNED_OUT → écran de connexion), puis la révoque auprès du service. Une erreur n'est
   * renvoyée que si la session n'a pas pu être supprimée.
   */
  const signOut = useCallback(async (): Promise<AuthMessageKey | null> => {
    userSignOut.current = true;
    try {
      const { error } = await withTimeout(auth.signOut({ scope: 'local' }), timeoutMs);
      if (error) {
        userSignOut.current = false;
        return authMessageKey(error);
      }
      setState({ status: 'signedOut' });
      return null;
    } catch (e) {
      userSignOut.current = false;
      return authMessageKey(e);
    }
  }, [auth, timeoutMs, setState]);

  return { state, retry, signOut };
}
