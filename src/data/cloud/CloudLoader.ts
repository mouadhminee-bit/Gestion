/**
 * Chargeur du cache Cloud (Plan directeur V1, V3.4-b ; curseur de récupération : V4.2).
 *
 * Remplace intégralement les données du cache `nexora-cache-<uid>` par le résultat de
 * `readCloudData` (V3.4-a), en deux temps strictement séparés :
 *  1. PRÉPARATION, en mémoire, sans aucune écriture : utilisateur attendu, cache de cet
 *     utilisateur, propriétaire et clé de chaque ligne, version de chaque clé, cohérence
 *     entre lignes actives, versions et totaux. Toute anomalie → `CloudLoadError`, le cache
 *     n'est pas ouvert en écriture.
 *  2. ÉCRITURE, en UNE transaction IndexedDB couvrant les 18 tables métier,
 *     `serverVersions` et `syncState` (et elles seules) :
 *       a. vider les 18 tables métier ;
 *       b. vider `serverVersions` puis `syncState` ;
 *       c. insérer les lignes ACTIVES ;
 *       d. insérer TOUTES les versions, clés supprimées comprises (`deleted: true`) ;
 *       e. insérer le curseur de récupération (V4.2), s'il est fourni : la borne de
 *          `pull_changes` prise AVANT la lecture (A2-b). Il REMPLACE le curseur précédent (jamais
 *          un maximum) : les données écrites viennent toutes de cette lecture, et tout ce qui a pu
 *          changer depuis la borne sera récupéré de nouveau. Sans curseur, `syncState` reste vide
 *          (aucune récupération incrémentale possible avant un chargement avec curseur).
 *     Une erreur à n'importe quelle étape (écriture refusée, quota dépassé…) annule la
 *     transaction : IndexedDB rétablit l'état antérieur, rien n'est conservé.
 *
 * Garanties :
 *  - aucune requête réseau pendant la transaction : `loadCloudCache` lit TOUT avant d'écrire,
 *    et l'écriture ne reçoit que des données déjà préparées ;
 *  - une ligne supprimée n'est JAMAIS écrite dans une table métier (sa version seule) ;
 *  - la table locale `meta` n'appartient pas à la transaction : elle ne peut être modifiée ;
 *  - la base locale `nexora` est refusée avant tout accès (`assertCloudCacheName`).
 * Les messages d'erreur ne contiennent ni valeur métier ni clé : table, motif et nombres.
 *
 * Déclenchement et vérification de la session juste avant l'écriture : `cloudLoadCycle.ts`
 * (V3.4-c).
 */
import type { ID } from '@/domain/types';
import type { Key } from '../storage';
import { PRIMARY_KEYS, type TableName } from '../tables';
import { CloudCacheDB, PULL_STATE_ID, SERVER_VERSIONS_TABLE, SYNC_STATE_TABLE, XID8_TEXT, assertCloudCacheName, type ServerVersionRecord } from './CloudCacheDB';
import { readCloudData, readPullBound, type CloudReadResult, type CloudReadSource } from './CloudReader';
import { CLOUD_TABLES, type CloudTableName } from './mapping';
import { keyString } from './transport';

export type CloudLoadErrorCode =
  /** Résultat ou cache d'un autre utilisateur que celui attendu. */
  | 'wrong_user'
  /** Base refusée : pas une `CloudCacheDB`, ou nom autre que `nexora-cache-<uid>` (dont `nexora`). */
  | 'invalid_cache'
  /** Données incohérentes : lignes, clés, versions ou totaux. */
  | 'inconsistent'
  /** Transaction IndexedDB en échec : annulée, cache inchangé. */
  | 'write_failed';

/** Refus du chargement : le cache est inchangé. Message sans valeur métier ni clé. */
export class CloudLoadError extends Error {
  readonly table: CloudTableName | null;
  /** Motif précis (ex. `missing_version`, nom de l'erreur IndexedDB). */
  readonly reason: string | null;

  constructor(
    readonly code: CloudLoadErrorCode,
    detail: string,
    info: { table?: CloudTableName | null; reason?: string | null } = {},
  ) {
    super(`Chargement du cache Cloud refusé (${code}${info.table ? `, ${info.table}` : ''}) : ${detail}`);
    this.name = 'CloudLoadError';
    this.table = info.table ?? null;
    this.reason = info.reason ?? null;
  }
}

type Row = Record<string, unknown>;

/** Données prêtes à écrire : lignes actives par table et toutes les versions. */
export interface PreparedCloudLoad {
  readonly userId: ID;
  readonly rows: Readonly<Record<CloudTableName, readonly Row[]>>;
  readonly versions: readonly ServerVersionRecord[];
}

/** Résumé d'un chargement réussi (diagnostic). */
export interface CloudLoadSummary {
  readonly userId: ID;
  /** Lignes actives écrites par table. */
  readonly rowCounts: Readonly<Record<CloudTableName, number>>;
  /** Versions écrites (clés actives et supprimées). */
  readonly versionCount: number;
  /** Dont clés supprimées. */
  readonly deletedCount: number;
  /** Curseur de récupération écrit avec les données (V4.2), `null` si aucun. */
  readonly cursor: string | null;
}

const inconsistent = (reason: string, table: CloudTableName | null, detail: string) => new CloudLoadError('inconsistent', detail, { table, reason });
const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCloudTable = (t: unknown): t is CloudTableName => typeof t === 'string' && (CLOUD_TABLES as readonly string[]).includes(t);

/** Clé d'une ligne : même calcul que `CloudStorage` ; `null` si une partie manque. */
function rowKey(table: CloudTableName, row: Row): Key | null {
  const pk = PRIMARY_KEYS[table];
  const parts = (typeof pk === 'string' ? [pk] : pk).map((f) => row[f]);
  if (!parts.every((p) => typeof p === 'string' && p.length > 0)) return null;
  return typeof pk === 'string' ? (parts[0] as string) : (parts as string[]);
}

/**
 * Prépare le chargement (aucune écriture) : vérifie le résultat de `readCloudData` pour
 * `userId` et renvoie les enregistrements des tables métier et de `serverVersions`.
 */
export function prepareCloudLoad(result: CloudReadResult, userId: ID): PreparedCloudLoad {
  if (typeof userId !== 'string' || !userId) throw new CloudLoadError('wrong_user', 'utilisateur attendu non précisé');
  if (!isObject(result) || result.userId !== userId) throw new CloudLoadError('wrong_user', 'résultat de lecture d’un autre utilisateur');
  if (!isObject(result.rows) || !Array.isArray(result.versions) || !isObject(result.totals)) throw inconsistent('shape', null, 'résultat de lecture incomplet');
  const extraTables = Object.keys(result.rows).filter((t) => !isCloudTable(t));
  if (extraTables.length) throw inconsistent('unknown_table', null, `${extraTables.length} table(s) inconnue(s) dans le résultat`);

  // Versions : forme, unicité (table, clé), répartition par table.
  const versionOf = new Map<string, ServerVersionRecord>();
  const perTable = new Map<CloudTableName, { all: number; active: number }>(CLOUD_TABLES.map((t) => [t, { all: 0, active: 0 }]));
  for (const v of result.versions as unknown[]) {
    if (!isObject(v) || !isCloudTable(v.table)) throw inconsistent('invalid_version', null, 'version d’une table inconnue ou illisible');
    const table = v.table;
    if (typeof v.key !== 'string' || !v.key) throw inconsistent('invalid_version', table, 'version sans clé');
    if (typeof v.version !== 'number' || !Number.isSafeInteger(v.version) || v.version < 1) throw inconsistent('invalid_version', table, 'numéro de version invalide (entier ≥ 1 attendu)');
    if (typeof v.deleted !== 'boolean') throw inconsistent('invalid_version', table, 'état de suppression illisible');
    const id = `${table}\u0000${v.key}`;
    if (versionOf.has(id)) throw inconsistent('duplicate_version', table, 'deux versions pour une même clé');
    versionOf.set(id, { table, key: v.key, version: v.version, deleted: v.deleted });
    const count = perTable.get(table)!;
    count.all++;
    if (!v.deleted) count.active++;
  }

  // Lignes actives : propriétaire, clé, unicité, version active correspondante.
  const rows = {} as Record<CloudTableName, Row[]>;
  for (const table of CLOUD_TABLES) {
    const list = result.rows[table] as unknown;
    if (!Array.isArray(list)) throw inconsistent('shape', table, 'lignes absentes du résultat');
    const total = (result.totals as Record<string, unknown>)[table];
    const count = perTable.get(table)!;
    if (total !== count.all) throw inconsistent('total_mismatch', table, `${count.all} version(s) pour un total de ${String(total)}`);
    if (list.length !== count.active) throw inconsistent('active_mismatch', table, `${list.length} ligne(s) active(s) pour ${count.active} version(s) active(s)`);
    const seen = new Set<string>();
    rows[table] = list.map((row: unknown) => {
      if (!isObject(row)) throw inconsistent('invalid_row', table, 'ligne illisible');
      if ((table === 'users' ? row.id : row.userId) !== userId) throw new CloudLoadError('wrong_user', 'ligne d’un autre utilisateur', { table });
      const key = rowKey(table, row);
      if (key === null) throw inconsistent('invalid_key', table, 'clé primaire absente ou invalide');
      const k = keyString(key);
      if (seen.has(k)) throw inconsistent('duplicate_key', table, 'deux lignes pour une même clé');
      seen.add(k);
      const v = versionOf.get(`${table}\u0000${k}`);
      if (!v) throw inconsistent('missing_version', table, 'ligne active sans version');
      if (v.deleted) throw inconsistent('deleted_row', table, 'ligne active marquée supprimée');
      return row;
    });
  }
  return { userId, rows, versions: [...versionOf.values()] };
}

/** Refuse toute base qui n'est pas la `CloudCacheDB` de `userId` (en particulier `nexora`). */
function checkedCache(cache: unknown, userId: ID): CloudCacheDB {
  if (!(cache instanceof CloudCacheDB)) throw new CloudLoadError('invalid_cache', 'base refusée : cache Cloud (CloudCacheDB) attendu');
  try {
    assertCloudCacheName(cache.name, userId);
  } catch {
    throw new CloudLoadError('invalid_cache', 'base refusée : ce n’est pas le cache de cet utilisateur');
  }
  if (cache.userId !== userId) throw new CloudLoadError('wrong_user', 'cache d’un autre utilisateur');
  return cache;
}

/**
 * Écrit un chargement préparé : UNE transaction sur les 18 tables métier, `serverVersions` et
 * `syncState` (vider, puis insérer). Tout échec annule l'ensemble. `cursor` : borne de
 * récupération prise avant la lecture (V4.2), écrite telle quelle.
 */
export async function writeCloudLoad(cache: CloudCacheDB, prepared: PreparedCloudLoad, cursor: string | null = null): Promise<CloudLoadSummary> {
  const db = checkedCache(cache, prepared.userId);
  if (cursor !== null && (typeof cursor !== 'string' || !XID8_TEXT.test(cursor))) throw inconsistent('invalid_cursor', null, 'curseur de récupération invalide');
  const tables = [...CLOUD_TABLES.map((t) => db.table(t)), db.table(SERVER_VERSIONS_TABLE), db.table(SYNC_STATE_TABLE)];
  try {
    await db.transaction('rw', tables, async () => {
      for (const t of CLOUD_TABLES) await db.table(t).clear();
      await db.table(SERVER_VERSIONS_TABLE).clear();
      await db.table(SYNC_STATE_TABLE).clear();
      for (const t of CLOUD_TABLES) if (prepared.rows[t].length) await db.table(t).bulkAdd([...prepared.rows[t]]);
      if (prepared.versions.length) await db.table(SERVER_VERSIONS_TABLE).bulkAdd([...prepared.versions]);
      if (cursor !== null) await db.table(SYNC_STATE_TABLE).add({ id: PULL_STATE_ID, cursor });
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    // Erreur interne d'une écriture groupée : son nom (ex. QuotaExceededError) est plus précis.
    const inner = (e as { failures?: unknown[]; inner?: { name?: unknown } })?.inner?.name;
    throw new CloudLoadError('write_failed', 'écriture du cache annulée, aucune modification conservée', { reason: typeof inner === 'string' ? inner : name });
  }
  const rowCounts = Object.fromEntries(CLOUD_TABLES.map((t) => [t, prepared.rows[t].length])) as Record<CloudTableName, number>;
  const deletedCount = prepared.versions.filter((v) => v.deleted).length;
  return { userId: prepared.userId, rowCounts, versionCount: prepared.versions.length, deletedCount, cursor };
}

/**
 * Charge le résultat d'une lecture dans le cache de `userId` : préparation complète, puis
 * écriture atomique. Toute erreur laisse le cache inchangé.
 */
export async function loadCloudData(cache: CloudCacheDB, result: CloudReadResult, userId: ID, cursor: string | null = null): Promise<CloudLoadSummary> {
  checkedCache(cache, userId); // avant toute préparation : aucune base étrangère n'est ouverte
  const prepared = prepareCloudLoad(result, userId);
  return writeCloudLoad(cache, prepared, cursor);
}

/**
 * Borne de récupération (V4.2, A2-b), lecture complète (`readCloudData`), PUIS chargement avec ce
 * curseur. Aucune requête réseau n'a lieu pendant la transaction : l'écriture ne commence qu'une
 * fois toutes les données lues et vérifiées. Une erreur de lecture (`CloudReadError`) laisse le
 * cache inchangé.
 */
export async function loadCloudCache(source: CloudReadSource, cache: CloudCacheDB, userId: ID): Promise<CloudLoadSummary> {
  checkedCache(cache, userId);
  const cursor = await readPullBound(source, userId);
  const result = await readCloudData(source, userId);
  return loadCloudData(cache, result, userId, cursor);
}

/** Tables écrites par le chargeur (diagnostic et tests) : les 18 tables métier, `serverVersions` et `syncState`. */
export const LOADED_TABLES: readonly (TableName | typeof SERVER_VERSIONS_TABLE | typeof SYNC_STATE_TABLE)[] = [...CLOUD_TABLES, SERVER_VERSIONS_TABLE, SYNC_STATE_TABLE];
