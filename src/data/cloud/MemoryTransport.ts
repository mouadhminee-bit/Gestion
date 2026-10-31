/**
 * Transport en mémoire — RÉSERVÉ AUX TESTS (jamais importé par l'application).
 *
 * Simule un serveur : les lignes sont partitionnées par utilisateur, chaque lot est
 * appliqué entièrement ou pas du tout, et une ligne appartenant à un autre utilisateur
 * est refusée (équivalent local de la clause `with check (user_id = auth.uid())` de la
 * RLS — la vraie RLS PostgreSQL sera testée au Lot 3).
 */
import type { ID } from '@/domain/types';
import type { TableName } from '../tables';
import type { ChangeSet, CloudTransport } from './transport';

export class IsolationViolationError extends Error {
  constructor(table: string, owner: unknown, userId: ID) {
    super(`Ligne ${table} attribuée à « ${String(owner)} » refusée pour l’utilisateur « ${userId} ».`);
    this.name = 'IsolationViolationError';
  }
}

/** Propriétaire déclaré d'une ligne (`meta` n'en a pas : partitionnée par lot). */
function ownerOf(table: TableName, row: Record<string, unknown>): unknown {
  if (table === 'meta') return undefined;
  if (table === 'users') return row.id;
  return row.userId;
}

export class MemoryTransport implements CloudTransport {
  readonly kind = 'memory';
  /** userId → table → clé sérialisée → ligne. */
  private readonly server = new Map<ID, Map<TableName, Map<string, Record<string, unknown>>>>();
  readonly commits: ChangeSet[] = [];
  /** Erreur à lever au prochain `commit` (simulation d'échec réseau / serveur). */
  failNext: Error | null = null;
  /** Échec conditionnel (ex. sur une table donnée). */
  failWhen: ((changes: ChangeSet) => Error | null) | null = null;

  async commit(changes: ChangeSet): Promise<void> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const conditional = this.failWhen?.(changes);
    if (conditional) throw conditional;
    // Validation complète AVANT application : tout ou rien.
    for (const op of changes.ops) {
      if (op.type !== 'put') continue;
      const owner = ownerOf(op.table, op.row);
      if (op.table !== 'meta' && owner !== changes.userId) throw new IsolationViolationError(op.table, owner, changes.userId);
    }
    const space = this.server.get(changes.userId) ?? new Map();
    this.server.set(changes.userId, space);
    for (const op of changes.ops) {
      const table = space.get(op.table) ?? new Map();
      space.set(op.table, table);
      const k = JSON.stringify(op.key);
      if (op.type === 'put') table.set(k, structuredClone(op.row));
      else table.delete(k);
    }
    this.commits.push(structuredClone(changes));
  }

  /** Lignes « serveur » d'un utilisateur pour une table. */
  rows(userId: ID, table: TableName): Record<string, unknown>[] {
    return [...(this.server.get(userId)?.get(table)?.values() ?? [])].map((r) => structuredClone(r));
  }

  /** Utilisateurs possédant au moins une ligne. */
  users(): ID[] {
    return [...this.server.keys()];
  }
}
