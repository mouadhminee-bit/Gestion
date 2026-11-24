/**
 * V4.2 — synchronisation incrémentale (`CloudSync`) sur le serveur simulé (`MemoryTransport`,
 * même contrat que `public.pull_changes`), caches fake-indexeddb : une fabrique par appareil,
 * une même fabrique pour deux onglets. Aucune requête réelle, aucun accès DEV/PROD.
 *
 * Couvre : propagation (création, modification, suppression, réactivation), curseur pris avant le
 * chargement (R2), plus de 1 000 changements, règle de la version la plus haute (R1), file
 * commune avec les écritures (R3), une seule synchronisation à la fois, déclencheurs (D7), arrêt
 * et session changée (R6), isolation, erreurs sans écriture, deux onglets sur un même cache.
 */
import { randomUUID } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@/domain/types';
import { commitAs, del, put, seed } from '@/test/cloudData';
import { CloudCacheDB, PULL_STATE_ID, cloudCacheName } from './CloudCacheDB';
import { loadCloudCache } from './CloudLoader';
import { CloudReadError, type CloudReadSource, type PullRequest } from './CloudReader';
import { CloudRepository } from './CloudRepository';
import { CloudSync, CloudSyncWriteError, createOperationQueue, type SyncOutcome, type SyncTriggerEnvironment } from './CloudSync';
import { CLOUD_TABLES, deserializeRow } from './mapping';
import { MemoryTransport } from './MemoryTransport';
import { CloudTransportError, keyString, type CloudTransport } from './transport';
import { PRIMARY_KEYS } from '../tables';

type Row = Record<string, unknown>;

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

/** Source espionne autour de la source simulée : appels `pull`, session modifiable, crochets. */
function spySource(server: MemoryTransport, uid: string) {
  const inner = server.readSource(uid);
  const pulls: PullRequest[] = [];
  const state: { session: string | null; beforePull?: (r: PullRequest) => void | Promise<void>; afterPull?: (page: unknown) => unknown } = { session: uid };
  const source: CloudReadSource = {
    kind: 'espion',
    sessionUserId: async () => state.session,
    page: (q, o, l) => inner.page(q, o, l),
    count: (q) => inner.count(q),
    pull: async (r) => {
      pulls.push(r);
      await state.beforePull?.(r);
      const page = await inner.pull(r);
      return state.afterPull ? state.afterPull(page) : page;
    },
  };
  return { source, pulls, state };
}

/** Un appareil (ou un onglet si `factory` est partagée) : cache chargé, dépôt et synchronisation sur la même file. */
async function device(server: MemoryTransport, uid: string, factory = new IDBFactory(), transport: CloudTransport = server.as(uid)) {
  const cache = new CloudCacheDB(cloudCacheName(uid), { userId: uid, dexie: { indexedDB: factory, IDBKeyRange } });
  const spy = spySource(server, uid);
  await loadCloudCache(spy.source, cache, uid);
  spy.pulls.length = 0;
  const queue = createOperationQueue();
  const repo = new CloudRepository(uid, { cache, transport, queue });
  const sync = new CloudSync({ userId: uid, cache, source: spy.source, queue });
  return { cache, repo, sync, factory, ...spy };
}

const cursorOf = async (cache: CloudCacheDB) => (await cache.syncState.get(PULL_STATE_ID))?.cursor;
const keyOf = (table: string, row: Row) => {
  const pk = PRIMARY_KEYS[table as keyof typeof PRIMARY_KEYS];
  return typeof pk === 'string' ? row[pk] : pk.map((f) => row[f]);
};

/** Cache = serveur : lignes actives (18 tables) et versions de toutes les clés. */
async function expectCacheMatchesServer(cache: CloudCacheDB, server: MemoryTransport, uid: string) {
  for (const table of CLOUD_TABLES) {
    const expected = server
      .sqlRows(uid, table)
      .filter((r) => r.deleted_at === null)
      .map((r) => deserializeRow(table, r).row as unknown as Row);
    const sort = (rows: Row[]) => [...rows].sort((a, b) => JSON.stringify(keyOf(table, a)).localeCompare(JSON.stringify(keyOf(table, b))));
    expect(sort((await cache.table(table).toArray()) as Row[]), table).toEqual(sort(expected));
  }
  const versions = await cache.serverVersions.toArray();
  expect(versions.length).toBe(CLOUD_TABLES.reduce((n, t) => n + server.sqlRows(uid, t).length, 0));
  for (const v of versions) {
    const e = server.entry(uid, v.table, JSON.parse(v.key));
    expect({ version: v.version, deleted: v.deleted }, `${v.table} ${v.key}`).toEqual({ version: e!.version, deleted: e!.deleted });
  }
}

/** Attend qu'une condition soit vraie (délai maximal : échec explicite, jamais d'attente fixe). */
async function waitFor(cond: () => boolean, what: string, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const applied = (o: SyncOutcome) => (o.status === 'applied' ? o.summary : null);
const errorOf = (o: SyncOutcome) => (o.status === 'failed' ? o.error : null);

describe('V4.2 — propagation entre appareils', () => {
  it('création, modification, suppression puis réactivation sur A apparaissent sur B après une synchronisation ; curseur = borne', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const A = await device(server, u);
    const B = await device(server, u);
    const c0 = await cursorOf(B.cache);
    expect(c0).toMatch(/^\d+$/);

    const acc = await A.repo.createAccount(account('Création'));
    let o = await B.sync.request();
    expect(applied(o)).toMatchObject({ received: 1, applied: 1 });
    expect(await B.cache.accounts.get(acc.id)).toMatchObject({ name: 'Création' });
    expect(BigInt((await cursorOf(B.cache))!)).toBeGreaterThan(BigInt(c0!));

    await A.repo.updateAccount(acc.id, { name: 'Modifié' });
    o = await B.sync.request();
    expect(applied(o)).toMatchObject({ received: 1, applied: 1 });
    expect(await B.cache.accounts.get(acc.id)).toMatchObject({ name: 'Modifié' });

    await A.repo.deleteAccount(acc.id);
    o = await B.sync.request();
    expect(applied(o)).toMatchObject({ received: 1, applied: 1 });
    expect(await B.cache.accounts.get(acc.id)).toBeUndefined(); // suppression propagée
    expect(await B.cache.serverVersions.get(['accounts', keyString(acc.id)])).toMatchObject({ version: 3, deleted: true });

    // Réactivation (écriture de la clé supprimée, version de la ligne supprimée).
    const row = { ...server.entry(u, 'accounts', acc.id)!.row, name: 'Réactivé' };
    await commitAs(server, u, [put('accounts', row, 3)]);
    o = await B.sync.request();
    expect(applied(o)).toMatchObject({ received: 1, applied: 1 });
    expect(await B.cache.accounts.get(acc.id)).toMatchObject({ name: 'Réactivé' });
    expect(await B.cache.serverVersions.get(['accounts', keyString(acc.id)])).toMatchObject({ version: 4, deleted: false });

    // Rien de nouveau : une requête, 0 changement, curseur inchangé.
    const before = await cursorOf(B.cache);
    B.pulls.length = 0;
    o = await B.sync.request();
    expect(applied(o)).toMatchObject({ received: 0, applied: 0 });
    expect(B.pulls).toHaveLength(1);
    expect(await cursorOf(B.cache)).toBe(before);
    await expectCacheMatchesServer(B.cache, server, u);
  });

  it('l’affichage (lecteur du cache) voit les changements récupérés ; B peut ensuite écrire sans conflit', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const A = await device(server, u);
    const B = await device(server, u);
    const acc = await A.repo.createAccount(account('Visible'));
    await B.sync.request();
    expect((await B.repo.snapshot())!.accounts.some((a) => a.id === acc.id && a.name === 'Visible')).toBe(true);
    await B.repo.updateAccount(acc.id, { name: 'Par B' }); // version attendue = celle récupérée
    expect(server.entry(u, 'accounts', acc.id)).toMatchObject({ version: 2, row: { name: 'Par B' } });
  });

  it('R2 : une modification faite PENDANT le chargement complet (après la borne) est récupérée au cycle suivant', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    const data = await seed(server, u);
    const target = data.accounts![0] as Row;
    const factory = new IDBFactory();
    const cache = new CloudCacheDB(cloudCacheName(u), { userId: u, dexie: { indexedDB: factory, IDBKeyRange } });
    const spy = spySource(server, u);
    let done = false;
    const source: CloudReadSource = {
      ...spy.source,
      page: async (q, o, l) => {
        // Les comptes sont déjà lus : l'autre appareil modifie un compte avant la fin du chargement.
        if (q.table === 'transactions' && !done) {
          done = true;
          const e = server.entry(u, 'accounts', target.id as string)!;
          await commitAs(server, u, [put('accounts', { ...e.row, name: 'Pendant le chargement' }, e.version)]);
        }
        return spy.source.page(q, o, l);
      },
    };
    await loadCloudCache(source, cache, u);
    expect(done).toBe(true);
    expect((await cache.accounts.get(target.id as string))?.name).not.toBe('Pendant le chargement'); // version antérieure (P40)
    const sync = new CloudSync({ userId: u, cache, source: spy.source, queue: createOperationQueue() });
    expect(applied(await sync.request())).toMatchObject({ applied: 1 });
    expect((await cache.accounts.get(target.id as string))?.name).toBe('Pendant le chargement');
    await expectCacheMatchesServer(cache, server, u);
  });

  it('plus de 1 000 changements : 3 pages, TOUS appliqués en une seule transaction, curseur = borne', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const B = await device(server, u);
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: randomUUID(), userId: u, ...account(`C${i}`), createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }));
    await commitAs(server, u, rows.map((r) => put('accounts', r)));
    const tx = vi.spyOn(B.cache, 'transaction');
    const o = await B.sync.request();
    expect(o.status === 'applied' && o.pages).toBe(3);
    expect(applied(o)).toMatchObject({ received: 2500, applied: 2500 });
    expect(tx.mock.calls.filter((c) => c[0] === 'rw')).toHaveLength(1);
    expect(B.pulls.map((p) => p.limit)).toEqual([1000, 1000, 1000]);
    expect(new Set(B.pulls.slice(1).map((p) => p.bound)).size).toBe(1); // borne constante
    expect(await cursorOf(B.cache)).toBe(B.pulls[1].bound);
    await expectCacheMatchesServer(B.cache, server, u);
  });

  it('réappliquer un intervalle déjà connu (curseur remis à 0) ne modifie rien : version la plus haute', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const B = await device(server, u);
    const before = await B.cache.serverVersions.toArray();
    const cursor = await cursorOf(B.cache);
    await B.cache.syncState.put({ id: PULL_STATE_ID, cursor: '0' });
    const o = await B.sync.request();
    expect(applied(o)?.received).toBeGreaterThan(0);
    expect(applied(o)?.applied).toBe(0);
    expect(await B.cache.serverVersions.toArray()).toEqual(before);
    expect(await cursorOf(B.cache)).toBe(cursor);
  });
  it('suppression d’un taux de change (autre table que les comptes) faite ailleurs : propagée comme toute suppression', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    const data = await seed(server, u);
    const B = await device(server, u);
    const rate = data.rates![0] as Row;
    const e = server.entry(u, 'rates', rate.id as string)!;
    await commitAs(server, u, [del('rates', rate.id as string, e.version)]);
    await B.sync.request();
    expect(await B.cache.table('rates').get(rate.id as string)).toBeUndefined();
    await expectCacheMatchesServer(B.cache, server, u);
  });
});

describe('V4.2 — version la plus haute et file des opérations', () => {
  it('R1 : lot à l’issue inconnue, version plus récente récupérée, puis résolution « replayed » : le cache garde la plus récente', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const A = await device(server, u);
    const B = await device(server, u);
    const acc = await B.repo.createAccount(account('B1'));
    server.loseResponseNext = new Error('réponse perdue');
    await expect(B.repo.updateAccount(acc.id, { name: 'B2' })).rejects.toBeInstanceOf(CloudTransportError); // v2, non confirmée
    await A.sync.request();
    await A.repo.updateAccount(acc.id, { name: 'A3' }); // v3
    await B.sync.request(); // B reçoit la v3
    expect(await B.cache.accounts.get(acc.id)).toMatchObject({ name: 'A3' });
    await B.repo.updateSettings({ theme: 'dark' }); // résolution du lot v2 (rejoué) avant l'écriture
    expect(await B.cache.accounts.get(acc.id)).toMatchObject({ name: 'A3' });
    expect(await B.cache.serverVersions.get(['accounts', keyString(acc.id)])).toMatchObject({ version: 3 });
    await expectCacheMatchesServer(B.cache, server, u);
  });

  it('R3 : l’application attend la fin de l’écriture en cours (même file), sans conflit ni perte', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const A = await device(server, u);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inCommit = new Promise<void>((r) => (entered = r));
    const gated: CloudTransport = {
      kind: 'porte',
      commit: async (c) => {
        entered();
        await gate;
        return server.as(u).commit(c);
      },
      resolve: (id, user) => server.as(u).resolve(id, user),
    };
    const B = await device(server, u, new IDBFactory(), gated);
    const acc = await A.repo.createAccount(account('Par A'));
    const write = B.repo.updateSettings({ theme: 'dark' });
    await inCommit; // l'écriture de B est en cours (lot envoyé, réponse attendue)
    let fetched = false;
    B.state.afterPull = (page) => ((fetched = true), page);
    const syncing = B.sync.request();
    await waitFor(() => fetched, 'récupération terminée pendant l’écriture');
    expect(B.pulls).toHaveLength(1); // la récupération (réseau) n'attend pas la file…
    expect(await B.cache.accounts.get(acc.id)).toBeUndefined(); // …mais l'application, si
    release();
    await write;
    expect(applied(await syncing)).toMatchObject({ applied: 1 });
    expect(await B.cache.accounts.get(acc.id)).toMatchObject({ name: 'Par A' });
    expect((await B.repo.getSettings())?.theme).toBe('dark');
    await expectCacheMatchesServer(B.cache, server, u);
  });

  it('une seule synchronisation à la fois : des demandes pendant un cycle donnent UNE relance', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const B = await device(server, u);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    B.state.beforePull = () => (B.pulls.length === 1 ? gate : undefined);
    const p1 = B.sync.request();
    const p2 = B.sync.request();
    const p3 = B.sync.request();
    await waitFor(() => B.pulls.length >= 1, 'premier cycle en cours');
    expect(B.pulls).toHaveLength(1); // le premier cycle est bloqué : aucun second cycle en parallèle
    release();
    await Promise.all([p1, p2, p3]);
    expect(B.pulls).toHaveLength(2); // le cycle en cours + une seule relance
  });
});

describe('V4.2 — arrêt, session et isolation (R6)', () => {
  it('arrêt PENDANT la récupération : aucune écriture, curseur inchangé, plus aucune requête', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const A = await device(server, u);
    const B = await device(server, u);
    await A.repo.createAccount(account('X'));
    const before = await B.cache.serverVersions.toArray();
    const cursor = await cursorOf(B.cache);
    B.state.beforePull = () => B.sync.stop();
    const o = await B.sync.request();
    expect(o).toEqual({ status: 'skipped', reason: 'stopped' });
    expect(await B.cache.serverVersions.toArray()).toEqual(before);
    expect(await cursorOf(B.cache)).toBe(cursor);
    expect(await B.sync.request()).toEqual({ status: 'skipped', reason: 'stopped' });
    expect(B.pulls).toHaveLength(1);
  });

  it('session changée (autre compte) entre la récupération et l’écriture : aucune écriture', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const A = await device(server, u);
    const B = await device(server, u);
    await A.repo.createAccount(account('X'));
    const before = await B.cache.serverVersions.toArray();
    B.state.afterPull = (page) => {
      B.state.session = randomUUID(); // changement de compte dans un autre onglet
      return page;
    };
    expect(await B.sync.request()).toEqual({ status: 'skipped', reason: 'stale' });
    expect(await B.cache.serverVersions.toArray()).toEqual(before);
  });

  it('sans session : aucune requête envoyée', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const B = await device(server, u);
    B.state.session = null;
    expect(await B.sync.request()).toEqual({ status: 'skipped', reason: 'stale' });
    expect(B.pulls).toHaveLength(0);
  });

  it('isolation : une ligne d’un autre utilisateur dans la réponse → refus du cycle entier, aucune écriture', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    const other = randomUUID();
    await seed(server, u);
    await seed(server, other);
    const A = await device(server, u);
    const B = await device(server, u);
    await A.repo.createAccount(account('Mien'));
    const foreign = server.pull(other, { cursor: '0', limit: 1 }).rows[0];
    B.state.afterPull = (page) => ({ ...(page as object), rows: [...(page as { rows: unknown[] }).rows, foreign] });
    const before = await B.cache.serverVersions.toArray();
    const cursor = await cursorOf(B.cache);
    const o = await B.sync.request();
    expect(o.status).toBe('failed');
    expect(errorOf(o)).toBeInstanceOf(CloudReadError);
    expect(errorOf(o)).toMatchObject({ code: 'foreign_row' });
    expect(await B.cache.serverVersions.toArray()).toEqual(before);
    expect(await cursorOf(B.cache)).toBe(cursor);
  });

  it('cache d’un autre utilisateur refusé à la construction', () => {
    const u = randomUUID();
    const cache = new CloudCacheDB(cloudCacheName(u), { userId: u, dexie: { indexedDB: new IDBFactory(), IDBKeyRange } });
    expect(() => new CloudSync({ userId: randomUUID(), cache, source: new MemoryTransport().readSource(u), queue: createOperationQueue() })).toThrow();
  });
});

describe('V4.2 — erreurs : rien n’est écrit, le curseur ne bouge pas', () => {
  async function prepared() {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const A = await device(server, u);
    const B = await device(server, u);
    await A.repo.createAccount(account('X'));
    return { server, u, A, B, before: await B.cache.serverVersions.toArray(), cursor: await cursorOf(B.cache) };
  }

  it('réseau indisponible', async () => {
    const { B, before, cursor } = await prepared();
    B.state.beforePull = () => {
      throw new TypeError('Failed to fetch');
    };
    const o = await B.sync.request();
    expect(o.status).toBe('failed');
    expect(errorOf(o)).toMatchObject({ code: 'unavailable' });
    expect(await B.cache.serverVersions.toArray()).toEqual(before);
    expect(await cursorOf(B.cache)).toBe(cursor);
    B.state.beforePull = undefined; // retour du réseau : reprise depuis le même curseur
    expect(applied(await B.sync.request())).toMatchObject({ applied: 1 });
  });

  it('refus invalid_pull (curseur postérieur à la borne, ex. base restaurée) : synchronisation sans effet, données conservées', async () => {
    const { B, before } = await prepared();
    await B.cache.syncState.put({ id: PULL_STATE_ID, cursor: '999999999999' });
    const o = await B.sync.request();
    expect(errorOf(o)).toMatchObject({ code: 'rejected', reason: 'PT400' });
    expect(await B.cache.serverVersions.toArray()).toEqual(before);
    expect(await cursorOf(B.cache)).toBe('999999999999');
  });

  it('réponse non conforme (borne modifiée pendant la pagination, ligne illisible)', async () => {
    const { B, before } = await prepared();
    B.state.afterPull = (page) => ({ ...(page as object), rows: [{ table: 'accounts', key: {}, row: { id: 'x' } }] });
    let o = await B.sync.request();
    expect(errorOf(o)).toMatchObject({ code: 'invalid_row' });
    B.state.afterPull = (page) => ({ ...(page as object), bound: 'abc' });
    o = await B.sync.request();
    expect(errorOf(o)).toMatchObject({ code: 'invalid_response' });
    expect(await B.cache.serverVersions.toArray()).toEqual(before);
  });

  it('écriture du cache impossible (quota) : transaction annulée, curseur inchangé', async () => {
    const { B, before, cursor } = await prepared();
    vi.spyOn(B.cache.serverVersions, 'put').mockImplementationOnce(() => {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    });
    const o = await B.sync.request();
    expect(errorOf(o)).toBeInstanceOf(CloudSyncWriteError);
    expect(await B.cache.serverVersions.toArray()).toEqual(before);
    expect(await cursorOf(B.cache)).toBe(cursor);
  });

  it('cache sans curseur (aucun chargement avec borne) : aucune requête', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const cache = new CloudCacheDB(cloudCacheName(u), { userId: u, dexie: { indexedDB: new IDBFactory(), IDBKeyRange } });
    const spy = spySource(server, u);
    const sync = new CloudSync({ userId: u, cache, source: spy.source, queue: createOperationQueue() });
    expect(await sync.request()).toEqual({ status: 'skipped', reason: 'no_cursor' });
    expect(spy.pulls).toHaveLength(0);
  });
});

describe('V4.2 — deux onglets, un seul cache', () => {
  it('synchronisations concurrentes : aucune perte, le curseur ne recule jamais', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const A = await device(server, u);
    const factory = new IDBFactory();
    const T1 = await device(server, u, factory);
    const T2cache = new CloudCacheDB(cloudCacheName(u), { userId: u, dexie: { indexedDB: factory, IDBKeyRange } });
    const spy2 = spySource(server, u);
    const T2 = new CloudSync({ userId: u, cache: T2cache, source: spy2.source, queue: createOperationQueue() });
    for (let i = 0; i < 5; i++) {
      await A.repo.createAccount(account(`N${i}`));
      const [o1, o2] = await Promise.all([T1.sync.request(), T2.request()]);
      expect([o1.status, o2.status]).toEqual(['applied', 'applied']);
    }
    const c1 = await cursorOf(T1.cache);
    await T2cache.syncState.put({ id: PULL_STATE_ID, cursor: c1! }); // même valeur
    await A.repo.createAccount(account('Dernier'));
    await T2.request(); // T2 avance le curseur
    const advanced = await cursorOf(T1.cache);
    expect(BigInt(advanced!)).toBeGreaterThan(BigInt(c1!));
    // T1 part d'un curseur plus ancien lu avant : le maximum est conservé.
    await T1.sync.request();
    expect(await cursorOf(T1.cache)).toBe(advanced);
    await expectCacheMatchesServer(T1.cache, server, u);
  });

  it('un chargement complet (autre onglet) REMPLACE le curseur par sa propre borne (jamais un maximum)', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const B = await device(server, u);
    await B.cache.syncState.put({ id: PULL_STATE_ID, cursor: '999999999999' });
    await loadCloudCache(server.readSource(u), B.cache, u);
    const cursor = await cursorOf(B.cache);
    expect(BigInt(cursor!)).toBeLessThan(999999999999n);
    expect(server.pull(u, { cursor: cursor! }).rows).toHaveLength(0);
  });
});

describe('V4.2 — déclencheurs (D7)', () => {
  function fakeEnv() {
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    const timers: { fn: () => void; ms: number }[] = [];
    const cleared: unknown[] = [];
    const env: SyncTriggerEnvironment = {
      target,
      document: doc as unknown as SyncTriggerEnvironment['document'],
      setInterval: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearInterval: (h) => cleared.push(h),
    };
    return { env, target, doc, timers, cleared };
  }

  it('retour au premier plan, retour du réseau et minuterie de 60 s lancent une synchronisation ; masqué : rien ; arrêt : plus rien', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const B = await device(server, u);
    const request = vi.spyOn(B.sync, 'request');
    const f = fakeEnv();
    B.sync.start(f.env);
    expect(f.timers).toEqual([{ fn: expect.any(Function), ms: 60_000 }]);
    expect(request).not.toHaveBeenCalled(); // aucune synchronisation supplémentaire au démarrage (D2)
    f.target.dispatchEvent(new Event('online'));
    expect(request).toHaveBeenCalledTimes(1);
    f.doc.visibilityState = 'hidden';
    f.doc.dispatchEvent(new Event('visibilitychange'));
    expect(request).toHaveBeenCalledTimes(1);
    f.doc.visibilityState = 'visible';
    f.doc.dispatchEvent(new Event('visibilitychange'));
    expect(request).toHaveBeenCalledTimes(2);
    f.timers[0].fn();
    expect(request).toHaveBeenCalledTimes(3);
    await B.sync.request();
    B.sync.stop();
    expect(f.cleared).toEqual([1]);
    f.target.dispatchEvent(new Event('online'));
    f.doc.dispatchEvent(new Event('visibilitychange'));
    expect(request).toHaveBeenCalledTimes(4); // aucun déclenchement après l'arrêt
    B.sync.start(f.env); // arrêt définitif
    expect(f.timers).toHaveLength(1);
  });

  it('sans environnement navigateur : aucun déclencheur', async () => {
    const server = new MemoryTransport();
    const u = randomUUID();
    await seed(server, u);
    const B = await device(server, u);
    expect(() => B.sync.start(null)).not.toThrow();
    B.sync.stop();
  });
});
