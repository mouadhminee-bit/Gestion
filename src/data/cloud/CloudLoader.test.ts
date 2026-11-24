/**
 * V3.4-b — chargeur du cache Cloud (`CloudLoader.ts`) :
 *  - [U] tests UNITAIRES : préparation (`prepareCloudLoad`), sans base ;
 *  - [T] tests de TRANSACTION IndexedDB : fake-indexeddb + Dexie, contenu RÉEL des tables
 *    relu après chaque chargement, pannes injectées au niveau des écritures (middleware
 *    Dexie), journal des écritures (une seule transaction, ordre, tables touchées) ;
 *  - [I] tests d'INTÉGRATION : `MemoryTransport` aligné → `readCloudData` → chargeur →
 *    `CloudRepository` / `CloudStorage` (écritures après chargement, `ensureUser`).
 * Aucune requête réseau (fetch global remplacé par une sonde), aucun accès à DEV ou PROD.
 */
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NexoraDB } from '../db';
import { CloudCacheDB, SERVER_VERSIONS_TABLE, SYNC_STATE_TABLE, type ServerVersionRecord } from './CloudCacheDB';
import { CloudLoadError, LOADED_TABLES, loadCloudCache, loadCloudData, prepareCloudLoad, writeCloudLoad } from './CloudLoader';
import { readCloudData, type CloudReadResult, type CloudReadSource } from './CloudReader';
import { CloudRepository } from './CloudRepository';
import { cloudCacheName } from './CloudStorage';
import { MemoryTransport, REGISTERED_AT } from './MemoryTransport';
import { CLOUD_TABLES, deserializeRow, type CloudTableName } from './mapping';
import { CloudConflictError, keyString } from './transport';
import { commitAs, del, keyOf, put, seed } from '@/test/cloudData';

const MARK = 'SUPPRIMÉ-CONTENU-SECRET';
type Row = Record<string, unknown>;

/** Cache d'un appareil (fabrique IndexedDB propre, ou celle des tests), instrumenté. */
function device(uid: string, factory?: IDBFactory) {
  const cache = new CloudCacheDB(cloudCacheName(uid), { userId: uid, dexie: factory ? { indexedDB: factory, IDBKeyRange } : undefined });
  const log: { table: string; type: string; trans: unknown }[] = [];
  let failure: ((table: string, type: string) => Error | null) | null = null;
  cache.use({
    stack: 'dbcore',
    name: 'instrumentation-test',
    create: (down) => ({
      ...down,
      table: (name) => {
        const t = down.table(name);
        return {
          ...t,
          mutate: (req) => {
            log.push({ table: name, type: req.type, trans: req.trans });
            const e = failure?.(name, req.type);
            return e ? Promise.reject(e) : t.mutate(req);
          },
        };
      },
    }),
  });
  return {
    cache,
    log,
    /** Panne au niveau IndexedDB pour les écritures ciblées (null : aucune). */
    failOn(fn: ((table: string, type: string) => Error | null) | null) {
      failure = fn;
    },
  };
}

/** Contenu RÉEL de toutes les tables de la base (métier, `serverVersions`, `meta`). */
async function dump(db: Dexie): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of [...db.tables].sort((a, b) => a.name.localeCompare(b.name))) out[t.name] = await t.toArray();
  return out;
}

/** Versions attendues : toutes les entrées du serveur (actives et supprimées). */
function serverVersions(server: MemoryTransport, uid: string): ServerVersionRecord[] {
  const out: ServerVersionRecord[] = [];
  for (const table of CLOUD_TABLES) {
    for (const sql of server.sqlRows(uid, table)) {
      const row = deserializeRow(table, sql).row as unknown as Row;
      const key = keyOf(table, row);
      const e = server.entry(uid, table, key)!;
      out.push({ table, key: keyString(key), version: e.version, deleted: e.deleted });
    }
  }
  return sortVersions(out);
}
const sortVersions = (v: ServerVersionRecord[]) => [...v].sort((a, b) => `${a.table} ${a.key}`.localeCompare(`${b.table} ${b.key}`));
/** Lignes actives du serveur converties (ce que le cache doit contenir), triées par clé. */
function activeRows(server: MemoryTransport, uid: string, table: CloudTableName): Row[] {
  return server
    .sqlRows(uid, table)
    .filter((r) => r.deleted_at === null)
    .map((r) => deserializeRow(table, r).row as unknown as Row)
    .sort((a, b) => keyString(keyOf(table, a)).localeCompare(keyString(keyOf(table, b))));
}
const sortRows = (table: CloudTableName, rows: Row[]) => [...rows].sort((a, b) => keyString(keyOf(table, a)).localeCompare(keyString(keyOf(table, b))));

/** Le cache contient exactement l'état actuel du serveur (tables métier et versions). */
async function expectCacheMatchesServer(cache: CloudCacheDB, server: MemoryTransport, uid: string) {
  for (const table of CLOUD_TABLES) expect(sortRows(table, (await cache.table(table).toArray()) as Row[]), table).toEqual(activeRows(server, uid, table));
  expect(sortVersions(await cache.serverVersions.toArray())).toEqual(serverVersions(server, uid));
}

const read = (server: MemoryTransport, uid: string) => readCloudData(server.readSource(uid), uid);

/** Données de A avec des lignes supprimées (contenu marqué) et des versions > 1. */
async function seeded() {
  const server = new MemoryTransport();
  const uid = randomUUID();
  const data = await seed(server, uid);
  const [a0, a1] = data.accounts!;
  const txs = data.transactions!;
  // Seconde notification, qui restera active (la première sera supprimée) : les 18 tables ont des lignes actives.
  await commitAs(server, uid, [put('notificationStates', { id: `budget:${randomUUID()}:2026-03:80`, userId: uid, read: true, dismissed: false, updatedAt: REGISTERED_AT })]);
  await commitAs(server, uid, [put('accounts', { ...a0, name: 'Compte modifié' }, 1), put('accounts', { ...a1, name: MARK }, 1), put('transactions', { ...txs[0], label: MARK, notes: MARK }, 1)]);
  await commitAs(server, uid, [
    del('accounts', a1.id as string, 2),
    del('transactions', txs[0].id as string, 2),
    del('occurrences', keyOf('occurrences', data.occurrences![0]), 1),
    del('notificationStates', keyOf('notificationStates', data.notificationStates![0]), 1),
  ]);
  return { server, uid, data };
}

async function refusal(p: Promise<unknown>): Promise<CloudLoadError> {
  const e = await p.then(
    () => {
      throw new Error('chargement accepté à tort');
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CloudLoadError);
  return e as CloudLoadError;
}

let networkProbe: ReturnType<typeof vi.fn>;
beforeEach(() => {
  networkProbe = vi.fn(() => Promise.reject(new Error('réseau réel interdit pendant les tests')));
  vi.stubGlobal('fetch', networkProbe);
});
afterEach(() => {
  expect(networkProbe).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// -------------------------------------------------------------------------------------------
// [U] Préparation
// -------------------------------------------------------------------------------------------

describe('V3.4-b [U] — préparation du chargement', () => {
  /** Copie modifiable d'un résultat de lecture valide. */
  async function validResult() {
    const { server, uid } = await seeded();
    const result = await read(server, uid);
    /** Copie MODIFIABLE (types relâchés : les tests y introduisent des incohérences). */
    type Editable = { userId: string; rows: Record<string, Row[]>; versions: ServerVersionRecord[]; totals: Record<string, number> };
    const asResult = (r: Editable) => r as unknown as CloudReadResult;
    return { uid, result, asResult, clone: () => structuredClone(result) as unknown as Editable };
  }

  it('résultat valide : lignes actives par table et toutes les versions, sans contenu supprimé', async () => {
    const { uid, result } = await validResult();
    const prepared = prepareCloudLoad(result, uid);
    expect(prepared.userId).toBe(uid);
    for (const t of CLOUD_TABLES) expect(prepared.rows[t], t).toEqual(result.rows[t]);
    expect(sortVersions([...prepared.versions])).toEqual(sortVersions(result.versions));
    expect(prepared.versions.filter((v) => v.deleted)).toHaveLength(4);
    expect(JSON.stringify(prepared)).not.toContain(MARK);
  });

  it('mauvais utilisateur : résultat d’un autre utilisateur, utilisateur non précisé, ligne étrangère → wrong_user', async () => {
    const { uid, result, clone, asResult } = await validResult();
    expect((await refusal(Promise.resolve().then(() => prepareCloudLoad(result, randomUUID())))).code).toBe('wrong_user');
    expect((await refusal(Promise.resolve().then(() => prepareCloudLoad(result, '')))).code).toBe('wrong_user');
    // En-tête d'un autre utilisateur, lignes de uid : refusé sur l'en-tête lui-même (aucune table en cause).
    const header = await refusal(Promise.resolve().then(() => prepareCloudLoad(asResult({ ...clone(), userId: randomUUID() }), uid)));
    expect([header.code, header.table]).toEqual(['wrong_user', null]);
    const r = clone();
    r.rows.accounts[0] = { ...r.rows.accounts[0], userId: randomUUID() };
    const e = await refusal(Promise.resolve().then(() => prepareCloudLoad(asResult(r), uid)));
    expect([e.code, e.table]).toEqual(['wrong_user', 'accounts']);
  });

  it('incohérences de clés, de versions et de totaux → inconsistent (motif précis), sans valeur dans le message', async () => {
    const { uid, clone, asResult } = await validResult();
    const versionIndex = (r: ReturnType<typeof clone>, table: string, deleted: boolean) => r.versions.findIndex((v) => v.table === table && v.deleted === deleted);
    const cases: [string, (r: ReturnType<typeof clone>) => void, string][] = [
      ['ligne active sans version', (r) => r.versions.splice(r.versions.findIndex((v) => v.table === 'accounts' && v.key === keyString(r.rows.accounts[0].id as string)), 1, { table: 'accounts', key: keyString(randomUUID()), version: 1, deleted: false }), 'missing_version'],
      ['version active sans ligne', (r) => r.rows.budgets.pop(), 'active_mismatch'],
      ['ligne active marquée supprimée', (r) => {
        // Échange : la version de la ligne active devient « supprimée », celle de la clé supprimée devient « active ».
        const gone = versionIndex(r, 'accounts', true);
        const i = r.versions.findIndex((v) => v.table === 'accounts' && v.key === keyString(r.rows.accounts[0].id as string));
        r.versions[i] = { ...r.versions[i], deleted: true };
        r.versions[gone] = { ...r.versions[gone], deleted: false };
      }, 'deleted_row'],
      ['deux versions pour une clé', (r) => r.versions.push({ ...r.versions[0] }), 'duplicate_version'],
      ['deux lignes pour une clé', (r) => (r.rows.goals[1] = { ...r.rows.goals[0] }), 'duplicate_key'],
      ['clé absente', (r) => (r.rows.debts[0] = { ...r.rows.debts[0], id: undefined }), 'invalid_key'],
      ['version 0', (r) => (r.versions[0] = { ...r.versions[0], version: 0 }), 'invalid_version'],
      ['version décimale', (r) => (r.versions[0] = { ...r.versions[0], version: 1.5 }), 'invalid_version'],
      ['version d’une table locale', (r) => r.versions.push({ table: 'meta' as never, key: '"schemaVersion"', version: 1, deleted: false }), 'invalid_version'],
      ['table inconnue dans les lignes', (r) => (r.rows.inconnue = []), 'unknown_table'],
      ['table absente des lignes', (r) => delete (r.rows as Record<string, unknown>).rates, 'shape'],
      ['total différent', (r) => (r.totals.assets = r.totals.assets + 1), 'total_mismatch'],
      ['suppression illisible', (r) => (r.versions[0] = { ...r.versions[0], deleted: 'non' as never }), 'invalid_version'],
    ];
    for (const [label, alter, reason] of cases) {
      const r = clone();
      alter(r);
      const e = await refusal(Promise.resolve().then(() => prepareCloudLoad(asResult(r), uid)));
      expect([e.code, e.reason], label).toEqual(['inconsistent', reason]);
      expect(e.message, label).not.toContain(uid);
    }
  });
});

// -------------------------------------------------------------------------------------------
// [T] Transaction IndexedDB
// -------------------------------------------------------------------------------------------

describe('V3.4-b [T] — écriture atomique dans IndexedDB', () => {
  it('T01 / T15 cache vide → contenu RÉEL relu = lignes actives des 18 tables et toutes les versions ; meta non créée', async () => {
    const { server, uid } = await seeded();
    const d = device(uid, new IDBFactory());
    const summary = await loadCloudCache(server.readSource(uid), d.cache, uid);
    await expectCacheMatchesServer(d.cache, server, uid);
    for (const t of CLOUD_TABLES) expect(await d.cache.table(t).count(), `${t} non vide`).toBeGreaterThan(0);
    expect(await d.cache.table('meta').count()).toBe(0);
    expect(summary).toMatchObject({ userId: uid, versionCount: serverVersions(server, uid).length, deletedCount: 4 });
  });

  it('une SEULE transaction : vider les 18 tables, serverVersions et syncState, insérer les lignes, les versions et le curseur ; meta jamais touchée', async () => {
    const { server, uid } = await seeded();
    const d = device(uid, new IDBFactory());
    await d.cache.table('meta').put({ key: 'schemaVersion', value: 1 });
    d.log.length = 0;
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    expect(new Set(d.log.map((e) => e.trans)).size).toBe(1);
    expect(d.log.some((e) => e.table === 'meta')).toBe(false);
    const clears = d.log.filter((e) => e.type === 'deleteRange').map((e) => e.table);
    const adds = d.log.filter((e) => e.type === 'add').map((e) => e.table);
    expect(clears).toEqual([...CLOUD_TABLES, SERVER_VERSIONS_TABLE, SYNC_STATE_TABLE]);
    expect(adds).toEqual([...CLOUD_TABLES, SERVER_VERSIONS_TABLE, SYNC_STATE_TABLE]);
    expect(d.log.map((e) => e.type)).toEqual([...clears.map(() => 'deleteRange'), ...adds.map(() => 'add')]);
    expect(new Set(d.log.map((e) => e.table))).toEqual(new Set(LOADED_TABLES));
  });

  it('aucune requête pendant la transaction : toutes les lectures précèdent la première écriture, hors transaction Dexie', async () => {
    const { server, uid } = await seeded();
    const d = device(uid, new IDBFactory());
    const events: string[] = [];
    const inner = server.readSource(uid);
    const source: CloudReadSource = {
      kind: 'espion',
      sessionUserId: () => inner.sessionUserId(),
      page: async (q, o, l) => {
        events.push(Dexie.currentTransaction ? 'réseau-DANS-transaction' : 'réseau');
        return inner.page(q, o, l);
      },
      count: async (q) => {
        events.push(Dexie.currentTransaction ? 'réseau-DANS-transaction' : 'réseau');
        return inner.count(q);
      },
      pull: async (r) => {
        events.push(Dexie.currentTransaction ? 'réseau-DANS-transaction' : 'réseau');
        return inner.pull(r);
      },
    };
    d.failOn((table, type) => {
      events.push(`écriture ${type} ${table}`);
      return null;
    });
    await loadCloudCache(source, d.cache, uid);
    expect(events).not.toContain('réseau-DANS-transaction');
    const firstWrite = events.findIndex((e) => e.startsWith('écriture'));
    expect(events.slice(0, firstWrite).every((e) => e === 'réseau')).toBe(true);
    expect(events.slice(firstWrite).every((e) => e.startsWith('écriture'))).toBe(true);
    expect(events.filter((e) => e === 'réseau')).toHaveLength(37); // borne de récupération (V4.2) + 18 pages + 18 contre-vérifications
  });

  it('T04 versions EXACTES de toutes les clés (actives et supprimées) relues dans serverVersions ; aucun contenu supprimé nulle part', async () => {
    const { server, uid, data } = await seeded();
    const d = device(uid, new IDBFactory());
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    const versions = sortVersions(await d.cache.serverVersions.toArray());
    expect(versions).toEqual(serverVersions(server, uid));
    expect(versions.filter((v) => v.deleted).map((v) => `${v.table}:${v.version}`).sort()).toEqual(['accounts:3', 'notificationStates:2', 'occurrences:2', 'transactions:3']);
    expect(versions.find((v) => v.table === 'accounts' && v.key === keyString(data.accounts![0].id as string))).toMatchObject({ version: 2, deleted: false });
    expect(await d.cache.table('accounts').get(data.accounts![1].id as string)).toBeUndefined();
    expect(await d.cache.table('transactions').get(data.transactions![0].id as string)).toBeUndefined();
    expect(JSON.stringify(await dump(d.cache))).not.toContain(MARK);
  });

  it('meta strictement conservée : après un chargement réussi et après un chargement en échec', async () => {
    const { server, uid } = await seeded();
    const d = device(uid, new IDBFactory());
    const meta = [
      { key: 'autre', value: { conservé: true, liste: [1, 2] } },
      { key: 'schemaVersion', value: 1 },
    ];
    await d.cache.table('meta').bulkPut(meta);
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    expect(await d.cache.table('meta').toArray()).toEqual(meta);
    d.failOn((table) => (table === SERVER_VERSIONS_TABLE ? new DOMException('quota', 'QuotaExceededError') : null));
    await refusal(loadCloudCache(server.readSource(uid), d.cache, uid));
    expect(await d.cache.table('meta').toArray()).toEqual(meta);
  });

  describe('T09 panne pendant l’écriture → annulation INTÉGRALE (contenu relu identique, toutes tables)', () => {
    const points: [string, (table: string, type: string) => boolean, string][] = [
      ['vidage de la première table', (t, type) => t === 'users' && type === 'deleteRange', 'AbortError'],
      ['vidage de serverVersions', (t, type) => t === SERVER_VERSIONS_TABLE && type === 'deleteRange', 'AbortError'],
      ['insertion d’une table du milieu', (t, type) => t === 'goals' && type === 'add', 'AbortError'],
      ['insertion de la dernière table', (t, type) => t === 'notificationStates' && type === 'add', 'AbortError'],
      ['quota dépassé à l’insertion des versions', (t, type) => t === SERVER_VERSIONS_TABLE && type === 'add', 'QuotaExceededError'],
    ];
    for (const [label, when, name] of points) {
      it(`T09 ${label}`, async () => {
        const { server, uid, data } = await seeded();
        const d = device(uid, new IDBFactory());
        await d.cache.table('meta').put({ key: 'schemaVersion', value: 1 });
        await loadCloudCache(server.readSource(uid), d.cache, uid);
        // Le serveur change : le chargement suivant doit tout remplacer… mais échoue.
        await commitAs(server, uid, [put('accounts', { ...data.accounts![0], name: 'Encore modifié' }, 2), del('budgets', data.budgets![0].id as string, 1)]);
        const before = await dump(d.cache);
        d.failOn((t, type) => (when(t, type) ? new DOMException(label, name) : null));
        const e = await refusal(loadCloudCache(server.readSource(uid), d.cache, uid));
        expect([e.code, e.reason]).toEqual(['write_failed', name]);
        expect(e.message).not.toContain(label);
        d.failOn(null);
        expect(await dump(d.cache)).toEqual(before);
      });
    }

    it('T09 erreur NATURELLE d’IndexedDB (clé en double, sans panne injectée) → annulation intégrale', async () => {
      const { server, uid } = await seeded();
      const d = device(uid, new IDBFactory());
      await loadCloudCache(server.readSource(uid), d.cache, uid);
      const before = await dump(d.cache);
      const prepared = prepareCloudLoad(await read(server, uid), uid);
      const broken = { ...prepared, rows: { ...prepared.rows, accounts: [...prepared.rows.accounts, prepared.rows.accounts[0]] } };
      const e = await refusal(writeCloudLoad(d.cache, broken));
      expect(e.code).toBe('write_failed');
      expect(await dump(d.cache)).toEqual(before);
    });
  });

  it('panne AVANT la transaction (lecture) ou erreur de PRÉPARATION → cache inchangé, aucune écriture tentée', async () => {
    const { server, uid } = await seeded();
    const d = device(uid, new IDBFactory());
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    const before = await dump(d.cache);
    d.log.length = 0;
    const inner = server.readSource(uid);
    const failing: CloudReadSource = { ...inner, kind: 'panne', page: async (q, o, l) => (q.table === 'debts' ? Promise.reject(new Error('panne')) : inner.page(q, o, l)) };
    await expect(loadCloudCache(failing, d.cache, uid)).rejects.toMatchObject({ name: 'CloudReadError', code: 'unavailable' });
    const result = structuredClone(await read(server, uid));
    (result.rows.accounts as Row[]).pop();
    expect((await refusal(loadCloudData(d.cache, result, uid))).code).toBe('inconsistent');
    expect(d.log).toHaveLength(0);
    expect(await dump(d.cache)).toEqual(before);
  });

  it('mauvais utilisateur ou mauvaise base → refus AVANT toute écriture ; la base locale « nexora » n’est jamais touchée', async () => {
    const { server, uid } = await seeded();
    const factory = new IDBFactory();
    // Base locale « nexora » réelle (mode local), avec des données.
    const local = new NexoraDB('nexora', { indexedDB: factory, IDBKeyRange });
    await local.table('meta').put({ key: 'schemaVersion', value: 1 });
    await local.table('accounts').put({ id: 'compte-local', userId: 'local', name: 'Local' });
    const localBefore = await dump(local);
    const result = await read(server, uid);
    // La base « nexora » ne peut être ni construite comme cache, ni chargée.
    expect(() => new CloudCacheDB('nexora', { userId: uid })).toThrow(/nexora/);
    const e1 = await refusal(loadCloudData(local as unknown as CloudCacheDB, result, uid));
    expect(e1.code).toBe('invalid_cache');
    // Cache d'un autre utilisateur, résultat d'un autre utilisateur.
    const other = randomUUID();
    const dOther = device(other, factory);
    expect((await refusal(loadCloudData(dOther.cache, result, other))).code).toBe('wrong_user');
    expect((await refusal(loadCloudData(dOther.cache, result, uid))).code).toBe('invalid_cache');
    expect(dOther.log).toHaveLength(0);
    // Chargement normal dans le cache de uid : « nexora » reste identique.
    const d = device(uid, factory);
    await loadCloudData(d.cache, result, uid);
    expect(await dump(local)).toEqual(localBefore);
    expect((await factory.databases()).map((x) => x.name).sort()).toEqual(['nexora', cloudCacheName(uid)].sort());
    local.close();
  });

  it('T16 lignes et versions devenues absentes du serveur (ou étrangères au serveur) → retirées du cache', async () => {
    const { server, uid, data } = await seeded();
    const d = device(uid, new IDBFactory());
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    // Restes locaux : ligne et version inconnues du serveur, version orpheline.
    const ghost = { ...data.accounts![2], id: randomUUID(), name: 'Fantôme' };
    await d.cache.table('accounts').put(ghost);
    await d.cache.serverVersions.bulkPut([
      { table: 'accounts', key: keyString(ghost.id as string), version: 7, deleted: false },
      { table: 'goals', key: keyString(randomUUID()), version: 3, deleted: true },
    ]);
    // Suppression sur le serveur depuis le dernier chargement.
    await commitAs(server, uid, [del('debts', data.debts![0].id as string, 1)]);
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    await expectCacheMatchesServer(d.cache, server, uid);
    expect(await d.cache.table('accounts').get(ghost.id as string)).toBeUndefined();
    expect(await d.cache.table('debts').get(data.debts![0].id as string)).toBeUndefined();
    expect(await d.cache.serverVersions.get(['debts', keyString(data.debts![0].id as string)])).toEqual({ table: 'debts', key: keyString(data.debts![0].id as string), version: 2, deleted: true });
  });
});

// -------------------------------------------------------------------------------------------
// [I] Intégration : écritures après chargement
// -------------------------------------------------------------------------------------------

describe('V3.4-b [I] — intégration avec CloudRepository / CloudStorage', () => {
  it('T14 rechargement après modifications sur le serveur (modification, suppression, création, réactivation) → cache = nouvel état ; meta conservée', async () => {
    const { server, uid, data } = await seeded();
    const d = device(uid, new IDBFactory());
    await d.cache.table('meta').put({ key: 'schemaVersion', value: 1 });
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    const a1 = data.accounts![1]; // supprimé en version 3
    await commitAs(server, uid, [
      put('accounts', { ...data.accounts![0], name: 'Rechargé' }, 2),
      del('budgets', data.budgets![0].id as string, 1),
      put('goals', { ...data.goals![0], id: randomUUID(), name: 'Nouvel objectif' }),
      put('accounts', { ...a1, name: 'Réactivé' }, 3),
    ]);
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    await expectCacheMatchesServer(d.cache, server, uid);
    expect(await d.cache.table('accounts').get(a1.id as string)).toMatchObject({ name: 'Réactivé' });
    expect(await d.cache.serverVersions.get(['accounts', keyString(a1.id as string)])).toEqual({ table: 'accounts', key: keyString(a1.id as string), version: 4, deleted: false });
    expect(await d.cache.table('meta').toArray()).toEqual([{ key: 'schemaVersion', value: 1 }]);
  });

  it('T05 clé fixe supprimée puis recréée (échéance sautée, rétablie, sautée de nouveau) : acceptée après chargement sur un autre appareil et après rechargement', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    const data = await seed(server, uid);
    const ruleId = data.recurringRules![0].id as string;
    const due = '2027-01-01';
    const occKey = `${ruleId}:${due}`;
    // Appareil 1 : chargement, saut, rétablissement (suppression).
    const d1 = device(uid, new IDBFactory());
    await loadCloudCache(server.readSource(uid), d1.cache, uid);
    const repo1 = new CloudRepository(uid, { cache: d1.cache, transport: server.as(uid) });
    await repo1.skipOccurrence(ruleId, due);
    await repo1.resetOccurrence(ruleId, due, false);
    expect(server.entry(uid, 'occurrences', occKey)).toMatchObject({ version: 2, deleted: true });
    // Appareil 2 : le chargement apporte la version de la clé supprimée → recréation acceptée.
    const d2 = device(uid, new IDBFactory());
    await loadCloudCache(server.readSource(uid), d2.cache, uid);
    expect(await d2.cache.serverVersions.get(['occurrences', keyString(occKey)])).toEqual({ table: 'occurrences', key: keyString(occKey), version: 2, deleted: true });
    expect(await d2.cache.table('occurrences').get(occKey)).toBeUndefined();
    await new CloudRepository(uid, { cache: d2.cache, transport: server.as(uid) }).skipOccurrence(ruleId, due);
    expect(server.entry(uid, 'occurrences', occKey)).toMatchObject({ version: 3, deleted: false });
    // Appareil 1, après rechargement : rétablir puis sauter de nouveau → accepté.
    await loadCloudCache(server.readSource(uid), d1.cache, uid);
    const repo1b = new CloudRepository(uid, { cache: d1.cache, transport: server.as(uid) });
    await repo1b.resetOccurrence(ruleId, due, false);
    await loadCloudCache(server.readSource(uid), d1.cache, uid);
    await new CloudRepository(uid, { cache: d1.cache, transport: server.as(uid) }).skipOccurrence(ruleId, due);
    expect(server.entry(uid, 'occurrences', occKey)).toMatchObject({ version: 5, deleted: false });
    await expectCacheMatchesServer(d1.cache, server, uid);
  });

  it('T05 contre-épreuve (D-1) : sans la version de la clé supprimée, la recréation est refusée par conflit', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    const data = await seed(server, uid);
    const ruleId = data.recurringRules![0].id as string;
    const due = '2027-02-01';
    const d1 = device(uid, new IDBFactory());
    await loadCloudCache(server.readSource(uid), d1.cache, uid);
    const repo1 = new CloudRepository(uid, { cache: d1.cache, transport: server.as(uid) });
    await repo1.skipOccurrence(ruleId, due);
    await repo1.resetOccurrence(ruleId, due, false);
    const d2 = device(uid, new IDBFactory());
    await loadCloudCache(server.readSource(uid), d2.cache, uid);
    await d2.cache.serverVersions.delete(['occurrences', keyString(`${ruleId}:${due}`)]); // « lignes actives seulement »
    await expect(new CloudRepository(uid, { cache: d2.cache, transport: server.as(uid) }).skipOccurrence(ruleId, due)).rejects.toBeInstanceOf(CloudConflictError);
  });

  it('T06 utilisateur neuf : chargement (profil seul, version 1) puis ensureUser → un seul lot accepté (profil, paramètres, catégories)', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    const d = device(uid, new IDBFactory());
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    expect(await d.cache.table('users').toArray()).toEqual([{ id: uid, displayName: '', createdAt: REGISTERED_AT }]);
    expect(await d.cache.serverVersions.toArray()).toEqual([{ table: 'users', key: keyString(uid), version: 1, deleted: false }]);
    const commitsBefore = server.commits.length;
    const settings = await new CloudRepository(uid, { cache: d.cache, transport: server.as(uid) }).ensureUser('Sara');
    expect(server.commits.length).toBe(commitsBefore + 1);
    expect(settings).toMatchObject({ id: uid, userId: uid, displayName: 'Sara' });
    expect(server.entry(uid, 'users', uid)).toMatchObject({ version: 2, row: { displayName: 'Sara' } });
    expect(server.entry(uid, 'settings', uid)).toMatchObject({ version: 1, deleted: false });
    expect(server.rows(uid, 'categories').length).toBeGreaterThan(0);
    expect(await d.cache.table('settings').get(uid)).toMatchObject({ displayName: 'Sara' });
    expect(await d.cache.serverVersions.get(['users', keyString(uid)])).toMatchObject({ version: 2 });
  });

  it('T06 utilisateur déjà configuré, second appareil : chargement puis ensureUser → aucune écriture', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    await seed(server, uid);
    const d = device(uid, new IDBFactory());
    await loadCloudCache(server.readSource(uid), d.cache, uid);
    const commitsBefore = server.commits.length;
    const settings = await new CloudRepository(uid, { cache: d.cache, transport: server.as(uid) }).ensureUser('Autre nom');
    expect(server.commits.length).toBe(commitsBefore);
    expect(settings).toEqual(await d.cache.table('settings').get(uid));
  });

  it('T06 contre-épreuve (P15) : sans chargement, ensureUser crée le profil sans version connue → conflit', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    server.registerUser(uid);
    const d = device(uid, new IDBFactory());
    await expect(new CloudRepository(uid, { cache: d.cache, transport: server.as(uid) }).ensureUser('Sara')).rejects.toBeInstanceOf(CloudConflictError);
  });
});
