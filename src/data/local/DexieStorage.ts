/**
 * Implémentation locale du port de stockage : délégation directe à Dexie.
 *
 * Aucune logique propre : chaque appel est transmis tel quel à `NexoraDB`, et
 * `transaction()` ouvre une transaction Dexie `'rw'` sur les mêmes tables que
 * l'ancien code de `LocalRepository` — les garanties d'atomicité d'IndexedDB sont
 * donc strictement celles d'avant l'extraction de `RepositoryCore`.
 */
import type { NexoraDB } from '../db';
import type { StoragePort, Tables } from '../storage';
import type { TableName } from '../tables';

export class DexieStorage implements StoragePort {
  readonly tables: Tables;

  constructor(public readonly db: NexoraDB) {
    // Les tables Dexie implémentent structurellement `TablePort` (Collection, WhereClause…).
    this.tables = db as unknown as Tables;
  }

  get name(): string {
    return this.db.name;
  }

  transaction<R>(tables: readonly TableName[], fn: () => Promise<R>): Promise<R> {
    return this.db.transaction('rw', tables.map((t) => this.db.table(t)), fn);
  }
}
