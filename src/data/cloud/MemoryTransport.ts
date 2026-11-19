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
 * ALIGNEMENT SUR LE SERVEUR (P15, V3.3) — comportement PAR DÉFAUT, identique à
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
 *  - `changeset_pending` simulable (`pendingResolveNext`).
 * Non modélisé (propre à PostgreSQL) : types et contraintes métier des colonnes (CHECK, clés
 * étrangères), taille en octets, concurrence réelle.
 *
 * Mode `legacy` (option) : comportement d'avant V3.3, conservé À L'IDENTIQUE pour les suites
 * écrites avant le chargement initial (V3.4) — elles créent le profil par un premier lot et
 * utilisent des identifiants fictifs non canoniques. À retirer quand elles seront migrées.
 */
import type { ID } from '@/domain/types';
import type { Key } from '../storage';
import { ALL_TABLES, PRIMARY_KEYS, type TableName } from '../tables';
import { EXCLUDED_TABLES, MAPPING, assertNoServerMetadata, fromSqlKey, toSqlKey } from './mapping';
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

export interface MemoryTransportOptions {
  /**
   * Comportement d'avant V3.3 (non aligné sur le serveur) : identifiants de lot globaux,
   * profil créé par un lot, clés non canoniques admises, `invalid_changeset` générique,
   * `IsolationViolationError`. Réservé aux suites antérieures à V3.4.
   */
  legacy?: boolean;
}

/** Limite du nombre d'opérations d'un lot (identique à la migration 8). */
const MAX_OPS = 5000;
/** Date d'inscription fictive des profils créés par `registerUser`. */
export const REGISTERED_AT = '2026-01-01T00:00:00.000Z';
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

export class IsolationViolationError extends Error {
  /** Refus définitif (RLS) : rien n'a été appliqué, aucune résolution nécessaire. */
  readonly definitive = true;
  constructor(table: string, owner: unknown, userId: ID) {
    super(`Ligne ${table} attribuée à « ${String(owner)} » refusée pour l’utilisateur « ${userId} ».`);
    this.name = 'IsolationViolationError';
  }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ServerEntry {
  row: Record<string, unknown>;
  version: number;
  deleted: boolean;
}

interface Processed {
  userId: ID;
  fingerprint: string;
  result: CommitResult;
}

export class MemoryTransport implements CloudTransport {
  readonly kind = 'memory';
  /** Comportement d'avant V3.3 (voir `MemoryTransportOptions`). */
  readonly legacy: boolean;
  constructor(options: MemoryTransportOptions = {}) {
    this.legacy = options.legacy === true;
  }
  /** userId → table → clé canonique → ligne versionnée. */
  private readonly server = new Map<ID, Map<TableName, Map<string, ServerEntry>>>();
  /** Mode aligné : lots par utilisateur (`uid␀changesetId`), appliqués ou abandonnés. */
  private readonly lots = new Map<string, { status: 'applied' | 'abandoned'; fingerprint?: string; result?: CommitResult }>();
  /** Mode aligné : propriétaire de chaque clé existante (clés primaires globales). */
  private readonly keyOwners = new Map<string, ID>();
  /** Mode aligné : prochain `resolve` → le lot est encore « en cours » (`changeset_pending`). */
  pendingResolveNext = false;
  /** Lots acceptés (idempotence), par `changesetId`. */
  private readonly processed = new Map<string, Processed>();
  /** Lots abandonnés lors d'une résolution : ne seront jamais appliqués. */
  private readonly abandoned = new Map<string, ID>();
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

  async commit(changes: ChangeSet): Promise<CommitResult> {
    return this.commitFor(this.legacy ? null : typeof changes?.userId === 'string' ? changes.userId : '', changes);
  }

  async resolve(changesetId: string, userId: ID): Promise<ResolveResult> {
    if (this.legacy) return this.resolveLegacy(changesetId, userId);
    return this.resolveFor(userId, changesetId, userId);
  }

  /**
   * Vue « session » (mode aligné) : les lots et résolutions sont soumis au nom de `uid`,
   * comme par un client authentifié. L'utilisateur est inscrit (profil créé) au besoin.
   */
  as(uid: ID): CloudTransport {
    if (this.legacy) throw new Error('MemoryTransport.as() : réservé au mode aligné sur le serveur');
    this.registerUser(uid);
    return {
      kind: 'memory',
      commit: (changes) => this.commitFor(uid, changes),
      resolve: (changesetId, userId) => this.resolveFor(uid, changesetId, userId),
    };
  }

  /** Mode aligné : inscription (déclencheur `handle_new_user`) — profil créé en version 1. */
  registerUser(uid: ID, displayName = ''): void {
    if (this.legacy || this.keyOwners.has(`users\u0000${keyString(uid)}`)) return;
    const space = this.server.get(uid) ?? new Map<TableName, Map<string, ServerEntry>>();
    this.server.set(uid, space);
    const users = space.get('users') ?? new Map<string, ServerEntry>();
    space.set('users', users);
    users.set(keyString(uid), { row: { id: uid, displayName, createdAt: REGISTERED_AT }, version: 1, deleted: false });
    this.keyOwners.set(`users\u0000${keyString(uid)}`, uid);
  }

  private async commitFor(uid: ID | null, changes: ChangeSet): Promise<CommitResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const conditional = this.failWhen?.(changes);
    if (conditional) throw conditional;
    const result = uid === null ? this.apply(changes) : this.applyAligned(uid, changes);
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

  /** Mode aligné : résolution dans le périmètre de l'utilisateur authentifié. */
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
   * Mode aligné : contrôles dans l'ordre de `apply_changeset` (enveloppe, identité, taille,
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
    for (const op of changes.ops) {
      const table = space.get(op.table) ?? new Map<string, ServerEntry>();
      space.set(op.table, table);
      const k = keyString(op.key);
      const cur = table.get(k);
      const version = (cur?.version ?? 0) + 1;
      if (op.type === 'put') table.set(k, { row: structuredClone(op.row), version, deleted: false });
      else table.set(k, { row: cur!.row, version, deleted: true });
      this.keyOwners.set(`${op.table}\u0000${k}`, uid);
      versions.push({ table: op.table, key: structuredClone(op.key) as Key, version, deleted: op.type === 'delete' });
    }
    const result: CommitResult = { changesetId: changes.changesetId, status: 'applied', versions };
    this.lots.set(lotKey, { status: 'applied', fingerprint, result: structuredClone(result) });
    this.commits.push(structuredClone(changes));
    return result;
  }

  private async resolveLegacy(changesetId: string, userId: ID): Promise<ResolveResult> {
    if (this.resolveFailure) throw this.resolveFailure;
    const done = this.processed.get(changesetId);
    if (done) {
      if (done.userId !== userId) throw new CloudProtocolError('unknown_changeset', 'lot inconnu pour cet utilisateur');
      return { ...structuredClone(done.result), status: 'replayed' };
    }
    const owner = this.abandoned.get(changesetId);
    if (owner !== undefined && owner !== userId) throw new CloudProtocolError('unknown_changeset', 'lot inconnu pour cet utilisateur');
    this.abandoned.set(changesetId, userId);
    return { changesetId, status: 'abandoned' };
  }

  /** Validation complète, puis application tout ou rien. */
  private apply(changes: ChangeSet): CommitResult {
    this.validateShape(changes);
    const fingerprint = changesetFingerprint(changes);
    const done = this.processed.get(changes.changesetId);
    if (done) {
      if (done.userId !== changes.userId || done.fingerprint !== fingerprint) throw new CloudProtocolError('changeset_id_reused', 'identifiant de lot déjà utilisé pour un autre contenu');
      return { ...structuredClone(done.result), status: 'replayed' };
    }
    if (this.abandoned.has(changes.changesetId)) throw new CloudProtocolError('changeset_abandoned', 'lot abandonné lors d’une résolution : jamais appliqué');

    for (const op of changes.ops) {
      if (op.type !== 'put') continue;
      const owner = ownerOf(op.table, op.row);
      if (owner !== changes.userId) throw new IsolationViolationError(op.table, owner, changes.userId);
    }

    const space = this.server.get(changes.userId) ?? new Map<TableName, Map<string, ServerEntry>>();
    const conflicts: VersionConflict[] = [];
    for (const op of changes.ops) {
      const cur = space.get(op.table)?.get(keyString(op.key));
      const ok =
        op.type === 'put'
          ? op.expectedVersion === null
            ? cur === undefined // création : la clé ne doit pas exister (même supprimée)
            : cur !== undefined && cur.version === op.expectedVersion // modification ou réactivation
          : op.expectedVersion !== null && cur !== undefined && !cur.deleted && cur.version === op.expectedVersion; // suppression d'une ligne active
      if (!ok) conflicts.push({ table: op.table, key: op.key, expectedVersion: op.expectedVersion, actualVersion: cur?.version ?? null, actualDeleted: cur?.deleted ?? null });
    }
    if (conflicts.length) throw new CloudConflictError(conflicts);

    // Application (aucune erreur possible au-delà de ce point : tout ou rien).
    this.server.set(changes.userId, space);
    const versions: VersionEntry[] = [];
    for (const op of changes.ops) {
      const table = space.get(op.table) ?? new Map<string, ServerEntry>();
      space.set(op.table, table);
      const k = keyString(op.key);
      const cur = table.get(k);
      const version = (cur?.version ?? 0) + 1;
      if (op.type === 'put') table.set(k, { row: structuredClone(op.row), version, deleted: false });
      else table.set(k, { row: cur!.row, version, deleted: true });
      versions.push({ table: op.table, key: structuredClone(op.key) as Key, version, deleted: op.type === 'delete' });
    }
    const result: CommitResult = { changesetId: changes.changesetId, status: 'applied', versions };
    this.processed.set(changes.changesetId, { userId: changes.userId, fingerprint, result: structuredClone(result) });
    this.commits.push(structuredClone(changes));
    return result;
  }

  private validateShape(changes: ChangeSet): void {
    const bad = (detail: string): never => {
      throw new CloudProtocolError('invalid_changeset', detail);
    };
    if (!changes || changes.protocol !== CHANGESET_PROTOCOL) bad('protocole inconnu');
    if (typeof changes.changesetId !== 'string' || !UUID_RE.test(changes.changesetId)) bad('changesetId : UUID attendu');
    if (typeof changes.userId !== 'string' || !changes.userId) bad('userId manquant');
    if (!Array.isArray(changes.ops) || !changes.ops.length) bad('lot vide');
    const seen = new Set<string>();
    for (const op of changes.ops) {
      if (!(ALL_TABLES as readonly string[]).includes(op.table)) bad(`table inconnue : ${String(op.table)}`);
      // Tables locales (`EXCLUDED_TABLES` du mapping, ex. `meta`) : inconnues du serveur.
      if (Object.prototype.hasOwnProperty.call(EXCLUDED_TABLES, op.table)) bad(`table locale, exclue du protocole cloud : ${op.table}`);
      if (op.type !== 'put' && op.type !== 'delete') bad('type d’opération inconnu');
      if (op.expectedVersion !== null && !(Number.isSafeInteger(op.expectedVersion) && op.expectedVersion >= 1)) bad('expectedVersion : entier ≥ 1 ou null');
      const k = `${op.table}\u0000${keyString(op.key)}`;
      if (seen.has(k)) bad('deux opérations sur la même clé');
      seen.add(k);
      if (op.type === 'put') {
        if (!op.row || typeof op.row !== 'object') bad('ligne manquante');
        if (keyString(keyOfRow(op.table, op.row)) !== keyString(op.key)) bad('clé incohérente avec la ligne');
      } else if ('row' in op) bad('une suppression ne transporte pas de ligne');
    }
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
}
