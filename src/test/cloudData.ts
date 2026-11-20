/**
 * Données Cloud de test (V3.4-a) — RÉSERVÉ AUX TESTS.
 *
 * Jeu de lignes valides couvrant les 18 tables synchronisées (profil créé à l'inscription,
 * paramètres et 14 tables de la démo, pièce jointe, lot d'import, état de notification),
 * écrit sur un `MemoryTransport` aligné par le protocole ChangeSet (comme un client réel).
 */
import { randomUUID } from 'node:crypto';
import { generateDemoData } from '@/data/demo';
import type { Key } from '@/data/storage';
import { PRIMARY_KEYS, type TableName } from '@/data/tables';
import type { MemoryTransport } from '@/data/cloud/MemoryTransport';
import type { CloudTableName } from '@/data/cloud/mapping';
import type { ChangeOp, ChangeSet, CommitResult } from '@/data/cloud/transport';

export const TODAY = '2026-03-15';
export const NOW = '2026-03-15T10:00:00.000Z';

export const keyOf = (table: TableName, row: Record<string, unknown>): Key => {
  const pk = PRIMARY_KEYS[table];
  return typeof pk === 'string' ? (row[pk] as string) : pk.map((f) => row[f] as string);
};
export const lot = (userId: string, ops: ChangeOp[]): ChangeSet => ({ protocol: 1, changesetId: randomUUID(), userId, ops });
export const put = (table: TableName, row: object, expectedVersion: number | null = null): ChangeOp => ({
  table,
  type: 'put',
  key: keyOf(table, row as Record<string, unknown>),
  expectedVersion,
  row: row as Record<string, unknown>,
});
export const del = (table: TableName, key: Key, expectedVersion: number): ChangeOp => ({ table, type: 'delete', key, expectedVersion });

/** Lignes d'import fictives (tables volumineuses : pagination). */
export function importBatches(uid: string, accountId: string, n: number, idOf: (i: number) => string = () => randomUUID()) {
  return Array.from({ length: n }, (_, i) => ({ id: idOf(i), userId: uid, fileName: `releve-${i}.csv`, createdAt: NOW, rowCount: 3, importedCount: 2, skippedCount: 1, accountId }));
}

export type Dataset = Partial<Record<Exclude<CloudTableName, 'users'>, Record<string, unknown>[]>>;

/** Données d'un utilisateur dans les 17 tables autres que le profil. */
export function dataset(uid: string): Dataset {
  const d = generateDemoData(uid, TODAY);
  const acc = d.accounts[0];
  const cat = d.categories[0];
  return {
    settings: [d.settings],
    accounts: d.accounts,
    categories: d.categories,
    transactions: d.transactions,
    attachments: [{ id: randomUUID(), userId: uid, name: 'recu.pdf', mimeType: 'application/pdf', size: 7, blob: new Blob(['CONTENU']), createdAt: NOW }],
    budgets: d.budgets,
    goals: d.goals,
    goalContributions: d.goalContributions,
    recurringRules: d.recurringRules,
    occurrences: d.occurrences,
    debts: d.debts,
    debtPayments: d.debtPayments,
    assets: d.assets,
    valuations: d.valuations,
    rates: d.rates,
    notificationStates: [{ id: `budget:${cat.id}:2026-03:90`, userId: uid, read: false, dismissed: false, updatedAt: NOW }],
    importBatches: importBatches(uid, acc.id, 2),
  } as unknown as Dataset;
}

/** Inscrit l'utilisateur puis écrit ses lignes par lots (≤ 5 000 opérations), comme un client. */
export async function seed(server: MemoryTransport, uid: string, data: Dataset = dataset(uid)): Promise<Dataset> {
  server.registerUser(uid);
  const ops = Object.entries(data).flatMap(([table, rows]) => (rows ?? []).map((r) => put(table as TableName, r)));
  for (let i = 0; i < ops.length; i += 5000) await server.as(uid).commit(lot(uid, ops.slice(i, i + 5000)));
  return data;
}

/** Écrit un lot pour `uid` (session de l'utilisateur) et renvoie la confirmation. */
export function commitAs(server: MemoryTransport, uid: string, ops: ChangeOp[]): Promise<CommitResult> {
  return server.as(uid).commit(lot(uid, ops));
}
