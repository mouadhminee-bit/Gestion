/**
 * Repository cloud. Branché dans l'application en mode Cloud depuis V3.5 (`cloudWorkspace.ts`,
 * transport `HttpTransport`) ; code inchangé par ce branchement.
 *
 * Mêmes règles métier que `LocalRepository` (héritées de `RepositoryCore`), exécutées
 * sur `CloudStorage` : lecture du cache `nexora-cache-<uid>`, écritures soumises à un
 * `CloudTransport`. Par défaut le transport est `DisabledTransport` : toute écriture est
 * refusée et le cache reste intact.
 *
 * L'affichage ne lit pas l'instantané par cette classe (file d'appels hors du suivi de Dexie) :
 * voir `CloudSnapshotReader` (V3.5, option O1).
 *
 * File des opérations (V4.2, A5) : injectable (`queue`) pour que l'application des changements
 * récupérés (`CloudSync`) attende son tour dans la MÊME file que les opérations publiques — jamais
 * au milieu d'une écriture. Aucune méthode n'est ajoutée au dépôt (contrat inchangé).
 */
import { RepositoryCore } from '../RepositoryCore';
import { REPOSITORY_METHODS } from '../contracts';
import type { ID } from '@/domain/types';
import type { NexoraDB } from '../db';
import { CloudCacheDB } from './CloudCacheDB';
import { CloudStorage, cloudCacheName } from './CloudStorage';
import { DisabledTransport, type CloudTransport } from './transport';
import { createOperationQueue, type OperationQueue } from './CloudSync';

export interface CloudRepositoryOptions {
  /** Transport des écritures (défaut : `DisabledTransport`, tout est refusé). */
  transport?: CloudTransport;
  /**
   * Base de cache à utiliser (tests) : son nom doit être `nexora-cache-<uid>` et ce doit
   * être une `CloudCacheDB` (table des versions) — vérifié à l'exécution par `CloudStorage`.
   */
  cache?: NexoraDB;
  /** File des opérations, partagée avec la synchronisation (défaut : file propre au dépôt). */
  queue?: OperationQueue;
}

const METHODS = new Set<string>(REPOSITORY_METHODS);
/** Méthodes en lecture seule : ni résolution réseau, ni observation des versions. */
const READ_ONLY = new Set<string>(['snapshot', 'getSettings', 'getTransactionGroup', 'getAttachment', 'categoryUsage', 'exportBackup']);

/**
 * Sérialise les appels publics : une seule opération à la fois (la surcouche de
 * transaction de `CloudStorage` est unique). Les appels internes (`this.x()` depuis une
 * méthode) passent par l'instance réelle et ne sont donc pas mis en file.
 */
function serialized<T extends object>(target: T, storage: CloudStorage, queue: OperationQueue): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj);
      if (typeof value !== 'function' || typeof prop !== 'string' || !METHODS.has(prop)) return value;
      return (...args: unknown[]) => {
        const call = () => (value as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
        // Opération susceptible d'écrire : versions observées dès la première lecture (protocole v1).
        return queue.run(() => (READ_ONLY.has(prop) ? call() : storage.runOperation(call)));
      };
    },
  });
}

export class CloudRepository extends RepositoryCore {
  readonly cacheName: string;
  readonly transportKind: string;

  constructor(userId: ID, options: CloudRepositoryOptions = {}) {
    const cache = options.cache ?? new CloudCacheDB(cloudCacheName(userId), { userId }); // Dexie n'ouvre la base qu'au premier accès
    const transport = options.transport ?? new DisabledTransport();
    const storage = new CloudStorage(cache, transport, userId);
    super(storage, userId);
    this.cacheName = cache.name;
    this.transportKind = transport.kind;
    return serialized(this, storage, options.queue ?? createOperationQueue());
  }
}
