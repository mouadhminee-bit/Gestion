/**
 * V3.4-c — révocation du cache (`CloudCacheDB`), suppression et purge des caches
 * (`cloudCaches.ts`), chargement lié à la session (`cloudLoadCycle.ts`) :
 *  - [F] fake-indexeddb + Dexie : contenu RÉEL des bases, liste `indexedDB.databases()` ;
 *  - [S] VRAI client Supabase (environnement node : le SDK n'y crée pas de BroadcastChannel)
 *    branché sur le serveur PostgREST / Auth simulé, session dans un stockage partagé.
 * Les tests multi-onglets (BroadcastChannel du SDK, jsdom) sont dans
 * `src/features/auth/CloudMultiTab.test.ts`. Aucune requête réseau réelle, aucun accès DEV/PROD.
 */
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NexoraDB } from '../db';
import { CloudCacheDB, cloudCacheName } from './CloudCacheDB';
import { prepareCloudLoad, writeCloudLoad } from './CloudLoader';
import { CloudReadError, readCloudData } from './CloudReader';
import { HttpReadSource } from './HttpReadSource';
import { deleteCloudCache, purgeOtherCloudCaches } from './cloudCaches';
import { runCloudLoad, type CloudLoadContext } from './cloudLoadCycle';
import { MemoryTransport } from './MemoryTransport';
import { CLOUD_TABLES, MAPPING, deserializeRow } from './mapping';
import { keyString } from './transport';
import { simBrowser, type SimBrowser } from '@/test/cloudBrowser';
import type { RecordedRequest } from '@/test/postgrestSimulator';
import { keyOf, seed } from '@/test/cloudData';

type Row = Record<string, unknown>;
const ALWAYS: CloudLoadContext = { isCurrent: () => true };
const dexieOf = (factory: IDBFactory) => ({ indexedDB: factory, IDBKeyRange });
const cacheOf = (factory: IDBFactory, uid: string) => new CloudCacheDB(cloudCacheName(uid), { userId: uid, dexie: dexieOf(factory) });
const names = async (factory: IDBFactory) => (await factory.databases()).map((d) => d.name ?? '').sort();

/** Contenu RÉEL de toutes les tables d'une base (ouverte puis refermée). */
async function dump(db: Dexie): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of [...db.tables].sort((a, b) => a.name.localeCompare(b.name))) out[t.name] = await t.toArray();
  db.close();
  return out;
}

/** Le cache de `uid` contient exactement les lignes actives et les versions du serveur. */
async function expectCacheMatchesServer(factory: IDBFactory, server: MemoryTransport, uid: string) {
  const cache = cacheOf(factory, uid);
  for (const table of CLOUD_TABLES) {
    const expected = server
      .sqlRows(uid, table)
      .filter((r) => r.deleted_at === null)
      .map((r) => deserializeRow(table, r).row as unknown as Row);
    const sort = (rows: Row[]) => [...rows].sort((a, b) => keyString(keyOf(table, a)).localeCompare(keyString(keyOf(table, b))));
    expect(sort((await cache.table(table).toArray()) as Row[]), table).toEqual(sort(expected));
  }
  expect((await cache.serverVersions.toArray()).length).toBe(CLOUD_TABLES.reduce((n, t) => n + server.sqlRows(uid, t).length, 0));
  cache.close();
}

const isGet = (sqlTable: string) => (r: RecordedRequest) => r.method === 'GET' && r.path === `/rest/v1/${sqlTable}`;
const isHead = (sqlTable: string) => (r: RecordedRequest) => r.method === 'HEAD' && r.path === `/rest/v1/${sqlTable}`;

/** Navigateur avec un utilisateur connecté, ses données sur le serveur, et un onglet. */
async function signedIn(b: SimBrowser = simBrowser()) {
  const uid = randomUUID();
  await seed(b.sim.server, uid);
  b.seedSession(uid);
  const { client } = b.tab();
  const deps = { source: new HttpReadSource(client), indexedDB: b.factory, IDBKeyRange };
  return { b, uid, deps, load: (ctx: CloudLoadContext = ALWAYS) => runCloudLoad(deps, uid, ctx) };
}

let networkProbe: ReturnType<typeof vi.fn>;
const browsers: SimBrowser[] = [];
beforeEach(() => {
  networkProbe = vi.fn(() => Promise.reject(new Error('réseau réel interdit pendant les tests')));
  vi.stubGlobal('fetch', networkProbe);
});
afterEach(async () => {
  expect(networkProbe).not.toHaveBeenCalled();
  for (const b of browsers.splice(0)) await b.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const browser = () => {
  const b = simBrowser();
  browsers.push(b);
  return b;
};

// -------------------------------------------------------------------------------------------
// [F] T41 — révocation d'un cache supprimé par une autre connexion
// -------------------------------------------------------------------------------------------

describe('V3.4-c [F] T41 — cache supprimé par une autre connexion (Dexie, fake-indexeddb)', () => {
  it('T41 comparatif SANS « return false » : le gestionnaire par défaut de Dexie s’exécute ensuite et la base est RECRÉÉE au premier accès', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const factory = new IDBFactory();
    const uid = randomUUID();
    const name = cloudCacheName(uid);
    // Mise en œuvre naïve (hypothèse initiale du cadrage) : fermeture sans réouverture, SANS arrêter la chaîne.
    const naive = new NexoraDB(name, dexieOf(factory));
    naive.on('versionchange', () => {
      naive.close({ disableAutoOpen: true });
    });
    await naive.table('accounts').put({ id: 'a', userId: uid });
    expect(await deleteCloudCache(uid, { indexedDB: factory })).toBe('deleted');
    expect(await names(factory)).not.toContain(name);
    // Accès suivant : la base est rouverte… donc RECRÉÉE (vide).
    expect(await naive.table('accounts').toArray()).toEqual([]);
    expect(await names(factory)).toContain(name);
    naive.close();
  });

  it('T41 CloudCacheDB (« return false ») : instance révoquée, lecture et écriture refusées (DatabaseClosedError), base NON recréée ; gestionnaire par défaut écarté', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const factory = new IDBFactory();
    const uid = randomUUID();
    const cache = cacheOf(factory, uid);
    await cache.table('accounts').put({ id: 'a', userId: uid });
    expect(cache.revoked).toBe(false);
    expect(await deleteCloudCache(uid, { indexedDB: factory })).toBe('deleted');
    expect(cache.revoked).toBe(true);
    await expect(cache.table('accounts').toArray()).rejects.toMatchObject({ name: 'DatabaseClosedError' });
    await expect(cache.table('accounts').put({ id: 'b', userId: uid })).rejects.toMatchObject({ name: 'DatabaseClosedError' });
    expect(await names(factory)).not.toContain(cloudCacheName(uid));
    expect(warn).not.toHaveBeenCalled(); // l'avertissement du gestionnaire par défaut de Dexie n'est pas émis
  });

  it('T41 mise à niveau de schéma par une autre connexion (nouvelle version) : comportement par défaut de Dexie conservé, instance NON révoquée', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const factory = new IDBFactory();
    const uid = randomUUID();
    const cache = cacheOf(factory, uid);
    await cache.open();
    await new Promise<void>((resolve, reject) => {
      const r = factory.open(cloudCacheName(uid), 500);
      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
      r.onerror = () => reject(r.error);
    });
    expect(cache.revoked).toBe(false);
  });

  it('suppression demandée PENDANT la transaction d’écriture — ÉTAT FINAL SEULEMENT : aucune base, instance révoquée. Ce test NE vérifie PAS l’ordre prévu par la norme IndexedDB (fin de la transaction, puis suppression) : fake-indexeddb 6.0.0 supprime d’abord ; validation réservée à un vrai navigateur (V3.7)', async () => {
    const factory = new IDBFactory();
    const server = new MemoryTransport();
    const uid = randomUUID();
    await seed(server, uid);
    const prepared = prepareCloudLoad(await readCloudData(server.readSource(uid), uid), uid);
    const cache = cacheOf(factory, uid);
    await cache.open();
    const write = writeCloudLoad(cache, prepared).then(
      () => 'écriture terminée',
      (e: unknown) => `écriture en échec (${(e as Error).name})`,
    );
    const removal = deleteCloudCache(uid, { indexedDB: factory });
    await Promise.all([write, removal]);
    expect(await removal).toBe('deleted');
    expect(cache.revoked).toBe(true);
    expect(await names(factory)).not.toContain(cloudCacheName(uid));
  });
});

// -------------------------------------------------------------------------------------------
// [F] Suppression (D6) et purge (P-3)
// -------------------------------------------------------------------------------------------

describe('V3.4-c [F] — suppression (D6) et purge (P-3) des caches', () => {
  it('D6 deleteCloudCache : le cache de l’utilisateur est supprimé, les autres bases restent', async () => {
    const factory = new IDBFactory();
    const [u1, u2] = [randomUUID(), randomUUID()];
    await cacheOf(factory, u1).table('accounts').put({ id: 'a', userId: u1 });
    const c2 = cacheOf(factory, u2);
    await c2.table('accounts').put({ id: 'b', userId: u2 });
    c2.close();
    expect(await deleteCloudCache(u1, { indexedDB: factory })).toBe('deleted');
    expect(await names(factory)).toEqual([cloudCacheName(u2)]);
  });

  it('T28 purge P-3 : caches des AUTRES utilisateurs supprimés ; « nexora », le cache courant et une base étrangère INTACTS (contenu relu)', async () => {
    const factory = new IDBFactory();
    const [me, other1, other2] = [randomUUID(), randomUUID(), randomUUID()];
    const local = new NexoraDB('nexora', dexieOf(factory));
    await local.table('accounts').put({ id: 'compte-local', userId: 'local', name: 'Local' });
    const localBefore = await dump(local);
    const mine = cacheOf(factory, me);
    await mine.table('accounts').put({ id: 'm', userId: me });
    const mineBefore = await dump(mine);
    for (const u of [other1, other2]) {
      const c = cacheOf(factory, u);
      await c.table('accounts').put({ id: u, userId: u });
      c.close();
    }
    const foreign = new Dexie('autre-application', dexieOf(factory));
    foreign.version(1).stores({ t: 'id' });
    await foreign.table('t').put({ id: 1 });
    foreign.close();
    expect(await purgeOtherCloudCaches(me, { indexedDB: factory })).toEqual({ supported: true, deleted: 2, pending: 0 });
    expect(await names(factory)).toEqual(['autre-application', cloudCacheName(me), 'nexora'].sort());
    expect(await dump(new NexoraDB('nexora', dexieOf(factory)))).toEqual(localBefore);
    expect(await dump(cacheOf(factory, me))).toEqual(mineBefore);
  });

  it('purge sans indexedDB.databases() (navigateur ancien) : rien n’est supprimé', async () => {
    const factory = new IDBFactory();
    const other = randomUUID();
    const c = cacheOf(factory, other);
    await c.table('accounts').put({ id: 'x', userId: other });
    c.close();
    const legacy = { open: factory.open.bind(factory), deleteDatabase: factory.deleteDatabase.bind(factory), cmp: factory.cmp.bind(factory) } as unknown as IDBFactory;
    expect(await purgeOtherCloudCaches(randomUUID(), { indexedDB: legacy })).toEqual({ supported: false, deleted: 0, pending: 0 });
    expect(await names(factory)).toEqual([cloudCacheName(other)]);
  });

  it('T29 suppression bloquée par une connexion qui ne se ferme pas : « pending » après le délai borné, puis base supprimée dès la fermeture', async () => {
    const factory = new IDBFactory();
    const uid = randomUUID();
    const raw: IDBDatabase = await new Promise((resolve, reject) => {
      const r = factory.open(cloudCacheName(uid), 1);
      r.onupgradeneeded = () => r.result.createObjectStore('s');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    raw.onversionchange = () => undefined; // ne se ferme pas
    expect(await deleteCloudCache(uid, { indexedDB: factory, timeoutMs: 40 })).toBe('pending');
    expect(await names(factory)).toContain(cloudCacheName(uid));
    raw.close();
    for (let i = 0; i < 20 && (await names(factory)).includes(cloudCacheName(uid)); i++) await new Promise((r) => setTimeout(r, 10));
    expect(await names(factory)).not.toContain(cloudCacheName(uid));
  });
});

// -------------------------------------------------------------------------------------------
// [S] Chargement lié à la session (vrai client Supabase, environnement node)
// -------------------------------------------------------------------------------------------

describe('V3.4-c [S] T42 — constat en environnement node', () => {
  it('sans `window` ni `document`, le SDK (auth-js 2.119) ne crée AUCUN BroadcastChannel : la diffusion entre onglets est testée sous jsdom (CloudMultiTab.test.ts)', () => {
    const b = browser();
    const { client } = b.tab();
    expect(typeof window).toBe('undefined');
    expect(typeof BroadcastChannel).toBe('function'); // disponible dans Node…
    expect((client.auth as unknown as { broadcastChannel: unknown }).broadcastChannel).toBeNull(); // … mais non utilisé par le SDK
  });
});

describe('V3.4-c [S] — chargement lié à la session : invalidation, D-3, P-6', () => {
  it('nominal : ouverture du cache, purge P-3, lecture, écriture ; cache relu = serveur ; caches d’autres utilisateurs purgés', async () => {
    const { b, uid, load } = await signedIn(browser());
    const stranger = randomUUID();
    const c = cacheOf(b.factory, stranger);
    await c.table('accounts').put({ id: 'x', userId: stranger });
    c.close();
    const outcome = await load();
    expect(outcome).toMatchObject({ status: 'loaded', purge: { supported: true, deleted: 1, pending: 0 } });
    expect(await names(b.factory)).toEqual([cloudCacheName(uid)]);
    await expectCacheMatchesServer(b.factory, b.sim.server, uid);
    // V4.2 : borne de récupération (1 appel pull_changes, AVANT la lecture) + 18 pages + 18 contre-vérifications.
    expect(b.sim.requests.filter((r) => r.path.startsWith('/rest/v1/'))).toHaveLength(37);
    expect(b.sim.requests.find((r) => r.path.startsWith('/rest/v1/'))).toMatchObject({ method: 'POST', path: '/rest/v1/rpc/pull_changes' });
  });

  it('T38 déconnexion PENDANT la lecture (session retirée du stockage partagé) : plus aucune requête, AUCUNE écriture, cache supprimé', async () => {
    const { b, uid, load } = await signedIn(browser());
    await load(); // cache existant, à supprimer
    const writes = vi.spyOn(CloudCacheDB.prototype, 'transaction');
    const from = b.sim.requests.length;
    b.sim.onRequest = (r) => {
      if (isGet(MAPPING.transactions.sqlTable)(r)) b.dropSession();
    };
    const outcome = await load();
    expect(outcome).toEqual({ status: 'cancelled', reason: 'session_lost', cacheDeleted: true });
    const sent = b.sim.requests.slice(from);
    expect(sent.at(-1)).toMatchObject({ method: 'GET', path: `/rest/v1/${MAPPING.transactions.sqlTable}` });
    expect(sent).toHaveLength(CLOUD_TABLES.indexOf('transactions') + 2); // borne de récupération (V4.2) + pages jusqu'aux transactions
    expect(writes).not.toHaveBeenCalled();
    expect(await names(b.factory)).not.toContain(cloudCacheName(uid));
  });

  it('T38 déconnexion JUSTE AVANT la transaction (pendant la dernière contre-vérification) : AUCUNE écriture, cache supprimé', async () => {
    const { b, uid, load } = await signedIn(browser());
    const writes = vi.spyOn(CloudCacheDB.prototype, 'transaction');
    b.sim.onRequest = (r) => {
      if (isHead(MAPPING.notificationStates.sqlTable)(r)) b.dropSession();
    };
    const outcome = await load();
    expect(outcome).toEqual({ status: 'cancelled', reason: 'session_lost', cacheDeleted: true });
    expect(b.sim.requests.filter((r) => r.path.startsWith('/rest/v1/'))).toHaveLength(37); // borne (V4.2) + 36 lectures
    expect(writes).not.toHaveBeenCalled();
    expect(await names(b.factory)).not.toContain(cloudCacheName(uid));
  });

  it('T13 chargement REMPLACÉ pendant la lecture (nouvel essai, autre utilisateur…) : abandon sans écriture ; session toujours valide → cache CONSERVÉ à l’identique', async () => {
    const { b, uid, load } = await signedIn(browser());
    await load();
    const before = await dump(cacheOf(b.factory, uid));
    let current = true;
    let invalidatedAt = -1;
    b.sim.onRequest = (r, i) => {
      if (isGet(MAPPING.budgets.sqlTable)(r)) {
        current = false;
        invalidatedAt = i;
      }
    };
    const writes = vi.spyOn(CloudCacheDB.prototype, 'transaction');
    const outcome = await load({ isCurrent: () => current });
    expect(outcome).toEqual({ status: 'cancelled', reason: 'superseded', cacheDeleted: false });
    expect(b.sim.requests).toHaveLength(invalidatedAt + 1); // plus AUCUNE requête après l'invalidation
    expect(writes).not.toHaveBeenCalled();
    expect(await dump(cacheOf(b.factory, uid))).toEqual(before);
  });

  it('session perdue APRÈS la validation de la transaction : revérification finale → cache supprimé', async () => {
    const { b, uid, load } = await signedIn(browser());
    const original = CloudCacheDB.prototype.transaction;
    vi.spyOn(CloudCacheDB.prototype, 'transaction').mockImplementation(async function (this: CloudCacheDB, ...args: unknown[]) {
      const r = await (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      b.dropSession(); // déconnexion survenue juste après la validation
      return r;
    } as never);
    const outcome = await load();
    expect(outcome).toEqual({ status: 'cancelled', reason: 'session_lost', cacheDeleted: true });
    expect(await names(b.factory)).not.toContain(cloudCacheName(uid));
  });

  it('T40 résidu P-6 : session déjà retirée et cache déjà supprimé AVANT l’ouverture → base vide recréée puis SUPPRIMÉE aussitôt ; aucune requête ; aucune transaction d’écriture', async () => {
    const { b, uid, load } = await signedIn(browser());
    await load();
    b.dropSession(); // déconnexion dans un autre onglet…
    expect(await deleteCloudCache(uid, { indexedDB: b.factory })).toBe('deleted'); // … qui a supprimé le cache
    const from = b.sim.requests.length;
    const opens = vi.spyOn(b.factory, 'open');
    const writes = vi.spyOn(CloudCacheDB.prototype, 'transaction');
    const outcome = await load();
    expect(outcome).toEqual({ status: 'cancelled', reason: 'session_lost', cacheDeleted: true });
    expect(opens.mock.calls.some(([name]) => name === cloudCacheName(uid))).toBe(true); // base (vide) recréée par l'ouverture
    expect(b.sim.requests.slice(from)).toHaveLength(0); // aucune requête
    expect(writes).not.toHaveBeenCalled(); // aucune donnée écrite
    expect(await names(b.factory)).not.toContain(cloudCacheName(uid)); // supprimée aussitôt
  });

  it('cache supprimé par un AUTRE onglet pendant la lecture (déconnexion là-bas) : ancien chargement abandonné, base NON recréée', async () => {
    const { b, uid, load } = await signedIn(browser());
    const writes = vi.spyOn(CloudCacheDB.prototype, 'transaction');
    b.sim.onRequest = async (r) => {
      if (!isGet(MAPPING.goals.sqlTable)(r)) return;
      b.dropSession(); // l'autre onglet : session retirée, puis suppression du cache
      await deleteCloudCache(uid, { indexedDB: b.factory });
    };
    const outcome = await load();
    expect(outcome.status).toBe('cancelled');
    expect(writes).not.toHaveBeenCalled();
    expect(await names(b.factory)).not.toContain(cloudCacheName(uid));
  });

  it('D-3 panne réseau, 503 ou délai dépassé pendant la lecture : erreur `unavailable`, cache CONSERVÉ à l’identique, base non supprimée', async () => {
    for (const failure of [{ network: true as const }, { status: 503, body: '{"code":"PGRST002","message":"x"}' }]) {
      const { b, uid, load } = await signedIn(browser());
      await load();
      const before = await dump(cacheOf(b.factory, uid));
      b.sim.onRequest = (r) => {
        if (isGet(MAPPING.debts.sqlTable)(r)) b.sim.respondNext(failure);
      };
      const e = await load().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CloudReadError);
      expect((e as CloudReadError).code).toBe('unavailable');
      expect(await names(b.factory)).toContain(cloudCacheName(uid));
      expect(await dump(cacheOf(b.factory, uid))).toEqual(before);
    }
  });

  it('D-3 refus 401 pendant la lecture : erreur `unauthorized` remontée (la vérification par Auth relève du cycle de session), cache CONSERVÉ', async () => {
    const { b, uid, load } = await signedIn(browser());
    await load();
    const before = await dump(cacheOf(b.factory, uid));
    b.sim.onRequest = (r) => {
      if (isGet(MAPPING.assets.sqlTable)(r)) b.sim.respondNext({ status: 401, body: '{"code":"PGRST303","message":"JWT expired"}' });
    };
    const e = await load().catch((x: unknown) => x);
    expect((e as CloudReadError).code).toBe('unauthorized');
    expect(await dump(cacheOf(b.factory, uid))).toEqual(before);
  });
});
