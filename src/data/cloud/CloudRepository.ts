/**
 * Repository cloud (PRÉPARÉ, NON ACTIVÉ).
 *
 * Mêmes règles métier que `LocalRepository` (héritées de `RepositoryCore`), exécutées
 * sur `CloudStorage` : lecture du cache `nexora-cache-<uid>`, écritures soumises à un
 * `CloudTransport`. Par défaut le transport est `DisabledTransport` : toute écriture est
 * refusée et le cache reste intact.
 *
 * Rien dans l'application n'instancie cette classe à ce stade (aucune authentification,
 * aucune synchronisation, aucune connexion Supabase).
 */
import { NexoraDB } from '../db';
import { RepositoryCore } from '../RepositoryCore';
import { REPOSITORY_METHODS } from '../contracts';
import type { ID } from '@/domain/types';
import { CloudStorage, cloudCacheName } from './CloudStorage';
import { DisabledTransport, type CloudTransport } from './transport';

export interface CloudRepositoryOptions {
  /** Transport des écritures (défaut : `DisabledTransport`, tout est refusé). */
  transport?: CloudTransport;
  /** Base de cache à utiliser (tests) ; son nom doit être `nexora-cache-<uid>`. */
  cache?: NexoraDB;
}

const METHODS = new Set<string>(REPOSITORY_METHODS);

/**
 * Sérialise les appels publics : une seule opération à la fois (la surcouche de
 * transaction de `CloudStorage` est unique). Les appels internes (`this.x()` depuis une
 * méthode) passent par l'instance réelle et ne sont donc pas mis en file.
 */
function serialized<T extends object>(target: T): T {
  let queue: Promise<unknown> = Promise.resolve();
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj);
      if (typeof value !== 'function' || typeof prop !== 'string' || !METHODS.has(prop)) return value;
      return (...args: unknown[]) => {
        const run = queue.then(() => (value as (...a: unknown[]) => unknown).apply(obj, args));
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };
    },
  });
}

export class CloudRepository extends RepositoryCore {
  readonly cacheName: string;
  readonly transportKind: string;

  constructor(userId: ID, options: CloudRepositoryOptions = {}) {
    const cache = options.cache ?? new NexoraDB(cloudCacheName(userId)); // Dexie n'ouvre la base qu'au premier accès
    const transport = options.transport ?? new DisabledTransport();
    super(new CloudStorage(cache, transport, userId), userId);
    this.cacheName = cache.name;
    this.transportKind = transport.kind;
    return serialized(this);
  }
}
