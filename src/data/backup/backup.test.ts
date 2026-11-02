/**
 * Sauvegarde / restauration v2 — non-régression.
 *
 * Exécutés sur LocalRepository (fake-indexeddb, base isolée par test) et sur
 * CloudRepository (cache isolé + serveur simulé MemoryTransport). Données 100 % fictives
 * (jeu de démonstration généré + pièces jointes synthétiques).
 *
 * Pour chaque refus, l'état complet (export de toutes les tables, pièces jointes
 * comprises) et, en cloud, le nombre de lots envoyés au serveur sont comparés avant /
 * après : un fichier refusé ne provoque aucune écriture.
 */
import { describe, expect, it, vi } from 'vitest';
import { NexoraDB } from '../db';
import { LocalRepository } from '../repository';
import { CloudRepository } from '../cloud/CloudRepository';
import { CloudCacheDB } from '../cloud/CloudCacheDB';
import { cloudCacheName } from '../cloud/CloudStorage';
import { MemoryTransport } from '../cloud/MemoryTransport';
import type { NexoraRepository } from '../contracts';
import type { StoragePort } from '../storage';
import type { TableName } from '../tables';
import { USER_TABLES } from '../tables';
import { generateDemoData } from '../demo';
import { accountBalance, buildContext, summarizePeriod, totalBalance } from '@/domain/calc/ledger';
import { monthPeriod } from '@/domain/dates';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  BackupValidationError,
  RestoreVerificationError,
  migrateBackup,
  planRestore,
  prepareBackup,
  validateBackup,
  type BackupFile,
  type BackupIssue,
} from './index';
import { base64ToBytes, bytesToBase64 } from './attachments';

const TODAY = '2026-10-15';
let seq = 0;

type Env = { kind: 'local' | 'cloud'; repo: NexoraRepository; transport?: MemoryTransport };

function makeLocal(): Env {
  const userId = `bk-local-${++seq}`;
  return { kind: 'local', repo: new LocalRepository(new NexoraDB(`backup-test-${userId}`), userId) };
}
function makeCloud(): Env {
  const userId = `bk-cloud-${++seq}`;
  const transport = new MemoryTransport();
  return { kind: 'cloud', repo: new CloudRepository(userId, { transport, cache: new CloudCacheDB(cloudCacheName(userId), { userId }) }), transport };
}

const J = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const store = (repo: NexoraRepository) => Reflect.get(repo, 'store') as StoragePort;
const bytes = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256);

/** Jeu fictif riche : démo (5 comptes, ~240 opérations, transferts, dettes, objectifs, actifs) + 2 pièces jointes. */
async function seed(env: Env) {
  const { repo } = env;
  await repo.replaceWithSnapshot(generateDemoData(repo.userId, TODAY, 'Test'));
  const s = (await repo.snapshot())!;
  const expenses = s.transactions.filter((t) => t.type === 'expense');
  await repo.addAttachment(expenses[0].id, new File([bytes(1500)], 'recu.pdf', { type: 'application/pdf' }));
  await repo.addAttachment(expenses[1].id, new File([bytes(64, 3)], 'ticket.png', { type: 'image/png' }));
  return (await repo.snapshot())!;
}

/** État observable complet (toutes les tables, contenu des pièces jointes) + lots envoyés au serveur. */
async function state(env: Env) {
  const backup = await env.repo.exportBackup();
  return { data: backup.data, commits: env.transport?.commits.length ?? 0 };
}

async function expectRejected(env: Env, file: unknown, code: BackupIssue['code'], match: Partial<BackupIssue> = {}) {
  const before = await state(env);
  const err = await env.repo.restoreBackup(file).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BackupValidationError);
  const issues = (err as BackupValidationError).issues.filter((i) => i.severity === 'error');
  expect(issues.some((i) => i.code === code && Object.entries(match).every(([k, v]) => i[k as keyof BackupIssue] === v)), JSON.stringify(issues.slice(0, 5))).toBe(true);
  expect(await state(env)).toEqual(before);
  return issues;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lignes JSON librement altérées par les tests
type Row = Record<string, any>;
type TestFile = Omit<BackupFile, 'data'> & { data: Record<string, Row[]> };

/** Fichier v2 valide de l'environnement (aller-retour JSON, comme un fichier téléchargé). */
async function validFile(env: Env): Promise<TestFile> {
  return J(await env.repo.exportBackup()) as never;
}

for (const make of [makeLocal, makeCloud]) {
  const kind = make().kind;
  describe(`sauvegarde / restauration v2 — ${kind}`, () => {
    // 1, 2, 19, 20 -------------------------------------------------------------------------
    it('1-2 export puis restauration complète dans un espace vierge : données, soldes et KPI identiques', async () => {
      const src = make();
      const before = await seed(src);
      const file = await validFile(src);
      expect(file.formatVersion).toBe(BACKUP_FORMAT_VERSION);
      expect(Object.keys(file.data).sort()).toEqual([...BACKUP_TABLES].sort());
      expect(before.accounts.length).toBeGreaterThanOrEqual(3);
      expect(before.transactions.length).toBeGreaterThan(100);

      const dst = make();
      await dst.repo.restoreBackup(file);
      const after = (await dst.repo.snapshot())!;
      const strip = <T extends { userId?: string }>(rows: T[]) => rows.map(({ userId: _u, ...r }) => r);
      for (const t of USER_TABLES.filter((x) => x !== 'settings' && x !== 'importBatches')) {
        expect(strip(after[t as keyof typeof after] as never[]), t).toEqual(strip(before[t as keyof typeof before] as never[]));
      }
      const { id: _a, userId: _b, ...settingsA } = after.settings;
      const { id: _c, userId: _d, ...settingsB } = before.settings;
      expect(settingsA).toEqual(settingsB);
      // KPI et soldes recalculés à partir des données restaurées.
      const ca = buildContext(after);
      const cb = buildContext(before);
      const p = monthPeriod(TODAY.slice(0, 7));
      expect(summarizePeriod(ca, after.transactions, p)).toEqual(summarizePeriod(cb, before.transactions, p));
      expect(totalBalance(ca, after.accounts, after.transactions, TODAY)).toEqual(totalBalance(cb, before.accounts, before.transactions, TODAY));
      for (const a of after.accounts) expect(accountBalance(a, after.transactions)).toBe(accountBalance(before.accounts.find((x) => x.id === a.id)!, before.transactions));
      // Fichier ré-exporté identique (hors date d'export et utilisateur).
      const again = await validFile(dst);
      const noUser = (d: Record<string, Row[]>) => Object.fromEntries(Object.entries(d).map(([t, rows]) => [t, rows.map(({ userId: _u, ...r }) => (t === 'settings' ? { ...r, id: '' } : r))]));
      expect(noUser(again.data)).toEqual(noUser(file.data));
    });

    it('20 pièces jointes : exportées en base64 et restaurées à l’identique (contenu, type, taille)', async () => {
      const src = make();
      const before = await seed(src);
      const file = await validFile(src);
      expect(file.data.attachments).toHaveLength(2);
      const dst = make();
      await dst.repo.restoreBackup(file);
      for (const t of before.transactions.filter((x) => x.attachmentId)) {
        const a = (await dst.repo.getAttachment(t.attachmentId!))!;
        const original = (await src.repo.getAttachment(t.attachmentId!))!;
        expect(a.name).toBe(original.name);
        expect(a.mimeType).toBe(original.mimeType);
        expect(a.size).toBe(original.size);
        expect(new Uint8Array(await a.blob.arrayBuffer())).toEqual(new Uint8Array(await original.blob.arrayBuffer()));
      }
    });

    it('20 pièce jointe : contenu base64 corrompu ou taille incohérente → refus', async () => {
      const env = make();
      await seed(env);
      const f1 = await validFile(env);
      f1.data.attachments[0].data = '%%%pas du base64%%%';
      await expectRejected(env, f1, 'badField', { table: 'attachments', field: 'data' });
      const f2 = await validFile(env);
      f2.data.attachments[0].size = (f2.data.attachments[0].size as number) + 1;
      await expectRejected(env, f2, 'badField', { table: 'attachments', field: 'data' });
      const f3 = await validFile(env);
      f3.data.attachments[0].size = 6 * 1024 * 1024;
      await expectRejected(env, f3, 'badField', { table: 'attachments', field: 'size' });
    });

    it('20 pièce jointe sans contenu (data: null) : avertissement, copie locale conservée', async () => {
      const env = make();
      const s = await seed(env);
      const file = await validFile(env);
      const id = file.data.attachments[0].id as string;
      const size = file.data.attachments[0].size;
      file.data.attachments[0].data = null;
      const prepared = prepareBackup(file);
      expect(prepared.warnings.some((w) => w.code === 'attachmentMissing' && w.id === id)).toBe(true);
      await env.repo.restoreBackup(file);
      expect((await env.repo.getAttachment(id))?.size).toBe(size);
      expect((await env.repo.snapshot())!.transactions.filter((t) => t.attachmentId)).toHaveLength(s.transactions.filter((t) => t.attachmentId).length);
    });

    // 3 à 11 : fichiers refusés AVANT toute écriture ----------------------------------------
    it('3 fichier incomplet (paramètres seuls) → refus, aucune écriture', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      await expectRejected(env, { app: 'nexora', formatVersion: 2, schemaVersion: 1, exportedAt: f.exportedAt, data: { settings: f.data.settings } }, 'missingTable', { table: 'transactions' });
      await expectRejected(env, { app: 'nexora', formatVersion: 2, schemaVersion: 1, exportedAt: f.exportedAt }, 'badData');
      await expectRejected(env, { app: 'autre', data: {} }, 'notNexora');
      await expectRejected(env, null, 'notNexora');
      await expectRejected(env, [], 'notNexora');
    });

    it('4 table absente → refus (jamais remplacée par [])', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      delete (f.data as Record<string, unknown>).accounts;
      await expectRejected(env, f, 'missingTable', { table: 'accounts' });
    });

    it('5 table mal nommée → refus (table inconnue + table absente)', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      (f.data as Record<string, unknown>).Transactions = f.data.transactions;
      delete (f.data as Record<string, unknown>).transactions;
      const issues = await expectRejected(env, f, 'unknownTable', { table: 'Transactions' });
      expect(issues.some((i) => i.code === 'missingTable' && i.table === 'transactions')).toBe(true);
    });

    it('6 table du mauvais type → refus', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      (f.data as Record<string, unknown>).budgets = { length: 1 };
      await expectRejected(env, f, 'notArray', { table: 'budgets' });
      const g = await validFile(env);
      (g.data.goals as unknown[])[0] = 'pas un objet';
      await expectRejected(env, g, 'badRow', { table: 'goals', row: 1 });
    });

    it('7 identifiant manquant → refus', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      delete f.data.transactions[5].id;
      await expectRejected(env, f, 'missingId', { table: 'transactions', row: 6 });
      const g = await validFile(env);
      g.data.accounts[0].id = '  ';
      await expectRejected(env, g, 'missingId', { table: 'accounts', row: 1 });
    });

    it('8 identifiants dupliqués → refus', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      f.data.categories.push({ ...f.data.categories[0] });
      await expectRejected(env, f, 'duplicateId', { table: 'categories', id: f.data.categories[0].id as string });
      const g = await validFile(env);
      g.data.settings.push({ ...g.data.settings[0] });
      await expectRejected(env, g, 'settingsCount');
    });

    it('9 montant invalide → refus', async () => {
      const env = make();
      await seed(env);
      for (const bad of ['12,50', 12.5, Number.NaN, null, 2 ** 60]) {
        const f = await validFile(env);
        f.data.transactions[0].amount = bad;
        await expectRejected(env, f, 'badField', { table: 'transactions', field: 'amount', row: 1 });
      }
      const g = await validFile(env);
      g.data.rates[0].rate = 0;
      await expectRejected(env, g, 'badField', { table: 'rates', field: 'rate' });
    });

    it('10 date invalide → refus', async () => {
      const env = make();
      await seed(env);
      for (const bad of ['hier', '2026-02-30', '15/10/2026', 20261015]) {
        const f = await validFile(env);
        f.data.transactions[1].date = bad;
        await expectRejected(env, f, 'badField', { table: 'transactions', field: 'date', row: 2 });
      }
      const g = await validFile(env);
      g.data.budgets[0].month = '2026-13';
      await expectRejected(env, g, 'badField', { table: 'budgets', field: 'month' });
    });

    it('11 relation orpheline bloquante → refus (transaction, contribution, paiement, valorisation, échéance, budget, catégorie)', async () => {
      const env = make();
      await seed(env);
      const cases: [string, (f: Awaited<ReturnType<typeof validFile>>) => void, string][] = [
        ['transactions', (f) => (f.data.transactions[0].accountId = 'compte-inexistant'), 'accountId'],
        ['transactions', (f) => (f.data.transactions[0].categoryId = 'cat-inexistante'), 'categoryId'],
        ['goalContributions', (f) => (f.data.goals = []), 'goalId'],
        ['debtPayments', (f) => (f.data.debts = f.data.debts.filter((d) => d.id !== f.data.debtPayments[0].debtId)), 'debtId'],
        ['valuations', (f) => (f.data.assets = []), 'assetId'],
        ['occurrences', (f) => (f.data.recurringRules = []), 'ruleId'],
        ['budgets', (f) => (f.data.budgets.find((b) => b.categoryId)!.categoryId = 'cat-inexistante'), 'categoryId'],
        ['categories', (f) => (f.data.categories.find((c) => c.parentId)!.parentId = 'parent-inexistant'), 'parentId'],
      ];
      for (const [table, mutate, field] of cases) {
        const f = await validFile(env);
        mutate(f);
        await expectRejected(env, f, 'orphan', { table, field });
      }
    });

    it('11 transfert incomplet (une seule jambe) → refus', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      const leg = f.data.transactions.find((t) => t.type === 'transfer')!;
      f.data.transactions = f.data.transactions.filter((t) => t.id !== leg.id);
      await expectRejected(env, f, 'transferPair', { id: leg.transferId as string });
    });

    it('11 lien historique orphelin (règle → compte supprimé) : avertissement, donnée restaurée telle quelle', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      f.data.recurringRules[0].accountId = 'compte-supprime';
      const prepared = prepareBackup(f);
      expect(prepared.warnings).toEqual([expect.objectContaining({ severity: 'warning', code: 'orphan', table: 'recurringRules', field: 'accountId', ref: 'compte-supprime' })]);
      await env.repo.restoreBackup(f);
      const rule = (await env.repo.snapshot())!.recurringRules.find((r) => r.id === f.data.recurringRules[0].id)!;
      expect(rule.accountId).toBe('compte-supprime'); // jamais réécrit ni remplacé
    });

    // 12, 13 : paramètres -------------------------------------------------------------------
    it('12 paramètres sans locale : complétés par défaut (tracé), restauration utilisable', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      f.data.settings[0].language = 'en';
      delete f.data.settings[0].locale;
      const prepared = prepareBackup(f);
      expect(prepared.report.filledSettings).toEqual(['locale']);
      await env.repo.restoreBackup(f);
      const s = (await env.repo.snapshot())!.settings;
      expect(s.locale).toBe('en-US');
      expect(s.language).toBe('en');
    });

    it('12 paramètre présent mais invalide (locale vide, langue inconnue, devise) → refus (jamais corrigé en silence)', async () => {
      const env = make();
      await seed(env);
      for (const [field, value] of [['locale', ''], ['locale', 42], ['language', 'xx'], ['baseCurrency', 'dirham'], ['theme', 'blue']] as const) {
        const f = await validFile(env);
        f.data.settings[0][field] = value;
        await expectRejected(env, f, 'badField', { table: 'settings', field });
      }
    });

    it('13 paramètres sans onboarded : complétés (espace configuré), pas de retour à l’accueil', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      delete f.data.settings[0].onboarded;
      delete f.data.settings[0].budgetAlertThresholds;
      const prepared = prepareBackup(f);
      expect(prepared.report.filledSettings.sort()).toEqual(['budgetAlertThresholds', 'onboarded']);
      await env.repo.restoreBackup(f);
      const s = (await env.repo.snapshot())!.settings;
      expect(s.onboarded).toBe(true);
      expect(s.budgetAlertThresholds.length).toBeGreaterThan(0);
    });

    // 14, 15 : versions ---------------------------------------------------------------------
    it('14 sauvegarde v1 (ancien format, sans pièces jointes) : migrée, restaurée, pièces jointes locales conservées', async () => {
      const env = make();
      const s = await seed(env);
      const v2 = await validFile(env);
      const { attachments: _a, ...v1data } = v2.data;
      const v1 = { app: 'nexora', schemaVersion: 1, exportedAt: v2.exportedAt, data: v1data };
      const { file, report } = migrateBackup(v1);
      expect(report).toEqual({ fromVersion: 1, toVersion: 2, steps: [expect.stringContaining('v1→v2')], filledSettings: [] });
      expect(file.data.attachments).toEqual([]);
      expect(v1.data).not.toHaveProperty('attachments'); // entrée non modifiée
      await env.repo.restoreBackup(v1);
      const after = (await env.repo.snapshot())!;
      expect(after.transactions).toHaveLength(s.transactions.length);
      const withAtt = after.transactions.filter((t) => t.attachmentId);
      expect(withAtt).toHaveLength(2);
      for (const t of withAtt) expect(await env.repo.getAttachment(t.attachmentId!)).toBeDefined();
      // Dans un espace vierge : la référence est signalée (avertissement) et conservée.
      const dst = make();
      const warnings = prepareBackup(v1).warnings;
      expect(warnings.filter((w) => w.code === 'orphan' && w.field === 'attachmentId')).toHaveLength(2);
      await dst.repo.restoreBackup(v1);
      expect((await dst.repo.snapshot())!.transactions.filter((t) => t.attachmentId)).toHaveLength(2);
      // Fichier v1 contenant une table « attachments » : inconnue en v1 → refus.
      await expectRejected(env, { ...v1, data: { ...v1.data, attachments: [] } }, 'unknownTable', { table: 'attachments' });
    });

    it('15 version future ou invalide → refus', async () => {
      const env = make();
      await seed(env);
      const f = await validFile(env);
      await expectRejected(env, { ...f, formatVersion: 3 }, 'newer');
      await expectRejected(env, { ...f, schemaVersion: 2 }, 'newer');
      await expectRejected(env, { ...f, schemaVersion: '1' }, 'badVersion');
      await expectRejected(env, { ...f, formatVersion: 1.5 }, 'badVersion');
      const { schemaVersion: _s, ...noVersion } = f;
      await expectRejected(env, noVersion, 'badVersion');
    });

    // 16, 17 : échecs pendant l'application -------------------------------------------------
    it('16-17 panne pendant l’écriture → erreur, état précédent intégralement conservé', async () => {
      const env = make();
      await seed(env);
      const file = await validFile(env);
      file.data.transactions = file.data.transactions.slice(0, 10).filter((t) => t.type !== 'transfer');
      file.data.occurrences = file.data.occurrences.filter((o) => !o.transactionId);
      const before = await state(env);
      for (const table of ['settings', 'transactions', 'attachments', 'importBatches'] as TableName[]) {
        const port = store(env.repo).tables[table] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        const spy = vi.spyOn(port, 'bulkPut').mockImplementationOnce(() => Promise.reject(new Error('panne simulée')));
        // importBatches : table vide dans le fichier, bulkPut non appelé → la restauration aboutit.
        const result = await env.repo.restoreBackup(file).then(() => 'ok', (e: Error) => e.message);
        spy.mockRestore();
        if (table === 'importBatches') {
          expect(result).toBe('ok');
          break;
        }
        expect(result, table).toBe('panne simulée');
        expect(await state(env), table).toEqual(before);
      }
    });

    it('17 contrôle après écriture : un écart de volume annule toute la transaction', async () => {
      const env = make();
      await seed(env);
      const file = await validFile(env);
      const before = await state(env);
      const port = store(env.repo).tables.budgets as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      // Écriture « silencieusement partielle » : une ligne perdue sans erreur.
      const original = port.bulkPut.bind(port);
      const spy = vi.spyOn(port, 'bulkPut').mockImplementationOnce((rows: unknown) => original((rows as unknown[]).slice(1)));
      const err = await env.repo.restoreBackup(file).catch((e: unknown) => e);
      spy.mockRestore();
      expect(err).toBeInstanceOf(RestoreVerificationError);
      expect(err).toMatchObject({ table: 'budgets', expected: file.data.budgets.length, actual: file.data.budgets.length - 1 });
      expect(await state(env)).toEqual(before);
    });

    // Phase B : sauvegarde de sécurité et aperçu --------------------------------------------
    it('B planRestore : aucune écriture, aperçu des volumes, sauvegarde de sécurité vérifiée et restaurable', async () => {
      const env = make();
      const original = await seed(env);
      const other = make();
      await other.repo.replaceWithSnapshot(generateDemoData(other.repo.userId, '2026-05-01', 'Autre'));
      const incoming = await validFile(other);
      const before = await state(env);
      const plan = await planRestore(env.repo, incoming);
      expect(await state(env)).toEqual(before);
      const row = (t: string) => plan.diff.find((d) => d.table === t)!;
      expect(row('transactions')).toEqual({ table: 'transactions', current: original.transactions.length, incoming: incoming.data.transactions.length });
      expect(row('attachments')).toEqual({ table: 'attachments', current: 2, incoming: 0 });
      // Application, puis retour à l'état antérieur grâce à la sauvegarde de sécurité.
      await env.repo.restoreBackup(plan.prepared.file);
      expect((await env.repo.snapshot())!.transactions).toHaveLength(incoming.data.transactions.length);
      await env.repo.restoreBackup(JSON.parse(plan.safety.json));
      expect((await state(env)).data).toEqual({ ...before.data });
    });

    it('B planRestore : fichier invalide → refus avant même la sauvegarde de sécurité', async () => {
      const env = make();
      await seed(env);
      const spy = vi.spyOn(env.repo, 'exportBackup');
      await expect(planRestore(env.repo, { app: 'nexora', schemaVersion: 1, data: { settings: [{}] } })).rejects.toBeInstanceOf(BackupValidationError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('jeu de démonstration et réinitialisation passent la validation stricte', async () => {
      const env = make();
      await env.repo.replaceWithSnapshot(generateDemoData(env.repo.userId, TODAY));
      expect(validateBackup(await validFile(env))).toEqual([]);
      await env.repo.resetToEmpty();
      expect(validateBackup(await validFile(env))).toEqual([]);
    });
  });
}

describe('codec base64 des pièces jointes', () => {
  it('aller-retour exact, y compris tailles non multiples de 3 et fichiers > 32 Ko', () => {
    for (const n of [0, 1, 2, 3, 100, 70_000]) expect(base64ToBytes(bytesToBase64(bytes(n)))).toEqual(bytes(n));
  });
});
