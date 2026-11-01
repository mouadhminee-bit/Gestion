/**
 * Transport des écritures cloud — protocole ChangeSet v1 (Lot 4, étape 4.3).
 *
 * `CloudStorage` regroupe les écritures d'une transaction en un `ChangeSet` (état final
 * par clé) et le soumet à un `CloudTransport`. Le cache local (lignes ET versions) n'est
 * modifié QUE si le transport confirme le lot par un `CommitResult` valide.
 *
 * Contrôle optimiste : chaque opération porte la version serveur que le client a vue
 * (`expectedVersion`). Le serveur refuse le lot ENTIER si une seule version ne correspond
 * pas (`CloudConflictError`) ; il n'y a jamais d'application partielle ni de fusion.
 *
 * Par défaut, toute écriture cloud est REFUSÉE (`DisabledTransport`). Aucun transport
 * réseau n'existe à ce stade : `apply_changeset` (Lot 4, étape 4.4) et le transport HTTP
 * (Lot 5) implémenteront ce même contrat. Le contrat complet est décrit dans
 * `docs/LOT4_PLAN.md` § 6.
 */
import type { ID } from '@/domain/types';
import type { Key } from '../storage';
import type { TableName } from '../tables';

/** Version du protocole des lots. */
export const CHANGESET_PROTOCOL = 1 as const;

/**
 * Convention de version (`expectedVersion`) — la dernière version serveur connue du client :
 *  - création d'une clé inconnue du serveur ............ `null` → version 1
 *  - modification d'une ligne active ................... v      → v + 1
 *  - suppression logique d'une ligne active ............ v      → v + 1 (supprimée)
 *  - réactivation (écriture d'une ligne supprimée) ..... v      → v + 1 (active)
 *  - rejeu d'un lot déjà accepté (même `changesetId`) .. aucune nouvelle version :
 *    le serveur renvoie le résultat d'origine (`status: 'replayed'`).
 */
export type ExpectedVersion = number | null;

export type ChangeOp =
  | { table: TableName; type: 'put'; key: Key; expectedVersion: ExpectedVersion; row: Record<string, unknown> }
  | { table: TableName; type: 'delete'; key: Key; expectedVersion: ExpectedVersion };

/** Lot d'écritures atomique : état final de chaque clé modifiée, dans l'ordre des écritures. */
export interface ChangeSet {
  protocol: typeof CHANGESET_PROTOCOL;
  /** UUID unique du lot, généré par le client ; clé d'idempotence côté serveur. */
  changesetId: string;
  /** Propriétaire logique (le serveur impose son propre utilisateur authentifié). */
  userId: ID;
  /** Au plus une opération par (table, clé). */
  ops: ChangeOp[];
}

/** Nouvelle version d'une clé après application, dans l'ordre des opérations du lot. */
export interface VersionEntry {
  table: TableName;
  key: Key;
  version: number;
  /** `true` si la ligne est supprimée logiquement après l'opération. */
  deleted: boolean;
}

/** Confirmation du serveur. */
export interface CommitResult {
  changesetId: string;
  /** `applied` : appliqué maintenant ; `replayed` : déjà appliqué, résultat d'origine renvoyé. */
  status: 'applied' | 'replayed';
  /** Une entrée par opération, dans le même ordre. */
  versions: VersionEntry[];
}

/** Réponse à la résolution d'un lot dont la confirmation n'a pas été reçue. */
export type ResolveResult = CommitResult | { changesetId: string; status: 'abandoned' };

export interface CloudTransport {
  /** Identifie l'implémentation (diagnostic). */
  readonly kind: string;
  /** Applique le lot de façon atomique côté serveur, ou échoue sans rien appliquer. */
  commit(changes: ChangeSet): Promise<CommitResult>;
  /**
   * Statut d'un lot envoyé sans confirmation reçue : s'il a été appliqué, renvoie son
   * résultat d'origine ; sinon le serveur le marque ABANDONNÉ — il ne sera jamais appliqué,
   * même s'il arrive plus tard — et renvoie `abandoned`.
   */
  resolve(changesetId: string, userId: ID): Promise<ResolveResult>;
}

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

/** Écritures cloud désactivées (mode par défaut). */
export class CloudWriteDisabledError extends Error {
  constructor() {
    super('Écriture cloud refusée : le mode cloud n’est pas activé.');
    this.name = 'CloudWriteDisabledError';
  }
}

/**
 * Échec du transport (réseau, réponse illisible…) : aucune écriture n'est conservée
 * localement. Le serveur a pu, ou non, appliquer le lot : `CloudStorage` le résout avant
 * toute nouvelle écriture (`CloudTransport.resolve`).
 */
export class CloudTransportError extends Error {
  constructor(public readonly cause: unknown) {
    super(`Écriture cloud non enregistrée : ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CloudTransportError';
  }
}

export interface VersionConflict {
  table: TableName;
  key: Key;
  expectedVersion: ExpectedVersion;
  /** Version serveur actuelle (`null` : clé inconnue du serveur). */
  actualVersion: number | null;
  actualDeleted: boolean | null;
}

/**
 * Conflit de version : au moins une ligne a changé sur le serveur depuis la dernière lecture.
 * Refus DÉFINITIF du lot entier : rien n'a été appliqué, ni sur le serveur ni dans le cache.
 * Les données doivent être rechargées (Lot 5) avant une nouvelle tentative.
 */
export class CloudConflictError extends Error {
  readonly definitive = true;
  constructor(public readonly conflicts: readonly VersionConflict[]) {
    super(`Conflit de version : ${conflicts.length} ligne(s) modifiée(s) entre-temps (${conflicts.map((c) => c.table).filter((t, i, a) => a.indexOf(t) === i).join(', ')}). Rechargez les données.`);
    this.name = 'CloudConflictError';
  }
}

export type CloudProtocolErrorCode = 'invalid_changeset' | 'changeset_id_reused' | 'changeset_abandoned' | 'unknown_changeset';

/** Lot refusé définitivement par le serveur (mal formé, identifiant réutilisé…) : rien n'est appliqué. */
export class CloudProtocolError extends Error {
  readonly definitive = true;
  constructor(
    public readonly code: CloudProtocolErrorCode,
    detail: string,
  ) {
    super(`Lot refusé (${code}) : ${detail}`);
    this.name = 'CloudProtocolError';
  }
}

/**
 * Lot ACCEPTÉ par le serveur, mais le cache local n'a pas pu être mis à jour (quota,
 * fermeture…). Le résultat est conservé et réappliqué avant toute nouvelle écriture.
 */
export class CloudCacheWriteError extends Error {
  constructor(public readonly cause: unknown) {
    super(`Écriture enregistrée sur le serveur, cache local non mis à jour : ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CloudCacheWriteError';
  }
}

/** Refus définitif du serveur (aucune résolution nécessaire). */
export function isDefinitiveRejection(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { definitive?: unknown }).definitive === true;
}

/** Refuse toute écriture. Transport par défaut de `CloudRepository`. */
export class DisabledTransport implements CloudTransport {
  readonly kind = 'disabled';
  async commit(): Promise<CommitResult> {
    throw new CloudWriteDisabledError();
  }
  async resolve(): Promise<ResolveResult> {
    throw new CloudWriteDisabledError();
  }
}

// ---------------------------------------------------------------------------
// Outils du protocole (partagés par le client et le serveur simulé)
// ---------------------------------------------------------------------------

/** Forme canonique d'une clé (comparaison, indexation). */
export const keyString = (key: Key): string => JSON.stringify(key);

function canonical(v: unknown): unknown {
  if (typeof Blob !== 'undefined' && v instanceof Blob) return { $blob: [v.size, v.type] };
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) if ((v as Record<string, unknown>)[k] !== undefined) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Empreinte du contenu d'un lot (clés triées) : détecte la réutilisation d'un `changesetId`. */
export function changesetFingerprint(changes: ChangeSet): string {
  return JSON.stringify(canonical({ protocol: changes.protocol, userId: changes.userId, ops: changes.ops }));
}

/**
 * Vérifie qu'un résultat confirme EXACTEMENT ce lot. Sinon la réponse est ambiguë et ne
 * vaut pas confirmation (le lot reste à résoudre).
 */
export function checkCommitResult(changes: ChangeSet, result: unknown): result is CommitResult {
  if (!result || typeof result !== 'object') return false;
  const r = result as CommitResult;
  if (r.changesetId !== changes.changesetId || (r.status !== 'applied' && r.status !== 'replayed') || !Array.isArray(r.versions) || r.versions.length !== changes.ops.length) return false;
  return changes.ops.every((op, i) => {
    const v = r.versions[i];
    return (
      !!v &&
      v.table === op.table &&
      keyString(v.key) === keyString(op.key) &&
      Number.isSafeInteger(v.version) &&
      v.version > (op.expectedVersion ?? 0) &&
      v.deleted === (op.type === 'delete')
    );
  });
}
