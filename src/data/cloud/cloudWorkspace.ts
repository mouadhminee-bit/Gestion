/**
 * Espace de données Cloud d'une session (Plan directeur V1, V3.5) : ouvert une fois le
 * chargement initial RÉUSSI pour l'utilisateur (V3.4), fermé à la fin de la session.
 *
 *  - `repo` : `CloudRepository(uid, transport)` — toutes les écritures (lots soumis au serveur,
 *    cache mis à jour seulement après confirmation) ; démo, pièces jointes et restauration
 *    refusées jusqu'à V5 par une garde EXTÉRIEURE au dépôt (`guardUnsupported`) : le contrat
 *    de `CloudRepository` (aucune méthode métier redéfinie) est inchangé ;
 *  - `reader` : lecteur d'affichage du MÊME cache, qui ne voit que les données confirmées
 *    (`CloudSnapshotReader`, option O1) ;
 *  - `close()` : ferme la connexion au cache (la suppression du cache à la déconnexion, D6,
 *    n'est alors pas retardée par cet onglet).
 * Le cache est toujours `nexora-cache-<uid>` : la base locale `nexora` n'est jamais ouverte.
 */
import type { DexieOptions } from 'dexie';
import type { NexoraRepository } from '../contracts';
import type { ID } from '@/domain/types';
import { CloudCacheDB, cloudCacheName } from './CloudCacheDB';
import { CloudRepository } from './CloudRepository';
import { createCloudSnapshotReader, type SnapshotSource } from './CloudSnapshotReader';
import type { CloudTransport } from './transport';

/** Fonction non disponible en mode Cloud (jusqu'à V5) : refusée, sans aucune lecture ni écriture. */
export class CloudFeatureUnavailableError extends Error {
  constructor(public readonly feature: 'attachments' | 'restore' | 'demo') {
    super(`Fonction non disponible en mode Cloud (${feature}).`);
    this.name = 'CloudFeatureUnavailableError';
  }
}

/** Méthodes refusées en mode Cloud jusqu'à V5 et fonction concernée. */
const UNSUPPORTED: Readonly<Record<string, CloudFeatureUnavailableError['feature']>> = {
  addAttachment: 'attachments',
  restoreBackup: 'restore',
  replaceWithSnapshot: 'demo',
};

/**
 * Garde de l'application (V3.5) : les méthodes de `UNSUPPORTED` sont refusées AVANT d'atteindre
 * le dépôt (aucun appel au serveur, aucune écriture) ; toutes les autres sont transmises telles
 * quelles. N'affecte ni `CloudRepository` ni ses suites de contrat.
 */
export function guardUnsupported(repo: NexoraRepository): NexoraRepository {
  return new Proxy(repo, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(UNSUPPORTED, prop)) {
        const feature = UNSUPPORTED[prop];
        return () => Promise.reject(new CloudFeatureUnavailableError(feature));
      }
      return Reflect.get(target, prop, target);
    },
  });
}

export interface CloudWorkspace {
  readonly userId: ID;
  readonly repo: NexoraRepository;
  readonly reader: SnapshotSource;
  close(): void;
}

export interface CloudWorkspacePort {
  open(userId: ID): CloudWorkspace;
}

export interface CloudWorkspaceDeps {
  /** Transport des écritures (`HttpTransport` en production, lié à la session du client). */
  readonly transport: CloudTransport;
  /** Fabrique IndexedDB (tests : fabrique distincte). */
  readonly indexedDB?: IDBFactory;
  readonly IDBKeyRange?: typeof IDBKeyRange;
}

export function createCloudWorkspacePort(deps: CloudWorkspaceDeps): CloudWorkspacePort {
  const dexie: DexieOptions | undefined = deps.indexedDB ? { indexedDB: deps.indexedDB, IDBKeyRange: deps.IDBKeyRange ?? globalThis.IDBKeyRange } : undefined;
  return {
    open(userId) {
      const cache = new CloudCacheDB(cloudCacheName(userId), { userId, dexie });
      const repo = guardUnsupported(new CloudRepository(userId, { cache, transport: deps.transport }));
      const reader = createCloudSnapshotReader(cache, userId);
      return { userId, repo, reader, close: () => cache.close() };
    },
  };
}
