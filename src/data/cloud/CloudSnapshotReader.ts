/**
 * Lecteur d'affichage du mode Cloud (Plan directeur V1, V3.5 — option O1).
 *
 * L'interface lit l'instantané (`snapshot()`) en direct, par `useLiveQuery` (Dexie). Les
 * lectures faites à travers `CloudRepository` sortent de la zone de suivi de Dexie (file
 * d'appels sérialisés : `queue.then(…)`) : l'instantané ne serait jamais recalculé.
 *
 * Ce lecteur applique les MÊMES règles de lecture (`RepositoryCore.snapshot`) directement sur
 * le cache `nexora-cache-<uid>` (`DexieStorage`), sans surcouche de transaction. Il ne voit donc
 * que ce que contient le cache, c'est-à-dire uniquement :
 *  - les données du chargement initial (V3.4) ;
 *  - les lots CONFIRMÉS par le serveur (`CloudStorage.applyConfirmed`, après un `CommitResult`
 *    valide), écrits dans le cache en une transaction Dexie ;
 * jamais une écriture en cours (surcouche en mémoire de `CloudStorage`), refusée, ou dont
 * l'issue est inconnue. Les écritures passent toutes par `CloudRepository`.
 *
 * Lecture seule par construction : l'objet exposé n'a qu'une méthode, `snapshot()` ; le
 * dépôt sous-jacent n'est pas accessible.
 */
import type { DataSnapshot, ID } from '@/domain/types';
import { RepositoryCore } from '../RepositoryCore';
import { DexieStorage } from '../local/DexieStorage';
import { CloudCacheDB, assertCloudCacheName } from './CloudCacheDB';

/** Source d'instantané (sous-ensemble en lecture de `NexoraRepository`). */
export interface SnapshotSource {
  snapshot(): Promise<DataSnapshot | null>;
}

/** Règles de lecture communes, sur le cache tel qu'il est (aucune écriture n'est exposée). */
class CacheReader extends RepositoryCore {}

/** Lecteur de l'instantané CONFIRMÉ de `userId`, pour l'affichage en mode Cloud. */
export function createCloudSnapshotReader(cache: CloudCacheDB, userId: ID): SnapshotSource {
  assertCloudCacheName(cache.name, userId); // jamais la base locale « nexora », jamais un autre utilisateur
  if (!(cache instanceof CloudCacheDB)) throw new Error('Mode cloud : le lecteur exige le cache CloudCacheDB de l’utilisateur.');
  const core = new CacheReader(new DexieStorage(cache), userId);
  return Object.freeze({ snapshot: () => core.snapshot() });
}
