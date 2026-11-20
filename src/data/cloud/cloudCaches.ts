/**
 * Suppression des caches Cloud (Plan directeur V1, V3.4-c : D6, D-3, P-3).
 *
 *  - `deleteCloudCache(uid)` : supprime la base `nexora-cache-<uid>` (déconnexion volontaire,
 *    changement de compte, session invalide confirmée par Auth). Jamais pour une panne réseau :
 *    c'est l'appelant (cycle de session) qui en décide.
 *  - `purgeOtherCloudCaches(uid)` : à l'ouverture de session, supprime les caches des AUTRES
 *    utilisateurs (`nexora-cache-*` sauf celui de `uid`), listés par `indexedDB.databases()`.
 *
 * Garde-fous : seul un nom `nexora-cache-<uid>` valide peut être supprimé ; la base locale
 * `nexora` et le cache de l'utilisateur courant ne le sont jamais. Une suppression bloquée
 * (connexion d'un autre onglet qui ne se ferme pas) n'est pas attendue indéfiniment : la
 * demande reste en file dans IndexedDB et aboutit à la fermeture ; la purge suivante la
 * termine au besoin. Aucune valeur (identifiant d'utilisateur compris) n'est journalisée.
 */
import type { ID } from '@/domain/types';
import { CLOUD_CACHE_PREFIX, LOCAL_DB_NAME, cloudCacheName } from './CloudCacheDB';

/** Attente maximale d'une suppression (au-delà : demande laissée en file, purge suivante). */
export const CACHE_DELETE_TIMEOUT_MS = 5_000;

/** Fabrique IndexedDB (celle du navigateur par défaut ; une autre dans les tests). */
export interface CacheDeps {
  indexedDB?: IDBFactory;
  timeoutMs?: number;
}

const factoryOf = (deps: CacheDeps): IDBFactory => deps.indexedDB ?? globalThis.indexedDB;

/** Résultat d'une suppression : terminée, ou encore en attente (bloquée par une connexion). */
export type DeleteOutcome = 'deleted' | 'pending';

/** Supprime une base par son nom, après vérification qu'il s'agit d'un cache Cloud. */
function deleteByName(name: string, deps: CacheDeps): Promise<DeleteOutcome> {
  if (name === LOCAL_DB_NAME || !name.startsWith(CLOUD_CACHE_PREFIX)) return Promise.reject(new Error('Suppression refusée : seul un cache Cloud peut être supprimé.'));
  return new Promise<DeleteOutcome>((resolve, reject) => {
    let settled = false;
    const done = (v: DeleteOutcome) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const timer = setTimeout(() => done('pending'), deps.timeoutMs ?? CACHE_DELETE_TIMEOUT_MS);
    let request: IDBOpenDBRequest;
    try {
      request = factoryOf(deps).deleteDatabase(name);
    } catch (e) {
      clearTimeout(timer);
      settled = true;
      reject(e);
      return;
    }
    request.onsuccess = () => done('deleted');
    request.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(request.error ?? new Error('Suppression du cache impossible.'));
    };
  });
}

/** Supprime le cache Cloud de `userId` (D6). */
export function deleteCloudCache(userId: ID, deps: CacheDeps = {}): Promise<DeleteOutcome> {
  return deleteByName(cloudCacheName(userId), deps);
}

/** Résultat de la purge : nombre de caches supprimés (ou encore en attente) ; `null` si non disponible. */
export interface PurgeOutcome {
  readonly supported: boolean;
  readonly deleted: number;
  readonly pending: number;
}

/**
 * P-3 : supprime les caches Cloud des autres utilisateurs. Ne touche ni `nexora`, ni le cache
 * de `currentUserId`. Sans `indexedDB.databases()` (navigateur ancien), rien n'est purgé.
 */
export async function purgeOtherCloudCaches(currentUserId: ID, deps: CacheDeps = {}): Promise<PurgeOutcome> {
  const own = cloudCacheName(currentUserId);
  const factory = factoryOf(deps) as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
  if (typeof factory.databases !== 'function') return { supported: false, deleted: 0, pending: 0 };
  const names = (await factory.databases()).map((d) => d.name).filter((n): n is string => typeof n === 'string' && n.startsWith(CLOUD_CACHE_PREFIX) && n !== own && n !== LOCAL_DB_NAME);
  let deleted = 0;
  let pending = 0;
  for (const name of names) {
    // Un échec n'empêche pas l'ouverture de la session : la purge suivante recommencera.
    const outcome = await deleteByName(name, deps).catch(() => 'pending' as const);
    if (outcome === 'deleted') deleted++;
    else pending++;
  }
  return { supported: true, deleted, pending };
}
