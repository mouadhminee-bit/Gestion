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
 *
 * Protocole v1 (Lot 4, étape 4.3) :
 * - chaque opération porte la dernière version serveur connue (`expectedVersion`), lue
 *   dans la table annexe `serverVersions` du cache ;
 * - les lignes ET les versions du cache ne changent qu'après un `CommitResult` valide,
 *   dans UNE transaction Dexie ;
 * - un lot dont la confirmation n'a pas été reçue (échec réseau, réponse ambiguë) est
 *   conservé (un seul emplacement, pas de file d'attente) et RÉSOLU auprès du serveur
 *   avant toute nouvelle écriture : appliqué → le cache le rattrape ; sinon abandonné
 *   (le serveur garantit qu'il ne sera jamais appliqué).
 */
import type { NexoraDB } from '../db';
import type { Collection, Key, StoragePort, TablePort, Tables, WhereClause } from '../storage';
import type { ID } from '@/domain/types';
import { ALL_TABLES, PRIMARY_KEYS, type TableName } from '../tables';
import { EXCLUDED_TABLES } from './mapping';
import { CloudCacheDB, SERVER_VERSIONS_TABLE, assertCloudCacheName, type ServerVersionRecord } from './CloudCacheDB';
import {
  CHANGESET_PROTOCOL,
  CloudCacheWriteError,
  CloudConflictError,
  CloudProtocolError,
  CloudTransportError,
  CloudWriteDisabledError,
  checkCommitResult,
  isDefinitiveRejection,
  keyString,
  type ChangeOp,
  type ChangeSet,
  type CloudTransport,
  type CommitResult,
} from './transport';

// Nommage du cache : défini dans `CloudCacheDB.ts` (contrôlé dès le constructeur), réexporté ici.
export { CLOUD_CACHE_PREFIX, LOCAL_DB_NAME, assertCloudCacheName, cloudCacheName } from './CloudCacheDB';

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

/** Version serveur de chaque clé lors de sa première lecture (`null` : inconnue du serveur). */
type Observations = Map<string, ServerVersionRecord | null>;

function observe(map: Observations, table: TableName, key: Key, rec: ServerVersionRecord | undefined) {
  const k = keyStr(table, key);
  if (!map.has(k)) map.set(k, rec ?? null);
}

/** Écritures en attente d'une transaction (état final par clé, ordre des écritures). */
class Overlay {
  readonly entries = new Map<string, Entry>();
  /**
   * Version serveur de chaque clé au moment où la transaction l'a LUE pour la première
   * fois (ou écrite sans lecture préalable). C'est la version attendue envoyée au serveur :
   * si une autre instance partageant le cache (autre onglet) a écrit la clé entre-temps,
   * le serveur détecte le conflit au lieu d'écraser son écriture.
   */
  readonly observed: Observations;

  constructor(observed?: Observations) {
    this.observed = observed ?? new Map();
  }

  observe(table: TableName, key: Key, rec: ServerVersionRecord | undefined) {
    observe(this.observed, table, key, rec);
  }

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

  all(): Entry[] {
    return [...this.entries.values()];
  }
}

/** Nouvel identifiant de lot (UUID v4), indépendant du générateur d'identifiants métier. */
function newChangesetId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Écriture d'une table locale (sans équivalent serveur, ex. `meta`) : appliquée au cache
 * uniquement, jamais transmise, sans version serveur.
 */
interface LocalOp {
  table: TableName;
  key: Key;
  /** `null` : suppression. */
  row: Row | null;
}

/** Résultat d'une transaction : lot pour le serveur + écritures purement locales. */
interface PreparedLot {
  changes: ChangeSet;
  local: LocalOp[];
}

/** Lot envoyé dont la confirmation n'a pas été reçue, ou confirmé mais pas encore dans le cache. */
interface Unconfirmed extends PreparedLot {
  /** `null` : issue inconnue (à résoudre) ; sinon : accepté, à appliquer au cache. */
  result: CommitResult | null;
}

/** Tables locales : la liste de référence est celle du mapping (`EXCLUDED_TABLES`). */
const isLocalTable = (table: TableName) => Object.prototype.hasOwnProperty.call(EXCLUDED_TABLES, table);

export class CloudStorage implements StoragePort {
  readonly tables: Tables;
  private active: Overlay | null = null;
  private unconfirmed: Unconfirmed | null = null;
  /** Observations de l'opération publique en cours (lectures hors transaction comprises). */
  private operation: Observations | null = null;
  private readonly cache: CloudCacheDB;

  constructor(
    cache: NexoraDB,
    private readonly transport: CloudTransport,
    public readonly userId: ID,
  ) {
    assertCloudCacheName(cache.name, userId); // d'abord le nom : « nexora » est toujours refusé
    if (!(cache instanceof CloudCacheDB)) throw new Error('Mode cloud : le cache doit être une base CloudCacheDB (table des versions serveur).');
    this.cache = cache;
    const tables = {} as Record<TableName, TablePort<unknown>>;
    for (const name of ALL_TABLES) tables[name] = this.tablePort(name);
    this.tables = tables as unknown as Tables;
  }

  get name(): string {
    return this.cache.name;
  }

  async transaction<R>(_tables: readonly TableName[], fn: () => Promise<R>): Promise<R> {
    if (this.active) return fn(); // transaction imbriquée : rejoint la transaction englobante
    // Un lot à l'issue inconnue est résolu AVANT de lire : les versions attendues du
    // nouveau lot partent ainsi d'un cache à jour.
    await this.resolveUnconfirmed();
    const overlay = new Overlay(this.operation ?? undefined);
    this.active = overlay;
    let result: R;
    try {
      result = await fn();
    } finally {
      this.active = null;
    }
    const lot = await this.buildChangeSet(overlay);
    if (lot.changes.ops.length) await this.commit(lot);
    else if (lot.local.length) await this.applyLocalOnly(lot.local); // aucun appel serveur
    return result;
  }

  /**
   * Exécute une opération publique susceptible d'écrire (appelé par `CloudRepository`) :
   *  1. résout d'abord un lot non confirmé, pour que les LECTURES partent d'un cache à jour
   *     (un échec est toléré ici : la transaction refusera alors l'écriture) ;
   *  2. enregistre la version de chaque clé à sa première lecture, y compris hors
   *     transaction (beaucoup de méthodes lisent avant d'écrire) : la version attendue est
   *     celle des données sur lesquelles l'opération s'est fondée.
   */
  async runOperation<R>(fn: () => Promise<R>): Promise<R> {
    if (this.operation) return fn(); // déjà dans une opération
    try {
      await this.resolveUnconfirmed();
    } catch {
      /* résolution impossible : lecture autorisée, écriture refusée par transaction() */
    }
    this.operation = new Map();
    try {
      return await fn();
    } finally {
      this.operation = null;
    }
  }

  /** Identifiant du lot non confirmé en attente de résolution (diagnostic), sinon `null`. */
  get unconfirmedChangesetId(): string | null {
    return this.unconfirmed?.changes.changesetId ?? null;
  }

  /** Dernière version serveur connue d'une clé (diagnostic et tests). */
  async serverVersion(table: TableName, key: Key): Promise<ServerVersionRecord | undefined> {
    return this.cache.serverVersions.get([table, keyString(key)]);
  }

  /**
   * Construit le lot : état final de chaque clé + version attendue (protocole v1). Les
   * tables locales (`EXCLUDED_TABLES` du mapping, ex. `meta`) sont séparées : jamais
   * transmises, appliquées au cache avec le lot confirmé.
   */
  private async buildChangeSet(overlay: Overlay): Promise<PreparedLot> {
    const ops: ChangeOp[] = [];
    const local: LocalOp[] = [];
    for (const e of overlay.all()) {
      if (isLocalTable(e.table)) {
        local.push({ table: e.table, key: e.key, row: e.row && clone(e.row) });
        continue;
      }
      const k = keyStr(e.table, e.key);
      const known = overlay.observed.has(k) ? overlay.observed.get(k) : await this.cache.serverVersions.get([e.table, keyString(e.key)]);
      const expectedVersion = known ? known.version : null;
      if (e.row) {
        ops.push({ table: e.table, type: 'put', key: e.key, expectedVersion, row: clone(e.row) });
        continue;
      }
      // Suppression d'une clé que le serveur ne connaît pas comme active (créée puis
      // supprimée dans la même transaction) : rien à transmettre.
      if ((!known || known.deleted) && !(await this.cache.table(e.table).get(e.key as never))) continue;
      ops.push({ table: e.table, type: 'delete', key: e.key, expectedVersion });
    }
    return { changes: { protocol: CHANGESET_PROTOCOL, changesetId: newChangesetId(), userId: this.userId, ops }, local };
  }

  /** Soumet le lot ; n'applique au cache que sur confirmation valide. */
  private async commit(lot: PreparedLot): Promise<void> {
    const { changes, local } = lot;
    let result: unknown;
    try {
      result = await this.transport.commit(changes);
    } catch (e) {
      if (e instanceof CloudWriteDisabledError || e instanceof CloudConflictError || e instanceof CloudProtocolError) throw e; // refus définitifs
      if (isDefinitiveRejection(e)) throw new CloudTransportError(e); // ex. isolation : refusé, rien appliqué
      this.unconfirmed = { changes, local, result: null }; // issue inconnue : jamais considéré comme enregistré
      throw new CloudTransportError(e);
    }
    if (!checkCommitResult(changes, result)) {
      this.unconfirmed = { changes, local, result: null };
      throw new CloudTransportError(new Error('réponse du serveur ambiguë : lot non confirmé'));
    }
    await this.applyConfirmed({ changes, local, result });
  }

  /**
   * Résout le lot non confirmé : s'il a été appliqué, le cache le rattrape ; s'il ne l'a
   * pas été, le serveur l'abandonne définitivement. En cas d'échec, l'écriture est refusée.
   */
  async resolveUnconfirmed(): Promise<void> {
    const pending = this.unconfirmed;
    if (!pending) return;
    if (!pending.result) {
      let r: unknown;
      try {
        r = await this.transport.resolve(pending.changes.changesetId, this.userId);
      } catch (e) {
        if (e instanceof CloudWriteDisabledError) throw e;
        throw new CloudTransportError(e);
      }
      const res = r as { status?: unknown; changesetId?: unknown };
      if (res?.status === 'abandoned' && res.changesetId === pending.changes.changesetId) {
        this.unconfirmed = null; // ses écritures locales sont abandonnées avec lui
        return;
      }
      if (!checkCommitResult(pending.changes, r)) throw new CloudTransportError(new Error('résolution ambiguë : lot toujours non confirmé'));
      pending.result = r;
    }
    await this.applyConfirmed(pending as Required<Unconfirmed> & { result: CommitResult });
  }

  /** Écritures purement locales (aucune opération serveur dans le lot) : transaction Dexie unique. */
  private async applyLocalOnly(local: LocalOp[]): Promise<void> {
    const tables = [...new Set(local.map((o) => o.table))].map((t) => this.cache.table(t));
    await this.cache.transaction('rw', tables, () => this.applyLocal(local));
  }

  private async applyLocal(local: LocalOp[]): Promise<void> {
    for (const op of local) {
      const table = this.cache.table(op.table);
      if (op.row) await table.put(op.row);
      else await table.delete(op.key as never);
    }
  }

  /**
   * Lignes, versions ET écritures locales dans UNE transaction Dexie : tout ou rien.
   * Aucune version n'est enregistrée pour les tables locales.
   */
  private async applyConfirmed(confirmed: PreparedLot & { result: CommitResult }): Promise<void> {
    const { changes, local, result } = confirmed;
    const touched = [...new Set([...changes.ops.map((o) => o.table), ...local.map((o) => o.table)])];
    try {
      await this.cache.transaction('rw', [...touched.map((t) => this.cache.table(t)), this.cache.table(SERVER_VERSIONS_TABLE)], async () => {
        for (const [i, op] of changes.ops.entries()) {
          const table = this.cache.table(op.table);
          if (op.type === 'put') await table.put(op.row);
          else await table.delete(op.key as never);
          const v = result.versions[i];
          await this.cache.serverVersions.put({ table: op.table, key: keyString(op.key), version: v.version, deleted: v.deleted });
        }
        await this.applyLocal(local);
      });
    } catch (e) {
      this.unconfirmed = { changes, local, result }; // accepté par le serveur : à réappliquer
      throw new CloudCacheWriteError(e);
    }
    this.unconfirmed = null;
    // L'opération en cours peut réécrire ces clés dans une transaction suivante : elle part
    // désormais des versions qu'elle vient elle-même de faire accepter.
    if (this.operation) {
      for (const [i, op] of changes.ops.entries()) {
        const v = result.versions[i];
        this.operation.set(keyStr(op.table, op.key), { table: op.table, key: keyString(op.key), version: v.version, deleted: v.deleted });
      }
    }
  }

  /** Exécute une écriture dans la transaction courante, ou dans une transaction dédiée. */
  private write<R>(table: TableName, fn: (o: Overlay) => Promise<R>): Promise<R> {
    if (this.active) return fn(this.active);
    return this.transaction([table], () => fn(this.active!));
  }

  private async read(table: TableName, key: Key): Promise<Row | undefined> {
    const pending = this.active?.lookup(table, key);
    if (pending) return pending.row ? clone(pending.row) : undefined;
    const obs = this.active?.observed ?? this.operation;
    if (!obs) return (await this.cache.table(table).get(key as never)) as Row | undefined;
    // Ligne et version lues ensemble (transaction Dexie de lecture) : instantané cohérent.
    return this.cache.transaction('r', [this.cache.table(table), this.cache.table(SERVER_VERSIONS_TABLE)], async () => {
      const row = (await this.cache.table(table).get(key as never)) as Row | undefined;
      observe(obs, table, key, await this.cache.serverVersions.get([table, keyString(key)]));
      return row;
    });
  }

  /** Écriture sans lecture préalable : la version attendue est celle connue maintenant. */
  private async observeForWrite(o: Overlay, table: TableName, key: Key): Promise<void> {
    if (!o.observed.has(keyStr(table, key))) o.observe(table, key, await this.cache.serverVersions.get([table, keyString(key)]));
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
          await this.observeForWrite(o, name, key);
          o.set(name, key, row as Row);
          return key;
        }),
      bulkAdd: (rows) =>
        this.write(name, async (o) => {
          for (const r of rows) await add(o, r as Row);
        }),
      bulkPut: (rows) =>
        this.write(name, async (o) => {
          for (const r of rows) {
            const key = keyOf(name, r as Row);
            await this.observeForWrite(o, name, key);
            o.set(name, key, r as Row);
          }
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
      const obs = this.active?.observed ?? this.operation;
      const base = obs
        ? await this.cache.transaction('r', [this.cache.table(name), this.cache.table(SERVER_VERSIONS_TABLE)], async () => {
            const found = (await this.cache.table(name).where(index).equals(value as never).toArray()) as Row[];
            const recs = await this.cache.serverVersions.bulkGet(found.map((r) => [name, keyString(keyOf(name, r))] as [string, string]));
            found.forEach((r, i) => observe(obs, name, keyOf(name, r), recs[i]));
            return found;
          })
        : ((await this.cache.table(name).where(index).equals(value as never).toArray()) as Row[]);
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

