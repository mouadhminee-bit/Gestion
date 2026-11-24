/**
 * Lecture initiale des données Cloud (Plan directeur V1, V3.4-a), branchée par le cycle de
 * chargement (`cloudLoadCycle.ts`, V3.4-c).
 *
 * Lit, pour l'utilisateur de la session, les 18 tables du serveur et renvoie un résultat
 * technique destiné au futur chargeur du cache (V3.4-b) :
 *  - `rows` : les lignes ACTIVES, converties par `deserializeRow` ;
 *  - `versions` : la version de CHAQUE clé lue, active (`deleted: false`) ou supprimée
 *    (`deleted: true`), au format de la table `serverVersions` du cache (D-1 b).
 * Le contenu métier d'une ligne supprimée est converti (contrôle complet), puis ABANDONNÉ :
 * il ne figure ni dans le résultat ni dans aucun message d'erreur (P-1).
 *
 * Requêtes (P-5), une à la fois, par la source (`CloudReadSource`) :
 *  - par table, des pages de `READ_PAGE_SIZE` lignes : filtre sur le propriétaire (`user_id`,
 *    ou `id` pour les profils), AUCUN filtre `deleted_at`, tri sur la clé primaire SQL,
 *    nombre total exact demandé à chaque page ;
 *  - après les 18 tables : une contre-vérification du nombre total de chaque table.
 *
 * Intégralité (rapport de cadrage V3.4, § 3) — toute incohérence fait refuser le résultat
 * COMPLET (`CloudReadError`), rien n'est renvoyé partiellement :
 *  - total présent et entier ≥ 0 à chaque page, identique à celui de la première page (N) ;
 *  - page non vide tant que N n'est pas atteint, jamais au-delà de N ni de la taille demandée ;
 *  - aucun doublon de clé ; décalage avancé du nombre de lignes REÇUES ;
 *  - nombre final de clés distinctes = N ; contre-vérification = N pour chaque table.
 * Hypothèse H1 (vérifiée dans le schéma) : aucune ligne n'est effacée physiquement — le total
 * d'une table ne peut que croître. Deux totaux égaux encadrant la lecture prouvent donc
 * qu'aucune ligne n'a été insérée entre-temps. Une modification SUR PLACE d'une ligne déjà
 * lue n'est pas détectée (version antérieure, protégée par le contrôle de version à
 * l'écriture) : ce n'est PAS un instantané transactionnel des 18 tables (P40). Depuis V4.2,
 * la borne de récupération est prise AVANT cette lecture (`readPullBound`) : une telle
 * modification a un `sync_txid` supérieur ou égal à la borne et est récupérée ensuite.
 *
 * Contrôles métier (P-7) : exactement 1 ligne de profil, active ; 0 ou 1 ligne de paramètres.
 * Isolation : toute ligne d'un autre utilisateur fait refuser le résultat (en plus de la RLS).
 * Session : vérifiée avant CHAQUE requête ; absente ou d'un autre utilisateur → refus, sans
 * requête.
 */
import type { ID } from '@/domain/types';
import type { Key } from '../storage';
import { PRIMARY_KEYS } from '../tables';
import { XID8_TEXT, type ServerVersionRecord } from './CloudCacheDB';
import { CLOUD_TABLES, MAPPING, MappingError, deserializeRow, type CloudRow, type CloudTableName, type ServerMetadata } from './mapping';
import { keyString } from './transport';

/** Taille d'une page (P-5). */
export const READ_PAGE_SIZE = 1000;

/** Tables lues, dans un ordre fixe (celui du mapping). */
export const READ_TABLES: readonly CloudTableName[] = CLOUD_TABLES;

/** Colonne propriétaire filtrée : `id` pour les profils, `user_id` partout ailleurs. */
export type OwnerColumn = 'id' | 'user_id';

/** Une requête de lecture : table, propriétaire, tri. */
export interface ReadQuery {
  readonly table: CloudTableName;
  readonly sqlTable: string;
  readonly owner: OwnerColumn;
  readonly userId: ID;
  /** Colonnes de la clé primaire SQL, tri croissant. */
  readonly order: readonly string[];
}

/** Réponse brute d'une page (validée par le lecteur, jamais supposée correcte). */
export interface ReadPage {
  readonly rows: unknown;
  readonly total: unknown;
}

/**
 * Source de lecture : supabase-js (`HttpReadSource`) ou serveur en mémoire des tests
 * (`MemoryTransport.readSource`). Même contrat : lignes SQL brutes, actives ET supprimées,
 * métadonnées comprises, limitées par la RLS à l'utilisateur de la session.
 */
export interface CloudReadSource {
  readonly kind: string;
  /** Utilisateur de la session courante (`null` : aucune). N'envoie aucune requête. */
  sessionUserId(): Promise<ID | null>;
  /** Une page, triée par la clé, avec le nombre total exact de lignes du filtre. */
  page(query: ReadQuery, offset: number, limit: number): Promise<ReadPage>;
  /** Nombre total exact de lignes du filtre, sans données (contre-vérification). */
  count(query: ReadQuery): Promise<unknown>;
  /**
   * Récupération des changements (V4.2) : une page de `public.pull_changes` (M9) pour
   * l'utilisateur de la session. Réponse brute `{ bound, rows, next }`, jamais supposée
   * correcte (validée par l'appelant). Erreurs : `CloudReadError` (refus `invalid_pull` :
   * code `rejected`, motif `PT400`).
   */
  pull(request: PullRequest): Promise<unknown>;
}

/** Paramètres d'une page de `pull_changes` (format filaire : `xid8` en texte). */
export interface PullRequest {
  readonly cursor: string;
  /** `null` à la première page : la borne est fixée par le serveur. */
  readonly bound: string | null;
  /** Position de reprise (`next` de la page précédente), `null` à la première page. */
  readonly after: unknown;
  readonly limit: number;
}

export type CloudReadErrorCode =
  /** Aucune session, session d'un autre utilisateur, ou refus d'authentification (401, 403…). */
  | 'unauthorized'
  /** Réseau, délai dépassé, erreur 5xx / 408 / 429 : un nouvel essai peut réussir. */
  | 'unavailable'
  /** Réponse illisible ou inattendue (corps, statut). */
  | 'invalid_response'
  /** Autre refus du serveur (4xx). */
  | 'rejected'
  /** Intégralité non démontrée (totaux, pages, doublons, contre-vérification). */
  | 'incomplete'
  /** Ligne non conforme au mapping (colonne inconnue ou absente, valeur invalide). */
  | 'invalid_row'
  /** Ligne appartenant à un autre utilisateur. */
  | 'foreign_row'
  /** Contrôle métier P-7 non respecté (profil, paramètres). */
  | 'invariant';

/**
 * Refus de la lecture : rien n'est renvoyé. Le message ne contient JAMAIS de valeur métier
 * (ni contenu de ligne, ni corps de réponse) : table, colonne, code et nombres seulement.
 */
export class CloudReadError extends Error {
  readonly table: CloudTableName | null;
  /** Statut HTTP, s'il y en a un. */
  readonly status: number | null;
  /** Motif précis (ex. `total_changed`, `duplicate_key`, code du mapping, SQLSTATE). */
  readonly reason: string | null;

  constructor(
    readonly code: CloudReadErrorCode,
    detail: string,
    info: { table?: CloudTableName | null; status?: number | null; reason?: string | null } = {},
  ) {
    super(`Lecture Cloud refusée (${code}${info.table ? `, ${info.table}` : ''}) : ${detail}`);
    this.name = 'CloudReadError';
    this.table = info.table ?? null;
    this.status = info.status ?? null;
    this.reason = info.reason ?? null;
  }

  /** Erreur passagère : un nouvel essai, demandé par l'utilisateur, peut réussir. */
  get transient(): boolean {
    return this.code === 'unavailable';
  }
}

/** Lignes actives de chaque table, converties (champs locaux absents). */
export type CloudTablesRows = { [N in CloudTableName]: CloudRow<N>[] };

/** Résultat technique destiné au chargeur du cache (V3.4-b). */
export interface CloudReadResult {
  readonly userId: ID;
  /** Lignes ACTIVES uniquement. */
  readonly rows: CloudTablesRows;
  /** Version de chaque clé lue, active ou supprimée (`deleted: true`), sans contenu. */
  readonly versions: ServerVersionRecord[];
  /** Nombre de lignes de chaque table (actives + supprimées), vérifié deux fois. */
  readonly totals: Readonly<Record<CloudTableName, number>>;
}

/** Requête de lecture d'une table pour un utilisateur. */
export function readQuery(table: CloudTableName, userId: ID): ReadQuery {
  return { table, sqlTable: MAPPING[table].sqlTable, owner: table === 'users' ? 'id' : 'user_id', userId, order: [...MAPPING[table].sqlKey] };
}

/** Clé TS d'une ligne : même calcul que `CloudStorage` (clé primaire du schéma Dexie). */
function rowKey(table: CloudTableName, row: Record<string, unknown>): Key {
  const pk = PRIMARY_KEYS[table];
  return typeof pk === 'string' ? (row[pk] as string) : pk.map((f) => row[f] as string);
}

const incomplete = (reason: string, table: CloudTableName | null, detail: string) => new CloudReadError('incomplete', detail, { table, reason });

/** Total exact renvoyé par la source : entier sûr ≥ 0, sinon intégralité non démontrable. */
function validTotal(total: unknown, table: CloudTableName): number {
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw incomplete('count_missing', table, 'nombre total exact absent ou invalide');
  return total;
}

/** Session vérifiée avant chaque requête : absente ou d'un autre utilisateur → refus, rien n'est envoyé. */
async function ensureSession(source: CloudReadSource, userId: ID, table: CloudTableName | null): Promise<void> {
  let uid: ID | null;
  try {
    uid = await source.sessionUserId();
  } catch {
    uid = null;
  }
  if (!uid) throw new CloudReadError('unauthorized', 'aucune session active (aucune requête envoyée)', { table });
  if (uid !== userId) throw new CloudReadError('unauthorized', 'session d’un autre utilisateur (aucune requête envoyée)', { table });
}

/** Appel à la source ; toute erreur non classée devient une indisponibilité, sans son message. */
async function call<T>(table: CloudTableName, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CloudReadError) throw e;
    throw new CloudReadError('unavailable', `échec de la source (${e instanceof Error ? e.name : 'erreur'})`, { table });
  }
}

/** Conversion stricte ; une erreur de mapping est rapportée SANS valeur (colonne et code seulement). */
function convert<N extends CloudTableName>(table: N, raw: unknown): { row: Record<string, unknown>; meta: ServerMetadata } {
  try {
    const d = deserializeRow(table, raw);
    return { row: d.row as unknown as Record<string, unknown>, meta: d.meta };
  } catch (e) {
    if (e instanceof MappingError) throw new CloudReadError('invalid_row', `ligne non conforme (colonne ${e.field ?? '—'}, ${e.code})`, { table, reason: e.code });
    throw new CloudReadError('invalid_row', 'ligne illisible', { table });
  }
}

const ownerOf = (table: CloudTableName, row: Record<string, unknown>) => (table === 'users' ? row.id : row.userId);

/**
 * Lit une table page par page et vérifie son intégralité. `accept` reçoit chaque ligne
 * convertie (une seule fois par clé). Renvoie N, le total de la table.
 */
async function readTable(
  source: CloudReadSource,
  q: ReadQuery,
  accept: (row: Record<string, unknown>, meta: ServerMetadata, key: string) => void,
): Promise<number> {
  const { table } = q;
  const keys = new Set<string>();
  let expected: number | null = null;
  let offset = 0;
  do {
    await ensureSession(source, q.userId, table);
    const page = await call(table, () => source.page(q, offset, READ_PAGE_SIZE));
    const total = validTotal(page.total, table);
    if (expected === null) expected = total;
    else if (total !== expected) throw incomplete('total_changed', table, `total modifié pendant la pagination (${expected} puis ${total})`);
    if (!Array.isArray(page.rows)) throw new CloudReadError('invalid_response', 'réponse sans liste de lignes', { table });
    const n = page.rows.length;
    if (n > READ_PAGE_SIZE) throw incomplete('page_overflow', table, `page de ${n} lignes pour ${READ_PAGE_SIZE} demandées`);
    if (n === 0 && offset < expected) throw incomplete('missing_rows', table, `page vide au rang ${offset} sur ${expected}`);
    if (offset + n > expected) throw incomplete('too_many_rows', table, `${offset + n} lignes reçues pour un total de ${expected}`);
    for (const raw of page.rows) {
      const { row, meta } = convert(table, raw);
      // Le mapping admet tout entier sûr ; le serveur numérote les versions à partir de 1 (une
      // version < 1 ne pourrait servir de version attendue : refusée par `apply_changeset`).
      if (meta.version < 1) throw new CloudReadError('invalid_row', 'version serveur invalide (< 1)', { table, reason: 'invalid_version' });
      if (ownerOf(table, row) !== q.userId) throw new CloudReadError('foreign_row', 'ligne d’un autre utilisateur', { table });
      const key = keyString(rowKey(table, row));
      if (keys.has(key)) throw incomplete('duplicate_key', table, 'clé reçue deux fois (lignes décalées entre deux pages)');
      keys.add(key);
      accept(row, meta, key);
    }
    offset += n;
  } while (offset < expected);
  if (keys.size !== expected) throw incomplete('count_mismatch', table, `${keys.size} clés distinctes pour un total de ${expected}`);
  return expected;
}

/** Contrôles P-7 : exactement 1 profil, actif ; au plus 1 ligne de paramètres. */
function checkInvariants(rows: CloudTablesRows, totals: Record<CloudTableName, number>): void {
  if (totals.users !== 1 || rows.users.length !== 1) {
    throw new CloudReadError('invariant', `profil : exactement 1 ligne active attendue (${totals.users} ligne(s), ${rows.users.length} active(s))`, { table: 'users', reason: 'profile' });
  }
  if (totals.settings > 1) throw new CloudReadError('invariant', `paramètres : 0 ou 1 ligne attendue (${totals.settings})`, { table: 'settings', reason: 'settings' });
}

/**
 * Lit toutes les données Cloud de `userId` (utilisateur de la session). Résultat complet et
 * vérifié, ou `CloudReadError` : jamais de résultat partiel.
 */
export async function readCloudData(source: CloudReadSource, userId: ID): Promise<CloudReadResult> {
  if (typeof userId !== 'string' || !userId) throw new CloudReadError('unauthorized', 'utilisateur non précisé (aucune requête envoyée)');
  const rows = Object.fromEntries(READ_TABLES.map((t) => [t, []])) as unknown as Record<CloudTableName, Record<string, unknown>[]>;
  const totals = {} as Record<CloudTableName, number>;
  const versions: ServerVersionRecord[] = [];

  for (const table of READ_TABLES) {
    totals[table] = await readTable(source, readQuery(table, userId), (row, meta, key) => {
      const deleted = meta.deletedAt !== null;
      versions.push({ table, key, version: meta.version, deleted });
      if (!deleted) rows[table].push(row); // ligne supprimée : contenu abandonné ici
    });
  }

  // Contre-vérification : aucune insertion dans une table après sa lecture.
  for (const table of READ_TABLES) {
    const q = readQuery(table, userId);
    await ensureSession(source, userId, table);
    const total = validTotal(await call(table, () => source.count(q)), table);
    if (total !== totals[table]) throw incomplete('fence_mismatch', table, `contre-vérification : ${total} lignes pour ${totals[table]} lues`);
  }

  const result = rows as unknown as CloudTablesRows;
  checkInvariants(result, totals);
  return { userId, rows: result, versions, totals };
}

/**
 * Borne de récupération des changements prise AVANT un chargement complet (V4.2, décision A2-b) :
 * une page d'une ligne de `pull_changes` depuis le curseur `'0'` (la ligne renvoyée est ignorée).
 * Toute transaction terminée avant cette borne est visible par la lecture complète qui suit ;
 * toute écriture ultérieure a un `sync_txid` supérieur ou égal et sera récupérée ensuite. Session
 * vérifiée avant l'envoi ; réponse sans borne valide → `invalid_response`.
 */
export async function readPullBound(source: CloudReadSource, userId: ID): Promise<string> {
  await ensureSession(source, userId, null); // aucune table : requête de borne
  let page: unknown;
  try {
    page = await source.pull({ cursor: '0', bound: null, after: null, limit: 1 });
  } catch (e) {
    if (e instanceof CloudReadError) throw e;
    throw new CloudReadError('unavailable', `échec de la source (${e instanceof Error ? e.name : 'erreur'})`, { reason: 'pull_bound' });
  }
  const bound = (page as { bound?: unknown } | null)?.bound;
  if (typeof bound !== 'string' || !XID8_TEXT.test(bound)) throw new CloudReadError('invalid_response', 'borne de récupération absente ou invalide', { reason: 'pull_bound' });
  return bound;
}
