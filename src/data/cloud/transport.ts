/**
 * Transport des écritures cloud.
 *
 * `CloudStorage` regroupe les écritures d'une transaction en un `ChangeSet` (état final
 * par clé) et le soumet à un `CloudTransport`. Le cache local n'est modifié QUE si le
 * transport accepte le lot.
 *
 * Par défaut, toute écriture cloud est REFUSÉE (`DisabledTransport`). Aucun transport
 * réseau (Supabase) n'existe à ce stade : il sera ajouté au Lot 5, après le schéma
 * (Lot 3) et la fonction serveur `apply_changeset` (Lot 4).
 */
import type { ID } from '@/domain/types';
import type { Key } from '../storage';
import type { TableName } from '../tables';

export type ChangeOp =
  | { table: TableName; type: 'put'; key: Key; row: Record<string, unknown> }
  | { table: TableName; type: 'delete'; key: Key };

/** Lot d'écritures atomique : état final de chaque clé modifiée, dans l'ordre des écritures. */
export interface ChangeSet {
  userId: ID;
  ops: ChangeOp[];
}

export interface CloudTransport {
  /** Identifie l'implémentation (diagnostic). */
  readonly kind: string;
  /** Applique le lot de façon atomique côté serveur, ou échoue sans rien appliquer. */
  commit(changes: ChangeSet): Promise<void>;
}

/** Écritures cloud désactivées (mode par défaut). */
export class CloudWriteDisabledError extends Error {
  constructor() {
    super('Écriture cloud refusée : le mode cloud n’est pas activé.');
    this.name = 'CloudWriteDisabledError';
  }
}

/** Échec du transport (réseau, refus serveur…) : aucune écriture n'a été conservée. */
export class CloudTransportError extends Error {
  constructor(public readonly cause: unknown) {
    super(`Écriture cloud non enregistrée : ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CloudTransportError';
  }
}

/** Refuse toute écriture. Transport par défaut de `CloudRepository`. */
export class DisabledTransport implements CloudTransport {
  readonly kind = 'disabled';
  async commit(): Promise<void> {
    throw new CloudWriteDisabledError();
  }
}
