/**
 * Annulation immédiate d'une restauration (P18) — LocalRepository et CloudRepository,
 * données fictives (jeu de démonstration, fixture V1 historique, pièces jointes
 * synthétiques).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NexoraDB } from '../db';
import { LocalRepository } from '../repository';
import { CloudRepository } from '../cloud/CloudRepository';
import { CloudCacheDB } from '../cloud/CloudCacheDB';
import { cloudCacheName } from '../cloud/CloudStorage';
import { MemoryTransport } from '../cloud/MemoryTransport';
import type { NexoraRepository } from '../contracts';
import type { StoragePort } from '../storage';
import { generateDemoData } from '../demo';
import { changedSinceRestore, fingerprintData, planRestore, undoRestore, undoStore, type UndoSlot } from './index';

const V1 = readFileSync(fileURLToPath(new URL('./__fixtures__/backup-v1-2026-10-31.json', import.meta.url)), 'utf8');
let seq = 0;
type Env = { kind: string; repo: NexoraRepository; db: NexoraDB; transport?: MemoryTransport };
function local(): Env {
  const db = new NexoraDB(`undo-${++seq}`);
  return { kind: 'local', repo: new LocalRepository(db, 'local-user'), db };
}
function cloud(): Env {
  const u = `undo-cloud-${++seq}`;
  const transport = new MemoryTransport();
  const db = new CloudCacheDB(cloudCacheName(u), { userId: u });
  return { kind: 'cloud', repo: new CloudRepository(u, { transport, cache: db }), db, transport };
}
const store = (r: NexoraRepository) => Reflect.get(r, 'store') as StoragePort;
const data = async (e: Env) => (await e.repo.exportBackup()).data;

/** État de départ : démo + pièce jointe ; puis restauration de la fixture V1 avec mise en mémoire (comme Settings). */
async function restoredWithUndo(make: () => Env) {
  const e = make();
  await e.repo.replaceWithSnapshot(generateDemoData(e.repo.userId, '2026-10-15', 'Avant'));
  const tx = (await e.repo.snapshot())!.transactions.find((t) => t.type === 'expense')!;
  await e.repo.addAttachment(tx.id, new File([Uint8Array.from({ length: 900 }, (_, i) => i % 251)], 'avant.pdf', { type: 'application/pdf' }));
  const before = await data(e);
  const plan = await planRestore(e.repo, JSON.parse(V1));
  expect(plan.safety.undoable).toBe(true);
  await e.repo.restoreBackup(plan.prepared.file);
  const slot: UndoSlot = { safetyJson: plan.safety.json, safetyName: 'nexora-securite-test.json', restoredFingerprint: fingerprintData(await e.repo.exportBackup()), restoredAt: new Date().toISOString() };
  undoStore.set(slot);
  return { e, before, slot };
}

afterEach(() => {
  undoStore.clear();
  vi.restoreAllMocks();
});

for (const make of [local, cloud]) {
  describe(`annulation immédiate — ${make().kind}`, () => {
    it('retour exact à l’état précédent (toutes tables, pièces jointes comprises), emplacement libéré', async () => {
      const { e, before, slot } = await restoredWithUndo(make);
      expect((await data(e)).transactions).toHaveLength(270); // fixture V1 restaurée
      expect(await changedSinceRestore(e.repo, slot)).toBe(false);
      const r = await undoRestore(e.repo);
      expect(r.verified).toBe(true);
      expect(await data(e)).toEqual(before);
      expect(undoStore.get()).toBeNull();
      expect(r.transactions.length).toBe((before.transactions as unknown[]).length);
    });

    it('modification faite depuis la restauration : détectée, puis perdue si l’utilisateur confirme', async () => {
      const { e, before, slot } = await restoredWithUndo(make);
      const s = (await e.repo.snapshot())!;
      await e.repo.updateAccount(s.accounts[0].id, { name: 'Renommé après restauration' });
      expect(await changedSinceRestore(e.repo, slot)).toBe(true);
      await undoRestore(e.repo);
      expect(await data(e)).toEqual(before);
    });

    it('quota de stockage dépassé pendant l’annulation : données restaurées intactes, emplacement conservé, nouvel essai réussi', async () => {
      const { e, before, slot } = await restoredWithUndo(make);
      const restored = await data(e);
      const port = store(e.repo).tables.transactions as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const spy = vi.spyOn(port, 'bulkPut').mockRejectedValueOnce(new DOMException('Quota dépassé (simulé)', 'QuotaExceededError'));
      await expect(undoRestore(e.repo)).rejects.toMatchObject({ name: 'QuotaExceededError' });
      spy.mockRestore();
      expect(await data(e)).toEqual(restored);
      expect(undoStore.get()).toBe(slot);
      if (e.transport) expect(e.transport.commits.length).toBeGreaterThan(0);
      await undoRestore(e.repo);
      expect(await data(e)).toEqual(before);
    });

    it('panne sur chaque table pendant l’annulation : jamais d’état partiel', async () => {
      const { e, before } = await restoredWithUndo(make);
      const restored = await data(e);
      for (const t of ['settings', 'accounts', 'categories', 'transactions', 'occurrences', 'attachments'] as const) {
        const port = store(e.repo).tables[t] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        const spy = vi.spyOn(port, 'bulkPut').mockRejectedValueOnce(new Error('panne'));
        await expect(undoRestore(e.repo), t).rejects.toThrow('panne');
        spy.mockRestore();
        expect(await data(e), t).toEqual(restored);
      }
      await undoRestore(e.repo);
      expect(await data(e)).toEqual(before);
    });
  });
}

describe('annulation immédiate — disponibilité et emplacement', () => {
  it('état actuel incohérent (relation bloquante) : restauration possible, annulation immédiate indisponible', async () => {
    const e = local();
    await e.repo.replaceWithSnapshot(generateDemoData(e.repo.userId, '2026-10-15'));
    const t = (await e.repo.snapshot())!.transactions[0];
    await e.db.transactions.put({ ...t, accountId: 'compte-disparu' }); // incohérence écrite hors application
    const plan = await planRestore(e.repo, JSON.parse(V1));
    expect(plan.safety.undoable).toBe(false);
    expect(plan.safety.json).toContain('compte-disparu'); // le fichier de sécurité reste complet
  });

  it('empreinte : stable pour un même contenu, différente après modification, indépendante de la date d’export', async () => {
    const e = local();
    await e.repo.replaceWithSnapshot(generateDemoData(e.repo.userId, '2026-10-15'));
    const a = await e.repo.exportBackup();
    const b = await e.repo.exportBackup();
    expect(fingerprintData(a)).toBe(fingerprintData(b));
    await e.repo.saveRate('USD', 'MAD', 9.9, '2026-10-01');
    expect(fingerprintData(await e.repo.exportBackup())).not.toBe(fingerprintData(a));
  });

  it('emplacement unique observable ; undoRestore sans emplacement → erreur sans écriture', async () => {
    const calls: number[] = [];
    const off = undoStore.subscribe(() => calls.push(1));
    undoStore.set({ safetyJson: '{}', safetyName: 'x', restoredFingerprint: '', restoredAt: '' });
    undoStore.clear();
    undoStore.clear(); // sans effet
    off();
    expect(calls).toHaveLength(2);
    const e = local();
    const spy = vi.spyOn(e.repo, 'restoreBackup');
    await expect(undoRestore(e.repo, null as never)).rejects.toThrow('no-undo-slot');
    expect(spy).not.toHaveBeenCalled();
  });
});
