/**
 * Protocole ChangeSet v1 : contrôle optimiste, idempotence, atomicité du cache
 * (Lot 4, étape 4.3).
 *
 * Uniquement fake-indexeddb, des utilisateurs fictifs et le serveur simulé
 * (`MemoryTransport`). Chaque « appareil » a sa propre fabrique IndexedDB : deux bases
 * `nexora-cache-<uid>` distinctes pour un même utilisateur, comme sur deux appareils.
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { CloudRepository } from './CloudRepository';
import { CloudCacheDB, SERVER_VERSIONS_TABLE } from './CloudCacheDB';
import { CloudStorage, cloudCacheName } from './CloudStorage';
import { MemoryTransport } from './MemoryTransport';
import {
  CHANGESET_PROTOCOL,
  CloudCacheWriteError,
  CloudConflictError,
  CloudProtocolError,
  CloudTransportError,
  CloudWriteDisabledError,
  DisabledTransport,
  checkCommitResult,
  keyString,
  type ChangeSet,
  type CloudTransport,
  type CommitResult,
} from './transport';
import { ALL_TABLES, USER_TABLES, type TableName } from '../tables';
import { EXCLUDED_TABLES } from './mapping';
import { REPOSITORY_METHODS, type NexoraRepository } from '../contracts';
import type { Account } from '@/domain/types';

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

let n = 0;
const uid = () => `proto_${++n}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Un appareil : sa propre base IndexedDB (fabrique distincte), son repository cloud. */
function device(userId: string, transport: CloudTransport, factory = new IDBFactory()) {
  const cache = new CloudCacheDB(cloudCacheName(userId), { userId, dexie: { indexedDB: factory, IDBKeyRange } });
  const repo = new CloudRepository(userId, { transport, cache });
  const storage = Reflect.get(repo, 'store') as CloudStorage;
  return { repo, cache, storage, factory };
}

/** Simule une récupération complète (Lot 5) : copie lignes ET versions d'un cache à l'autre. */
async function pull(from: CloudCacheDB, to: CloudCacheDB) {
  for (const t of [...ALL_TABLES, SERVER_VERSIONS_TABLE]) {
    const rows = await from.table(t).toArray();
    await to.table(t).clear();
    await to.table(t).bulkPut(rows);
  }
}

async function dumpCache(cache: CloudCacheDB) {
  const out: Record<string, unknown[]> = {};
  for (const t of [...ALL_TABLES, SERVER_VERSIONS_TABLE]) out[t] = await cache.table(t).toArray();
  return out;
}

const account = (name: string): Omit<Account, 'id' | 'userId' | 'createdAt' | 'updatedAt'> => ({
  name,
  type: 'bank',
  currency: 'MAD',
  initialBalance: 0,
  initialBalanceDate: '2026-01-01',
  archived: false,
  includeInTotal: true,
  color: '#000',
  order: 0,
});

const goalInput = { name: 'G', targetAmount: 100000, currency: 'MAD', savedAmount: 0, priority: 'low' as const, trackLinkedAccount: false, status: 'active' as const, icon: 'X', color: '#fff' };

/** Transport dont les `commit` attendent un signal : force l'entrelacement de deux écritures. */
function gated(inner: MemoryTransport) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let waiting = 0;
  const t: CloudTransport = {
    kind: 'gated',
    commit: async (c) => {
      waiting++;
      await gate;
      return inner.commit(c);
    },
    resolve: (id, u) => inner.resolve(id, u),
  };
  return { transport: t, open: () => open(), waiting: () => waiting };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

/** Invariant : pour chaque clé connue du serveur, le cache a la même version et le même état. */
async function expectVersionsConsistent(userId: string, cache: CloudCacheDB, server: MemoryTransport) {
  const recs = await cache.serverVersions.toArray();
  expect(recs.length).toBeGreaterThan(0);
  for (const r of recs) {
    const e = server.entry(userId, r.table, JSON.parse(r.key));
    expect(e, `${r.table} ${r.key}`).toBeDefined();
    expect({ version: r.version, deleted: r.deleted }, `${r.table} ${r.key}`).toEqual({ version: e!.version, deleted: e!.deleted });
    const cached = await cache.table(r.table).get(JSON.parse(r.key));
    expect(cached === undefined, `${r.table} ${r.key} : présent dans le cache ⇔ actif`).toBe(r.deleted);
  }
}

// ---------------------------------------------------------------------------
// Forme du lot et convention de version
// ---------------------------------------------------------------------------

describe('protocole v1 : forme du lot', () => {
  it('protocol 1, changesetId UUID unique par lot, userId, au plus une opération par clé, version attendue', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo } = device(u, server);
    await repo.ensureUser('Test');
    await repo.createAccount(account('Banque'));
    await repo.createAccount(account('Épargne'));
    expect(server.commits).toHaveLength(3);
    const ids = server.commits.map((c) => c.changesetId);
    expect(new Set(ids).size).toBe(3);
    for (const c of server.commits) {
      expect(c.protocol).toBe(CHANGESET_PROTOCOL);
      expect(c.changesetId).toMatch(UUID);
      expect(c.userId).toBe(u);
      const keys = c.ops.map((o) => `${o.table}:${keyString(o.key)}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const op of c.ops) {
        expect(op).toHaveProperty('expectedVersion');
        expect(op.expectedVersion).toBeNull(); // créations uniquement
        if (op.type === 'put') expect(op.row).toBeTypeOf('object');
        else expect(op).not.toHaveProperty('row');
      }
    }
  });

  it('une clé créée puis supprimée dans la même transaction n’est pas transmise', async () => {
    const server = new MemoryTransport();
    const { repo, storage } = device(uid(), server);
    await repo.ensureUser('Test');
    const before = server.commits.length;
    await storage.transaction(['accounts'], async () => {
      await storage.tables.accounts.add({ id: 'tmp', userId: repo.userId, ...account('Tmp'), createdAt: 'x', updatedAt: 'x' });
      await storage.tables.accounts.delete('tmp');
    });
    expect(server.commits.length).toBe(before); // lot vide : rien envoyé
    expect(await storage.serverVersion('accounts', 'tmp')).toBeUndefined();
  });
});

describe('protocole v1 : versions (création, modification, suppression, réactivation)', () => {
  it('création → version 1 ; modification avec la bonne version → v + 1 (serveur et cache)', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage } = device(u, server);
    await repo.ensureUser('Test');
    const acc = await repo.createAccount(account('Banque'));
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 1, deleted: false });
    expect(await storage.serverVersion('accounts', acc.id)).toEqual({ table: 'accounts', key: keyString(acc.id), version: 1, deleted: false });

    await repo.updateAccount(acc.id, { name: 'Banque 2' });
    const op = server.commits.at(-1)!.ops.find((o) => o.table === 'accounts')!;
    expect(op).toMatchObject({ type: 'put', key: acc.id, expectedVersion: 1 });
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 2, deleted: false, row: { name: 'Banque 2' } });
    expect((await storage.serverVersion('accounts', acc.id))?.version).toBe(2);
    await repo.updateAccount(acc.id, { name: 'Banque 3' });
    expect((await storage.serverVersion('accounts', acc.id))?.version).toBe(3);
    await expectVersionsConsistent(u, Reflect.get(storage, 'cache') as CloudCacheDB, server);
  });

  it('suppression logique : version + 1, ligne conservée côté serveur, retirée du cache, version conservée', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage, cache } = device(u, server);
    await repo.ensureUser('Test');
    const acc = await repo.createAccount(account('À supprimer'));
    await repo.deleteAccount(acc.id);
    const op = server.commits.at(-1)!.ops.find((o) => o.table === 'accounts')!;
    expect(op).toEqual({ table: 'accounts', type: 'delete', key: acc.id, expectedVersion: 1 });
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 2, deleted: true, row: { name: 'À supprimer' } });
    expect(server.rows(u, 'accounts')).toEqual([]);
    expect(await cache.accounts.get(acc.id)).toBeUndefined();
    expect(await storage.serverVersion('accounts', acc.id)).toMatchObject({ version: 2, deleted: true });
    await expectVersionsConsistent(u, cache, server);
  });

  it('réactivation : réécrire une clé supprimée porte la version de la ligne supprimée → v + 1, active', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage, cache } = device(u, server);
    await repo.ensureUser('Test');
    const acc = await repo.createAccount(account('Compte'));
    const backup = await repo.exportBackup();
    await repo.deleteAccount(acc.id); // v2, supprimé
    await repo.restoreBackup(backup); // réécrit le compte : réactivation
    const op = server.commits.at(-1)!.ops.find((o) => o.table === 'accounts' && o.key === acc.id)!;
    expect(op).toMatchObject({ type: 'put', expectedVersion: 2 });
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 3, deleted: false });
    expect(await storage.serverVersion('accounts', acc.id)).toMatchObject({ version: 3, deleted: false });
    expect((await repo.snapshot())!.accounts.map((a) => a.id)).toEqual([acc.id]);
    await expectVersionsConsistent(u, cache, server);
  });

  it('une création sur une clé déjà connue du serveur (même supprimée) est un conflit', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const a = device(u, server);
    await a.repo.ensureUser('Test');
    const acc = await a.repo.createAccount(account('X'));
    await a.repo.deleteAccount(acc.id);
    // Appareil sans historique : la clé lui est inconnue → expectedVersion null.
    const b = device(u, server);
    const err = await b.storage.tables.accounts.put({ ...acc } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudConflictError);
    expect((err as CloudConflictError).conflicts).toEqual([{ table: 'accounts', key: acc.id, expectedVersion: null, actualVersion: 2, actualDeleted: true }]);
  });
});

// ---------------------------------------------------------------------------
// Conflits
// ---------------------------------------------------------------------------

describe('protocole v1 : conflits entre clients', () => {
  it('scénario de référence : deux appareils, même version initiale ; le second est refusé en entier, rien n’est perdu', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const a = device(u, server);
    await a.repo.ensureUser('Test');
    const acc = await a.repo.createAccount(account('Initial'));
    // 1. Deux repositories disposent de la même version initiale (récupération simulée).
    const b = device(u, server);
    await pull(a.cache, b.cache);
    expect((await b.storage.serverVersion('accounts', acc.id))?.version).toBe(1);
    // 2–3. A modifie ; le serveur accepte et incrémente.
    await a.repo.updateAccount(acc.id, { name: 'Par A' });
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 2, row: { name: 'Par A' } });
    const aAfter = await dumpCache(a.cache);
    const bBefore = await dumpCache(b.cache);
    const commits = server.commits.length;
    // 4–5. B tente avec son ancienne version : lot rejeté intégralement.
    const err = await b.repo.updateAccount(acc.id, { name: 'Par B', color: '#f00' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudConflictError);
    expect(err).not.toBeInstanceOf(CloudTransportError);
    expect((err as CloudConflictError).conflicts).toEqual([{ table: 'accounts', key: acc.id, expectedVersion: 1, actualVersion: 2, actualDeleted: false }]);
    expect(server.commits.length).toBe(commits);
    // 6. Les données de A restent intactes (serveur et cache de A).
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 2, row: { name: 'Par A', color: '#000' } });
    expect(await dumpCache(a.cache)).toEqual(aAfter);
    // 7. Le cache de B n'intègre pas l'écriture refusée (lignes et versions inchangées).
    expect(await dumpCache(b.cache)).toEqual(bBefore);
    expect((await b.repo.snapshot())!.accounts[0].name).toBe('Initial');
    expect(b.storage.unconfirmedChangesetId).toBeNull(); // refus définitif : rien à résoudre
    // Après récupération (Lot 5), B peut écrire.
    await pull(a.cache, b.cache);
    await b.repo.updateAccount(acc.id, { name: 'Par B' });
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 3, row: { name: 'Par B' } });
  });

  it('deux écritures concurrentes sur la même clé (deux appareils) : une acceptée, l’autre en conflit', async () => {
    const mem = new MemoryTransport();
    const u = uid();
    const a = device(u, mem);
    await a.repo.ensureUser('Test');
    const acc = await a.repo.createAccount(account('Initial'));
    const g = gated(mem);
    const a2 = new CloudRepository(u, { transport: g.transport, cache: a.cache });
    const b = device(u, g.transport);
    await pull(a.cache, b.cache);
    const pA = a2.updateAccount(acc.id, { name: 'A' }).then(() => 'ok', (e: unknown) => e);
    const pB = b.repo.updateAccount(acc.id, { name: 'B' }).then(() => 'ok', (e: unknown) => e);
    await until(() => g.waiting() === 2); // les deux ont lu la version 1 avant toute écriture
    g.open();
    const [rA, rB] = await Promise.all([pA, pB]);
    const results = [rA, rB];
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r instanceof CloudConflictError)).toHaveLength(1);
    const winner = rA === 'ok' ? 'A' : 'B';
    expect(mem.entry(u, 'accounts', acc.id)).toMatchObject({ version: 2, row: { name: winner } });
  });

  it('même cache partagé (deux onglets) : la version attendue est celle de la LECTURE, pas celle du moment de l’envoi', async () => {
    const mem = new MemoryTransport();
    const u = uid();
    const a = device(u, mem);
    await a.repo.ensureUser('Test');
    const acc = await a.repo.createAccount(account('Initial'));
    const g = gated(mem);
    const tab1 = new CloudRepository(u, { transport: g.transport, cache: a.cache });
    const tab2 = new CloudRepository(u, { transport: mem, cache: a.cache });
    // L'onglet 1 lit la version 1 puis attend l'envoi…
    const p1 = tab1.updateAccount(acc.id, { name: 'Onglet 1' }).then(() => 'ok', (e: unknown) => e);
    await until(() => g.waiting() === 1);
    // … pendant que l'onglet 2 écrit (v2) dans le MÊME cache.
    await tab2.updateAccount(acc.id, { name: 'Onglet 2' });
    g.open();
    const r1 = await p1;
    expect(r1).toBeInstanceOf(CloudConflictError); // pas d'écrasement silencieux
    expect(mem.entry(u, 'accounts', acc.id)).toMatchObject({ version: 2, row: { name: 'Onglet 2' } });
    expect((await a.cache.accounts.get(acc.id))?.name).toBe('Onglet 2');
  });

  it('lecture HORS transaction puis écriture : un autre onglet écrit entre les deux → conflit, pas d’écrasement', async () => {
    const mem = new MemoryTransport();
    const u = uid();
    const a = device(u, mem);
    await a.repo.ensureUser('Test');
    const acc = await a.repo.createAccount(account('Initial'));
    const tab1 = new CloudRepository(u, { transport: mem, cache: a.cache });
    const tab2 = new CloudRepository(u, { transport: mem, cache: a.cache });
    const s1 = Reflect.get(tab1, 'store') as CloudStorage;
    // Même enchaînement que les méthodes qui lisent avant d'écrire (ex. updateAccount).
    const err = await s1
      .runOperation(async () => {
        const row = await s1.tables.accounts.get(acc.id); // lu en version 1, hors transaction
        await tab2.updateAccount(acc.id, { name: 'Onglet 2' }); // v2 écrite entre-temps
        await s1.tables.accounts.put({ ...row!, color: '#abc' }); // fondée sur la v1
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudConflictError);
    expect((err as CloudConflictError).conflicts[0]).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
    expect(mem.entry(u, 'accounts', acc.id)).toMatchObject({ version: 2, row: { name: 'Onglet 2', color: '#000' } });
  });

  it('lot multi-tables : un seul conflit (objectif modifié ailleurs) → la contribution n’est pas créée non plus', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const a = device(u, server);
    await a.repo.ensureUser('Test');
    const goal = await a.repo.saveGoal(goalInput);
    const b = device(u, server);
    await pull(a.cache, b.cache);
    await a.repo.saveGoal({ ...goal, name: 'Renommé par A' });
    const bBefore = await dumpCache(b.cache);
    const err = await b.repo.addGoalContribution(goal.id, 5000, '2026-03-01').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudConflictError);
    expect((err as CloudConflictError).conflicts.map((c) => c.table)).toEqual(['goals']);
    expect(server.rows(u, 'goalContributions')).toEqual([]); // aucune application partielle
    expect(server.entry(u, 'goals', goal.id)).toMatchObject({ version: 2, row: { savedAmount: 0, name: 'Renommé par A' } });
    expect(await dumpCache(b.cache)).toEqual(bBefore);
  });

  it('clé déterministe créée sur deux appareils (état de notification) : le second est en conflit', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const a = device(u, server);
    await a.repo.ensureUser('Test');
    const b = device(u, server);
    await pull(a.cache, b.cache);
    await a.repo.setNotificationState(['budget:x:2026-10:90'], { read: true });
    const err = await b.repo.setNotificationState(['budget:x:2026-10:90'], { dismissed: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudConflictError);
    expect((err as CloudConflictError).conflicts[0]).toMatchObject({ table: 'notificationStates', expectedVersion: null, actualVersion: 1 });
  });
});

// ---------------------------------------------------------------------------
// Atomicité, idempotence, issue inconnue
// ---------------------------------------------------------------------------

describe('protocole v1 : atomicité et idempotence', () => {
  it('lot multi-tables accepté : toutes les lignes et toutes les versions appliquées ensemble', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, cache } = device(u, server);
    await repo.ensureUser('Test');
    const bank = await repo.createAccount(account('Banque'));
    const debt = await repo.createDebt({ label: 'D', type: 'loan', direction: 'payable', principal: 100000, currency: 'MAD', startDate: '2026-03-01', status: 'active' });
    await repo.addDebtPayment(debt.id, { date: '2026-03-02', principal: 100000, interest: 0, accountId: bank.id });
    const lot = server.commits.at(-1)!;
    expect(new Set(lot.ops.map((o) => o.table))).toEqual(new Set(['transactions', 'debtPayments', 'debts']));
    await expectVersionsConsistent(u, cache, server);
  });

  it('rejeu idempotent : même changesetId et même contenu → résultat d’origine, aucune seconde modification', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo } = device(u, server);
    await repo.ensureUser('Test');
    const acc = await repo.createAccount(account('A'));
    await repo.updateAccount(acc.id, { name: 'B' });
    const lot = server.commits.at(-1)!;
    const before = server.entry(u, 'accounts', acc.id);
    const commits = server.commits.length;
    const replay = await server.commit(structuredClone(lot));
    expect(replay.status).toBe('replayed');
    expect(replay.versions).toEqual([{ table: 'accounts', key: acc.id, version: 2, deleted: false }]);
    expect(checkCommitResult(lot, replay)).toBe(true);
    expect(server.entry(u, 'accounts', acc.id)).toEqual(before);
    expect(server.commits.length).toBe(commits);
    // Les clés de l'objet sont comparées sous forme canonique (ordre indifférent).
    const reordered = { ...lot, ops: lot.ops.map((o) => (o.type === 'put' ? { row: { ...o.row }, expectedVersion: o.expectedVersion, key: o.key, type: o.type, table: o.table } : o)) } as ChangeSet;
    expect((await server.commit(reordered)).status).toBe('replayed');
  });

  it('réutilisation frauduleuse d’un changesetId : autre contenu ou autre utilisateur → refus, rien appliqué', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo } = device(u, server);
    await repo.ensureUser('Test');
    const acc = await repo.createAccount(account('A'));
    const lot = server.commits.at(-1)!;
    const forgedRow = { ...(lot.ops[0] as { row: Record<string, unknown> }).row, name: 'Falsifié' };
    const forged: ChangeSet = { ...lot, ops: [{ ...lot.ops[0], row: forgedRow } as ChangeSet['ops'][number]] };
    for (const bad of [forged, { ...lot, userId: 'autre' }]) {
      const err = await server.commit(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CloudProtocolError);
      expect((err as CloudProtocolError).code).toBe('changeset_id_reused');
    }
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 1, row: { name: 'A' } });
  });

  it('lots mal formés refusés en entier (protocole, identifiant, doublon de clé, clé incohérente, version)', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const row = { id: 'k1', userId: u, ...account('A'), createdAt: 'x', updatedAt: 'x' };
    const base = (): ChangeSet => ({ protocol: 1, changesetId: globalThis.crypto.randomUUID(), userId: u, ops: [{ table: 'accounts', type: 'put', key: 'k1', expectedVersion: null, row }] });
    const cases: [string, ChangeSet][] = [
      ['protocole', { ...base(), protocol: 2 as never }],
      ['identifiant', { ...base(), changesetId: 'pas-un-uuid' }],
      ['vide', { ...base(), ops: [] }],
      ['doublon', { ...base(), ops: [...base().ops, ...base().ops] }],
      ['clé incohérente', { ...base(), ops: [{ table: 'accounts', type: 'put', key: 'autre', expectedVersion: null, row }] }],
      ['version 0', { ...base(), ops: [{ table: 'accounts', type: 'put', key: 'k1', expectedVersion: 0, row }] }],
      ['version décimale', { ...base(), ops: [{ table: 'accounts', type: 'put', key: 'k1', expectedVersion: 1.5, row }] }],
      ['table inconnue', { ...base(), ops: [{ table: 'inconnue' as TableName, type: 'put', key: 'k1', expectedVersion: null, row }] }],
    ];
    for (const [label, cs] of cases) {
      const err = await server.commit(cs).catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(CloudProtocolError);
      expect((err as CloudProtocolError).code, label).toBe('invalid_changeset');
    }
    expect(server.users()).toEqual([]);
  });

  it('échec avant confirmation : rien dans le cache ; résolu (abandonné) avant l’écriture suivante ; jamais appliqué ensuite', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage, cache } = device(u, server);
    await repo.ensureUser('Test');
    const before = await dumpCache(cache);
    let sent: ChangeSet | null = null;
    server.failWhen = (c) => {
      sent = structuredClone(c);
      server.failWhen = null;
      return new Error('réseau coupé à l’aller');
    };
    const err = await repo.createAccount(account('Perdu')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudTransportError);
    expect(await dumpCache(cache)).toEqual(before);
    expect(storage.unconfirmedChangesetId).toBe(sent!.changesetId);
    // Écriture suivante : le lot inconnu est d'abord résolu → abandonné.
    await repo.createAccount(account('Suivant'));
    expect(storage.unconfirmedChangesetId).toBeNull();
    expect(server.rows(u, 'accounts').map((a) => a.name)).toEqual(['Suivant']);
    // Le lot abandonné, s'il arrive en retard, n'est jamais appliqué.
    const late = await server.commit(sent!).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(CloudProtocolError);
    expect((late as CloudProtocolError).code).toBe('changeset_abandoned');
    expect(server.rows(u, 'accounts').map((a) => a.name)).toEqual(['Suivant']);
  });

  it('réponse perdue après acceptation : signalé non enregistré, puis le cache rattrape le serveur sans doublon ni conflit', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage, cache } = device(u, server);
    await repo.ensureUser('Test');
    const acc = await repo.createAccount(account('A'));
    server.loseResponseNext = new Error('réponse perdue');
    const err = await repo.updateAccount(acc.id, { name: 'B' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudTransportError); // jamais présenté comme confirmé
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 2, row: { name: 'B' } }); // appliqué côté serveur
    expect((await cache.accounts.get(acc.id))?.name).toBe('A'); // cache inchangé tant que non confirmé
    expect((await storage.serverVersion('accounts', acc.id))?.version).toBe(1);
    expect(storage.unconfirmedChangesetId).not.toBeNull();
    // Écriture suivante : résolution (rejoué) → cache à jour → la nouvelle écriture part de v2.
    await repo.updateAccount(acc.id, { color: '#123' });
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 3, row: { name: 'B', color: '#123' } });
    expect(await cache.accounts.get(acc.id)).toMatchObject({ name: 'B', color: '#123' });
    expect(storage.unconfirmedChangesetId).toBeNull();
    await expectVersionsConsistent(u, cache, server);
  });

  it('réponse ambiguë (résultat incohérent) : non confirmée, cache inchangé ; résolue ensuite', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage, cache } = device(u, server);
    await repo.ensureUser('Test');
    const garbles: ((r: CommitResult) => unknown)[] = [
      (r) => ({ ...r, changesetId: globalThis.crypto.randomUUID() }),
      (r) => ({ ...r, versions: [] }),
      (r) => ({ ...r, versions: r.versions.map((v) => ({ ...v, version: 0 })) }),
      (r) => ({ ...r, status: 'ok' }),
      () => undefined,
    ];
    for (const garble of garbles) {
      const before = await dumpCache(cache);
      server.garbleResponseNext = garble;
      const err = await repo.createAccount(account('X')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CloudTransportError);
      expect(await dumpCache(cache)).toEqual(before);
      expect(storage.unconfirmedChangesetId).not.toBeNull();
      await storage.resolveUnconfirmed(); // le serveur l'avait appliqué : le cache le rattrape
      expect(storage.unconfirmedChangesetId).toBeNull();
    }
    expect((await repo.snapshot())!.accounts).toHaveLength(garbles.length);
    await expectVersionsConsistent(u, cache, server);
  });

  it('résolution impossible (réseau) : l’écriture suivante est refusée et rien n’est écrit, jusqu’au retour du réseau', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage, cache } = device(u, server);
    await repo.ensureUser('Test');
    server.loseResponseNext = new Error('réponse perdue');
    await expect(repo.createAccount(account('A'))).rejects.toBeInstanceOf(CloudTransportError);
    const pending = storage.unconfirmedChangesetId;
    const before = await dumpCache(cache);
    const commits = server.commits.length;
    server.resolveFailure = new Error('toujours hors ligne');
    await expect(repo.createAccount(account('B'))).rejects.toBeInstanceOf(CloudTransportError);
    await expect(repo.updateSettings({ theme: 'dark' })).rejects.toBeInstanceOf(CloudTransportError);
    expect(storage.unconfirmedChangesetId).toBe(pending);
    expect(await dumpCache(cache)).toEqual(before);
    expect(server.commits.length).toBe(commits);
    // Lecture toujours possible (hors ligne : lecture seule).
    expect((await repo.snapshot())!.accounts).toHaveLength(0);
    server.resolveFailure = null; // retour du réseau
    await repo.createAccount(account('B'));
    expect((await repo.snapshot())!.accounts.map((a) => a.name).sort()).toEqual(['A', 'B']);
  });

  it('échec d’écriture du cache après acceptation : ni ligne ni version partielles ; réappliqué avant l’écriture suivante', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage, cache } = device(u, server);
    await repo.ensureUser('Test');
    const before = await dumpCache(cache);
    const original = cache.transaction.bind(cache);
    let failed = false;
    const spy = vi.spyOn(cache, 'transaction').mockImplementation(((mode: string, ...rest: unknown[]) => {
      if (mode === 'rw' && !failed) {
        failed = true;
        return Promise.reject(new Error('quota dépassé'));
      }
      return (original as (...a: unknown[]) => unknown)(mode, ...rest);
    }) as never);
    const err = await repo.createAccount(account('A')).catch((e: unknown) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(CloudCacheWriteError);
    expect(server.rows(u, 'accounts')).toHaveLength(1); // enregistré sur le serveur
    expect(await dumpCache(cache)).toEqual(before); // ni ligne ni version dans le cache
    await repo.createAccount(account('B'));
    expect((await repo.snapshot())!.accounts.map((a) => a.name).sort()).toEqual(['A', 'B']);
    expect(storage.unconfirmedChangesetId).toBeNull();
    await expectVersionsConsistent(u, cache, server);
  });

  it('mode désactivé : aucune résolution, aucun lot en attente', async () => {
    const u = uid();
    const { repo, storage } = device(u, new DisabledTransport());
    await expect(repo.ensureUser('x')).rejects.toBeInstanceOf(CloudWriteDisabledError);
    expect(storage.unconfirmedChangesetId).toBeNull();
    await expect(new DisabledTransport().resolve()).rejects.toBeInstanceOf(CloudWriteDisabledError);
  });
});

// ---------------------------------------------------------------------------
// Versions : persistance, isolation, exclusion des données métier
// ---------------------------------------------------------------------------

describe('protocole v1 : stockage des versions', () => {
  it('persistance : versions conservées à la réouverture du cache ; l’écriture suivante part de la bonne version', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const first = device(u, server);
    await first.repo.ensureUser('Test');
    const acc = await first.repo.createAccount(account('A'));
    await first.repo.updateAccount(acc.id, { name: 'B' });
    first.cache.close();
    const reopened = device(u, server, first.factory); // même appareil (même fabrique), nouvelle session
    expect(await reopened.storage.serverVersion('accounts', acc.id)).toMatchObject({ version: 2 });
    await reopened.repo.updateAccount(acc.id, { name: 'C' });
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 3, row: { name: 'C' } });
    expect((await first.factory.databases()).map((d) => d.name)).toEqual([cloudCacheName(u)]); // jamais « nexora »
  });

  it('isolation : chaque utilisateur a ses versions dans son propre cache', async () => {
    const server = new MemoryTransport();
    const factory = new IDBFactory();
    const u1 = uid();
    const u2 = uid();
    const c1 = device(u1, server, factory);
    const c2 = device(u2, server, factory);
    await c1.repo.ensureUser('Un');
    await c2.repo.ensureUser('Deux');
    const a1 = await c1.repo.createAccount(account('U1'));
    await c2.repo.createAccount(account('U2'));
    expect((await factory.databases()).map((d) => d.name).sort()).toEqual([cloudCacheName(u1), cloudCacheName(u2)].sort());
    expect(await c2.storage.serverVersion('accounts', a1.id)).toBeUndefined();
    for (const [c, u] of [[c1, u1], [c2, u2]] as const) {
      for (const r of await c.cache.serverVersions.toArray()) {
        const e = server.entry(u, r.table, JSON.parse(r.key));
        expect(e, `${u} ${r.table}`).toBeDefined(); // chaque version appartient à une ligne de CET utilisateur
      }
      await expectVersionsConsistent(u, c.cache, server);
    }
  });

  it('les versions n’apparaissent ni dans les lignes, ni dans snapshot(), ni dans exportBackup()', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, cache } = device(u, server);
    await repo.ensureUser('Test');
    const acc = await repo.createAccount(account('A'));
    await repo.updateAccount(acc.id, { name: 'B' });
    await repo.saveGoal(goalInput);
    const forbidden = /"(version|serverVersions?|expectedVersion|syncTxid|sync_txid|deletedAt|deleted_at)"/;
    const snap = await repo.snapshot();
    const backup = await repo.exportBackup();
    expect(JSON.stringify(snap)).not.toMatch(forbidden);
    expect(JSON.stringify(backup)).not.toMatch(forbidden);
    // Format v2 : les 16 tables utilisateur + les pièces jointes (backup/format.ts).
    expect(Object.keys(backup.data).sort()).toEqual([...USER_TABLES, 'attachments'].sort());
    for (const t of ALL_TABLES) for (const row of await cache.table(t).toArray()) expect(JSON.stringify(row), t).not.toMatch(forbidden);
    expect(await cache.serverVersions.count()).toBeGreaterThan(0);
    // Une restauration de cette sauvegarde n'introduit aucune version dans les données.
    await repo.restoreBackup(backup);
    expect(JSON.stringify(await repo.snapshot())).not.toMatch(forbidden);
  });
});

// ---------------------------------------------------------------------------
// Compatibilité
// ---------------------------------------------------------------------------

describe('protocole v1 : compatibilité', () => {
  it('54 méthodes inchangées ; suite d’opérations variée : cache et serveur cohérents (versions comprises)', async () => {
    expect(REPOSITORY_METHODS).toHaveLength(54);
    const server = new MemoryTransport();
    const u = uid();
    const { repo, cache } = device(u, server);
    for (const m of REPOSITORY_METHODS) expect(typeof (repo as unknown as Record<string, unknown>)[m], m).toBe('function');
    const r: NexoraRepository = repo;
    await r.ensureUser('Test');
    const bank = await r.createAccount(account('Banque'));
    const savings = await r.createAccount({ ...account('Épargne'), type: 'savings' });
    const cats = (await r.snapshot())!.categories;
    const food = cats.find((c) => c.key === 'food')!;
    const [t1] = await r.createTransaction({ type: 'expense', amount: 1000, date: '2026-03-01', label: 'Courses', accountId: bank.id, categoryId: food.id, tags: [], status: 'cleared' } as never);
    await r.createTransaction({ type: 'transfer', amount: 500, date: '2026-03-02', label: 'Virement', accountId: bank.id, toAccountId: savings.id, categoryId: null, tags: [], status: 'cleared' } as never);
    await r.setBudget('2026-03', food.id, 50000, 'MAD', { applyToFollowingMonths: 2 });
    const goal = await r.saveGoal(goalInput);
    await r.addGoalContribution(goal.id, 2000, '2026-03-03');
    await r.deleteTransactions([t1.id]);
    await r.setNotificationState(['a', 'b'], { read: true });
    await r.setNotificationState(['a'], { dismissed: true });
    const backup = await r.exportBackup();
    await r.clearUserData();
    await r.restoreBackup(backup);
    await r.resetToEmpty({ displayName: 'Nouveau' });
    await expectVersionsConsistent(u, cache, server);
    // Les lignes actives du serveur sont exactement celles du cache (tables synchronisées) ;
    // `meta` reste locale.
    for (const t of ALL_TABLES.filter((x) => !(x in EXCLUDED_TABLES))) expect(server.rows(u, t).length, t).toBe(await cache.table(t).count());
    expect(await cache.meta.count()).toBe(1);
    expect(server.rows(u, 'meta')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tables locales (`meta`) : présentes dans le cache, jamais transmises
// ---------------------------------------------------------------------------

describe('protocole v1 : tables locales (meta)', () => {
  /** Transport espion : compte les appels et enregistre chaque lot reçu. */
  function spy(inner: MemoryTransport) {
    const seen: ChangeSet[] = [];
    const t: CloudTransport = {
      kind: 'spy',
      commit: (c) => {
        seen.push(structuredClone(c));
        return inner.commit(c);
      },
      resolve: (id, u) => inner.resolve(id, u),
    };
    return { transport: t, seen };
  }

  it('meta reste dans le cache, n’est jamais transmise ; les autres tables le sont normalement', async () => {
    const server = new MemoryTransport();
    const s = spy(server);
    const u = uid();
    const { repo, cache } = device(u, s.transport);
    await repo.ensureUser('Test');
    await repo.createAccount(account('Banque'));
    await repo.resetToEmpty({ displayName: 'Nouveau' }); // réécrit meta via ensureUser
    expect(await cache.meta.toArray()).toEqual([{ key: 'schemaVersion', value: 1 }]);
    expect(s.seen.length).toBeGreaterThanOrEqual(3);
    expect(s.seen.flatMap((c) => c.ops).filter((o) => o.table === 'meta')).toEqual([]);
    expect(new Set(s.seen[0].ops.map((o) => o.table))).toEqual(new Set(['users', 'settings', 'categories']));
    expect(server.rows(u, 'meta')).toEqual([]);
  });

  it('versions serveur : uniquement pour les tables synchronisées', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, cache, storage } = device(u, server);
    await repo.ensureUser('Test');
    await repo.createAccount(account('Banque'));
    const tables = new Set((await cache.serverVersions.toArray()).map((r) => r.table));
    expect(tables.has('meta')).toBe(false);
    for (const t of tables) expect(t in EXCLUDED_TABLES, t).toBe(false);
    expect(await storage.serverVersion('meta', 'schemaVersion')).toBeUndefined();
  });

  it('atomicité : meta n’est écrite qu’avec le lot confirmé (conflit → rien ; échec du cache → ni meta ni lignes)', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const a = device(u, server);
    await a.repo.ensureUser('A');
    // Appareil sans récupération : son ensureUser entre en conflit → rien d'écrit, meta comprise.
    const b = device(u, server);
    await expect(b.repo.ensureUser('B')).rejects.toBeInstanceOf(CloudConflictError);
    expect(await b.cache.meta.count()).toBe(0);
    for (const t of ALL_TABLES) expect(await b.cache.table(t).count(), t).toBe(0);
    // Échec d'écriture du cache après acceptation : la transaction Dexie annule tout.
    const c = device(uid(), server);
    const original = c.cache.transaction.bind(c.cache);
    let failed = false;
    const spyTx = vi.spyOn(c.cache, 'transaction').mockImplementation(((mode: string, ...rest: unknown[]) => {
      if (mode === 'rw' && !failed) {
        failed = true;
        return Promise.reject(new Error('quota dépassé'));
      }
      return (original as (...x: unknown[]) => unknown)(mode, ...rest);
    }) as never);
    await expect(c.repo.ensureUser('C')).rejects.toBeInstanceOf(CloudCacheWriteError);
    spyTx.mockRestore();
    expect(await c.cache.meta.count()).toBe(0);
    expect(await c.cache.settings.count()).toBe(0);
    await c.storage.resolveUnconfirmed(); // réapplication : lignes ET meta ensemble
    expect(await c.cache.meta.count()).toBe(1);
    expect(await c.cache.settings.count()).toBe(1);
  });

  it('atomicité : une panne sur l’écriture locale (meta) annule aussi les lignes et les versions confirmées', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage, cache } = device(u, server);
    // `cache.table('meta')` n'est pas l'objet `cache.meta` : on intercepte le prototype commun.
    const proto = Object.getPrototypeOf(cache.meta) as { put: (...a: unknown[]) => unknown };
    const originalPut = proto.put;
    let failed = false;
    const spyMeta = vi.spyOn(proto, 'put').mockImplementation(function (this: { name: string }, ...args: unknown[]) {
      if (this.name === 'meta' && !failed) {
        failed = true;
        return Promise.reject(new Error('panne sur meta'));
      }
      return originalPut.apply(this, args);
    } as never);
    await expect(repo.ensureUser('Test')).rejects.toBeInstanceOf(CloudCacheWriteError);
    spyMeta.mockRestore();
    expect(server.rows(u, 'settings')).toHaveLength(1); // accepté par le serveur
    for (const t of ALL_TABLES) expect(await cache.table(t).count(), t).toBe(0); // rien de partiel
    expect(await cache.serverVersions.count()).toBe(0);
    await storage.resolveUnconfirmed();
    expect(await cache.meta.count()).toBe(1);
    expect(await cache.settings.count()).toBe(1);
    await expectVersionsConsistent(u, cache, server);
  });

  it('réponse perdue : meta appliquée seulement à la résolution (rejouée) ; abandonnée avec un lot jamais appliqué', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const { repo, storage, cache } = device(u, server);
    server.loseResponseNext = new Error('réponse perdue');
    await expect(repo.ensureUser('Test')).rejects.toBeInstanceOf(CloudTransportError);
    expect(await cache.meta.count()).toBe(0);
    expect(server.rows(u, 'settings')).toHaveLength(1);
    await storage.resolveUnconfirmed();
    expect(await cache.meta.toArray()).toEqual([{ key: 'schemaVersion', value: 1 }]);
    expect(await cache.settings.count()).toBe(1);

    const u2 = uid();
    const other = device(u2, server);
    server.failNext = new Error('réseau coupé à l’aller');
    await expect(other.repo.ensureUser('X')).rejects.toBeInstanceOf(CloudTransportError);
    await other.storage.resolveUnconfirmed(); // jamais appliqué → abandonné
    expect(other.storage.unconfirmedChangesetId).toBeNull();
    expect(await other.cache.meta.count()).toBe(0); // écritures locales abandonnées avec le lot
    expect(server.rows(u2, 'settings')).toEqual([]);
  });

  it('lot purement local : appliqué au cache sans aucun appel serveur', async () => {
    const server = new MemoryTransport();
    const s = spy(server);
    const u = uid();
    const { repo, storage, cache } = device(u, s.transport);
    await repo.ensureUser('Test');
    const calls = s.seen.length;
    await storage.transaction(['meta'], async () => {
      await storage.tables.meta.put({ key: 'localPref', value: 'x' });
    });
    expect(s.seen.length).toBe(calls);
    expect(await cache.meta.get('localPref')).toEqual({ key: 'localPref', value: 'x' });
    // Même en mode désactivé : aucune écriture serveur demandée, donc aucun refus.
    const off = device(uid(), new DisabledTransport());
    await off.storage.transaction(['meta'], async () => {
      await off.storage.tables.meta.put({ key: 'localPref', value: 'y' });
    });
    expect(await off.cache.meta.count()).toBe(1);
  });

  it('MemoryTransport refuse toute table exclue du mapping (meta), rien n’est appliqué', async () => {
    const server = new MemoryTransport();
    const u = uid();
    const cs: ChangeSet = {
      protocol: 1,
      changesetId: globalThis.crypto.randomUUID(),
      userId: u,
      ops: [
        { table: 'settings', type: 'put', key: u, expectedVersion: null, row: { id: u, userId: u } },
        { table: 'meta', type: 'put', key: 'schemaVersion', expectedVersion: null, row: { key: 'schemaVersion', value: 1 } },
      ],
    };
    const err = await server.commit(cs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudProtocolError);
    expect((err as CloudProtocolError).code).toBe('invalid_changeset');
    expect((err as Error).message).toMatch(/meta/);
    expect(server.users()).toEqual([]);
    expect(Object.keys(EXCLUDED_TABLES)).toEqual(['meta']);
  });
});

// ---------------------------------------------------------------------------
// CloudCacheDB : protection du nom (jamais la base locale réelle)
// ---------------------------------------------------------------------------

describe('CloudCacheDB : protection du constructeur', () => {
  it('refuse « nexora » avant toute création de base', async () => {
    const factory = new IDBFactory();
    for (const userId of ['u1', 'nexora', '']) {
      expect(() => new CloudCacheDB('nexora', { userId, dexie: { indexedDB: factory, IDBKeyRange } })).toThrow(/« nexora »/);
    }
    expect(await factory.databases()).toEqual([]);
  });

  it('refuse un nom sans préfixe, un autre utilisateur, un identifiant invalide ou un utilisateur absent', () => {
    const dexie = { indexedDB: new IDBFactory(), IDBKeyRange };
    const cases: [string, string, RegExp][] = [
      ['autre', 'u1', /préfixe/],
      ['Nexora-cache-u1', 'u1', /préfixe/],
      ['nexora-cache', 'u1', /préfixe/],
      ['nexora-cache-u2', 'u1', /attendu « nexora-cache-u1 »/],
      ['nexora-cache-u1x', 'u1', /attendu/],
      ['nexora-cache-../nexora', '../nexora', /invalide/],
    ];
    for (const [name, userId, msg] of cases) expect(() => new CloudCacheDB(name, { userId, dexie }), name).toThrow(msg);
    expect(() => new CloudCacheDB(cloudCacheName('u1'), undefined as never)).toThrow();
  });

  it('accepte le nom de cache de son utilisateur : version 2 avec la table annexe', async () => {
    const u = uid();
    const db = new CloudCacheDB(cloudCacheName(u), { userId: u, dexie: { indexedDB: new IDBFactory(), IDBKeyRange } });
    expect(db.name).toBe(`nexora-cache-${u}`);
    expect(db.userId).toBe(u);
    await db.open();
    expect(db.verno).toBe(2);
    expect(db.tables.map((t) => t.name).sort()).toEqual([...ALL_TABLES, SERVER_VERSIONS_TABLE].sort());
    db.close();
  });

  it('ne met jamais à jour la base locale réelle : « nexora » reste en version 1, sans table annexe, données intactes', async () => {
    const factory = new IDBFactory();
    const { NexoraDB } = await import('../db');
    const local = new NexoraDB('nexora', { indexedDB: factory, IDBKeyRange });
    await local.meta.put({ key: 'schemaVersion', value: 1 });
    local.close();
    expect(() => new CloudCacheDB('nexora', { userId: 'u1', dexie: { indexedDB: factory, IDBKeyRange } })).toThrow();
    const reopened = new NexoraDB('nexora', { indexedDB: factory, IDBKeyRange });
    await reopened.open();
    expect(reopened.verno).toBe(1);
    expect(reopened.tables.map((t) => t.name)).not.toContain(SERVER_VERSIONS_TABLE);
    expect(await reopened.meta.get('schemaVersion')).toEqual({ key: 'schemaVersion', value: 1 });
    reopened.close();
    expect((await factory.databases()).map((d) => [d.name, d.version])).toEqual([['nexora', 10]]); // Dexie : version 1 × 10
  });

  it('CloudRepository construit toujours un cache contrôlé ; un cache d’un autre utilisateur est refusé', () => {
    const u = uid();
    const repo = new CloudRepository(u, { transport: new MemoryTransport() });
    expect(repo.cacheName).toBe(cloudCacheName(u));
    const other = new CloudCacheDB(cloudCacheName('autre_u'), { userId: 'autre_u', dexie: { indexedDB: new IDBFactory(), IDBKeyRange } });
    expect(() => new CloudRepository(u, { transport: new MemoryTransport(), cache: other })).toThrow(/refusé/);
  });
});
