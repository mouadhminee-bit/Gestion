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
 */
import type { ID } from '@/domain/types';
import type { Key } from '../storage';
import { ALL_TABLES, PRIMARY_KEYS, type TableName } from '../tables';
import { EXCLUDED_TABLES } from './mapping';
import {
  CHANGESET_PROTOCOL,
  CloudConflictError,
  CloudProtocolError,
  changesetFingerprint,
  keyString,
  type ChangeSet,
  type CloudTransport,
  type CommitResult,
  type ResolveResult,
  type VersionConflict,
  type VersionEntry,
} from './transport';

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
  /** userId → table → clé canonique → ligne versionnée. */
  private readonly server = new Map<ID, Map<TableName, Map<string, ServerEntry>>>();
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
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const conditional = this.failWhen?.(changes);
    if (conditional) throw conditional;
    const result = this.apply(changes);
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

  async resolve(changesetId: string, userId: ID): Promise<ResolveResult> {
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
