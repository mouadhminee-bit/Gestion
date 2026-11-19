/**
 * Transport HTTP du protocole ChangeSet v1 (Plan directeur V1, V3.3).
 *
 * Implémente `CloudTransport` (contrat de `transport.ts`) par les deux fonctions de la
 * migration 8, appelées avec le client Supabase de l'application :
 *  - `commit`  → `POST /rest/v1/rpc/apply_changeset`  `{ p_changeset }` ;
 *  - `resolve` → `POST /rest/v1/rpc/resolve_changeset` `{ p_changeset_id }`.
 *
 * Identité : le SDK joint le jeton de la SESSION COURANTE (`Authorization: Bearer …`, avec la
 * clé publique en `apikey`) ; aucune clé `service_role`, aucun jeton manipulé ici. Sans
 * session, ou si le lot est attribué à un autre utilisateur, rien n'est envoyé.
 *
 * Format filaire (docs/LOT4_PLAN.md § 7.2) : noms SQL, clés SQL et lignes converties par le
 * mapping (`serializeRow`) — les champs locaux (fichier d'une pièce jointe, P19) ne quittent
 * jamais l'appareil. Les réponses sont reconverties en noms et clés TS ; `CloudStorage`
 * vérifie ensuite qu'elles confirment exactement le lot (`checkCommitResult`).
 *
 * Erreurs (docs/LOT4_PLAN.md § 7.7) — aucune n'est transformée en succès :
 *  - `version_conflict` → `CloudConflictError` (conflits reconvertis : table, clé, versions) ;
 *  - autres codes du protocole, refus d'authentification, contraintes, autres 4xx →
 *    `CloudProtocolError` (refus définitif : le serveur a tout annulé) ;
 *  - `invalid_row` d'origine passagère (verrou, ressources, délai : P20) et HTTP 429 →
 *    `CloudTransientRejectionError` (refusé, rien appliqué, soumissible à nouveau) ;
 *  - réseau, délai dépassé, 5xx, `changeset_pending`, réponse illisible ou inattendue →
 *    `CloudTransportError` : issue INCONNUE, le lot est résolu ensuite par `CloudStorage`.
 * Aucune nouvelle tentative automatique (`retry(false)`) ; chaque appel est borné par un délai.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ID } from '@/domain/types';
import { MappingError, fromSqlKey, serializeRow, sqlTableOf, tableOfSql, toSqlKey, type MappingErrorCode, type SqlRow } from './mapping';
import {
  CloudConflictError,
  CloudProtocolError,
  CloudTransientRejectionError,
  CloudTransportError,
  type ChangeSet,
  type CloudProtocolErrorCode,
  type CloudTransport,
  type CommitResult,
  type ResolveResult,
  type VersionConflict,
  type VersionEntry,
} from './transport';

/** Délai maximal d'un appel (au-delà : issue inconnue, lot résolu ensuite). */
export const HTTP_TIMEOUT_MS = 30_000;

/** Partie du client Supabase utilisée : la session (lue localement) et l'appel de fonction. */
export type RpcClient = Pick<SupabaseClient, 'rpc' | 'auth'>;

/** Opération au format filaire (noms et clés SQL). */
export type WireOp =
  | { table: string; type: 'put'; key: SqlRow; expectedVersion: number | null; row: SqlRow }
  | { table: string; type: 'delete'; key: SqlRow; expectedVersion: number | null };

export interface WireChangeSet {
  protocol: number;
  changesetId: string;
  userId: ID;
  ops: WireOp[];
}

/** Codes du protocole renvoyés dans `message` par `private.changeset_error` (hors conflit et attente). */
const PROTOCOL_CODES = new Set<CloudProtocolErrorCode>([
  'unauthorized',
  'unsupported_protocol',
  'invalid_changeset',
  'unsupported_table',
  'invalid_operation',
  'invalid_key',
  'invalid_row',
  'duplicate_key',
  'changeset_too_large',
  'changeset_id_reused',
  'changeset_abandoned',
]);

/**
 * SQLSTATE d'une erreur passagère (P20) : classes 08 (connexion), 40 (sérialisation,
 * interblocage), 53 (ressources), 58 (système) ; verrou indisponible, objet en cours
 * d'utilisation, requête annulée (délai), arrêt du serveur.
 */
export function isTransientSqlstate(s: unknown): s is string {
  return typeof s === 'string' && (/^(08|40|53|58)[0-9A-Z]{3}$/.test(s) || ['55P03', '55006', '57014', '57P01', '57P02', '57P03'].includes(s));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function ambiguous(reason: string): CloudTransportError {
  return new CloudTransportError(new Error(`${reason} : issue inconnue, le lot sera résolu`));
}

// ---------------------------------------------------------------------------------------------
// Aller : ChangeSet (TS) → format filaire (SQL)
// ---------------------------------------------------------------------------------------------

function refusedBeforeSending(code: CloudProtocolErrorCode, e: MappingError): CloudProtocolError {
  return new CloudProtocolError(code, `${e.message} (aucune requête envoyée)`);
}

const ROW_CODE: Readonly<Partial<Record<MappingErrorCode, CloudProtocolErrorCode>>> = {
  unknown_table: 'unsupported_table',
  excluded_table: 'unsupported_table',
  key_mismatch: 'invalid_key',
  owner_mismatch: 'unauthorized',
};

/** Convertit un lot au format filaire ; une ligne ou une clé invalide est refusée AVANT l'envoi. */
export function toWireChangeSet(changes: ChangeSet): WireChangeSet {
  const ops = changes.ops.map((op): WireOp => {
    let table: string;
    let key: SqlRow;
    try {
      table = sqlTableOf(op.table);
    } catch (e) {
      if (e instanceof MappingError) throw refusedBeforeSending('unsupported_table', e);
      throw e;
    }
    try {
      key = toSqlKey(op.table, op.key);
    } catch (e) {
      if (e instanceof MappingError) throw refusedBeforeSending('invalid_key', e);
      throw e;
    }
    if (op.type === 'delete') return { table, type: 'delete', key, expectedVersion: op.expectedVersion };
    try {
      const s = serializeRow(op.table, op.row, { userId: changes.userId });
      if (JSON.stringify(s.key) !== JSON.stringify(key)) throw new MappingError('key_mismatch', op.table, null, 'clé incohérente avec la ligne');
      return { table, type: 'put', key, expectedVersion: op.expectedVersion, row: s.values };
    } catch (e) {
      if (e instanceof MappingError) throw refusedBeforeSending(ROW_CODE[e.code] ?? 'invalid_row', e);
      throw e;
    }
  });
  return { protocol: changes.protocol, changesetId: changes.changesetId, userId: changes.userId, ops };
}

// ---------------------------------------------------------------------------------------------
// Retour : réponses et erreurs (SQL → TS)
// ---------------------------------------------------------------------------------------------

/** Confirmation au format filaire → `CommitResult` (noms et clés TS). Réponse inattendue → issue inconnue. */
export function fromWireResult(data: unknown, allowed: readonly ('applied' | 'replayed')[]): CommitResult {
  if (!isObject(data) || typeof data.changesetId !== 'string' || !allowed.includes(data.status as 'applied') || !Array.isArray(data.versions)) {
    throw ambiguous('réponse du serveur inattendue');
  }
  try {
    const versions = data.versions.map((v): VersionEntry => {
      if (!isObject(v) || typeof v.table !== 'string' || !isObject(v.key) || !Number.isSafeInteger(v.version) || typeof v.deleted !== 'boolean') throw new Error('version illisible');
      const table = tableOfSql(v.table);
      return { table, key: fromSqlKey(table, v.key), version: v.version as number, deleted: v.deleted };
    });
    return { changesetId: data.changesetId, status: data.status as CommitResult['status'], versions };
  } catch {
    throw ambiguous('confirmation du serveur illisible');
  }
}

function parseDetails(details: unknown): Record<string, unknown> | null {
  if (isObject(details)) return details;
  if (typeof details !== 'string' || !details) return null;
  try {
    const parsed: unknown = JSON.parse(details);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Conflits renvoyés par le serveur, reconvertis (entrées illisibles ignorées). */
function parseConflicts(details: Record<string, unknown> | null): VersionConflict[] {
  const list = Array.isArray(details?.conflicts) ? details.conflicts : [];
  const out: VersionConflict[] = [];
  for (const c of list) {
    if (!isObject(c) || typeof c.table !== 'string' || !isObject(c.key)) continue;
    try {
      const table = tableOfSql(c.table);
      out.push({
        table,
        key: fromSqlKey(table, c.key),
        expectedVersion: Number.isSafeInteger(c.expectedVersion) ? (c.expectedVersion as number) : null,
        actualVersion: Number.isSafeInteger(c.actualVersion) ? (c.actualVersion as number) : null,
        actualDeleted: typeof c.actualDeleted === 'boolean' ? c.actualDeleted : null,
      });
    } catch {
      /* entrée illisible : ignorée, le refus reste un conflit */
    }
  }
  return out;
}

/** Résumé des détails d'un refus (motif, opération, table) — jamais de valeur métier. */
function summary(details: Record<string, unknown> | null): string {
  if (!details) return 'refusé par le serveur';
  const parts = ['reason', 'op', 'table', 'sqlstate', 'constraint'].filter((k) => details[k] !== undefined && details[k] !== null).map((k) => `${k}=${String(details[k]).slice(0, 80)}`);
  return parts.length ? parts.join(', ') : 'refusé par le serveur';
}

interface RpcError {
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  code?: unknown;
}

/** Erreur d'appel → erreur du contrat `CloudTransport`. */
export function classifyRpcError(status: number, error: RpcError, timeoutMs = HTTP_TIMEOUT_MS): Error {
  const message = typeof error.message === 'string' ? error.message : '';
  const sqlstate = typeof error.code === 'string' ? error.code : '';
  if (status === 0) {
    const aborted = /abort|timeout/i.test(`${message} ${typeof error.hint === 'string' ? error.hint : ''}`);
    return ambiguous(aborted ? `délai dépassé (${timeoutMs} ms)` : `échec réseau (${message.slice(0, 120)})`);
  }
  if (status >= 200 && status < 300) return ambiguous(`réponse illisible (HTTP ${status})`);
  if (status >= 500 || status === 408) return ambiguous(`erreur du serveur (HTTP ${status})`);
  const details = parseDetails(error.details);
  if (message === 'version_conflict') return new CloudConflictError(parseConflicts(details));
  if (message === 'changeset_pending') return ambiguous('changeset_pending : lot encore en cours de traitement');
  if (message === 'invalid_row' && isTransientSqlstate(details?.sqlstate)) return new CloudTransientRejectionError('invalid_row', details.sqlstate, summary(details));
  if (PROTOCOL_CODES.has(message as CloudProtocolErrorCode)) return new CloudProtocolError(message as CloudProtocolErrorCode, summary(details));
  // Contraintes différées vérifiées à la validation (SQLSTATE natifs, § 7.7).
  if (['23503', '23502', '23514'].includes(sqlstate)) return new CloudProtocolError('invalid_row', `contrainte ${sqlstate} (HTTP ${status})`);
  if (['23505', '23P01'].includes(sqlstate)) return new CloudProtocolError('duplicate_key', `contrainte ${sqlstate} (HTTP ${status})`);
  if (status === 401 || status === 403 || sqlstate === '42501' || /^PGRST30\d$/.test(sqlstate)) return new CloudProtocolError('unauthorized', `session refusée par le serveur (HTTP ${status}${sqlstate ? ` ${sqlstate}` : ''})`);
  if (status === 429) return new CloudTransientRejectionError('HTTP 429', null, 'limite de débit atteinte');
  if (isTransientSqlstate(sqlstate)) return new CloudTransientRejectionError(`HTTP ${status}`, sqlstate, 'erreur passagère du serveur');
  return new CloudProtocolError('rejected', `HTTP ${status}${sqlstate ? ` ${sqlstate}` : ''}`);
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

export class HttpTransport implements CloudTransport {
  readonly kind = 'http';

  constructor(
    private readonly client: RpcClient,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? HTTP_TIMEOUT_MS;
  }

  /** Utilisateur de la session courante ; sans session, refus AVANT tout envoi. */
  private async sessionUser(expected: ID): Promise<void> {
    let uid: string | undefined;
    try {
      const { data } = await this.client.auth.getSession();
      uid = data.session?.access_token ? data.session.user?.id : undefined;
    } catch {
      uid = undefined;
    }
    if (!uid) throw new CloudProtocolError('unauthorized', 'aucune session active : connexion requise (aucune requête envoyée)');
    if (uid !== expected) throw new CloudProtocolError('unauthorized', 'lot attribué à un autre utilisateur que la session (aucune requête envoyée)');
  }

  /** Un seul appel, sans nouvelle tentative, borné par un délai. */
  private async call(fn: 'apply_changeset' | 'resolve_changeset', args: Record<string, unknown>): Promise<unknown> {
    let res: { data: unknown; error: RpcError | null; status: number };
    try {
      res = await this.client.rpc(fn, args).retry(false).abortSignal(AbortSignal.timeout(this.timeoutMs));
    } catch (e) {
      throw new CloudTransportError(e);
    }
    if (res.error) throw classifyRpcError(res.status, res.error, this.timeoutMs);
    if (res.status < 200 || res.status >= 300) throw ambiguous(`statut HTTP ${res.status} inattendu`);
    return res.data;
  }

  async commit(changes: ChangeSet): Promise<CommitResult> {
    await this.sessionUser(changes.userId);
    const wire = toWireChangeSet(changes);
    const data = await this.call('apply_changeset', { p_changeset: wire });
    return fromWireResult(data, ['applied', 'replayed']);
  }

  async resolve(changesetId: string, userId: ID): Promise<ResolveResult> {
    await this.sessionUser(userId);
    const data = await this.call('resolve_changeset', { p_changeset_id: changesetId });
    if (isObject(data) && data.status === 'abandoned') {
      if (typeof data.changesetId !== 'string') throw ambiguous('réponse de résolution inattendue');
      return { changesetId: data.changesetId, status: 'abandoned' };
    }
    return fromWireResult(data, ['replayed']);
  }
}
