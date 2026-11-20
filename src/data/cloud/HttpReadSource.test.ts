/**
 * V3.4-a — lecture HTTP (`HttpReadSource` + `readCloudData`) : tests [S] SIMULÉS.
 * Vrai client Supabase (supabase-js, postgrest-js), réseau remplacé par le serveur PostgREST
 * simulé (`src/test/postgrestSimulator.ts`) : RLS par jeton, filtres, tri, pages, comptage.
 * Aucune requête réelle (fetch global remplacé par une sonde), aucun accès à DEV ou PROD.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudReadError, READ_TABLES, readCloudData, readQuery } from './CloudReader';
import { HttpReadSource } from './HttpReadSource';
import { HttpTransport } from './HttpTransport';
import { MemoryTransport, REGISTERED_AT } from './MemoryTransport';
import { MAPPING, type CloudTableName } from './mapping';
import { CloudConflictError, keyString } from './transport';
import { SIM_ANON_KEY, postgrestSimulator, simClient, userToken, type Override, type RecordedRequest } from '@/test/postgrestSimulator';
import { commitAs, dataset, del, importBatches, lot, put, seed, NOW } from '@/test/cloudData';

const MARK = 'SUPPRIMÉ-CONTENU-SECRET';
const sql = (t: CloudTableName) => MAPPING[t].sqlTable;
const owner = (t: CloudTableName) => (t === 'users' ? 'id' : 'user_id');
const params = (r: RecordedRequest) => Object.fromEntries(new URLSearchParams(r.query));
const isGet = (t: CloudTableName, offset?: number) => (r: RecordedRequest) => r.method === 'GET' && r.path === `/rest/v1/${sql(t)}` && (offset === undefined || params(r).offset === String(offset));
const isHead = (t: CloudTableName) => (r: RecordedRequest) => r.method === 'HEAD' && r.path === `/rest/v1/${sql(t)}`;
const forced = (rows: unknown[] | null, contentRange: string | null, status = 200): Override => ({
  status,
  body: rows === null ? null : JSON.stringify(rows),
  headers: contentRange === null ? {} : { 'Content-Range': contentRange },
});

function setup(opts: { maxRows?: number; timeoutMs?: number; token?: string; session?: string | null } = {}) {
  const sim = postgrestSimulator(new MemoryTransport(), { maxRows: opts.maxRows });
  const uid = randomUUID();
  sim.server.registerUser(uid);
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await sim.fetch(input, init);
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  const sessionUid = opts.session === undefined ? uid : opts.session;
  const token = opts.token ?? (sessionUid ? userToken(sessionUid) : '');
  const client = simClient(fetchImpl, sessionUid ? { uid: sessionUid, token } : null);
  const rules: { when: (r: RecordedRequest, i: number) => boolean; then: Override | ((r: RecordedRequest) => Promise<void> | void) }[] = [];
  sim.onRequest = async (r, i) => {
    for (const rule of rules) {
      if (!rule.when(r, i)) continue;
      if (typeof rule.then === 'function') await rule.then(r);
      else sim.respondNext(rule.then);
    }
  };
  return {
    sim,
    uid,
    token,
    client,
    source: new HttpReadSource(client, { timeoutMs: opts.timeoutMs }),
    maxInFlight: () => maxInFlight,
    /** Avant la requête qui vérifie `when` : réponse imposée, ou action sur le serveur. */
    on(when: (r: RecordedRequest, i: number) => boolean, then: Override | ((r: RecordedRequest) => Promise<void> | void)) {
      rules.push({ when, then });
    },
    read: () => readCloudData(new HttpReadSource(client, { timeoutMs: opts.timeoutMs }), uid),
  };
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

let networkProbe: ReturnType<typeof vi.fn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  networkProbe = vi.fn(() => Promise.reject(new Error('réseau réel interdit pendant les tests')));
  vi.stubGlobal('fetch', networkProbe);
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
});
afterEach(() => {
  expect(networkProbe).not.toHaveBeenCalled();
  for (const s of consoleSpies) expect(s, 'aucun journal').not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('V3.4-a [S] — forme des requêtes (T02)', () => {
  it('T02 18 lectures paginées puis 18 contre-vérifications, une requête à la fois : filtre propriétaire, AUCUN filtre deleted_at, tri sur la clé, page de 1 000, nombre exact', async () => {
    const h = setup();
    await seed(h.sim.server, h.uid);
    const result = await h.read();
    expect(Object.keys(result.totals)).toEqual([...READ_TABLES]);
    const reqs = h.sim.requests;
    expect(reqs).toHaveLength(36);
    expect(h.maxInFlight()).toBe(1);
    READ_TABLES.forEach((t, i) => {
      const order = MAPPING[t].sqlKey.map((c) => `${c}.asc`).join(',');
      expect(reqs[i], t).toMatchObject({ method: 'GET', path: `/rest/v1/${sql(t)}`, body: null });
      expect(params(reqs[i]), t).toEqual({ select: '*', [owner(t)]: `eq.${h.uid}`, order, offset: '0', limit: '1000' });
      expect(reqs[18 + i], t).toMatchObject({ method: 'HEAD', path: `/rest/v1/${sql(t)}`, body: null });
      expect(params(reqs[18 + i]), t).toEqual({ select: '*', [owner(t)]: `eq.${h.uid}` });
    });
    for (const r of reqs) {
      expect(r.query).not.toContain('deleted_at');
      expect(r.headers.prefer).toBe('count=exact');
      expect(r.headers.apikey).toBe(SIM_ANON_KEY);
      expect(r.headers.authorization).toBe(`Bearer ${h.token}`);
    }
  });

  it('T02 aucune nouvelle tentative : 503 et 520 sur une lecture ou une contre-vérification → une seule requête, unavailable', async () => {
    for (const status of [503, 520]) {
      for (const at of [0, 18]) {
        const h = setup();
        h.on((_r, i) => i === at, { status, body: JSON.stringify({ code: 'PGRST002', message: 'indisponible' }) });
        const e = await refusal(h.read());
        expect([e.code, e.status]).toEqual(['unavailable', status]);
        expect(h.sim.requests).toHaveLength(at + 1);
      }
    }
  });

  it('T02 délai de 30 s par défaut, appliqué à chacune des 36 requêtes', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const h = setup();
    await h.read();
    expect(spy).toHaveBeenCalledTimes(36);
    expect(spy.mock.calls.every(([ms]) => ms === 30_000)).toBe(true);
  });

  it('T02 délai dépassé → unavailable (timeout), sans nouvelle tentative', async () => {
    const h = setup({ timeoutMs: 40 });
    h.on((_r, i) => i === 2, { hang: true });
    const e = await refusal(h.read());
    expect([e.code, e.reason, e.table]).toEqual(['unavailable', 'timeout', READ_TABLES[2]]);
    expect(h.sim.requests).toHaveLength(3);
  });
});

describe('V3.4-a [S] — lignes supprimées (T03) et contrat commun', () => {
  async function withDeleted() {
    const h = setup();
    const data = await seed(h.sim.server, h.uid);
    const acc = data.accounts![1];
    const tx = data.transactions![0];
    await commitAs(h.sim.server, h.uid, [put('accounts', { ...acc, name: MARK }, 1), put('transactions', { ...tx, label: MARK, notes: MARK }, 1)]);
    await commitAs(h.sim.server, h.uid, [del('accounts', acc.id as string, 2), del('transactions', tx.id as string, 2)]);
    return { h, acc, tx };
  }

  it('T03 lues sans filtre, converties puis abandonnées : absentes des lignes, versions deleted true, contenu absent du résultat', async () => {
    const { h, acc, tx } = await withDeleted();
    const result = await h.read();
    expect(result.rows.accounts.some((r) => r.id === acc.id)).toBe(false);
    expect(result.rows.transactions.some((r) => r.id === tx.id)).toBe(false);
    expect(result.versions).toContainEqual({ table: 'accounts', key: keyString(acc.id as string), version: 3, deleted: true });
    expect(result.versions).toContainEqual({ table: 'transactions', key: keyString(tx.id as string), version: 3, deleted: true });
    expect(result.totals.accounts).toBe(result.rows.accounts.length + 1);
    expect(JSON.stringify(result)).not.toContain(MARK);
    // Les lignes supprimées ont bien circulé (lecture sans filtre) : le simulateur les a renvoyées.
    expect(h.sim.server.sqlRows(h.uid, 'accounts').some((r) => r.deleted_at !== null && r.name === MARK)).toBe(true);
  });

  it('Contrat : MemoryTransport.readSource et HttpReadSource renvoient exactement le même résultat sur les mêmes données', async () => {
    const { h } = await withDeleted();
    const viaHttp = await h.read();
    const viaMemory = await readCloudData(h.sim.server.readSource(h.uid), h.uid);
    expect(viaHttp).toEqual(viaMemory);
  });
});

describe('V3.4-a [S] — isolation (T07)', () => {
  it('T07 A ne reçoit que ses lignes : RLS par jeton et filtre propriétaire ; aucune clé de B, active ou supprimée', async () => {
    const h = setup();
    const b = randomUUID();
    await seed(h.sim.server, h.uid);
    const dataB = await seed(h.sim.server, b);
    await commitAs(h.sim.server, b, [del('accounts', dataB.accounts![0].id as string, 1)]);
    const result = await h.read();
    expect(JSON.stringify(result)).not.toContain(b);
    for (const r of h.sim.requests) expect(Object.values(params(r))).toContain(`eq.${h.uid}`);
    const keysB = new Set(READ_TABLES.flatMap((t) => h.sim.server.sqlRows(b, t).map((r) => `${t} ${String(r.id ?? r.user_id)}`)));
    expect(result.versions.some((v) => keysB.has(`${v.table} ${JSON.parse(v.key)}`))).toBe(false);
  });

  it('T07 une ligne de B glissée dans la réponse de A → foreign_row, rien de renvoyé', async () => {
    const h = setup();
    const b = randomUUID();
    await seed(h.sim.server, h.uid);
    await seed(h.sim.server, b);
    const rows = [...h.sim.server.sqlRows(h.uid, 'accounts'), h.sim.server.sqlRows(b, 'accounts')[0]];
    h.on(isGet('accounts'), forced(rows, `0-${rows.length - 1}/${rows.length}`));
    const e = await refusal(h.read());
    expect([e.code, e.table]).toEqual(['foreign_row', 'accounts']);
    expect(e.message).not.toContain(b);
  });

  it('T07 session de B (ou aucune) pour lire A → unauthorized, aucune requête envoyée', async () => {
    for (const session of [randomUUID(), null]) {
      const h = setup({ session });
      const e = await refusal(h.read());
      expect(e.code).toBe('unauthorized');
      expect(h.sim.requests).toHaveLength(0);
    }
  });
});

describe('V3.4-a [S] — conversion (T08)', () => {
  it('T08 colonne inconnue, colonne absente, valeur invalide, ligne supprimée invalide → invalid_row, sans valeur dans le message', async () => {
    const alterations: [string, (r: Record<string, unknown>) => Record<string, unknown>, string][] = [
      ['colonne inconnue', (r) => ({ ...r, nouvelle_colonne: MARK }), 'unknown_column'],
      ['colonne absente', ({ currency: _c, ...r }) => r, 'missing_column'],
      ['valeur invalide', (r) => ({ ...r, initial_balance: MARK }), 'invalid_value'],
      ['métadonnée invalide', (r) => ({ ...r, sync_txid: 'abc' }), 'invalid_value'],
      ['version nulle', (r) => ({ ...r, version: 0 }), 'invalid_version'],
      ['version négative', (r) => ({ ...r, version: -3 }), 'invalid_version'],
      ['ligne supprimée invalide', (r) => ({ ...r, name: MARK, created_at: MARK, deleted_at: NOW }), 'invalid_value'],
    ];
    for (const [label, alter, reason] of alterations) {
      const h = setup();
      await seed(h.sim.server, h.uid);
      const rows = h.sim.server.sqlRows(h.uid, 'accounts').map((r, i) => (i === 0 ? alter(r) : r));
      h.on(isGet('accounts'), forced(rows, `0-${rows.length - 1}/${rows.length}`));
      const e = await refusal(h.read());
      expect([e.code, e.table, e.reason], label).toEqual(['invalid_row', 'accounts', reason]);
      expect(e.message, label).not.toContain(MARK);
    }
  });
});

describe('V3.4-a [S] — indisponibilité (T10)', () => {
  const failures: [string, Override, string | null][] = [
    ['réseau', { network: true }, 'network'],
    ['500', { status: 500, body: '{"code":"XX000","message":"erreur"}' }, 'XX000'],
    ['502', { status: 502, body: '' }, null],
    ['503', { status: 503, body: '{"code":"PGRST002","message":"x"}' }, 'PGRST002'],
    ['504', { status: 504, body: '' }, null],
    ['408', { status: 408, body: '' }, null],
    ['429', { status: 429, body: '' }, null],
    ['SQLSTATE passager', { status: 400, body: '{"code":"57014","message":"canceling statement due to statement timeout"}' }, '57014'],
  ];
  // Première table, table du milieu, dernière table, première et dernière contre-vérification.
  for (const at of [0, 9, 17, 18, 35]) {
    it(`T10 panne à la requête ${at + 1} / 36 → unavailable, arrêt immédiat, rien de renvoyé`, async () => {
      for (const [label, failure, reason] of failures) {
        const h = setup();
        await seed(h.sim.server, h.uid);
        h.on((_r, i) => i === at, failure);
        const e = await refusal(h.read());
        expect([e.code, e.reason], label).toEqual(['unavailable', reason]);
        expect(e.table, label).toBe(READ_TABLES[at % 18]);
        expect(h.sim.requests, label).toHaveLength(at + 1);
      }
    });
  }

  it('T10 réponse 2xx illisible → invalid_response, sans le corps dans le message', async () => {
    const h = setup();
    h.on(isGet('settings'), { status: 200, body: `pas du json ${MARK}`, headers: { 'Content-Range': '0-0/1' } });
    const e = await refusal(h.read());
    expect([e.code, e.table]).toEqual(['invalid_response', 'settings']);
    expect(e.message).not.toContain(MARK);
  });
});

describe('V3.4-a [S] — refus d’authentification (T11)', () => {
  it('T11 jeton expiré (PGRST303), signature invalide (PGRST301), 403 42501, 401 sur une contre-vérification → unauthorized, arrêt immédiat', async () => {
    const cases: [string, Parameters<typeof setup>[0], ((h: ReturnType<typeof setup>) => void) | null, number, string | null][] = [
      ['jeton expiré', { token: 'EXPIRED' }, null, 401, 'PGRST303'],
      ['signature invalide', { token: 'INVALID' }, null, 401, 'PGRST301'],
      ['permission refusée', {}, (h) => h.on(isGet('budgets'), { status: 403, body: '{"code":"42501","message":"permission denied for table budgets"}' }), 403, '42501'],
      ['contre-vérification refusée', {}, (h) => h.on(isHead('accounts'), { status: 401, body: null }), 401, null],
    ];
    for (const [label, opts, arrange, status, reason] of cases) {
      const uid = randomUUID();
      const token = opts?.token === 'EXPIRED' ? userToken(uid, { expired: true }) : opts?.token === 'INVALID' ? userToken(uid, { invalid: true }) : undefined;
      const h = setup({ ...opts, token, session: token ? uid : undefined });
      const target = token ? uid : h.uid;
      arrange?.(h);
      const e = await refusal(readCloudData(h.source, target));
      expect([e.code, e.status, e.reason], label).toEqual(['unauthorized', status, reason]);
      const expected = label === 'permission refusée' ? READ_TABLES.indexOf('budgets') + 1 : label === 'contre-vérification refusée' ? 18 + READ_TABLES.indexOf('accounts') + 1 : 1;
      expect(h.sim.requests, label).toHaveLength(expected);
    }
  });
});

describe('V3.4-a [S] — pagination (T12, T34)', () => {
  it('T12 2 345 lignes → pages 0 / 1 000 / 2 000, fin exacte ; 2 000 lignes → 2 pages ; table vide → 1 requête', async () => {
    for (const [n, offsets] of [
      [2345, [0, 1000, 2000]],
      [2000, [0, 1000]],
      [0, [0]],
    ] as const) {
      const h = setup();
      if (n) await seed(h.sim.server, h.uid, { importBatches: importBatches(h.uid, randomUUID(), n) });
      const result = await h.read();
      const gets = h.sim.requests.filter(isGet('importBatches'));
      expect(gets.map((r) => Number(params(r).offset)), String(n)).toEqual(offsets);
      expect(gets.every((r) => params(r).limit === '1000')).toBe(true);
      expect(result.rows.importBatches, String(n)).toHaveLength(n);
      expect(new Set(result.rows.importBatches.map((r) => r.id)).size).toBe(n);
      expect(result.totals.importBatches).toBe(n);
    }
  });

  it('T34 serveur plafonné à 300 lignes par réponse → le décalage avance du nombre de lignes reçues, rien n’est sauté', async () => {
    const h = setup({ maxRows: 300 });
    await seed(h.sim.server, h.uid, { importBatches: importBatches(h.uid, randomUUID(), 2345) });
    const result = await h.read();
    const gets = h.sim.requests.filter(isGet('importBatches'));
    expect(gets.map((r) => Number(params(r).offset))).toEqual([0, 300, 600, 900, 1200, 1500, 1800, 2100]);
    expect(gets.every((r) => params(r).limit === '1000')).toBe(true);
    expect(new Set(result.rows.importBatches.map((r) => r.id)).size).toBe(2345);
  });
});

describe('V3.4-a [S] — intégralité : insertions pendant la lecture (T31, T32)', () => {
  async function big(h: ReturnType<typeof setup>) {
    const acc = randomUUID();
    await seed(h.sim.server, h.uid, { importBatches: importBatches(h.uid, acc, 2345) });
    return acc;
  }

  it('T31 insertion AVANT la position courante entre deux pages → total modifié → incomplete, rien de renvoyé', async () => {
    const h = setup();
    const acc = await big(h);
    h.on(isGet('importBatches', 1000), () => commitAs(h.sim.server, h.uid, [put('importBatches', importBatches(h.uid, acc, 1, () => '00000000-0000-4000-8000-000000000001')[0])]).then(() => undefined));
    const e = await refusal(h.read());
    expect([e.code, e.reason, e.table]).toEqual(['incomplete', 'total_changed', 'importBatches']);
    expect(h.sim.requests.filter(isGet('importBatches'))).toHaveLength(2);
  });

  it('T31 insertion APRÈS la position courante → total modifié → incomplete', async () => {
    const h = setup();
    const acc = await big(h);
    h.on(isGet('importBatches', 2000), () => commitAs(h.sim.server, h.uid, [put('importBatches', importBatches(h.uid, acc, 1, () => 'ffffffff-ffff-4fff-bfff-ffffffffffff')[0])]).then(() => undefined));
    expect((await refusal(h.read())).reason).toBe('total_changed');
  });

  it('T31 doublon entre deux pages (lignes décalées) avec un total inchangé → incomplete duplicate_key', async () => {
    const h = setup();
    await big(h);
    const sorted = h.sim.server.sqlRows(h.uid, 'importBatches').sort((a, b) => String(a.id).localeCompare(String(b.id)));
    h.on(isGet('importBatches', 1000), forced(sorted.slice(999, 1999), '1000-1999/2345', 206));
    expect((await refusal(h.read())).reason).toBe('duplicate_key');
  });

  it('T31 suppression logique pendant la pagination : acceptée, AUCUNE ligne sautée (lecture sans filtre deleted_at)', async () => {
    const h = setup();
    await big(h);
    const sorted = h.sim.server.sqlRows(h.uid, 'importBatches').sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const victim = sorted[10];
    h.on(isGet('importBatches', 1000), () => commitAs(h.sim.server, h.uid, [del('importBatches', victim.id as string, 1)]).then(() => undefined));
    const result = await h.read();
    expect(result.totals.importBatches).toBe(2345);
    expect(result.versions.filter((v) => v.table === 'importBatches')).toHaveLength(2345);
    // Vue antérieure de la ligne déjà lue (protégée par le contrôle de version) ; aucune autre manquante.
    expect(result.rows.importBatches).toHaveLength(2345);
  });

  it('T32 insertion dans une table APRÈS sa lecture → contre-vérification différente → incomplete fence_mismatch', async () => {
    const h = setup();
    const data = await seed(h.sim.server, h.uid);
    h.on(isGet('transactions'), () => commitAs(h.sim.server, h.uid, [put('accounts', { ...data.accounts![0], id: randomUUID(), name: 'Nouveau' })]).then(() => undefined));
    const e = await refusal(h.read());
    expect([e.code, e.reason, e.table]).toEqual(['incomplete', 'fence_mismatch', 'accounts']);
  });

  it('T32 insertion dans la DERNIÈRE table pendant les contre-vérifications → fence_mismatch', async () => {
    const h = setup();
    await seed(h.sim.server, h.uid);
    const last = READ_TABLES[READ_TABLES.length - 1];
    expect(last).toBe('notificationStates');
    h.on(isHead('users'), () =>
      commitAs(h.sim.server, h.uid, [put('notificationStates', { id: `budget:${randomUUID()}:2026-03:90`, userId: h.uid, read: false, dismissed: false, updatedAt: NOW })]).then(() => undefined),
    );
    const e = await refusal(h.read());
    expect([e.reason, e.table]).toEqual(['fence_mismatch', 'notificationStates']);
  });
});

describe('V3.4-a [S] — totaux incohérents (T33)', () => {
  it('T33 [X] postgrest-js : sans en-tête Content-Range → total null ; total « * » → NaN ; les deux refusés (count_missing)', async () => {
    const h = setup();
    const q = readQuery('users', h.uid);
    const rows = h.sim.server.sqlRows(h.uid, 'users');
    h.sim.respondNext(forced(rows, null));
    expect((await h.source.page(q, 0, 1000)).total).toBeNull();
    h.sim.respondNext(forced(rows, '0-0/*'));
    expect(Number.isNaN((await h.source.page(q, 0, 1000)).total)).toBe(true);
    for (const range of [null, '0-0/*']) {
      const h2 = setup();
      h2.on(isGet('users'), forced(rows.map((r) => ({ ...r, id: h2.uid })), range));
      expect((await refusal(h2.read())).reason).toBe('count_missing');
    }
  });

  it('T33 total qui varie, page vide avant N, plus de lignes que N, page plus grande que demandée → incomplete', async () => {
    const scenarios: [string, (h: ReturnType<typeof setup>, rows: Record<string, unknown>[]) => void, string][] = [
      ['total qui varie', (h, rows) => h.on(isGet('importBatches', 1000), forced(rows.slice(1000, 2000), '1000-1999/2400', 206)), 'total_changed'],
      ['page vide avant N', (h) => h.on(isGet('importBatches', 1000), forced([], '*/2345', 206)), 'missing_rows'],
      ['plus de lignes que N', (h, rows) => h.on(isGet('importBatches', 2000), forced(rows.slice(1999, 2345), '2000-2345/2345', 206)), 'too_many_rows'],
      ['page plus grande que demandée', (h, rows) => h.on(isGet('importBatches', 0), forced(rows.slice(0, 1001), '0-1000/2345', 206)), 'page_overflow'],
    ];
    for (const [label, arrange, reason] of scenarios) {
      const h = setup();
      await seed(h.sim.server, h.uid, { importBatches: importBatches(h.uid, randomUUID(), 2345) });
      const rows = h.sim.server.sqlRows(h.uid, 'importBatches').sort((a, b) => String(a.id).localeCompare(String(b.id)));
      arrange(h, rows);
      const e = await refusal(h.read());
      expect([e.code, e.reason, e.table], label).toEqual(['incomplete', reason, 'importBatches']);
    }
  });

  it('T33 contre-vérification sans total valide, 404 à corps tableau (converti en succès vide par postgrest-js), 416 → refus', async () => {
    const h1 = setup();
    h1.on(isHead('rates'), forced(null, '*/*'));
    expect((await refusal(h1.read())).reason).toBe('count_missing');
    const h2 = setup();
    h2.on(isGet('goals'), forced([], null, 404));
    expect((await refusal(h2.read())).reason).toBe('count_missing');
    const h3 = setup();
    h3.on(isGet('debts'), { status: 416, body: '{"code":"PGRST103","message":"Requested range not satisfiable"}', headers: { 'Content-Range': '*/0' } });
    const e = await refusal(h3.read());
    expect([e.code, e.reason]).toEqual(['rejected', 'PGRST103']);
  });
});

describe('V3.4-a [S] — modification sur place (T35)', () => {
  it('T35 compte modifié et compte supprimé logiquement pendant la lecture : lecture acceptée (vue antérieure) ; écritures HTTP fondées sur elle refusées par conflit, sans perte', async () => {
    const h = setup();
    const data = await seed(h.sim.server, h.uid);
    const [a0, a1] = data.accounts!;
    h.on(isGet('transactions'), () => commitAs(h.sim.server, h.uid, [put('accounts', { ...a0, name: 'Modifié ailleurs' }, 1), del('accounts', a1.id as string, 1)]).then(() => undefined));
    const result = await h.read();
    const version = (id: unknown) => result.versions.find((v) => v.table === 'accounts' && v.key === keyString(id as string))!;
    expect(version(a0.id)).toMatchObject({ version: 1, deleted: false });
    expect(version(a1.id)).toMatchObject({ version: 1, deleted: false });
    const transport = new HttpTransport(h.client);
    await expect(transport.commit(lot(h.uid, [put('accounts', { ...a0, name: 'Écrasement' }, 1)]))).rejects.toBeInstanceOf(CloudConflictError);
    await expect(transport.commit(lot(h.uid, [del('accounts', a1.id as string, 1)]))).rejects.toBeInstanceOf(CloudConflictError);
    expect(h.sim.server.entry(h.uid, 'accounts', a0.id as string)).toMatchObject({ version: 2, row: { name: 'Modifié ailleurs' } });
    expect(h.sim.server.entry(h.uid, 'accounts', a1.id as string)).toMatchObject({ version: 2, deleted: true });
  });
});

describe('V3.4-a [S] — contrôle P-7 (T36)', () => {
  it('T36 aucun profil, ou profil supprimé → invariant ; rien de renvoyé', async () => {
    for (const [label, rows] of [
      ['aucun profil', () => []],
      ['profil supprimé', (uid: string) => [{ id: uid, display_name: '', created_at: REGISTERED_AT, version: 2, sync_txid: '2', server_updated_at: NOW, deleted_at: NOW }]],
    ] as const) {
      const h = setup();
      const list = rows(h.uid);
      h.on(isGet('users'), forced(list, list.length ? `0-${list.length - 1}/${list.length}` : '*/0'));
      h.on(isHead('users'), forced(null, `*/${list.length}`));
      const e = await refusal(h.read());
      expect([e.code, e.reason, e.table], label).toEqual(['invariant', 'profile', 'users']);
      expect(h.sim.requests, label).toHaveLength(36);
    }
  });

  it('T36 paramètres : 0 ligne acceptée ; 1 ligne supprimée acceptée (deleted true) ; 2 lignes → refus', async () => {
    const h = setup();
    const fresh = await h.read();
    expect(fresh.rows.settings).toEqual([]);
    expect(fresh.rows.users).toEqual([{ id: h.uid, displayName: '', createdAt: REGISTERED_AT }]);
    await commitAs(h.sim.server, h.uid, [put('settings', dataset(h.uid).settings![0])]);
    await commitAs(h.sim.server, h.uid, [del('settings', h.uid, 1)]);
    const after = await h.read();
    expect(after.rows.settings).toEqual([]);
    expect(after.versions).toContainEqual({ table: 'settings', key: keyString(h.uid), version: 2, deleted: true });
    const row = h.sim.server.sqlRows(h.uid, 'settings')[0];
    const h2 = setup();
    h2.on(isGet('settings'), forced([{ ...row, user_id: h2.uid }, { ...row, user_id: h2.uid }], '0-1/2'));
    h2.on(isHead('settings'), forced(null, '*/2'));
    expect((await refusal(h2.read())).code).toBe('incomplete'); // même clé deux fois : refus avant le contrôle P-7
  });
});
