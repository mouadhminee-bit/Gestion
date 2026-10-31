/**
 * Port de stockage cloud (PRÉPARÉ, non activé).
 *
 * - Lectures : cache IndexedDB propre à l'utilisateur, `nexora-cache-<uid>` (jamais la
 *   base locale `nexora`, refusée explicitement).
 * - Écritures : pendant une transaction, elles sont conservées dans une surcouche en
 *   mémoire (lisibles par la suite de la transaction). À la fin, l'état final de chaque
 *   clé forme un `ChangeSet` soumis au `CloudTransport` ; le cache n'est mis à jour que
 *   si le transport l'accepte. En cas d'échec (règle métier, transport), rien n'est écrit.
 * - Une écriture hors transaction forme à elle seule un lot.
 *
 * Concurrence : la surcouche est unique ; les appels doivent donc être sérialisés.
 * `CloudRepository` garantit qu'une seule opération publique s'exécute à la fois.
 */
import type { NexoraDB } from '../db';
import type { Collection, Key, StoragePort, TablePort, Tables, WhereClause } from '../storage';
import type { ID } from '@/domain/types';
import { ALL_TABLES, PRIMARY_KEYS, type TableName } from '../tables';
import { CloudTransportError, CloudWriteDisabledError, type ChangeOp, type ChangeSet, type CloudTransport } from './transport';

export const CLOUD_CACHE_PREFIX = 'nexora-cache-';
/** Nom de la base IndexedDB réelle du mode local : ne doit JAMAIS être ouverte en mode cloud. */
export const LOCAL_DB_NAME = 'nexora';

/** Nom du cache d'un utilisateur : `nexora-cache-<uid>`. */
export function cloudCacheName(userId: ID): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error(`Identifiant utilisateur invalide pour le cache cloud : « ${userId} ».`);
  return `${CLOUD_CACHE_PREFIX}${userId}`;
}

/** Refuse toute base qui n'est pas exactement le cache de cet utilisateur. */
export function assertCloudCacheName(name: string, userId: ID): void {
  if (name === LOCAL_DB_NAME) throw new Error('Mode cloud : la base locale « nexora » ne doit jamais être ouverte.');
  if (name !== cloudCacheName(userId)) throw new Error(`Mode cloud : cache « ${name} » refusé, attendu « ${cloudCacheName(userId)} ».`);
}

export class ConstraintError extends Error {
  constructor(table: string, key: Key) {
    super(`Clé déjà présente dans ${table} : ${JSON.stringify(key)}`);
    this.name = 'ConstraintError';
  }
}

type Row = Record<string, unknown>;
type Entry = { table: TableName; key: Key; row: Row | null }; // row null = supprimée

function clone<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return v;
  }
}

function keyOf(table: TableName, row: Row): Key {
  const pk = PRIMARY_KEYS[table];
  return typeof pk === 'string' ? (row[pk] as string) : pk.map((f) => row[f] as string);
}

const keyStr = (table: TableName, key: Key) => `${table}\u0000${JSON.stringify(key)}`;

function compareKeys(a: Key, b: Key): number {
  const x = Array.isArray(a) ? a : [a];
  const y = Array.isArray(b) ? b : [b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
}

/** Une ligne correspond-elle à `where(index).equals(value)` ? (index simple ou `[a+b]`) */
function matchesIndex(row: Row, index: string, value: unknown): boolean {
  if (index.startsWith('[')) {
    const fields = index.slice(1, -1).split('+');
    const values = value as unknown[];
    return Array.isArray(values) && fields.every((f, i) => row[f] === values[i]);
  }
  return row[index] === value;
}

/** Écritures en attente d'une transaction (état final par clé, ordre des écritures). */
class Overlay {
  readonly entries = new Map<string, Entry>();

  lookup(table: TableName, key: Key): Entry | undefined {
    return this.entries.get(keyStr(table, key));
  }

  set(table: TableName, key: Key, row: Row | null) {
    const k = keyStr(table, key);
    this.entries.delete(k); // l'ordre reflète la dernière écriture
    this.entries.set(k, { table, key, row: row && clone(row) });
  }

  forTable(table: TableName): Entry[] {
    return [...this.entries.values()].filter((e) => e.table === table);
  }

  toChangeSet(userId: ID): ChangeSet {
    const ops: ChangeOp[] = [...this.entries.values()].map((e) =>
      e.row ? { table: e.table, type: 'put', key: e.key, row: clone(e.row) } : { table: e.table, type: 'delete', key: e.key },
    );
    return { userId, ops };
  }
}

export class CloudStorage implements StoragePort {
  readonly tables: Tables;
  private active: Overlay | null = null;

  constructor(
    private readonly cache: NexoraDB,
    private readonly transport: CloudTransport,
    public readonly userId: ID,
  ) {
    assertCloudCacheName(cache.name, userId);
    const tables = {} as Record<TableName, TablePort<unknown>>;
    for (const name of ALL_TABLES) tables[name] = this.tablePort(name);
    this.tables = tables as unknown as Tables;
  }

  get name(): string {
    return this.cache.name;
  }

  async transaction<R>(_tables: readonly TableName[], fn: () => Promise<R>): Promise<R> {
    if (this.active) return fn(); // transaction imbriquée : rejoint la transaction englobante
    const overlay = new Overlay();
    this.active = overlay;
    let result: R;
    try {
      result = await fn();
    } finally {
      this.active = null;
    }
    await this.commit(overlay.toChangeSet(this.userId));
    return result;
  }

  /** Soumet le lot au transport, puis l'applique au cache (seulement en cas de succès). */
  private async commit(changes: ChangeSet): Promise<void> {
    if (!changes.ops.length) return;
    try {
      await this.transport.commit(changes);
    } catch (e) {
      if (e instanceof CloudWriteDisabledError) throw e;
      throw new CloudTransportError(e);
    }
    const touched = [...new Set(changes.ops.map((o) => o.table))];
    await this.cache.transaction('rw', touched.map((t) => this.cache.table(t)), async () => {
      for (const op of changes.ops) {
        const table = this.cache.table(op.table);
        if (op.type === 'put') await table.put(op.row);
        else await table.delete(op.key as never);
      }
    });
  }

  /** Exécute une écriture dans la transaction courante, ou dans une transaction dédiée. */
  private write<R>(table: TableName, fn: (o: Overlay) => Promise<R>): Promise<R> {
    if (this.active) return fn(this.active);
    return this.transaction([table], () => fn(this.active!));
  }

  private async read(table: TableName, key: Key): Promise<Row | undefined> {
    const pending = this.active?.lookup(table, key);
    if (pending) return pending.row ? clone(pending.row) : undefined;
    return (await this.cache.table(table).get(key as never)) as Row | undefined;
  }

  private tablePort(name: TableName): TablePort<unknown> {
    const add = async (o: Overlay, row: Row) => {
      const key = keyOf(name, row);
      if (await this.read(name, key)) throw new ConstraintError(name, key);
      o.set(name, key, row);
      return key;
    };
    const del = async (o: Overlay, key: Key) => {
      if (await this.read(name, key)) o.set(name, key, null);
    };
    return {
      get: (key) => this.read(name, key),
      add: (row) => this.write(name, (o) => add(o, row as Row)),
      put: (row) =>
        this.write(name, async (o) => {
          const key = keyOf(name, row as Row);
          o.set(name, key, row as Row);
          return key;
        }),
      bulkAdd: (rows) =>
        this.write(name, async (o) => {
          for (const r of rows) await add(o, r as Row);
        }),
      bulkPut: (rows) =>
        this.write(name, async (o) => {
          for (const r of rows) o.set(name, keyOf(name, r as Row), r as Row);
        }),
      delete: (key) => this.write(name, (o) => del(o, key)),
      bulkDelete: (keys) =>
        this.write(name, async (o) => {
          for (const k of keys) await del(o, k);
        }),
      where: (index): WhereClause<unknown> => ({
        equals: (value) => this.collection(name, index, value, []),
      }),
    };
  }

  private collection(name: TableName, index: string, value: unknown, filters: ((r: Row) => boolean)[]): Collection<unknown> {
    const rows = async (): Promise<Row[]> => {
      const base = (await this.cache.table(name).where(index).equals(value as never).toArray()) as Row[];
      const merged = new Map<string, { key: Key; row: Row }>();
      for (const r of base) {
        const key = keyOf(name, r);
        merged.set(JSON.stringify(key), { key, row: r });
      }
      for (const e of this.active?.forTable(name) ?? []) {
        const k = JSON.stringify(e.key);
        if (e.row && matchesIndex(e.row, index, value)) merged.set(k, { key: e.key, row: clone(e.row) });
        else merged.delete(k);
      }
      // Ordre IndexedDB : valeur d'index identique → tri par clé primaire.
      return [...merged.values()]
        .sort((a, b) => compareKeys(a.key, b.key))
        .map((x) => x.row)
        .filter((r) => filters.every((f) => f(r)));
    };
    return {
      toArray: rows,
      count: async () => (await rows()).length,
      first: async () => (await rows())[0],
      filter: (fn) => this.collection(name, index, value, [...filters, fn as (r: Row) => boolean]),
      delete: () =>
        this.write(name, async (o) => {
          const list = await rows();
          for (const r of list) o.set(name, keyOf(name, r), null);
          return list.length;
        }),
    };
  }
}

