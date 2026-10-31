/**
 * Port de stockage : le sous-ensemble exact de l'API Dexie utilisé par `RepositoryCore`.
 *
 * `RepositoryCore` (règles métier) ne connaît que ce port. Deux implémentations :
 *  - `DexieStorage` (local) : délégation directe à `NexoraDB` — comportement inchangé ;
 *  - `CloudStorage` (préparé) : lecture du cache `nexora-cache-<uid>`, écritures
 *    regroupées en `ChangeSet` et soumises à un `CloudTransport`.
 *
 * Sémantique attendue de toute implémentation (vérifiée par `contract.test.ts`) :
 *  - `transaction(tables, fn)` est atomique : si `fn` échoue, aucune écriture n'est
 *    conservée ; les écritures effectuées dans `fn` sont lisibles dans `fn` ;
 *  - un appel imbriqué rejoint la transaction englobante ;
 *  - une écriture hors transaction est atomique à elle seule ;
 *  - `add` / `bulkAdd` échouent (`ConstraintError`) si la clé existe déjà ;
 *  - les lignes lues sont des copies : les modifier n'affecte pas le stockage.
 */
import type { TableName, TableRows } from './tables';

export type Key = string | readonly string[];

export interface Collection<T> {
  toArray(): Promise<T[]>;
  count(): Promise<number>;
  first(): Promise<T | undefined>;
  /** Supprime les lignes de la collection ; renvoie leur nombre. */
  delete(): Promise<number>;
  filter(fn: (row: T) => boolean): Collection<T>;
}

export interface WhereClause<T> {
  /** Égalité sur un index simple (`'userId'`) ou composé (`'[userId+month]'`, valeur = liste). */
  equals(value: unknown): Collection<T>;
}

export interface TablePort<T> {
  get(key: Key): Promise<T | undefined>;
  add(row: T): Promise<unknown>;
  put(row: T): Promise<unknown>;
  bulkAdd(rows: readonly T[]): Promise<unknown>;
  bulkPut(rows: readonly T[]): Promise<unknown>;
  delete(key: Key): Promise<void>;
  bulkDelete(keys: readonly Key[]): Promise<void>;
  where(index: string): WhereClause<T>;
}

export type Tables = { readonly [N in TableName]: TablePort<TableRows[N]> };

export interface StoragePort {
  /** Nom de la base physique (ex. `nexora`, `nexora-cache-<uid>`). */
  readonly name: string;
  readonly tables: Tables;
  /** Exécute `fn` de façon atomique sur les tables indiquées (lecture-écriture). */
  transaction<R>(tables: readonly TableName[], fn: () => Promise<R>): Promise<R>;
}
