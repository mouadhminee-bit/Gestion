/**
 * Repository local (IndexedDB via Dexie).
 *
 * Les règles métier d'écriture vivent dans `RepositoryCore` ; `LocalRepository` les
 * exécute sur `DexieStorage`, simple délégation à `NexoraDB`. Constructeur, propriété
 * publique `db`, nom de base et comportement sont inchangés.
 *
 * Une implémentation cloud respecte la même interface (`NexoraRepository`, voir
 * `cloud/CloudRepository.ts`).
 */
import type { NexoraDB } from './db';
import type { ID } from '@/domain/types';
import { RepositoryCore } from './RepositoryCore';
import { DexieStorage } from './local/DexieStorage';

// Ré-exports : les modules existants continuent d'importer depuis `@/data/repository`.
export { ValidationError } from '@/domain/errors';
export type { BackupFile, NexoraRepository, NewEntity } from './contracts';

export class LocalRepository extends RepositoryCore {
  constructor(
    public readonly db: NexoraDB,
    userId: ID,
  ) {
    super(new DexieStorage(db), userId);
  }
}
