/**
 * V3.3 / P15 — suite de CONTRAT commune aux deux transports du protocole ChangeSet v1.
 *
 * Les mêmes scénarios (lots TS) sont joués :
 *  - sur `MemoryTransport` ALIGNÉ sur le serveur (vue « session » `as(uid)`) ;
 *  - sur `HttpTransport`, par le VRAI client Supabase (jeton de session, format filaire SQL),
 *    jusqu'au serveur PostgREST SIMULÉ (`src/test/postgrestSimulator.ts`).
 * Ils doivent produire exactement les mêmes confirmations et les mêmes refus (codes, conflits).
 * Tests SIMULÉS : aucune requête réseau réelle (fetch global remplacé par une sonde).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDemoData } from '@/data/demo';
import { PRIMARY_KEYS, type TableName } from '@/data/tables';
import type { Key } from '@/data/storage';
import { MemoryTransport, REGISTERED_AT } from './MemoryTransport';
import { HttpTransport } from './HttpTransport';
import { CloudConflictError, CloudProtocolError, CloudTransportError, checkCommitResult, type ChangeOp, type ChangeSet, type CloudTransport } from './transport';
import { postgrestSimulator, simClient } from '@/test/postgrestSimulator';

const TODAY = '2026-03-15';
const NOW = '2026-03-15T10:00:00.000Z';

interface Harness {
  name: string;
  make(): { server: MemoryTransport; as(uid: string): CloudTransport };
}

const harnesses: Harness[] = [
  {
    name: 'MemoryTransport aligné',
    make: () => {
      const server = new MemoryTransport();
      return { server, as: (uid) => server.as(uid) };
    },
  },
  {
    name: 'HttpTransport → PostgREST simulé',
    make: () => {
      const sim = postgrestSimulator();
      return {
        server: sim.server,
        as: (uid) => {
          sim.server.registerUser(uid);
          return new HttpTransport(simClient(sim.fetch, { uid }));
        },
      };
    },
  },
];

const keyOf = (table: TableName, row: Record<string, unknown>): Key => {
  const pk = PRIMARY_KEYS[table];
  return typeof pk === 'string' ? (row[pk] as string) : pk.map((f) => row[f] as string);
};
const lot = (userId: string, ops: ChangeOp[], changesetId: string = randomUUID()): ChangeSet => ({ protocol: 1, changesetId, userId, ops });
const put = (table: TableName, row: object, expectedVersion: number | null = null): ChangeOp => ({ table, type: 'put', key: keyOf(table, row as Record<string, unknown>), expectedVersion, row: row as Record<string, unknown> });
const del = (table: TableName, key: Key, expectedVersion: number | null): ChangeOp => ({ table, type: 'delete', key, expectedVersion });
const demo = (uid: string) => generateDemoData(uid, TODAY);

async function refusal(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('succès inattendu');
    },
    (e: unknown) => e,
  );
}
async function expectCode(p: Promise<unknown>, code: string) {
  const e = await refusal(p);
  expect(e).toBeInstanceOf(CloudProtocolError);
  expect((e as CloudProtocolError).code).toBe(code);
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

describe.each(harnesses)('contrat du transport — $name', (h) => {
  it('création, modification, suppression logique, réactivation : versions 1 → 4, confirmations exactes', async () => {
    const { server, as } = h.make();
    const uid = randomUUID();
    const c = as(uid);
    const acc = demo(uid).accounts[0];
    const steps: [ChangeSet, number, boolean][] = [
      [lot(uid, [put('accounts', acc)]), 1, false],
      [lot(uid, [put('accounts', { ...acc, name: 'Renommé', updatedAt: NOW }, 1)]), 2, false],
      [lot(uid, [del('accounts', acc.id, 2)]), 3, true],
      [lot(uid, [put('accounts', { ...acc, name: 'Réactivé', updatedAt: NOW }, 3)]), 4, false],
    ];
    for (const [changes, version, deleted] of steps) {
      const r = await c.commit(changes);
      expect(r.status).toBe('applied');
      expect(r.versions).toEqual([{ table: 'accounts', key: acc.id, version, deleted }]);
      expect(checkCommitResult(changes, r)).toBe(true);
    }
    expect(server.entry(uid, 'accounts', acc.id)).toMatchObject({ version: 4, deleted: false });
  });

  it('clés composites et dérivées (paramètres, règle + échéance, notification) : aller-retour exact', async () => {
    const { as } = h.make();
    const uid = randomUUID();
    const d = demo(uid);
    const occ = d.occurrences[0];
    const rule = d.recurringRules.find((r) => r.id === occ.ruleId)!;
    const notif = { id: 'budget:x:2026-03:90', userId: uid, read: true, dismissed: false, updatedAt: NOW };
    const changes = lot(uid, [put('settings', d.settings), put('recurringRules', rule), put('occurrences', occ), put('notificationStates', notif)]);
    const r = await as(uid).commit(changes);
    expect(r.versions.map((v) => [v.table, v.key, v.version])).toEqual([
      ['settings', uid, 1],
      ['recurringRules', rule.id, 1],
      ['occurrences', `${occ.ruleId}:${occ.dueDate}`, 1],
      ['notificationStates', [uid, notif.id], 1],
    ]);
    expect(checkCommitResult(changes, r)).toBe(true);
  });

  it('conflit de version : lot refusé EN ENTIER, informations de conflit complètes', async () => {
    const { server, as } = h.make();
    const uid = randomUUID();
    const c = as(uid);
    const [a1, a2] = demo(uid).accounts;
    await c.commit(lot(uid, [put('accounts', a1), put('accounts', a2)]));
    await c.commit(lot(uid, [del('accounts', a2.id, 1)]));
    const e = await refusal(c.commit(lot(uid, [put('accounts', { ...a1, name: 'X' }, 1), put('accounts', { ...a2, name: 'Y' }, 5)])));
    expect(e).toBeInstanceOf(CloudConflictError);
    expect((e as CloudConflictError).conflicts).toEqual([{ table: 'accounts', key: a2.id, expectedVersion: 5, actualVersion: 2, actualDeleted: true }]);
    expect(server.entry(uid, 'accounts', a1.id)).toMatchObject({ version: 1 }); // la 1re opération, valide, n'est pas appliquée
    const gone = await refusal(c.commit(lot(uid, [del('accounts', a2.id, 2)])));
    expect((gone as CloudConflictError).conflicts).toEqual([{ table: 'accounts', key: a2.id, expectedVersion: 2, actualVersion: 2, actualDeleted: true }]);
  });

  it('idempotence : même lot → replayed (mêmes versions) ; même identifiant, autre contenu → changeset_id_reused', async () => {
    const { as } = h.make();
    const uid = randomUUID();
    const c = as(uid);
    const acc = demo(uid).accounts[0];
    const changes = lot(uid, [put('accounts', acc)]);
    const first = await c.commit(changes);
    const again = await c.commit(changes);
    expect(again).toEqual({ ...first, status: 'replayed' });
    await expectCode(c.commit(lot(uid, [put('accounts', { ...acc, name: 'Autre' }, 1)], changes.changesetId)), 'changeset_id_reused');
  });

  it('résolution : appliqué → replayed ; inconnu → abandoned, puis jamais appliqué', async () => {
    const { as } = h.make();
    const uid = randomUUID();
    const c = as(uid);
    const [a1, a2] = demo(uid).accounts;
    const applied = lot(uid, [put('accounts', a1)]);
    const r = await c.commit(applied);
    expect(await c.resolve(applied.changesetId, uid)).toEqual({ ...r, status: 'replayed' });
    const lost = randomUUID();
    expect(await c.resolve(lost, uid)).toEqual({ changesetId: lost, status: 'abandoned' });
    await expectCode(c.commit(lot(uid, [put('accounts', a2)], lost)), 'changeset_abandoned');
  });

  it('identifiant de lot propre à chaque utilisateur : aucune fuite entre utilisateurs', async () => {
    const { as } = h.make();
    const [ua, ub, uc] = [randomUUID(), randomUUID(), randomUUID()];
    const id = randomUUID();
    await as(ua).commit(lot(ua, [put('accounts', demo(ua).accounts[0])], id));
    const rb = await as(ub).commit(lot(ub, [put('accounts', demo(ub).accounts[0])], id));
    expect(rb.status).toBe('applied'); // même identifiant, autre utilisateur : lot distinct
    expect(await as(uc).resolve(id, uc)).toEqual({ changesetId: id, status: 'abandoned' }); // inconnu pour C
  });

  it('identité : lot d’un autre utilisateur, ligne ou clé d’un autre → unauthorized', async () => {
    const { as } = h.make();
    const [ua, ub] = [randomUUID(), randomUUID()];
    const c = as(ua);
    await expectCode(c.commit(lot(ub, [put('accounts', demo(ub).accounts[0])])), 'unauthorized');
    await expectCode(c.commit(lot(ua, [put('accounts', demo(ub).accounts[0])])), 'unauthorized');
    await expectCode(c.commit(lot(ua, [put('settings', demo(ub).settings)])), 'unauthorized');
    await expectCode(c.resolve(randomUUID(), ub), 'unauthorized');
  });

  it('profil : créé à l’inscription (version 1), modifiable, jamais recréé ni supprimé par un lot', async () => {
    const { server, as } = h.make();
    const uid = randomUUID();
    const c = as(uid);
    expect(server.entry(uid, 'users', uid)).toMatchObject({ version: 1, deleted: false });
    const profile = { id: uid, displayName: 'Nouveau nom', createdAt: REGISTERED_AT };
    expect((await c.commit(lot(uid, [put('users', profile, 1)]))).versions[0]).toEqual({ table: 'users', key: uid, version: 2, deleted: false });
    const recreate = await refusal(c.commit(lot(uid, [put('users', profile, null)])));
    expect((recreate as CloudConflictError).conflicts).toEqual([{ table: 'users', key: uid, expectedVersion: null, actualVersion: 2, actualDeleted: false }]);
    await expectCode(c.commit(lot(uid, [del('users', uid, 2)])), 'invalid_operation');
  });

  it('clé déjà prise par un autre utilisateur : création refusée (duplicate_key), modification = conflit sans fuite', async () => {
    const { as } = h.make();
    const [ua, ub] = [randomUUID(), randomUUID()];
    const accA = demo(ua).accounts[0];
    await as(ua).commit(lot(ua, [put('accounts', accA)]));
    const stolen = { ...demo(ub).accounts[0], id: accA.id };
    await expectCode(as(ub).commit(lot(ub, [put('accounts', stolen)])), 'duplicate_key');
    const e = await refusal(as(ub).commit(lot(ub, [put('accounts', stolen, 1)])));
    expect((e as CloudConflictError).conflicts).toEqual([{ table: 'accounts', key: accA.id, expectedVersion: 1, actualVersion: null, actualDeleted: null }]);
  });

  it('refus de forme : codes du serveur (table, version attendue, clé, lot, protocole, métadonnées)', async () => {
    const { as } = h.make();
    const uid = randomUUID();
    const c = as(uid);
    const acc = demo(uid).accounts[0];
    await expectCode(c.commit(lot(uid, [{ table: 'meta', type: 'put', key: 'schema', expectedVersion: null, row: { key: 'schema', value: 1 } }])), 'unsupported_table');
    await expectCode(c.commit(lot(uid, [put('accounts', acc, 0)])), 'invalid_operation');
    const upper = { ...acc, id: acc.id.toUpperCase() };
    await expectCode(c.commit(lot(uid, [put('accounts', upper)])), 'invalid_key');
    await expectCode(c.commit(lot(uid, [{ ...put('accounts', acc), key: randomUUID() }])), 'invalid_key');
    await expectCode(c.commit(lot(uid, [])), 'invalid_changeset');
    await expectCode(c.commit(lot(uid, [put('accounts', acc), put('accounts', { ...acc, name: 'Bis' })])), 'invalid_changeset');
    await expectCode(c.commit({ ...lot(uid, [put('accounts', acc)]), protocol: 2 } as unknown as ChangeSet), 'unsupported_protocol');
    await expectCode(c.commit(lot(uid, [put('accounts', { ...acc, version: 3 })])), 'invalid_row');
  });

  it('atomicité : un refus annule tout le lot (aucune opération appliquée)', async () => {
    const { server, as } = h.make();
    const uid = randomUUID();
    const c = as(uid);
    const [a1, a2] = demo(uid).accounts;
    await c.commit(lot(uid, [put('accounts', a1)]));
    await refusal(c.commit(lot(uid, [put('accounts', a2), put('accounts', a1, 9)])));
    expect(server.entry(uid, 'accounts', a2.id)).toBeUndefined();
  });

  it('résolution pendant un lot en cours : changeset_pending → issue inconnue (CloudTransportError)', async () => {
    const { server, as } = h.make();
    const uid = randomUUID();
    const c = as(uid);
    server.pendingResolveNext = true;
    const e = await refusal(c.resolve(randomUUID(), uid));
    expect(e).toBeInstanceOf(CloudTransportError);
    expect(String((e as Error).message)).toMatch(/changeset_pending/);
  });
});
