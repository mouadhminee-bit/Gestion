/**
 * Transport en mémoire — RÉSERVÉ AUX TESTS (jamais importé par l'application).
 *
 * Simule le serveur du protocole ChangeSet v1 (référence du comportement attendu de
 * `apply_changeset`, Lot 4 étape 4.4) :
 *  - lignes partitionnées par utilisateur ; une ligne attribuée à un autre utilisateur est
 *    refusée (équivalent de `with check (user_id = auth.uid())`) ;
 *  - chaque clé porte une version (1 à la création, +1 à chaque écriture) et un état
 *    supprimé ; les lignes supprimées sont CONSERVÉES (suppression logique) ;
 *  - contrôle optimiste : toutes les versions attendues sont vérifiées AVANT toute
 *    application ; un seul écart → `CloudConflictError`, rien n'est appliqué ;
 *  - idempotence : un `changesetId` déjà accepté renvoie le résultat d'origine
 *    (`replayed`) sans rien réappliquer ; réutilisé avec un autre contenu → refus ;
 *  - résolution : un lot inconnu est marqué abandonné et ne sera jamais appliqué.
 *
 * ALIGNEMENT SUR LE SERVEUR (P15, V3.3 ; seul comportement depuis V3.4-d), identique à
 * `apply_changeset` / `resolve_changeset` (migration 8, docs/LOT4_PLAN.md § 7.3 à 7.7) :
 *  - identité : celle de la session (`as(uid)`), ou à défaut le `userId` du lot ; lot d'un
 *    autre utilisateur ou ligne / clé appartenant à un autre → `unauthorized` ;
 *  - identifiant de lot propre à chaque utilisateur (idempotence, résolution, abandon) ;
 *  - profil (`users` → `profiles`) créé à l'inscription (`registerUser`, automatique pour
 *    l'utilisateur authentifié), jamais créé ni supprimé par un lot → `invalid_operation` ;
 *  - clés canoniques exigées (UUID en minuscules, date AAAA-MM-JJ…) → `invalid_key` ;
 *  - clés primaires globales : créer une clé déjà prise par un autre utilisateur →
 *    `duplicate_key` ;
 *  - codes du serveur (`unsupported_protocol`, `unsupported_table`, `invalid_operation`,
 *    `invalid_key`, `invalid_row`, `changeset_too_large`…), dans le même ordre de contrôle ;
 *  - `changeset_pending` simulable (`pendingResolveNext`) ;
 *  - lecture (V3.4-a) : lignes SQL actives et supprimées (`sqlRows`), source de lecture de la
 *    session (`readSource`, même contrat que `HttpReadSource`) ;
 *  - récupération des changements (V4.1, migration 9 : `pull`) : chaque lot accepté reçoit un
 *    identifiant de transaction croissant (`sync_txid`, comme `pg_current_xact_id()`), commun
 *    à toutes ses lignes ; borne = prochain identifiant (aucune transaction en cours en
 *    mémoire) ; mêmes paramètres, pagination, ordre (sync_txid, table, clé) et refus
 *    (`invalid_pull`) que `public.pull_changes`.
 * Non modélisé (propre à PostgreSQL) : types et contraintes métier des colonnes (CHECK, clés
 * étrangères), taille en octets, concurrence réelle (donc transactions en cours retenant la
 * borne de récupération : qualifié sur PostgreSQL, suites 07 et 12).
 */
import type { ID } from '@/domain/types';
import type { Key } from '../storage';
import { PRIMARY_KEYS, type TableName } from '../tables';
import { MAPPING, assertNoServerMetadata, fromSqlKey, serializeRow, sqlColumnsOf, toSqlKey, type CloudTableName } from './mapping';
import { CloudReadError, type CloudReadSource, type ReadQuery } from './CloudReader';
import {
  CHANGESET_PROTOCOL,
  CloudConflictError,
  CloudProtocolError,
  CloudTransportError,
  changesetFingerprint,
  keyString,
  type ChangeSet,
  type ChangeOp,
  type CloudProtocolErrorCode,
  type CloudTransport,
  type CommitResult,
  type ResolveResult,
  type VersionConflict,
  type VersionEntry,
} from './transport';

/** Limite du nombre d'opérations d'un lot (identique à la migration 8). */
const MAX_OPS = 5000;
/** Date d'inscription fictive des profils créés par `registerUser` (forme TS canonique). */
export const REGISTERED_AT = '2026-01-01T00:00:00.000Z';
/**
 * Même instant au format RÉEL de PostgreSQL / PostgREST pour une colonne `timestamptz` remplie
 * par le serveur (`DEFAULT now()`) : précision à la MICROSECONDE, fuseau `+00:00` (V3.7, P39).
 * Ramené à la milliseconde par le mapping, il redonne exactement `REGISTERED_AT`.
 */
export const REGISTERED_AT_SQL = '2026-01-01T00:00:00.000456+00:00';
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OP_FIELDS = new Set(['table', 'type', 'key', 'expectedVersion', 'row']);

const isCloudTable = (t: unknown): t is Exclude<TableName, 'meta'> => typeof t === 'string' && Object.prototype.hasOwnProperty.call(MAPPING, t);
const updateOnly = (t: Exclude<TableName, 'meta'>) => MAPPING[t].write === 'update-only';

/** Utilisateur désigné par la clé elle-même (profil, paramètres, notifications), sinon `undefined`. */
function ownerOfKey(table: TableName, key: Key): unknown {
  if (table === 'users' || table === 'settings') return key;
  if (table === 'notificationStates' && Array.isArray(key)) return key[0];
  return undefined;
}

/** Propriétaire déclaré d'une ligne. */
function ownerOf(table: TableName, row: Record<string, unknown>): unknown {
  if (table === 'users') return row.id;
  return row.userId;
}

function keyOfRow(table: TableName, row: Record<string, unknown>): Key {
  const pk = PRIMARY_KEYS[table];
  return typeof pk === 'string' ? (row[pk] as string) : pk.map((f) => row[f] as string);
}

interface ServerEntry {
  row: Record<string, unknown>;
  version: number;
  deleted: boolean;
  /** Identifiant de la transaction (lot) qui a écrit la ligne en dernier (`sync_txid`). */
  txid: number;
}

/** Paramètre refusé par la récupération des changements (`invalid_pull`, PT400). */
export class PullRequestError extends Error {
  constructor(readonly reason: string) {
    super(`invalid_pull : ${reason}`);
    this.name = 'PullRequestError';
  }
}

/** Position de reprise d'une page de récupération (champ `next` de la réponse). */
export interface PullPosition {
  readonly txid: string;
  readonly table: string;
  readonly key: string;
}

/** Réponse de la récupération des changements (format filaire de `public.pull_changes`). */
export interface PullResponse {
  readonly bound: string;
  readonly rows: { readonly table: string; readonly key: Record<string, unknown>; readonly row: Record<string, unknown> }[];
  readonly next: PullPosition | null;
}

/** Taille maximale d'une page de récupération (comme la migration 9). */
export const PULL_MAX_LIMIT = 1000;
const XID_TEXT = /^[0-9]{1,20}$/;

export class MemoryTransport implements CloudTransport {
  readonly kind = 'memory';
  /** userId → table → clé canonique → ligne versionnée. */
  private readonly server = new Map<ID, Map<TableName, Map<string, ServerEntry>>>();
  /** Lots par utilisateur (`uid␀changesetId`), appliqués ou abandonnés. */
  private readonly lots = new Map<string, { status: 'applied' | 'abandoned'; fingerprint?: string; result?: CommitResult }>();
  /** Propriétaire de chaque clé existante (clés primaires globales). */
  private readonly keyOwners = new Map<string, ID>();
  /** Prochain `resolve` → le lot est encore « en cours » (`changeset_pending`). */
  pendingResolveNext = false;
  /** Lots ACCEPTÉS (dans l'ordre). Les rejeus n'y figurent pas. */
  readonly commits: ChangeSet[] = [];
  /** Erreur à lever au prochain `commit`, AVANT toute application (échec réseau à l'aller). */
  failNext: Error | null = null;
  /** Échec conditionnel (ex. sur une table donnée), avant application. */
  failWhen: ((changes: ChangeSet) => Error | null) | null = null;
  /** Prochain `commit` : appliqué, PUIS réponse perdue (erreur levée après acceptation). */
  loseResponseNext: Error | null = null;
  /** Prochain `commit` : appliqué, mais réponse renvoyée altérée (réponse ambiguë). */
  garbleResponseNext: ((r: CommitResult) => unknown) | null = null;
  /** Tant que non nul : chaque `resolve` échoue avec cette erreur (réseau indisponible). */
  resolveFailure: Error | null = null;
  /** Prochain identifiant de transaction (`sync_txid`) ; 1 est réservé (jamais attribué). */
  private nextTxid = 2;

  /** Identité : à défaut de session (`as`), le `userId` du lot. */
  async commit(changes: ChangeSet): Promise<CommitResult> {
    return this.commitFor(typeof changes?.userId === 'string' ? changes.userId : '', changes);
  }

  async resolve(changesetId: string, userId: ID): Promise<ResolveResult> {
    return this.resolveFor(userId, changesetId, userId);
  }

  /**
   * Vue « session » : les lots et résolutions sont soumis au nom de `uid`, comme par un
   * client authentifié. L'utilisateur est inscrit (profil créé) au besoin.
   */
  as(uid: ID): CloudTransport {
    this.registerUser(uid);
    return {
      kind: 'memory',
      commit: (changes) => this.commitFor(uid, changes),
      resolve: (changesetId, userId) => this.resolveFor(uid, changesetId, userId),
    };
  }

  /** Inscription (déclencheur `handle_new_user`) — profil créé en version 1. */
  registerUser(uid: ID, displayName = ''): void {
    if (this.keyOwners.has(`users\u0000${keyString(uid)}`)) return;
    const space = this.server.get(uid) ?? new Map<TableName, Map<string, ServerEntry>>();
    this.server.set(uid, space);
    const users = space.get('users') ?? new Map<string, ServerEntry>();
    space.set('users', users);
    users.set(keyString(uid), { row: { id: uid, displayName, createdAt: REGISTERED_AT }, version: 1, deleted: false, txid: this.nextTxid++ });
    this.keyOwners.set(`users\u0000${keyString(uid)}`, uid);
  }

  private async commitFor(uid: ID, changes: ChangeSet): Promise<CommitResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const conditional = this.failWhen?.(changes);
    if (conditional) throw conditional;
    const result = this.applyAligned(uid, changes);
    if (this.loseResponseNext) {
      const e = this.loseResponseNext;
      this.loseResponseNext = null;
      throw e;
    }
    if (this.garbleResponseNext) {
      const garble = this.garbleResponseNext;
      this.garbleResponseNext = null;
      return garble(structuredClone(result)) as CommitResult;
    }
    return structuredClone(result);
  }

  /** Résolution dans le périmètre de l'utilisateur authentifié. */
  private async resolveFor(uid: ID, changesetId: string, userId: ID): Promise<ResolveResult> {
    if (this.resolveFailure) throw this.resolveFailure;
    if (userId !== uid) throw new CloudProtocolError('unauthorized', 'résolution demandée pour un autre utilisateur');
    this.registerUser(uid);
    if (typeof changesetId !== 'string' || !UUID_ANY.test(changesetId)) throw new CloudProtocolError('invalid_changeset', 'changesetId : UUID attendu');
    if (this.pendingResolveNext) {
      this.pendingResolveNext = false;
      throw new CloudTransportError(new Error('changeset_pending : lot encore en cours de traitement'));
    }
    const id = changesetId.toLowerCase();
    const lotKey = `${uid}\u0000${id}`;
    const prev = this.lots.get(lotKey);
    if (prev?.status === 'applied') return { ...structuredClone(prev.result!), status: 'replayed' };
    if (!prev) this.lots.set(lotKey, { status: 'abandoned' });
    return { changesetId: id, status: 'abandoned' };
  }

  /**
   * Contrôles dans l'ordre de `apply_changeset` (enveloppe, identité, taille,
   * idempotence, forme de chaque opération, versions, écritures), puis application tout ou rien.
   */
  private applyAligned(uid: ID, changes: ChangeSet): CommitResult {
    const bad = (code: CloudProtocolErrorCode, detail: string): never => {
      throw new CloudProtocolError(code, detail);
    };
    // Enveloppe et identité
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) bad('invalid_changeset', 'objet attendu');
    if (Object.keys(changes).sort().join(',') !== 'changesetId,ops,protocol,userId') bad('invalid_changeset', 'champs attendus : protocol, changesetId, userId, ops');
    if (changes.protocol !== CHANGESET_PROTOCOL) bad('unsupported_protocol', 'protocole 1 attendu');
    if (typeof changes.changesetId !== 'string' || !UUID_ANY.test(changes.changesetId)) bad('invalid_changeset', 'changesetId : UUID attendu');
    if (!uid || changes.userId !== uid) bad('unauthorized', 'userId différent de l’utilisateur authentifié');
    if (!Array.isArray(changes.ops) || !changes.ops.length) bad('invalid_changeset', 'ops : tableau non vide attendu');
    if (changes.ops.length > MAX_OPS) bad('changeset_too_large', `${changes.ops.length} opérations (maximum ${MAX_OPS})`);
    this.registerUser(uid);

    // Idempotence (avant toute validation métier)
    const lotKey = `${uid}\u0000${changes.changesetId.toLowerCase()}`;
    const fingerprint = changesetFingerprint(changes);
    const prev = this.lots.get(lotKey);
    if (prev?.status === 'abandoned') bad('changeset_abandoned', 'lot abandonné lors d’une résolution : jamais appliqué');
    if (prev) {
      if (prev.fingerprint !== fingerprint) bad('changeset_id_reused', 'identifiant de lot déjà utilisé pour un autre contenu');
      return { ...structuredClone(prev.result!), status: 'replayed' };
    }

    // Phase 1 : forme de chaque opération
    const seen = new Set<string>();
    for (const op of changes.ops as unknown[]) {
      const o = op as Partial<ChangeOp> | null;
      const k = `${JSON.stringify(o?.table)}\u0000${JSON.stringify(o?.key)}`;
      if (seen.has(k)) bad('invalid_changeset', 'deux opérations sur la même clé');
      seen.add(k);
    }
    for (const [i, raw] of (changes.ops as unknown[]).entries()) {
      const op = raw as ChangeOp;
      if (!op || typeof op !== 'object' || Array.isArray(op) || !['table', 'type', 'key', 'expectedVersion'].every((f) => f in op) || Object.keys(op).some((f) => !OP_FIELDS.has(f))) {
        bad('invalid_operation', `opération ${i} : champs attendus table, type, key, expectedVersion[, row]`);
      }
      if (!isCloudTable(op.table)) bad('unsupported_table', `opération ${i} : table hors liste blanche`);
      const table = op.table as Exclude<TableName, 'meta'>;
      if (op.type !== 'put' && op.type !== 'delete') bad('invalid_operation', `opération ${i} : type put ou delete`);
      if (op.expectedVersion !== null && !(Number.isSafeInteger(op.expectedVersion) && op.expectedVersion >= 1)) bad('invalid_operation', `opération ${i} : expectedVersion entier ≥ 1 ou null`);
      let canonical: string;
      try {
        canonical = keyString(fromSqlKey(table, toSqlKey(table, op.key)));
      } catch {
        return bad('invalid_key', `opération ${i} : valeur de clé invalide`);
      }
      if (canonical !== keyString(op.key)) bad('invalid_key', `opération ${i} : clé non canonique`);
      if (op.type === 'delete') {
        if ('row' in op) bad('invalid_operation', `opération ${i} : une suppression ne transporte pas de ligne`);
        if (updateOnly(table)) bad('invalid_operation', `opération ${i} : suppression interdite pour cette table`);
      } else {
        if (!op.row || typeof op.row !== 'object' || Array.isArray(op.row)) bad('invalid_row', `opération ${i} : ligne attendue`);
        try {
          assertNoServerMetadata(table, op.row);
        } catch {
          bad('invalid_row', `opération ${i} : métadonnées serveur interdites`);
        }
        if (keyString(keyOfRow(table, op.row)) !== keyString(op.key)) bad('invalid_key', `opération ${i} : clé incohérente avec la ligne`);
      }
      const keyOwner = ownerOfKey(table, op.key);
      if ((keyOwner !== undefined && keyOwner !== uid) || (op.type === 'put' && ownerOf(table, op.row) !== uid)) bad('unauthorized', `opération ${i} : ligne attribuée à un autre utilisateur`);
    }

    // Phase 2 : versions (toutes vérifiées avant la première écriture)
    const space = this.server.get(uid) ?? new Map<TableName, Map<string, ServerEntry>>();
    const conflicts: VersionConflict[] = [];
    for (const op of changes.ops) {
      const cur = space.get(op.table)?.get(keyString(op.key));
      const ok =
        op.type === 'put'
          ? op.expectedVersion === null
            ? cur === undefined
            : cur !== undefined && cur.version === op.expectedVersion
          : op.expectedVersion !== null && cur !== undefined && !cur.deleted && cur.version === op.expectedVersion;
      if (!ok) conflicts.push({ table: op.table, key: op.key, expectedVersion: op.expectedVersion, actualVersion: cur?.version ?? null, actualDeleted: cur?.deleted ?? null });
    }
    if (conflicts.length) throw new CloudConflictError(conflicts);

    // Phase 3 : refus possibles à l'écriture, dans l'ordre du lot (rien n'est encore appliqué)
    for (const [i, op] of changes.ops.entries()) {
      if (op.type !== 'put' || space.get(op.table)?.has(keyString(op.key))) continue;
      if (updateOnly(op.table as Exclude<TableName, 'meta'>)) bad('invalid_operation', `opération ${i} : création interdite pour cette table`);
      const owner = this.keyOwners.get(`${op.table}\u0000${keyString(op.key)}`);
      if (owner !== undefined && owner !== uid) bad('duplicate_key', `opération ${i} : clé déjà utilisée`);
    }

    // Application (tout ou rien)
    this.server.set(uid, space);
    const versions: VersionEntry[] = [];
    const txid = this.nextTxid++; // une transaction par lot : même sync_txid pour toutes ses lignes
    for (const op of changes.ops) {
      const table = space.get(op.table) ?? new Map<string, ServerEntry>();
      space.set(op.table, table);
      const k = keyString(op.key);
      const cur = table.get(k);
      const version = (cur?.version ?? 0) + 1;
      if (op.type === 'put') table.set(k, { row: structuredClone(op.row), version, deleted: false, txid });
      else table.set(k, { row: cur!.row, version, deleted: true, txid });
      this.keyOwners.set(`${op.table}\u0000${k}`, uid);
      versions.push({ table: op.table, key: structuredClone(op.key) as Key, version, deleted: op.type === 'delete' });
    }
    const result: CommitResult = { changesetId: changes.changesetId, status: 'applied', versions };
    this.lots.set(lotKey, { status: 'applied', fingerprint, result: structuredClone(result) });
    this.commits.push(structuredClone(changes));
    return result;
  }

  /** Lignes ACTIVES (non supprimées) d'un utilisateur pour une table. */
  rows(userId: ID, table: TableName): Record<string, unknown>[] {
    return [...(this.server.get(userId)?.get(table)?.values() ?? [])].filter((e) => !e.deleted).map((e) => structuredClone(e.row));
  }

  /** État serveur d'une clé (version, suppression), ou `undefined`. */
  entry(userId: ID, table: TableName, key: Key): { version: number; deleted: boolean; row: Record<string, unknown> } | undefined {
    const e = this.server.get(userId)?.get(table)?.get(keyString(key));
    return e && structuredClone(e);
  }

  /** Utilisateurs possédant au moins une ligne. */
  users(): ID[] {
    return [...this.server.keys()];
  }

  /**
   * Lignes SQL d'un utilisateur pour une table (V3.4-a), ACTIVES ET SUPPRIMÉES, au format
   * renvoyé par PostgREST pour `select=*` : colonnes du mapping (ligne convertie par
   * `serializeRow` ; date d'inscription du profil, seule colonne non modifiable, fixée par le
   * serveur) et métadonnées serveur. Métadonnées simulées : `sync_txid` = identifiant du lot
   * qui a écrit la ligne (V4.1), horodatages fixes à la microseconde comme PostgreSQL
   * (`REGISTERED_AT_SQL`).
   */
  sqlRows(userId: ID, table: CloudTableName): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const e of this.server.get(userId)?.get(table)?.values() ?? []) {
      const sql: Record<string, unknown> = { ...serializeRow(table, e.row).values };
      for (const column of sqlColumnsOf(table)) {
        if (column in sql) continue;
        // Colonne remplie par le serveur à l'inscription, jamais écrite par le client : valeur et
        // précision du serveur réel (une valeur envoyée par le client n'y est jamais reprise).
        if (table === 'users' && column === 'created_at') sql.created_at = REGISTERED_AT_SQL;
        else throw new Error(`MemoryTransport.sqlRows : colonne ${table}.${column} non simulée`);
      }
      sql.version = e.version;
      sql.sync_txid = String(e.txid);
      sql.server_updated_at = REGISTERED_AT_SQL;
      sql.deleted_at = e.deleted ? REGISTERED_AT_SQL : null;
      out.push(structuredClone(sql));
    }
    return out;
  }

  /**
   * Récupération des changements (V4.1), même contrat que `public.pull_changes` (migration 9) :
   * lignes de `userId`, actives et supprimées, telles que `cursor ≤ sync_txid < borne`, triées
   * par (sync_txid, table SQL, clé) en ordre d'octets, par pages de `limit` ; `next` permet de
   * reprendre dans le même intervalle (`bound`), nul quand l'intervalle est épuisé.
   */
  pull(userId: ID, params: { cursor?: unknown; bound?: unknown; after?: unknown; limit?: unknown }): PullResponse {
    const xmin = BigInt(this.nextTxid);
    const cursorText = params.cursor === undefined ? '0' : params.cursor;
    if (typeof cursorText !== 'string' || !XID_TEXT.test(cursorText)) throw new PullRequestError('p_cursor : entier xid8 en texte attendu');
    const cursor = BigInt(cursorText);
    let bound: bigint;
    if (params.bound === null || params.bound === undefined) {
      if (params.after !== null && params.after !== undefined) throw new PullRequestError('p_after exige p_bound (page suivante d’un même intervalle)');
      bound = xmin;
    } else {
      if (typeof params.bound !== 'string' || !XID_TEXT.test(params.bound)) throw new PullRequestError('p_bound : entier xid8 en texte attendu');
      bound = BigInt(params.bound);
      if (bound > xmin) throw new PullRequestError('p_bound : borne postérieure à la borne sûre actuelle');
    }
    if (cursor > bound) throw new PullRequestError('p_cursor supérieur à la borne');
    const limit = params.limit === undefined ? PULL_MAX_LIMIT : params.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > PULL_MAX_LIMIT) throw new PullRequestError('p_limit : entier de 1 à 1000 attendu');
    let after: { txid: bigint; table: string; key: string } | null = null;
    if (params.after !== null && params.after !== undefined) {
      const a = params.after as Record<string, unknown>;
      if (typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some((k) => !['txid', 'table', 'key'].includes(k))
          || typeof a.txid !== 'string' || typeof a.table !== 'string' || typeof a.key !== 'string' || !XID_TEXT.test(a.txid)) {
        throw new PullRequestError('p_after : { txid, table, key } attendu (valeur de next)');
      }
      after = { txid: BigInt(a.txid), table: a.table, key: a.key };
      if (after.txid < cursor || after.txid >= bound) throw new PullRequestError('p_after hors de l’intervalle [p_cursor, p_bound)');
    }
    const items: { s: bigint; t: string; k: string; key: Record<string, unknown>; row: Record<string, unknown> }[] = [];
    for (const table of Object.keys(MAPPING) as CloudTableName[]) {
      const spec = MAPPING[table];
      for (const row of this.sqlRows(userId, table)) {
        const s = BigInt(row.sync_txid as string);
        if (s < cursor || s >= bound) continue;
        const key = Object.fromEntries(spec.sqlKey.map((c) => [c, row[c]]));
        const k = spec.sqlTable === 'user_settings' ? String(row.user_id)
          : spec.sqlTable === 'recurring_occurrences' ? `${row.rule_id}|${row.due_date}` : String(row.id);
        items.push({ s, t: spec.sqlTable, k, key, row });
      }
    }
    const cmp = (x: { s: bigint; t: string; k: string }, y: { s: bigint; t: string; k: string }) =>
      x.s !== y.s ? (x.s < y.s ? -1 : 1) : x.t !== y.t ? (x.t < y.t ? -1 : 1) : x.k < y.k ? -1 : x.k > y.k ? 1 : 0;
    items.sort(cmp);
    const rest = after ? items.filter((i) => cmp(i, { s: after!.txid, t: after!.table, k: after!.key }) > 0) : items;
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    return structuredClone({
      bound: String(bound),
      rows: page.map((i) => ({ table: i.t, key: i.key, row: i.row })),
      next: rest.length > limit ? { txid: String(last.s), table: last.t, key: last.k } : null,
    });
  }

  /**
   * Source de lecture vue par la session de `uid` (V3.4-a) — même contrat que `HttpReadSource` :
   * RLS (lignes de `uid` seulement, actives et supprimées), filtre sur le propriétaire, tri
   * sur les colonnes demandées, pages, nombre total exact. L'utilisateur est inscrit au besoin
   * (profil créé, comme par le déclencheur d'inscription).
   */
  readSource(uid: ID): CloudReadSource {
    this.registerUser(uid);
    const visible = (q: ReadQuery) => {
      if (MAPPING[q.table]?.sqlTable !== q.sqlTable) throw new Error(`MemoryTransport.readSource : table incohérente (${q.table} / ${q.sqlTable})`);
      return orderSqlRows(
        this.sqlRows(uid, q.table).filter((r) => r[q.owner] === q.userId),
        q.order.map((column) => ({ column, ascending: true })),
      );
    };
    return {
      kind: 'memory',
      sessionUserId: async () => uid,
      page: async (q, offset, limit) => {
        const all = visible(q);
        return { rows: all.slice(offset, offset + limit), total: all.length };
      },
      count: async (q) => visible(q).length,
      pull: async (request) => {
        try {
          return this.pull(uid, request);
        } catch (e) {
          if (e instanceof PullRequestError) throw new CloudReadError('rejected', 'lecture refusée par le serveur (HTTP 400 PT400)', { status: 400, reason: 'PT400' });
          throw e;
        }
      },
    };
  }
}

/** Trie des lignes SQL sur les colonnes indiquées (valeurs comparées en texte, ordre stable). */
export function orderSqlRows(rows: Record<string, unknown>[], order: readonly { column: string; ascending: boolean }[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of order) {
      const x = String(a[column]);
      const y = String(b[column]);
      if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
    }
    return 0;
  });
}
