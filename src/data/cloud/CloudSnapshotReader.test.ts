/**
 * V3.5 (option O1) — lecteur d'affichage du mode Cloud : il ne montre JAMAIS une écriture
 * non confirmée par le serveur. Données fictives, `MemoryTransport` aligné, fake-indexeddb.
 *
 * Cas couverts : écriture en cours (lot envoyé, réponse attendue), conflit, refus définitif,
 * refus temporaire, issue inconnue (appliquée ou non par le serveur, puis résolue), cache non
 * mis à jour après acceptation, lecture seule, isolation des caches.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Account } from '@/domain/types';
import type { NewEntity } from '../contracts';
import { NexoraDB } from '../db';
import { CloudCacheDB, cloudCacheName } from './CloudCacheDB';
import { loadCloudCache } from './CloudLoader';
import { CloudRepository } from './CloudRepository';
import { createCloudSnapshotReader } from './CloudSnapshotReader';
import { MemoryTransport } from './MemoryTransport';
import { CloudConflictError, CloudProtocolError, CloudTransientRejectionError, CloudTransportError, type ChangeSet, type CloudTransport } from './transport';

const account = (name: string): NewEntity<Account> => ({ name, type: 'bank', currency: 'MAD', initialBalance: 0, initialBalanceDate: '2026-01-01', archived: false, includeInTotal: true, color: '#5271FF', order: 0 });

/** Utilisateur inscrit, cache chargé (V3.4), dépôt d'écriture et lecteur d'affichage. */
async function setup(transportFor?: (inner: CloudTransport) => CloudTransport) {
  const server = new MemoryTransport();
  const uid = randomUUID();
  server.registerUser(uid);
  const cache = new CloudCacheDB(cloudCacheName(uid), { userId: uid });
  await loadCloudCache(server.readSource(uid), cache, uid);
  const inner = server.as(uid);
  const repo = new CloudRepository(uid, { cache, transport: transportFor ? transportFor(inner) : inner });
  const reader = createCloudSnapshotReader(cache, uid);
  const names = async () => ((await reader.snapshot())?.accounts ?? []).map((a) => a.name).sort();
  const serverAccounts = async () => (await server.sqlRows(uid, 'accounts')).filter((r) => r.deleted_at == null).length;
  return { server, uid, cache, repo, reader, names, serverAccounts, inner };
}

/** Transport dont chaque envoi est retenu jusqu'à `release()`. */
function held(inner: CloudTransport) {
  let release: () => void = () => undefined;
  let sent: () => void = () => undefined;
  const isSent = new Promise<void>((r) => (sent = r));
  const gate = new Promise<void>((r) => (release = r));
  const transport: CloudTransport = {
    kind: 'held',
    async commit(c: ChangeSet) {
      sent();
      await gate;
      return inner.commit(c);
    },
    resolve: (id, uid) => inner.resolve(id, uid),
  };
  return { transport, release: () => release(), isSent };
}

describe('V3.5 — lecteur d’affichage Cloud : uniquement des données confirmées par le serveur', () => {
  it('écriture en cours (lot envoyé, réponse attendue) : invisible ; visible après confirmation', async () => {
    let h!: ReturnType<typeof held>;
    const s = await setup((inner) => (h = held(inner)).transport);
    expect(await s.reader.snapshot()).toBeNull(); // nouvel utilisateur : aucun paramètre (onboarding)
    const pending = s.repo.ensureUser('Sara');
    await h.isSent;
    // Lot construit et envoyé : la surcouche contient paramètres et catégories, le cache non.
    expect(await s.reader.snapshot()).toBeNull();
    expect(await s.cache.settings.count()).toBe(0);
    h.release();
    await pending;
    const snap = await s.reader.snapshot();
    expect(snap?.settings.displayName).toBe('Sara');
    expect(snap?.categories.length).toBeGreaterThan(0);
  });

  it('écriture en cours d’une opération composée : aucun état intermédiaire visible', async () => {
    let h!: ReturnType<typeof held>;
    const s = await setup((inner) => (h = held(inner)).transport);
    h.release();
    await s.repo.ensureUser('Sara');
    // Nouveau transport retenu pour l'écriture suivante.
    const h2 = held(s.inner);
    const repo2 = new CloudRepository(s.uid, { cache: s.cache, transport: h2.transport });
    const pending = repo2.createAccount(account('Courant'));
    await h2.isSent;
    expect(await s.names()).toEqual([]);
    h2.release();
    await pending;
    expect(await s.names()).toEqual(['Courant']);
  });

  it('conflit de version : rien n’est affiché', async () => {
    const s = await setup();
    await s.repo.ensureUser('Sara');
    const acc = await s.repo.createAccount(account('Courant'));
    // Autre appareil : modifie le compte sur le serveur (version + 1), le cache l'ignore.
    const other = new CloudCacheDB(cloudCacheName(s.uid), { userId: s.uid, dexie: { indexedDB: new (await import('fake-indexeddb')).IDBFactory(), IDBKeyRange: (await import('fake-indexeddb')).IDBKeyRange } });
    await loadCloudCache(s.server.readSource(s.uid), other, s.uid);
    await new CloudRepository(s.uid, { cache: other, transport: s.server.as(s.uid) }).updateAccount(acc.id, { name: 'Ailleurs' });
    other.close();
    await expect(s.repo.updateAccount(acc.id, { name: 'Ici' })).rejects.toBeInstanceOf(CloudConflictError);
    expect(await s.names()).toEqual(['Courant']);
  });

  it('refus définitif du serveur : rien n’est affiché', async () => {
    const s = await setup((inner) => ({
      kind: 'refus',
      commit: async (c) => (c.ops.some((o) => o.table === 'accounts') ? Promise.reject(new CloudProtocolError('invalid_row', 'refus simulé')) : inner.commit(c)),
      resolve: (id, uid) => inner.resolve(id, uid),
    }));
    await s.repo.ensureUser('Sara');
    await expect(s.repo.createAccount(account('Refusé'))).rejects.toBeInstanceOf(CloudProtocolError);
    expect(await s.names()).toEqual([]);
    expect(await s.serverAccounts()).toBe(0);
  });

  it('refus temporaire : rien n’est affiché, rien n’est en attente', async () => {
    const s = await setup((inner) => ({
      kind: 'temporaire',
      commit: async (c) => (c.ops.some((o) => o.table === 'accounts') ? Promise.reject(new CloudTransientRejectionError('invalid_row', '40001', 'sérialisation')) : inner.commit(c)),
      resolve: (id, uid) => inner.resolve(id, uid),
    }));
    await s.repo.ensureUser('Sara');
    await expect(s.repo.createAccount(account('Plus tard'))).rejects.toBeInstanceOf(CloudTransportError);
    expect(await s.names()).toEqual([]);
  });

  it('issue inconnue, lot appliqué par le serveur : invisible tant qu’il n’est pas résolu, puis affiché', async () => {
    let lose = false;
    const s = await setup((inner) => ({
      kind: 'perte',
      async commit(c) {
        const r = await inner.commit(c);
        if (lose) throw new Error('réponse perdue (réseau)');
        return r;
      },
      resolve: (id, uid) => inner.resolve(id, uid),
    }));
    await s.repo.ensureUser('Sara');
    lose = true;
    await expect(s.repo.createAccount(account('Appliqué'))).rejects.toBeInstanceOf(CloudTransportError);
    expect(await s.serverAccounts()).toBe(1); // appliqué côté serveur…
    expect(await s.names()).toEqual([]); // …mais jamais affiché sans confirmation
    lose = false;
    await s.repo.updateSettings({ displayName: 'Sara B.' }); // résolution avant toute écriture : « replayed »
    expect(await s.names()).toEqual(['Appliqué']);
  });

  it('issue inconnue, lot NON appliqué : jamais affiché, abandonné à la résolution', async () => {
    let drop = false;
    const s = await setup((inner) => ({
      kind: 'perdu',
      commit: async (c) => (drop ? Promise.reject(new Error('requête perdue (réseau)')) : inner.commit(c)),
      resolve: (id, uid) => inner.resolve(id, uid),
    }));
    await s.repo.ensureUser('Sara');
    drop = true;
    await expect(s.repo.createAccount(account('Perdu'))).rejects.toBeInstanceOf(CloudTransportError);
    expect(await s.names()).toEqual([]);
    drop = false;
    await s.repo.updateSettings({ displayName: 'Sara B.' }); // résolution : « abandoned »
    expect(await s.names()).toEqual([]);
    expect(await s.serverAccounts()).toBe(0);
    expect((await s.reader.snapshot())?.settings.displayName).toBe('Sara B.');
  });

  it('lot accepté mais cache non mis à jour : invisible jusqu’à la réapplication', async () => {
    const s = await setup();
    await s.repo.ensureUser('Sara');
    const original = s.cache.transaction.bind(s.cache) as (...a: unknown[]) => unknown;
    let fail = true;
    (s.cache as unknown as { transaction: (...a: unknown[]) => unknown }).transaction = (...args: unknown[]) => {
      if (fail && args[0] === 'rw') {
        fail = false;
        return Promise.reject(new Error('QuotaExceededError (simulé)'));
      }
      return original(...args);
    };
    await expect(s.repo.createAccount(account('Accepté'))).rejects.toThrow(/cache local non mis à jour/);
    expect(await s.serverAccounts()).toBe(1);
    expect(await s.names()).toEqual([]);
    await s.repo.updateSettings({ displayName: 'Sara B.' }); // réapplication avant toute écriture
    expect(await s.names()).toEqual(['Accepté']);
  });

  it('lecture seule : seul `snapshot()` est exposé, objet figé', async () => {
    const s = await setup();
    expect(Object.keys(s.reader)).toEqual(['snapshot']);
    expect(Object.isFrozen(s.reader)).toBe(true);
    for (const m of ['ensureUser', 'updateSettings', 'createAccount', 'clearUserData', 'restoreBackup']) expect((s.reader as unknown as Record<string, unknown>)[m]).toBeUndefined();
  });

  it('isolation : refuse la base locale « nexora » et le cache d’un autre utilisateur', () => {
    const u1 = randomUUID();
    const u2 = randomUUID();
    expect(() => createCloudSnapshotReader(new NexoraDB('nexora') as CloudCacheDB, u1)).toThrow(/« nexora »/);
    expect(() => createCloudSnapshotReader(new CloudCacheDB(cloudCacheName(u2), { userId: u2 }), u1)).toThrow(/refusé/);
    expect(() => createCloudSnapshotReader(new NexoraDB(cloudCacheName(u1)) as CloudCacheDB, u1)).toThrow(/CloudCacheDB/);
  });
});
