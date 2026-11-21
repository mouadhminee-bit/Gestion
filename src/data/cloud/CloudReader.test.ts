/**
 * V3.4-a — lecteur générique (`CloudReader.ts`) :
 *  - [U] tests UNITAIRES : source scriptée (pages altérées), contrôles du lecteur seuls ;
 *  - [I] tests d'INTÉGRATION : `MemoryTransport` aligné (`readSource`), données écrites par
 *    le protocole ChangeSet comme par un client.
 * Les tests passant par supabase-js et le serveur PostgREST SIMULÉ sont dans
 * `HttpReadSource.test.ts`. Aucune requête réseau (fetch global remplacé par une sonde).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ID } from '@/domain/types';
import { CloudReadError, READ_PAGE_SIZE, READ_TABLES, readCloudData, readQuery, type CloudReadResult, type CloudReadSource, type ReadPage, type ReadQuery } from './CloudReader';
import { MemoryTransport, REGISTERED_AT } from './MemoryTransport';
import { CLOUD_TABLES, MAPPING, deserializeRow, fromSqlKey, toCloudRow, type CloudTableName } from './mapping';
import { CloudConflictError, keyString } from './transport';
import { commitAs, dataset, del, keyOf, put, seed, NOW } from '@/test/cloudData';

const MARK = 'SUPPRIMÉ-CONTENU-SECRET';

/** Source enveloppée : chaque appel est journalisé et peut être altéré. */
function tamper(
  src: CloudReadSource,
  edit: {
    session?: () => ID | null;
    page?: (q: ReadQuery, offset: number, page: ReadPage) => ReadPage | Promise<ReadPage>;
    count?: (q: ReadQuery, total: unknown) => unknown;
    before?: (q: ReadQuery, kind: 'page' | 'count', offset: number) => void | Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  let sessions = 0;
  const source: CloudReadSource = {
    kind: 'altérée',
    sessionUserId: async () => {
      sessions++;
      return edit.session ? edit.session() : src.sessionUserId();
    },
    page: async (q, offset, limit) => {
      calls.push(`page ${q.table} ${offset} ${limit}`);
      await edit.before?.(q, 'page', offset);
      const p = await src.page(q, offset, limit);
      return edit.page ? edit.page(q, offset, p) : p;
    },
    count: async (q) => {
      calls.push(`count ${q.table}`);
      await edit.before?.(q, 'count', 0);
      const c = await src.count(q);
      return edit.count ? edit.count(q, c) : c;
    },
  };
  return { source, calls, sessions: () => sessions };
}

async function refusal(p: Promise<unknown>): Promise<CloudReadError> {
  const e = await p.then(
    () => {
      throw new Error('lecture acceptée à tort');
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CloudReadError);
  return e as CloudReadError;
}

/** Versions attendues : toutes les entrées du serveur (actives et supprimées), triées. */
function serverVersions(server: MemoryTransport, uid: string) {
  const out: { table: CloudTableName; key: string; version: number; deleted: boolean }[] = [];
  for (const table of CLOUD_TABLES) {
    for (const sql of server.sqlRows(uid, table)) {
      const key = fromSqlKey(table, Object.fromEntries(MAPPING[table].sqlKey.map((c) => [c, sql[c]])));
      const e = server.entry(uid, table, key)!;
      out.push({ table, key: keyString(key), version: e.version, deleted: e.deleted });
    }
  }
  return sortVersions(out);
}
const sortVersions = <T extends { table: string; key: string }>(v: T[]) => [...v].sort((a, b) => `${a.table} ${a.key}`.localeCompare(`${b.table} ${b.key}`));
const sortRows = (table: CloudTableName, rows: object[]) => [...rows].sort((a, b) => keyString(keyOf(table, a as Record<string, unknown>)).localeCompare(keyString(keyOf(table, b as Record<string, unknown>))));

let networkProbe: ReturnType<typeof vi.fn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  networkProbe = vi.fn(() => Promise.reject(new Error('réseau réel interdit pendant les tests')));
  vi.stubGlobal('fetch', networkProbe);
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
});
afterEach(() => {
  expect(networkProbe).not.toHaveBeenCalled();
  for (const s of consoleSpies) expect(s, 'le lecteur ne journalise rien').not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('V3.4-a [U] — requêtes et contrôles du lecteur', () => {
  it('requête de chaque table : 18 tables dans l’ordre du mapping ; propriétaire `id` pour les profils, `user_id` ailleurs ; tri sur la clé primaire SQL', () => {
    expect(READ_TABLES).toEqual(CLOUD_TABLES);
    expect(READ_TABLES).toHaveLength(18);
    for (const table of READ_TABLES) {
      const q = readQuery(table, 'u');
      expect(q).toEqual({ table, sqlTable: MAPPING[table].sqlTable, owner: table === 'users' ? 'id' : 'user_id', userId: 'u', order: [...MAPPING[table].sqlKey] });
    }
    expect(readQuery('occurrences', 'u').order).toEqual(['rule_id', 'due_date']);
    expect(readQuery('notificationStates', 'u').order).toEqual(['user_id', 'id']);
    expect(READ_PAGE_SIZE).toBe(1000);
  });

  it('session vérifiée avant CHAQUE requête ; absente ou d’un autre utilisateur → unauthorized, aucune requête', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    const ok = tamper(server.readSource(uid));
    await readCloudData(ok.source, uid);
    expect(ok.calls).toHaveLength(36);
    expect(ok.sessions()).toBe(36);
    for (const session of [() => null, () => randomUUID(), () => { throw new Error('stockage illisible'); }]) {
      const t = tamper(server.readSource(uid), { session });
      const e = await refusal(readCloudData(t.source, uid));
      expect(e.code).toBe('unauthorized');
      expect(t.calls).toHaveLength(0);
    }
    expect((await refusal(readCloudData(ok.source, ''))).code).toBe('unauthorized');
  });

  it('session perdue en cours de lecture : refus à la requête suivante, rien de renvoyé', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    let n = 0;
    const t = tamper(server.readSource(uid), { session: () => (++n <= 5 ? uid : null) });
    const e = await refusal(readCloudData(t.source, uid));
    expect(e.code).toBe('unauthorized');
    expect(t.calls).toHaveLength(5);
  });

  it('T33 [U] total invalide (absent, NaN, texte, négatif, décimal, trop grand) → incomplete count_missing', async () => {
    for (const bad of [null, undefined, Number.NaN, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const server = new MemoryTransport();
      const uid = randomUUID();
      const t = tamper(server.readSource(uid), { page: (q, _o, p) => (q.table === 'accounts' ? { ...p, total: bad } : p) });
      const e = await refusal(readCloudData(t.source, uid));
      expect([e.code, e.reason, e.table]).toEqual(['incomplete', 'count_missing', 'accounts']);
    }
    const server = new MemoryTransport();
    const uid = randomUUID();
    const t = tamper(server.readSource(uid), { count: (q, c) => (q.table === 'rates' ? Number.NaN : c) });
    expect((await refusal(readCloudData(t.source, uid))).reason).toBe('count_missing');
  });

  it('réponse sans liste de lignes → invalid_response ; erreur inconnue de la source → unavailable, sans son message', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    const t1 = tamper(server.readSource(uid), { page: (q, _o, p) => (q.table === 'goals' ? { ...p, rows: { 0: 'x' } } : p) });
    expect((await refusal(readCloudData(t1.source, uid))).code).toBe('invalid_response');
    const t2 = tamper(server.readSource(uid), {
      page: (q, _o, p) => {
        if (q.table === 'debts') throw new Error(`panne interne ${MARK}`);
        return p;
      },
    });
    const e = await refusal(readCloudData(t2.source, uid));
    expect([e.code, e.table]).toEqual(['unavailable', 'debts']);
    expect(e.message).not.toContain(MARK);
  });

  it('T08 [U] ligne non conforme (y compris supprimée) → invalid_row avec colonne et code, JAMAIS la valeur', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    await seed(server, uid);
    const cases: [string, (r: Record<string, unknown>) => Record<string, unknown>, string][] = [
      ['colonne inconnue', (r) => ({ ...r, colonne_inconnue: MARK }), 'unknown_column'],
      ['colonne absente', ({ name: _n, ...r }) => r, 'missing_column'],
      ['valeur invalide', (r) => ({ ...r, currency: { secret: MARK } }), 'invalid_value'],
      ['ligne supprimée invalide', (r) => ({ ...r, name: MARK, initial_balance: `${MARK}-pas-un-nombre`, deleted_at: REGISTERED_AT }), 'invalid_value'],
    ];
    for (const [, alter, reason] of cases) {
      const t = tamper(server.readSource(uid), { page: (q, _o, p) => (q.table === 'accounts' ? { ...p, rows: (p.rows as Record<string, unknown>[]).map((r, i) => (i === 1 ? alter(r) : r)) } : p) });
      const e = await refusal(readCloudData(t.source, uid));
      expect([e.code, e.table, e.reason]).toEqual(['invalid_row', 'accounts', reason]);
      expect(e.message).not.toContain(MARK);
      expect(JSON.stringify(e)).not.toContain(MARK);
    }
  });
});

describe('V3.4-a [I] — lecture par MemoryTransport aligné', () => {
  /** Données de A, dont des lignes supprimées (contenu marqué) et des versions > 1. */
  async function seeded() {
    const server = new MemoryTransport();
    const uid = randomUUID();
    const data = await seed(server, uid);
    const session = server.as(uid);
    const acc = data.accounts!;
    const txs = data.transactions!;
    // Versions > 1 : modification d'un compte ; suppressions après marquage du contenu.
    await commitAs(server, uid, [put('accounts', { ...acc[0], name: 'Compte modifié' }, 1)]);
    const marked = [put('accounts', { ...acc[1], name: MARK }, 1), ...txs.slice(0, 3).map((t) => put('transactions', { ...t, label: MARK }, 1))];
    await commitAs(server, uid, marked);
    await commitAs(server, uid, [
      del('accounts', acc[1].id as string, 2),
      ...txs.slice(0, 3).map((t) => del('transactions', t.id as string, 2)),
      del('occurrences', keyOf('occurrences', data.occurrences![0]), 1),
      del('notificationStates', keyOf('notificationStates', data.notificationStates![0]), 1),
    ]);
    void session;
    return { server, uid, data };
  }

  function expectMatchesServer(result: CloudReadResult, server: MemoryTransport, uid: string) {
    for (const table of READ_TABLES) {
      // Lignes actives du serveur, converties par le mapping (aller-retour SQL : champ facultatif absent → null).
      const expected = server
        .sqlRows(uid, table)
        .filter((r) => r.deleted_at === null)
        .map((r) => deserializeRow(table, r).row);
      expect(expected.length, table).toBe(server.rows(uid, table).length);
      for (const r of expected) expect(toCloudRow(table, server.entry(uid, table, keyOf(table, r as Record<string, unknown>))!.row as never), table).toEqual(expect.objectContaining(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null))));
      expect(sortRows(table, result.rows[table]), table).toEqual(sortRows(table, expected));
      expect(result.totals[table], table).toBe(server.sqlRows(uid, table).length);
    }
    expect(sortVersions(result.versions)).toEqual(serverVersions(server, uid));
  }

  it('T03 [I] lignes actives des 18 tables converties ; versions de TOUTES les clés (supprimées : deleted true) ; contenu supprimé absent du résultat', async () => {
    const { server, uid } = await seeded();
    const result = await readCloudData(server.readSource(uid), uid);
    expect(result.userId).toBe(uid);
    for (const table of READ_TABLES) expect(result.totals[table], `${table} non vide`).toBeGreaterThan(0);
    expectMatchesServer(result, server, uid);
    const deleted = result.versions.filter((v) => v.deleted);
    expect(deleted.map((v) => v.table).sort()).toEqual(['accounts', 'notificationStates', 'occurrences', 'transactions', 'transactions', 'transactions']);
    expect(deleted.find((v) => v.table === 'accounts')!.version).toBe(3);
    expect(result.versions.find((v) => v.table === 'users')).toEqual({ table: 'users', key: keyString(uid), version: 1, deleted: false });
    expect(JSON.stringify(result)).not.toContain(MARK);
    // Champ local jamais renvoyé (fichier d'une pièce jointe).
    expect(result.rows.attachments[0]).not.toHaveProperty('blob');
  });

  it('T03 [I] clé de chaque version : identique à la clé reconvertie par le mapping (fromSqlKey), pour les 18 tables', async () => {
    const { server, uid } = await seeded();
    const result = await readCloudData(server.readSource(uid), uid);
    const fromMapping = new Set<string>();
    for (const table of READ_TABLES) {
      for (const sql of server.sqlRows(uid, table)) fromMapping.add(`${table} ${keyString(fromSqlKey(table, Object.fromEntries(MAPPING[table].sqlKey.map((c) => [c, sql[c]]))))}`);
    }
    expect(new Set(result.versions.map((v) => `${v.table} ${v.key}`))).toEqual(fromMapping);
    expect(result.versions).toHaveLength(fromMapping.size);
  });

  it('T07 [I] isolation : A ne reçoit aucune ligne ni version de B (actives ou supprimées) ; lecture pour B avec la session de A refusée sans requête', async () => {
    const server = new MemoryTransport();
    const a = randomUUID();
    const b = randomUUID();
    await seed(server, a);
    const dataB = await seed(server, b);
    await commitAs(server, b, [del('accounts', dataB.accounts![0].id as string, 1)]);
    const result = await readCloudData(server.readSource(a), a);
    const keysB = new Set(serverVersions(server, b).map((v) => `${v.table} ${v.key}`));
    expect(result.versions.some((v) => keysB.has(`${v.table} ${v.key}`))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(b);
    const t = tamper(server.readSource(a));
    expect((await refusal(readCloudData(t.source, b))).code).toBe('unauthorized');
    expect(t.calls).toHaveLength(0);
  });

  it('T35 [I] modification SUR PLACE pendant la lecture : acceptée, version antérieure ; l’écriture fondée sur elle est refusée (conflit), sans perte', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    const data = await seed(server, uid);
    const [acc0, acc1] = data.accounts!;
    let done = false;
    const t = tamper(server.readSource(uid), {
      before: async (q, kind) => {
        if (done || kind !== 'page' || q.table !== 'transactions') return;
        done = true; // comptes déjà lus : modification et suppression logique concurrentes
        await commitAs(server, uid, [put('accounts', { ...acc0, name: 'Modifié ailleurs' }, 1), del('accounts', acc1.id as string, 1)]);
      },
    });
    const result = await readCloudData(t.source, uid);
    const v = (id: unknown) => result.versions.find((x) => x.table === 'accounts' && x.key === keyString(id as string))!;
    expect(v(acc0.id)).toEqual({ table: 'accounts', key: keyString(acc0.id as string), version: 1, deleted: false });
    expect(v(acc1.id).deleted).toBe(false); // vue antérieure
    expect(result.rows.accounts.find((r) => r.id === acc0.id)!.name).toBe(acc0.name);
    // Écritures fondées sur la vue antérieure : refusées par le contrôle de version.
    await expect(commitAs(server, uid, [put('accounts', { ...acc0, name: 'Écrasement' }, v(acc0.id).version)])).rejects.toBeInstanceOf(CloudConflictError);
    await expect(commitAs(server, uid, [del('accounts', acc1.id as string, v(acc1.id).version)])).rejects.toBeInstanceOf(CloudConflictError);
    expect(server.entry(uid, 'accounts', acc0.id as string)).toMatchObject({ version: 2, deleted: false, row: { name: 'Modifié ailleurs' } });
    expect(server.entry(uid, 'accounts', acc1.id as string)).toMatchObject({ version: 2, deleted: true });
  });

  it('T36 [I] paramètres : 0 ligne acceptée (utilisateur neuf, profil seul) ; 1 ligne supprimée acceptée (version deleted true)', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    const fresh = await readCloudData(server.readSource(uid), uid);
    expect(fresh.rows.users).toEqual([{ id: uid, displayName: '', createdAt: REGISTERED_AT }]);
    expect(fresh.rows.settings).toEqual([]);
    expect(fresh.versions).toEqual([{ table: 'users', key: keyString(uid), version: 1, deleted: false }]);
    const settings = dataset(uid).settings![0];
    await commitAs(server, uid, [put('settings', settings)]);
    await commitAs(server, uid, [del('settings', uid, 1)]);
    const after = await readCloudData(server.readSource(uid), uid);
    expect(after.rows.settings).toEqual([]);
    expect(after.totals.settings).toBe(1);
    expect(after.versions).toContainEqual({ table: 'settings', key: keyString(uid), version: 2, deleted: true });
  });

  it('T36 [I] profil absent, supprimé ou en double → invariant / refus ; résultat jamais renvoyé', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    const prof = server.sqlRows(uid, 'users');
    expect(prof).toEqual([]); // pas encore inscrit
    const src = server.readSource(uid); // inscription
    const row = server.sqlRows(uid, 'users')[0];
    const scenarios: [string, unknown[], string, string | null][] = [
      ['aucun profil', [], 'invariant', 'profile'],
      ['profil supprimé', [{ ...row, deleted_at: NOW, version: 2 }], 'invariant', 'profile'],
      ['profil en double', [row, row], 'incomplete', 'duplicate_key'],
      ['profil d’un autre utilisateur', [{ ...row, id: randomUUID() }], 'foreign_row', null],
    ];
    for (const [, rows, code, reason] of scenarios) {
      const t = tamper(src, {
        page: (q, _o, p) => (q.table === 'users' ? { rows, total: rows.length } : p),
        count: (q, c) => (q.table === 'users' ? rows.length : c),
      });
      const e = await refusal(readCloudData(t.source, uid));
      expect([e.code, e.reason]).toEqual([code, reason]);
    }
  });

  it('T36 [I] paramètres en double ou d’un autre utilisateur → refus', async () => {
    const server = new MemoryTransport();
    const uid = randomUUID();
    await commitAs(server, uid, [put('settings', dataset(uid).settings![0])]);
    const row = server.sqlRows(uid, 'settings')[0];
    for (const [rows, code] of [
      [[row, row], 'incomplete'],
      [[{ ...row, user_id: randomUUID() }], 'foreign_row'],
    ] as const) {
      const t = tamper(server.readSource(uid), {
        page: (q, _o, p) => (q.table === 'settings' ? { rows, total: rows.length } : p),
        count: (q, c) => (q.table === 'settings' ? rows.length : c),
      });
      expect((await refusal(readCloudData(t.source, uid))).code).toBe(code);
    }
  });
});

describe('V3.7 (P39) — serveur simulé aligné sur la précision de PostgreSQL', () => {
  it('profil : created_at renvoyé à la microseconde (forme réelle) ; chargé à la milliseconde, = REGISTERED_AT', async () => {
    const { MemoryTransport: MT, REGISTERED_AT, REGISTERED_AT_SQL } = await import('./MemoryTransport');
    const { readCloudData: read } = await import('./CloudReader');
    const { prepareCloudLoad } = await import('./CloudLoader');
    expect(REGISTERED_AT_SQL).toMatch(/\.\d{6}\+00:00$/);
    const server = new MT();
    const uid = '22222222-2222-4222-8222-222222222222';
    server.registerUser(uid);
    const [sql] = server.sqlRows(uid, 'users');
    expect(sql.created_at).toBe(REGISTERED_AT_SQL);
    expect(sql.server_updated_at).toBe(REGISTERED_AT_SQL);
    const prepared = prepareCloudLoad(await read(server.readSource(uid), uid), uid);
    expect(prepared.rows.users).toEqual([{ id: uid, displayName: '', createdAt: REGISTERED_AT }]);
  });
});
