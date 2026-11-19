/**
 * V3.3 — transport HTTP (`HttpTransport.ts`) : requêtes, jeton de session, format filaire,
 * erreurs HTTP / métier / authentification / réseau, réponses inattendues, intégration avec
 * `CloudStorage`. Tests SIMULÉS : vrai client Supabase, réseau remplacé par le serveur
 * PostgREST simulé ; aucune requête réelle (fetch global remplacé par une sonde).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDemoData } from '@/data/demo';
import { serializeRow } from './mapping';
import { HttpTransport } from './HttpTransport';
import { CloudCacheDB } from './CloudCacheDB';
import { CloudStorage, cloudCacheName } from './CloudStorage';
import {
  CloudConflictError,
  CloudProtocolError,
  CloudTransientRejectionError,
  CloudTransportError,
  isDefinitiveRejection,
  type ChangeOp,
  type ChangeSet,
} from './transport';
import { SIM_ANON_KEY, postgrestSimulator, simClient, userToken } from '@/test/postgrestSimulator';

const TODAY = '2026-03-15';
const lot = (userId: string, ops: ChangeOp[], changesetId = randomUUID()): ChangeSet => ({ protocol: 1, changesetId, userId, ops });
const putAccount = (row: { id: string }, expectedVersion: number | null = null): ChangeOp => ({ table: 'accounts', type: 'put', key: row.id, expectedVersion, row: row as unknown as Record<string, unknown> });

function setup(opts: { session?: boolean; token?: string; timeoutMs?: number } = {}) {
  const sim = postgrestSimulator();
  const uid = randomUUID();
  sim.server.registerUser(uid);
  const token = opts.token ?? userToken(uid);
  const client = simClient(sim.fetch, opts.session === false ? null : { uid, token });
  return { sim, uid, token, transport: new HttpTransport(client, { timeoutMs: opts.timeoutMs }), acc: generateDemoData(uid, TODAY).accounts[0] };
}

async function refusal(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('succès inattendu');
    },
    (e: unknown) => e,
  );
}

let networkProbe: ReturnType<typeof vi.fn>;
beforeEach(() => {
  networkProbe = vi.fn(() => Promise.reject(new Error('réseau réel interdit pendant les tests')));
  vi.stubGlobal('fetch', networkProbe);
});
afterEach(() => {
  expect(networkProbe).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('V3.3 — requêtes HTTP', () => {
  it('apply_changeset : POST /rest/v1/rpc/apply_changeset, clé publique, jeton de la session, corps { p_changeset } au format SQL', async () => {
    const { sim, uid, token, transport, acc } = setup();
    const changes = lot(uid, [putAccount(acc)]);
    await transport.commit(changes);
    expect(sim.requests).toHaveLength(1);
    const [req] = sim.requests;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/rest/v1/rpc/apply_changeset');
    expect(req.headers.apikey).toBe(SIM_ANON_KEY);
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    expect(req.headers['content-type']).toMatch(/application\/json/);
    expect(req.body).toEqual({
      p_changeset: {
        protocol: 1,
        changesetId: changes.changesetId,
        userId: uid,
        ops: [{ table: 'accounts', type: 'put', key: { id: acc.id }, expectedVersion: null, row: serializeRow('accounts', acc).values }],
      },
    });
    expect(JSON.stringify(req)).not.toMatch(/service_role|sb_secret_/);
  });

  it('suppression et clés composites au format SQL ; resolve_changeset : corps { p_changeset_id }', async () => {
    const { sim, uid, transport, acc } = setup();
    await transport.commit(lot(uid, [putAccount(acc)]));
    await transport.commit(lot(uid, [{ table: 'accounts', type: 'delete', key: acc.id, expectedVersion: 1 }, { table: 'notificationStates', type: 'put', key: [uid, 'n:1'], expectedVersion: null, row: { id: 'n:1', userId: uid, read: false, dismissed: false, updatedAt: '2026-03-15T10:00:00.000Z' } }]));
    expect((sim.requests[1].body as { p_changeset: { ops: unknown[] } }).p_changeset.ops).toEqual([
      { table: 'accounts', type: 'delete', key: { id: acc.id }, expectedVersion: 1 },
      { table: 'notification_states', type: 'put', key: { user_id: uid, id: 'n:1' }, expectedVersion: null, row: { user_id: uid, id: 'n:1', read: false, dismissed: false, updated_at: '2026-03-15T10:00:00.000Z' } },
    ]);
    const id = randomUUID();
    expect(await transport.resolve(id, uid)).toEqual({ changesetId: id, status: 'abandoned' });
    expect(sim.requests[2]).toMatchObject({ method: 'POST', path: '/rest/v1/rpc/resolve_changeset', body: { p_changeset_id: id } });
  });

  it('chaque client transmet le jeton de SA session', async () => {
    const sim = postgrestSimulator();
    const [ua, ub] = [randomUUID(), randomUUID()];
    const ta = new HttpTransport(simClient(sim.fetch, { uid: ua }));
    const tb = new HttpTransport(simClient(sim.fetch, { uid: ub }));
    await ta.commit(lot(ua, [putAccount(generateDemoData(ua, TODAY).accounts[0])]));
    await tb.commit(lot(ub, [putAccount(generateDemoData(ub, TODAY).accounts[0])]));
    const subs = sim.requests.map((r) => JSON.parse(atob(r.headers.authorization.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub);
    expect(subs).toEqual([ua, ub]);
  });

  it('pièce jointe : le fichier ne quitte jamais l’appareil (P19)', async () => {
    const { sim, uid, transport } = setup();
    const att = { id: randomUUID(), userId: uid, name: 'recu.png', mimeType: 'image/png', size: 9, blob: new Blob(['CONTENU-SECRET']), createdAt: '2026-03-15T10:00:00.000Z' };
    await transport.commit(lot(uid, [{ table: 'attachments', type: 'put', key: att.id, expectedVersion: null, row: att as unknown as Record<string, unknown> }]));
    const row = (sim.requests[0].body as { p_changeset: { ops: { row: Record<string, unknown> }[] } }).p_changeset.ops[0].row;
    expect(Object.keys(row).sort()).toEqual(['created_at', 'id', 'mime_type', 'name', 'size', 'user_id']);
    expect(JSON.stringify(sim.requests)).not.toContain('CONTENU-SECRET');
  });
});

describe('V3.3 — refus avant tout envoi', () => {
  it('sans session : commit et resolve refusés (unauthorized), aucune requête', async () => {
    const { sim, uid, transport, acc } = setup({ session: false });
    for (const p of [transport.commit(lot(uid, [putAccount(acc)])), transport.resolve(randomUUID(), uid)]) {
      const e = await refusal(p);
      expect(e).toBeInstanceOf(CloudProtocolError);
      expect((e as CloudProtocolError).code).toBe('unauthorized');
    }
    expect(sim.requests).toHaveLength(0);
  });

  it('lot d’un autre utilisateur que la session, ou ligne / clé invalide : refus définitif, aucune requête', async () => {
    const { sim, uid, transport, acc } = setup();
    const other = randomUUID();
    const cases: [ChangeSet, string][] = [
      [lot(other, [putAccount({ ...acc, userId: other } as never)]), 'unauthorized'],
      [lot(uid, [putAccount({ ...acc, userId: other } as never)]), 'unauthorized'],
      [lot(uid, [putAccount({ ...acc, id: acc.id.toUpperCase() })]), 'invalid_key'],
      [lot(uid, [{ table: 'meta', type: 'put', key: 'k', expectedVersion: null, row: { key: 'k', value: 1 } }]), 'unsupported_table'],
      [lot(uid, [putAccount({ ...acc, version: 2 } as never)]), 'invalid_row'],
      [lot(uid, [{ ...putAccount(acc), key: randomUUID() }]), 'invalid_key'],
    ];
    for (const [changes, code] of cases) {
      const e = await refusal(transport.commit(changes));
      expect(e, code).toBeInstanceOf(CloudProtocolError);
      expect((e as CloudProtocolError).code, code).toBe(code);
      expect(isDefinitiveRejection(e)).toBe(true);
    }
    expect(sim.requests).toHaveLength(0);
  });
});

describe('V3.3 — réponses et erreurs du serveur', () => {
  const pg = (status: number, code: string | null, message: string, details: unknown = null) => ({ status, body: JSON.stringify({ code, message, details: details === null ? null : JSON.stringify(details), hint: null }) });

  it('confirmation reconvertie (tables et clés TS), y compris replayed', async () => {
    const { uid, transport, acc } = setup();
    const changes = lot(uid, [putAccount(acc)]);
    const r = await transport.commit(changes);
    expect(r).toEqual({ changesetId: changes.changesetId, status: 'applied', versions: [{ table: 'accounts', key: acc.id, version: 1, deleted: false }] });
    expect(await transport.commit(changes)).toEqual({ ...r, status: 'replayed' });
  });

  it('version_conflict : CloudConflictError avec conflits reconvertis (clés TS, versions) ; détails illisibles → conflit sans détail', async () => {
    const { sim, uid, transport, acc } = setup();
    sim.respondNext(pg(409, 'PT409', 'version_conflict', { conflicts: [{ table: 'accounts', key: { id: acc.id }, expectedVersion: 1, actualVersion: 3, actualDeleted: false }, { table: 'recurring_occurrences', key: { rule_id: acc.id, due_date: '2026-03-03' }, expectedVersion: null, actualVersion: null, actualDeleted: null }] }));
    const e = await refusal(transport.commit(lot(uid, [putAccount(acc, 1)])));
    expect(e).toBeInstanceOf(CloudConflictError);
    expect((e as CloudConflictError).conflicts).toEqual([
      { table: 'accounts', key: acc.id, expectedVersion: 1, actualVersion: 3, actualDeleted: false },
      { table: 'occurrences', key: `${acc.id}:2026-03-03`, expectedVersion: null, actualVersion: null, actualDeleted: null },
    ]);
    sim.respondNext({ status: 409, body: JSON.stringify({ code: 'PT409', message: 'version_conflict', details: 'illisible', hint: null }) });
    const e2 = await refusal(transport.commit(lot(uid, [putAccount(acc, 1)])));
    expect(e2).toBeInstanceOf(CloudConflictError);
    expect((e2 as CloudConflictError).conflicts).toEqual([]);
  });

  it.each([
    ['403 unauthorized', pg(403, 'PT403', 'unauthorized', { reason: 'x' }), CloudProtocolError, 'unauthorized'],
    ['400 invalid_row (CHECK 23514)', pg(400, 'PT400', 'invalid_row', { op: 0, sqlstate: '23514', constraint: 'accounts_type_check' }), CloudProtocolError, 'invalid_row'],
    ['400 invalid_key', pg(400, 'PT400', 'invalid_key', { op: 0 }), CloudProtocolError, 'invalid_key'],
    ['400 unsupported_protocol', pg(400, 'PT400', 'unsupported_protocol', null), CloudProtocolError, 'unsupported_protocol'],
    ['409 duplicate_key', pg(409, 'PT409', 'duplicate_key', { op: 0 }), CloudProtocolError, 'duplicate_key'],
    ['409 changeset_id_reused', pg(409, 'PT409', 'changeset_id_reused', null), CloudProtocolError, 'changeset_id_reused'],
    ['409 changeset_abandoned', pg(409, 'PT409', 'changeset_abandoned', null), CloudProtocolError, 'changeset_abandoned'],
    ['413 changeset_too_large', pg(413, 'PT413', 'changeset_too_large', { maxOps: 5000 }), CloudProtocolError, 'changeset_too_large'],
    ['409 contrainte différée 23503', pg(409, '23503', 'insert or update violates foreign key constraint'), CloudProtocolError, 'invalid_row'],
    ['409 exclusion différée 23P01', pg(409, '23P01', 'conflicting key value violates exclusion constraint'), CloudProtocolError, 'duplicate_key'],
    ['401 JWT expiré (PGRST303)', pg(401, 'PGRST303', 'JWT expired'), CloudProtocolError, 'unauthorized'],
    ['401 permission (42501)', pg(401, '42501', 'permission denied for function apply_changeset'), CloudProtocolError, 'unauthorized'],
    ['404 fonction absente (PGRST202)', pg(404, 'PGRST202', 'Could not find the function'), CloudProtocolError, 'rejected'],
    ['400 invalid_row passagère (40001)', pg(400, 'PT400', 'invalid_row', { op: 0, sqlstate: '40001' }), CloudTransientRejectionError, null],
    ['400 invalid_row passagère (55P03)', pg(400, 'PT400', 'invalid_row', { op: 0, sqlstate: '55P03' }), CloudTransientRejectionError, null],
    ['429 limite de débit', { status: 429, body: '{"message":"Too Many Requests"}' }, CloudTransientRejectionError, null],
  ])('%s → refus définitif (%s)', async (_label, response, cls, code) => {
    const { sim, uid, transport, acc } = setup();
    sim.respondNext(response);
    const e = await refusal(transport.commit(lot(uid, [putAccount(acc)])));
    expect(e).toBeInstanceOf(cls);
    if (code) expect((e as CloudProtocolError).code).toBe(code);
    expect(isDefinitiveRejection(e)).toBe(true);
    expect(sim.requests).toHaveLength(1); // aucune nouvelle tentative
  });

  it.each([
    ['500', { status: 500, body: '{"message":"internal"}' }],
    ['502', { status: 502, body: 'Bad Gateway', contentType: 'text/plain' }],
    ['503', { status: 503, body: '{"message":"unavailable"}' }],
    ['504', { status: 504, body: 'Gateway Timeout', contentType: 'text/plain' }],
    ['200 corps non JSON', { status: 200, body: '<html>proxy</html>', contentType: 'text/html' }],
    ['200 corps vide', { status: 200, body: '' }],
    ['200 forme inattendue', { status: 200, body: '{"ok":true}' }],
    ['200 table inconnue', { status: 200, body: '{"changesetId":"x","status":"applied","versions":[{"table":"inconnue","key":{"id":"x"},"version":1,"deleted":false}]}' }],
    ['200 statut inconnu', { status: 200, body: '{"changesetId":"x","status":"ok","versions":[]}' }],
    ['404 tableau', { status: 404, body: '[]' }],
  ])('%s → issue inconnue (CloudTransportError), jamais un succès', async (_label, response) => {
    const { sim, uid, transport, acc } = setup();
    sim.respondNext(response);
    const e = await refusal(transport.commit(lot(uid, [putAccount(acc)])));
    expect(e).toBeInstanceOf(CloudTransportError);
    expect(isDefinitiveRejection(e)).toBe(false);
    expect(sim.requests).toHaveLength(1);
  });

  it('échec réseau → issue inconnue, une seule tentative', async () => {
    const { sim, uid, transport, acc } = setup();
    sim.respondNext({ network: true });
    const e = await refusal(transport.commit(lot(uid, [putAccount(acc)])));
    expect(e).toBeInstanceOf(CloudTransportError);
    expect(String((e as Error).message)).toMatch(/réseau/);
    expect(sim.requests).toHaveLength(1);
  });

  it('délai dépassé → requête annulée, issue inconnue', async () => {
    const { sim, uid, transport, acc } = setup({ timeoutMs: 50 });
    sim.respondNext({ hang: true });
    const e = await refusal(transport.commit(lot(uid, [putAccount(acc)])));
    expect(e).toBeInstanceOf(CloudTransportError);
    expect(String((e as Error).message)).toMatch(/délai dépassé \(50 ms\)/);
    expect(sim.requests).toHaveLength(1);
  });

  it('jeton refusé par le serveur (signature invalide, expiré) → unauthorized', async () => {
    for (const token of [userToken(randomUUID(), { invalid: true }), userToken(randomUUID(), { expired: true })]) {
      const sim = postgrestSimulator();
      const uid = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string;
      const transport = new HttpTransport(simClient(sim.fetch, { uid, token }));
      const e = await refusal(transport.commit(lot(uid, [putAccount(generateDemoData(uid, TODAY).accounts[0])])));
      expect((e as CloudProtocolError).code).toBe('unauthorized');
    }
  });

  it('resolve : changeset_pending → issue inconnue ; réponse inattendue → issue inconnue', async () => {
    const { sim, uid, transport } = setup();
    sim.respondNext(pg(409, 'PT409', 'changeset_pending', { changesetId: 'x' }));
    expect(await refusal(transport.resolve(randomUUID(), uid))).toBeInstanceOf(CloudTransportError);
    sim.respondNext({ status: 200, body: '{"status":"abandoned"}' });
    expect(await refusal(transport.resolve(randomUUID(), uid))).toBeInstanceOf(CloudTransportError);
  });
});

describe('V3.3 — intégration avec CloudStorage (contrat existant)', () => {
  function storageFor() {
    const { sim, uid, transport, acc } = setup();
    const cache = new CloudCacheDB(cloudCacheName(uid), { userId: uid });
    return { sim, uid, acc, cache, storage: new CloudStorage(cache, transport, uid) };
  }

  it('écriture confirmée : cache et version serveur mis à jour', async () => {
    const { sim, uid, acc, cache, storage } = storageFor();
    await storage.tables.accounts.put(acc);
    expect(sim.server.entry(uid, 'accounts', acc.id)).toMatchObject({ version: 1 });
    expect(await storage.serverVersion('accounts', acc.id)).toMatchObject({ version: 1, deleted: false });
    expect(await cache.accounts.get(acc.id)).toEqual(acc);
    await cache.delete();
  });

  it('issue inconnue (503) : lot conservé non confirmé, résolu avant l’écriture suivante (abandonné), cache intact', async () => {
    const { sim, uid, acc, cache, storage } = storageFor();
    sim.respondNext({ status: 503, body: '{"message":"unavailable"}' });
    await expect(storage.tables.accounts.put(acc)).rejects.toBeInstanceOf(CloudTransportError);
    expect(storage.unconfirmedChangesetId).not.toBeNull();
    const other = { ...generateDemoData(uid, TODAY).accounts[1] };
    await storage.tables.accounts.put(other);
    expect(storage.unconfirmedChangesetId).toBeNull();
    expect(sim.requests.map((r) => r.path)).toEqual(['/rest/v1/rpc/apply_changeset', '/rest/v1/rpc/resolve_changeset', '/rest/v1/rpc/apply_changeset']);
    expect(await cache.accounts.get(acc.id)).toBeUndefined();
    expect(sim.server.entry(uid, 'accounts', acc.id)).toBeUndefined();
    await cache.delete();
  });

  it('conflit : refus définitif remonté tel quel, rien d’écrit dans le cache', async () => {
    const { sim, acc, cache, storage } = storageFor();
    sim.respondNext({ status: 409, body: JSON.stringify({ code: 'PT409', message: 'version_conflict', details: JSON.stringify({ conflicts: [] }), hint: null }) });
    await expect(storage.tables.accounts.put(acc)).rejects.toBeInstanceOf(CloudConflictError);
    expect(storage.unconfirmedChangesetId).toBeNull();
    expect(await cache.accounts.get(acc.id)).toBeUndefined();
    await cache.delete();
  });
});
