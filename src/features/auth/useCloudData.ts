/**
 * Données Cloud de la session (Plan directeur V1, V3.4-c) : chargement initial lié au cycle de
 * session, invalidation des chargements caducs, suppression des caches (D-3, D6).
 *
 *  - session ouverte ou restaurée (`signedIn`) → chargement de `uid` ; l'accès n'est donné
 *    qu'une fois le chargement RÉUSSI (`ready`). Déclenché sur l'IDENTIFIANT : un
 *    renouvellement de jeton (nouvel objet utilisateur, même `uid`) ne recharge rien ;
 *  - changement de compte (`uid` différent) → chargement précédent invalidé, cache de
 *    l'ancien utilisateur supprimé, chargement du nouveau ;
 *  - fin de session (`signedOut` : déconnexion volontaire, session refusée par Auth) →
 *    chargements invalidés, cache de l'utilisateur concerné supprimé ;
 *  - vérification en cours ou impossible (`checking`, `error`) → chargements invalidés, AUCUNE
 *    suppression (une panne réseau n'est pas une déconnexion) ;
 *  - échec du chargement :
 *      · réseau, délai, 5xx → « service injoignable », cache conservé, nouvel essai possible ;
 *      · refus d'authentification (401…) → la session est revérifiée auprès d'Auth : refusée →
 *        déconnexion locale (SIGNED_OUT → suppression du cache) ; valide → « accès refusé » ;
 *        Auth injoignable → « service injoignable » (rien n'est supprimé) ;
 *      · données incohérentes, écriture impossible → « échec du chargement », cache inchangé.
 * Aucune nouvelle tentative automatique : « Réessayer » relance un chargement complet.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isTransientAuthError, withTimeout, AUTH_TIMEOUT_MS, type AuthPort } from '@/data/cloud/auth';
import { CloudReadError } from '@/data/cloud/CloudReader';
import type { CloudDataPort } from '@/data/cloud/cloudLoadCycle';
import type { MessageKey } from '@/i18n/core';
import type { CloudSessionState } from './useCloudSession';

export type CloudLoadMessageKey = Extract<MessageKey, 'cloud.loadError.unavailable' | 'cloud.loadError.denied' | 'cloud.loadError.failed'>;

export type CloudDataState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly userId: string }
  | { readonly status: 'ready'; readonly userId: string }
  | { readonly status: 'error'; readonly userId: string; readonly message: CloudLoadMessageKey };

export function useCloudData(session: CloudSessionState, port: CloudDataPort, auth: AuthPort, timeoutMs: number = AUTH_TIMEOUT_MS) {
  const [state, setState] = useState<CloudDataState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  /** Génération du chargement en cours : tout chargement d'une génération antérieure est caduc. */
  const generation = useRef(0);
  /** Utilisateur dont cet onglet gère le cache (pour le supprimer à la fin de sa session). */
  const owner = useRef<string | null>(null);
  const uid = session.status === 'signedIn' ? session.user.id : null;

  // Fin de session, vérification en cours ou impossible : chargements invalidés ; suppression
  // du cache uniquement quand la session a pris fin (D-3).
  useEffect(() => {
    if (session.status === 'signedIn') return;
    generation.current++;
    if (session.status === 'signedOut') {
      const ended = session.endedUserId ?? owner.current;
      owner.current = null;
      if (ended) void port.deleteCache(ended).catch(() => undefined);
    }
    setState({ status: 'idle' });
  }, [session, port]);

  // Session ouverte ou restaurée : chargement de l'utilisateur (une génération par essai).
  useEffect(() => {
    if (!uid) return undefined;
    const previous = owner.current;
    owner.current = uid;
    if (previous && previous !== uid) void port.deleteCache(previous).catch(() => undefined); // changement de compte
    const mine = ++generation.current;
    let mounted = true;
    const isCurrent = () => mounted && generation.current === mine;
    setState({ status: 'loading', userId: uid });

    /** Refus d'authentification : la session est revérifiée auprès d'Auth avant toute conclusion. */
    async function afterDenied(): Promise<CloudLoadMessageKey> {
      try {
        const { data, error } = await withTimeout(auth.getUser(), timeoutMs);
        if (!error && data.user && data.user.id === uid) return 'cloud.loadError.denied';
        if (error && isTransientAuthError(error)) return 'cloud.loadError.unavailable';
        // Session introuvable côté Auth : le SDK a déjà supprimé la session locale (SIGNED_OUT →
        // cache supprimé) ; une seconde déconnexion émettrait un SIGNED_OUT de plus.
        if ((error as { name?: unknown } | null)?.name === 'AuthSessionMissingError') return 'cloud.loadError.denied';
      } catch {
        return 'cloud.loadError.unavailable'; // Auth injoignable : rien n'est supprimé
      }
      // Session refusée par Auth (jeton invalide…) : déconnexion locale → SIGNED_OUT → cache supprimé.
      await withTimeout(auth.signOut({ scope: 'local' }), timeoutMs).catch(() => undefined);
      return 'cloud.loadError.denied';
    }

    port.load(uid, { isCurrent }).then(
      (outcome) => {
        if (isCurrent() && outcome.status === 'loaded') setState({ status: 'ready', userId: uid });
      },
      async (e: unknown) => {
        if (!isCurrent()) return;
        let message: CloudLoadMessageKey = 'cloud.loadError.failed';
        if (e instanceof CloudReadError) {
          if (e.code === 'unauthorized') message = await afterDenied();
          else if (e.transient) message = 'cloud.loadError.unavailable';
        }
        if (isCurrent()) setState({ status: 'error', userId: uid, message });
      },
    );
    return () => {
      mounted = false;
    };
  }, [uid, attempt, port, auth, timeoutMs]);

  /** Nouvel essai, demandé par l'utilisateur (aucune tentative automatique). */
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { state, retry };
}
