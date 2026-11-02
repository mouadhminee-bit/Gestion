/**
 * Non-régression : sauvegarde V1 historique du 31/10/2026 (données 100 % FICTIVES).
 *
 * La fixture `__fixtures__/backup-v1-2026-10-31.json` a été produite par le code EXACT du
 * 31/10/2026 (commit 341f3da ; code de données identique de 27defa5 à 341f3da) via
 * `scripts/fixtures/backup-v1-2026-10-31/generate.sh`. Aucune donnée personnelle, aucun
 * fichier réel. Son empreinte est vérifiée : toute modification doit être volontaire
 * (régénération + mise à jour de l'empreinte).
 *
 * Exécutés sur LocalRepository et CloudRepository (serveur simulé).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NexoraDB } from '../db';
import { LocalRepository } from '../repository';
import { CloudRepository } from '../cloud/CloudRepository';
import { CloudCacheDB } from '../cloud/CloudCacheDB';
import { cloudCacheName } from '../cloud/CloudStorage';
import { MemoryTransport } from '../cloud/MemoryTransport';
import type { NexoraRepository } from '../contracts';
import { USER_TABLES } from '../tables';
import { migrateBackup, prepareBackup, validateBackup } from './index';
import { buildContext, summarizePeriod, totalBalance } from '@/domain/calc/ledger';
import { monthPeriod } from '@/domain/dates';
import type { Attachment, DataSnapshot } from '@/domain/types';

const path = (f: string) => fileURLToPath(new URL(`./__fixtures__/${f}`, import.meta.url));
const RAW = readFileSync(path('backup-v1-2026-10-31.json'), 'utf8');
const RAW_ATT = readFileSync(path('backup-v1-2026-10-31.local-attachments.json'), 'utf8');
const FIXTURE_SHA256 = '7f2939a38bd5e664928f2a894280cc1d1562eda949292bf66aba57c1f3522512';
const ATT_SHA256 = '03f6c62aa2734b4f988127355a6113aa9cb800f7f3f124f98aede692d46729fa';

type Row = Record<string, unknown>;
const v1 = () => JSON.parse(RAW) as { app: string; schemaVersion: number; exportedAt: string; data: Record<string, Row[]> };
const LOCAL_ATT = (JSON.parse(RAW_ATT) as (Omit<Attachment, 'blob'> & { bytes: number[] })[])[0];

let seq = 0;
type Env = { kind: 'local' | 'cloud'; repo: NexoraRepository; db: NexoraDB; transport?: MemoryTransport };
function local(): Env {
  const db = new NexoraDB(`hist-v1-${++seq}`);
  return { kind: 'local', repo: new LocalRepository(db, 'local-user'), db };
}
function cloud(): Env {
  const u = `hist-v1-cloud-${++seq}`;
  const transport = new MemoryTransport();
  const db = new CloudCacheDB(cloudCacheName(u), { userId: u });
  return { kind: 'cloud', repo: new CloudRepository(u, { transport, cache: db }), db, transport };
}

const strip = (rows: Row[], table: string) => rows.map(({ userId: _u, ...r }) => (table === 'settings' ? { ...r, id: '' } : r));
const byId = (rows: Row[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const putLocalAttachment = (e: Env) =>
  e.db.attachments.put({ ...LOCAL_ATT, userId: e.repo.userId, blob: new Blob([new Uint8Array(LOCAL_ATT.bytes)], { type: LOCAL_ATT.mimeType }) } as never);

describe('sauvegarde V1 historique (31/10/2026, fictive)', () => {
  it('fixture intacte (empreinte SHA-256) et fictive', () => {
    expect(createHash('sha256').update(RAW).digest('hex')).toBe(FIXTURE_SHA256);
    expect(createHash('sha256').update(RAW_ATT).digest('hex')).toBe(ATT_SHA256);
    expect(v1().data.settings[0].displayName).toBe('Utilisateur fictif');
  });

  it('format V1 exact : enveloppe sans formatVersion, 16 tables, aucune table attachments', () => {
    const f = v1();
    expect(Object.keys(f).sort()).toEqual(['app', 'data', 'exportedAt', 'schemaVersion']);
    expect(f.schemaVersion).toBe(1);
    expect(Object.keys(f.data).sort()).toEqual([...USER_TABLES].sort());
    const counts = Object.fromEntries(Object.entries(f.data).map(([k, v]) => [k, v.length]));
    expect(counts).toEqual({ settings: 1, accounts: 7, categories: 40, transactions: 270, budgets: 64, goals: 6, goalContributions: 6, recurringRules: 8, occurrences: 35, debts: 3, debtPayments: 17, assets: 3, valuations: 10, rates: 4, notificationStates: 2, importBatches: 1 });
  });

  it('migration V1 → V2 tracée, entrée non modifiée, aucun problème bloquant, avertissements attendus', () => {
    const f = v1();
    const { file, report } = migrateBackup(f);
    expect(report).toEqual({ fromVersion: 1, toVersion: 2, steps: ['v1→v2: attachments = [] (not exported by format v1)'], filledSettings: [] });
    expect(file.data.attachments).toEqual([]);
    expect(JSON.stringify(f)).toBe(JSON.stringify(v1()));
    const issues = validateBackup(file);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.map((i) => `${i.severity}:${i.code}:${i.table}.${i.field}`).sort()).toEqual([
      'warning:orphan:goals.linkedAccountId',
      'warning:orphan:recurringRules.accountId',
      'warning:orphan:transactions.attachmentId',
    ]);
  });

  it('cas historiques présents dans la fixture (garantit sa couverture)', () => {
    const d = v1().data;
    expect(d.occurrences.some((o) => o.closure === 'waived')).toBe(true);
    expect(d.occurrences.some((o) => o.status === 'skipped')).toBe(true);
    expect(d.occurrences.some((o) => o.status === 'paid' && !o.closure && o.transactionId)).toBe(true);
    expect(d.transactions.some((t) => t.type === 'transfer' && t.currency === 'EUR')).toBe(true);
    for (const type of ['refund', 'adjustment', 'debt', 'income', 'expense']) expect(d.transactions.some((t) => t.type === type), type).toBe(true);
    expect(d.transactions.some((t) => t.importBatchId && t.payee)).toBe(true);
    expect(d.transactions.some((t) => t.attachmentId)).toBe(true);
    expect(d.categories.some((c) => c.parentId)).toBe(true);
    expect(d.accounts.some((a) => a.archived)).toBe(true);
    expect(d.goalContributions.some((c) => (c.amount as number) < 0)).toBe(true);
    expect(d.debtPayments.some((p) => !p.accountId)).toBe(true);
  });

  it('paramètres d’un profil antérieur sans `language` : seul ce champ est complété', () => {
    const f = v1();
    const before = { ...f.data.settings[0] };
    delete f.data.settings[0].language;
    const r = prepareBackup(f);
    expect(r.report.filledSettings).toEqual(['language']);
    const { language: _a, ...after } = r.file.data.settings[0];
    const { language: _b, ...orig } = before;
    expect(after).toEqual(orig);
  });

  for (const make of [local, cloud]) {
    const kind = make().kind;
    describe(kind, () => {
      it('conservation intégrale : toutes les tables identiques champ par champ, KPI et soldes identiques', async () => {
        const e = make();
        await e.repo.restoreBackup(v1());
        const out = (await e.repo.exportBackup()).data as Record<string, Row[]>;
        const src = v1().data;
        for (const t of USER_TABLES) expect(byId(strip(out[t], t)), t).toEqual(byId(strip(src[t], t)));
        expect(out.attachments).toEqual([]);
        const s = (await e.repo.snapshot())!;
        const o = { ...src, settings: src.settings[0] } as unknown as DataSnapshot;
        for (const m of ['2026-07', '2026-08', '2026-09', '2026-10']) {
          expect(summarizePeriod(buildContext(s), s.transactions, monthPeriod(m)), m).toEqual(summarizePeriod(buildContext(o), o.transactions, monthPeriod(m)));
        }
        expect(totalBalance(buildContext(s), s.accounts, s.transactions, '2026-10-31')).toEqual(totalBalance(buildContext(o), o.accounts, o.transactions, '2026-10-31'));
      });

      it('pièce jointe existante dans la base (non exportée en V1) : fichier et attachmentId conservés', async () => {
        const e = make();
        await e.repo.restoreBackup(v1());
        await putLocalAttachment(e);
        await e.repo.restoreBackup(v1());
        const tx = (await e.repo.snapshot())!.transactions.find((t) => t.attachmentId)!;
        expect(tx.attachmentId).toBe(LOCAL_ATT.id);
        const a = (await e.repo.getAttachment(LOCAL_ATT.id))!;
        expect(Array.from(new Uint8Array(await a.blob.arrayBuffer()))).toEqual(LOCAL_ATT.bytes);
        const v2 = (await e.repo.exportBackup()).data.attachments as { id: string }[];
        expect(v2.map((x) => x.id)).toEqual([LOCAL_ATT.id]);
      });

      it('espace vierge : attachmentId conservé tel quel (avertissement), rien d’inventé', async () => {
        const e = make();
        await e.repo.restoreBackup(v1());
        expect((await e.repo.snapshot())!.transactions.find((t) => t.attachmentId)!.attachmentId).toBe(LOCAL_ATT.id);
        expect(await e.repo.getAttachment(LOCAL_ATT.id)).toBeUndefined();
      });
    });
  }

  it('Local et Cloud : même fichier → mêmes instantanés', async () => {
    const a = local();
    const b = cloud();
    await a.repo.restoreBackup(v1());
    await b.repo.restoreBackup(v1());
    const sa = (await a.repo.snapshot())! as unknown as Record<string, Row[]>;
    const sb = (await b.repo.snapshot())! as unknown as Record<string, Row[]>;
    for (const t of USER_TABLES.filter((x) => x !== 'settings' && x !== 'importBatches')) expect(strip(sb[t], t), t).toEqual(strip(sa[t], t));
  });
});
