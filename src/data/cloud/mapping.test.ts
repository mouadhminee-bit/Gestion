/**
 * Tests du mapping TypeScript ↔ PostgreSQL (Lot 4, étape 4.2).
 *
 * Données fictives uniquement ; aucune base, aucun réseau. Le schéma de référence est lu
 * directement dans `supabase/migrations/` (et non dans la documentation).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLOUD_TABLES,
  EXCLUDED_TABLES,
  MAPPING,
  MappingError,
  SERVER_METADATA_COLUMNS,
  assertCloudTable,
  assertKnownFields,
  deserializeRow,
  fromSqlKey,
  occurrenceKey,
  parseOccurrenceKey,
  serializeRow,
  sqlColumnsOf,
  sqlTableOf,
  tableOfSql,
  toCloudRow,
  toSqlKey,
  type CloudTableName,
  type ColumnSpec,
  type FieldSpec,
  type MappingErrorCode,
  type SqlRow,
} from './mapping';
import { ALL_TABLES, PRIMARY_KEYS, type TableRows } from '../tables';
import { generateDemoData } from '../demo';
import { occurrenceId } from '@/domain/calc/recurring';
import { MAX_AMOUNT } from '@/domain/validation';

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

const U = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const TS = '2026-10-31T12:34:56.789Z';

/** Représentation PostgREST d'un horodatage client : `+00:00`, fraction omise si nulle. */
function pgTimestamp(iso: string): string {
  return iso.replace(/\.000Z$/, '+00:00').replace(/Z$/, '+00:00');
}

const META = { version: 1, sync_txid: '734', server_updated_at: '2026-11-01T10:00:00.123456+00:00', deleted_at: null };

/**
 * Ligne telle que le serveur la renverrait après écriture : colonnes écrites, colonnes
 * fixées par le serveur (`profiles.created_at`), métadonnées, horodatages au format
 * PostgREST, et passage par JSON (comme sur le réseau).
 */
function asServerRow(table: CloudTableName, row: unknown, serverOwned: Record<string, unknown> = {}): Record<string, unknown> {
  const { values } = serializeRow(table, row);
  const out: Record<string, unknown> = { ...values, ...serverOwned, ...META };
  for (const [, f] of Object.entries(MAPPING[table].fields as Record<string, { kind: string }>)) {
    const c = f as ColumnSpec;
    if (c.kind === 'column' && c.type === 'timestamptz' && typeof out[c.column] === 'string') out[c.column] = pgTimestamp(out[c.column] as string);
  }
  return JSON.parse(JSON.stringify(out));
}

/**
 * Forme attendue après aller-retour — exceptions documentées (`docs/LOT4_PLAN.md` § 5.4) :
 * champs locaux retirés ; clés de valeur `undefined` absentes ; champ facultatif `null`
 * → absent ; champ `T | null` absent → `null` ; horodatages en forme canonique `Z`.
 */
function expected(table: CloudTableName, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const cloud = toCloudRow(table, row as never) as Record<string, unknown>;
  for (const [field, f] of Object.entries(MAPPING[table].fields as Record<string, FieldSpec>)) {
    if (f.kind === 'local') continue;
    const v = cloud[field];
    if (f.kind === 'derived') {
      out[field] = v;
      continue;
    }
    if (v === undefined || v === null) {
      if (f.presence === 'nullable' || f.presence === 'optionalNullable') out[field] = null;
      continue;
    }
    out[field] = f.type === 'timestamptz' ? new Date(v as string).toISOString() : v;
  }
  return out;
}

function roundTrip<N extends CloudTableName>(table: N, row: unknown, serverOwned?: Record<string, unknown>) {
  return deserializeRow(table, asServerRow(table, row, serverOwned));
}

function expectMappingError(fn: () => unknown, code: MappingErrorCode, field?: string) {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'MappingError attendue').toBeInstanceOf(MappingError);
  expect((err as MappingError).code).toBe(code);
  if (field !== undefined) expect((err as MappingError).field).toBe(field);
}

// ---------------------------------------------------------------------------
// Lignes complètes (tous les champs facultatifs renseignés), une par table
// ---------------------------------------------------------------------------

const ent = () => ({ id: uuid(), userId: U, createdAt: TS, updatedAt: '2026-11-01T08:00:00.001Z' });

function fullRows(): { [N in CloudTableName]: TableRows[N] } {
  return {
    users: { id: U, displayName: 'Sara', email: 'sara@example.test', createdAt: TS },
    settings: {
      id: U, userId: U, displayName: 'Sara', baseCurrency: 'MAD', language: 'fr', locale: 'fr-MA', timeZone: 'Africa/Casablanca',
      dateFormat: 'DD/MM/YYYY', weekStartsOn: 1, theme: 'dark', currencyDisplay: 'symbol', privacyMode: false,
      budgetAlertThresholds: [50, 75, 90, 100], notifyBudgets: true, notifyBills: false, notifyDebts: true,
      billReminderDays: 3, onboarded: true, demoMode: false, updatedAt: TS,
    },
    accounts: { ...ent(), name: 'Banque', type: 'bank', currency: 'MAD', initialBalance: -123456789, initialBalanceDate: '2026-01-01', archived: false, includeInTotal: true, color: '#123456', description: 'Compte courant', order: 3 },
    categories: { ...ent(), name: 'Courses', kind: 'expense', nature: 'variable', parentId: uuid(), icon: 'cart', color: '#fff', archived: false, order: 0, key: 'food' },
    transactions: {
      ...ent(), type: 'debt', direction: 'out', amount: MAX_AMOUNT, currency: 'EUR', label: 'Échéance « prêt » – 🏠', date: '2026-02-28',
      categoryId: uuid(), subcategoryId: uuid(), accountId: uuid(), paymentMethod: 'transfer', payee: "L'agence", notes: 'ligne 1\nligne 2',
      tags: ['a', 'b c', ''], attachmentId: uuid(), status: 'pending', transferId: uuid(), counterpartAccountId: uuid(), refundOfId: uuid(),
      debtId: uuid(), debtPaymentId: uuid(), interestAmount: 1234, recurringRuleId: uuid(), recurringDueDate: '2026-02-28', importBatchId: uuid(),
    },
    attachments: { id: uuid(), userId: U, name: 'facture.pdf', mimeType: 'application/pdf', size: 5242880, blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), createdAt: TS },
    importBatches: { id: uuid(), userId: U, fileName: 'releve.csv', createdAt: TS, rowCount: 10, importedCount: 8, skippedCount: 2, accountId: uuid() },
    budgets: { ...ent(), month: '2026-10', categoryId: uuid(), amount: 0, currency: 'MAD', alertThresholds: [80, 100.5] },
    goals: {
      ...ent(), name: 'Voyage', description: 'Été', targetAmount: 1, currency: 'MAD', savedAmount: 0, targetDate: '2027-07-01', priority: 'high',
      linkedAccountId: uuid(), trackLinkedAccount: true, monthlyContribution: 50000, status: 'active', icon: 'plane', color: '#0af',
    },
    goalContributions: { id: uuid(), userId: U, goalId: uuid(), date: '2026-10-01', amount: -2500, note: 'retrait', createdAt: TS },
    recurringRules: {
      ...ent(), kind: 'expense', label: 'Loyer', amount: 450000, currency: 'MAD', accountId: uuid(), categoryId: uuid(), subcategoryId: uuid(),
      payee: 'Propriétaire', frequency: 'custom', customInterval: 1.5, customUnit: 'month', startDate: '2026-01-31', endDate: '2027-01-31', active: true, notes: 'n',
    },
    occurrences: (() => {
      const ruleId = uuid();
      return { id: `${ruleId}:2026-03-31`, userId: U, ruleId, dueDate: '2026-03-31', status: 'paid' as const, transactionId: uuid(), closure: 'waived' as const, updatedAt: TS };
    })(),
    debts: {
      ...ent(), label: 'Prêt', type: 'loan', direction: 'payable', principal: 0, currency: 'MAD', startDate: '2026-01-01', dueDate: '2030-01-01',
      counterparty: 'Banque', interestRate: 3.95, installmentAmount: 120000, installmentFrequency: 'monthly', status: 'active', notes: 'taux fixe', originTransactionId: uuid(),
    },
    debtPayments: { id: uuid(), userId: U, debtId: uuid(), date: '2026-02-01', principal: 100000, interest: 3292, accountId: uuid(), transactionId: uuid(), note: 'n', createdAt: TS },
    assets: { ...ent(), name: 'Appartement', type: 'real_estate', currency: 'MAD', linkedAccountId: uuid(), archived: false, notes: 'n' },
    valuations: { id: uuid(), userId: U, assetId: uuid(), date: '2026-03-01', value: 9007199254740991, source: 'manual', note: 'expertise', createdAt: TS },
    rates: { id: uuid(), userId: U, base: 'EUR', quote: 'MAD', rate: 10.86, date: '2026-03-01', source: 'manual', createdAt: TS },
    notificationStates: { id: 'budget:cat:2026-10:90', userId: U, read: true, dismissed: false, updatedAt: TS },
  };
}

/** Variante minimale : champs facultatifs absents, champs `T | null` à `null`. */
function minimalRow(table: CloudTableName, full: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...full };
  for (const [field, f] of Object.entries(MAPPING[table].fields as Record<string, ColumnSpec | { kind: string }>)) {
    if (f.kind === 'local') delete out[field];
    if (f.kind !== 'column') continue;
    const c = f as ColumnSpec;
    if (c.presence === 'optional') delete out[field];
    if (c.presence === 'nullable' || c.presence === 'optionalNullable') out[field] = null;
  }
  return out;
}

// Les colonnes non écrites par le client : `profiles.created_at` (date d'inscription).
const serverOwned = (table: CloudTableName, row: Record<string, unknown>) => (table === 'users' ? { created_at: pgTimestamp(row.createdAt as string) } : {});

// ---------------------------------------------------------------------------
// Schéma lu dans les migrations
// ---------------------------------------------------------------------------

interface SchemaColumn {
  type: string;
  notNull: boolean;
}
interface SchemaTable {
  columns: Map<string, SchemaColumn>;
  primaryKey: string[];
}

function readSchema(): Map<string, SchemaTable> {
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  // Le parseur ne gère que `create table` : refuser toute autre forme d'évolution de colonnes.
  expect(sql).not.toMatch(/\b(add|drop|rename|alter)\s+column\b/i);
  const tables = new Map<string, SchemaTable>();
  for (const m of sql.matchAll(/create table public\.(\w+) \(\n([\s\S]*?)\n\);/g)) {
    const columns = new Map<string, SchemaColumn>();
    let primaryKey: string[] = [];
    for (const raw of m[2].split('\n')) {
      const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '');
      if (!line) continue;
      const pk = /^primary key \(([^)]+)\)/.exec(line);
      if (pk) {
        primaryKey = pk[1].split(',').map((s) => s.trim());
        continue;
      }
      if (/^(constraint|or |\(|\))/.test(line) || /^\s/.test(raw.replace(/^ {2}/, ''))) continue; // suites de contraintes multilignes
      const c = /^(\w+) (uuid|text\[\]|text|boolean|bigint|integer|smallint|double precision\[\]|double precision|date|char\(7\)|timestamptz|xid8)(?=\s|$)(.*)$/.exec(line);
      if (!c) throw new Error(`Ligne de schéma non reconnue (${m[1]}) : ${line}`);
      const rest = c[3];
      if (/\bprimary key\b/.test(rest)) primaryKey = [c[1]];
      columns.set(c[1], { type: c[2], notNull: /\bnot null\b|\bprimary key\b/.test(rest) });
    }
    tables.set(m[1], { columns, primaryKey });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// 1. Les 18 tables et leurs colonnes
// ---------------------------------------------------------------------------

describe('mapping : couverture du schéma (migrations) et des tables TypeScript', () => {
  const schema = readSchema();

  it('18 tables PostgreSQL ↔ 18 tables TypeScript ; meta seule exclue, avec justification', () => {
    expect(schema.size).toBe(18);
    expect(CLOUD_TABLES).toHaveLength(18);
    expect(new Set(CLOUD_TABLES.map((t) => MAPPING[t].sqlTable))).toEqual(new Set(schema.keys()));
    expect([...CLOUD_TABLES, ...Object.keys(EXCLUDED_TABLES)].sort()).toEqual([...ALL_TABLES].sort());
    expect(Object.keys(EXCLUDED_TABLES)).toEqual(['meta']);
  });

  for (const table of CLOUD_TABLES) {
    it(`${table} → ${MAPPING[table].sqlTable} : colonnes, types, nullabilité et clé primaire identiques au schéma`, () => {
      const t = schema.get(MAPPING[table].sqlTable)!;
      expect(t, 'table présente dans les migrations').toBeDefined();
      const mapped = Object.entries(MAPPING[table].fields as Record<string, ColumnSpec | { kind: string }>).filter(([, f]) => f.kind === 'column') as [string, ColumnSpec][];
      // Toutes les colonnes : métier (mapping) + métadonnées serveur, ni plus ni moins.
      expect(new Set([...mapped.map(([, c]) => c.column), ...SERVER_METADATA_COLUMNS])).toEqual(new Set(t.columns.keys()));
      expect(sqlColumnsOf(table)).toEqual(mapped.map(([, c]) => c.column));
      for (const [field, c] of mapped) {
        const s = t.columns.get(c.column)!;
        expect(s.type, `${field} → ${c.column}`).toBe(c.type);
        expect(s.notNull, `${field} → ${c.column} : NOT NULL ⇔ champ obligatoire`).toBe(c.presence === 'required');
      }
      // Métadonnées serveur : types attendus.
      expect(t.columns.get('version')).toEqual({ type: 'bigint', notNull: true });
      expect(t.columns.get('sync_txid')).toEqual({ type: 'xid8', notNull: true });
      expect(t.columns.get('server_updated_at')).toEqual({ type: 'timestamptz', notNull: true });
      expect(t.columns.get('deleted_at')).toEqual({ type: 'timestamptz', notNull: false });
      expect(MAPPING[table].sqlKey).toEqual(t.primaryKey);
    });
  }

  it('chaque champ TS est décrit (colonne, champ local ou champ dérivé) ; exceptions explicites', () => {
    const nonColumns = CLOUD_TABLES.flatMap((t) =>
      Object.entries(MAPPING[t].fields as Record<string, { kind: string }>)
        .filter(([, f]) => f.kind !== 'column')
        .map(([field, f]) => `${t}.${field}:${f.kind}`),
    );
    expect(nonColumns.sort()).toEqual(['attachments.blob:local', 'occurrences.id:derived', 'settings.id:derived', 'users.email:local']);
    // Le mapping suit les clés primaires IndexedDB.
    expect(PRIMARY_KEYS.occurrences).toBe('id');
    expect(PRIMARY_KEYS.notificationStates).toEqual(['userId', 'id']);
  });

  it('les noms de tables SQL sont résolus dans les deux sens ; table inconnue refusée', () => {
    for (const t of CLOUD_TABLES) expect(tableOfSql(sqlTableOf(t))).toBe(t);
    expectMappingError(() => tableOfSql('users'), 'unknown_table'); // `users` n'est pas une table SQL
    expectMappingError(() => tableOfSql('auth.users'), 'unknown_table');
  });
});

// ---------------------------------------------------------------------------
// 2–3. Aller-retour et valeurs nulles / facultatives
// ---------------------------------------------------------------------------

describe('mapping : aller-retour TS → PostgreSQL → TS', () => {
  const full = fullRows();
  for (const table of CLOUD_TABLES) {
    it(`${table} : ligne complète et ligne minimale, sans perte`, () => {
      for (const row of [full[table] as unknown as Record<string, unknown>, minimalRow(table, full[table] as unknown as Record<string, unknown>)]) {
        const { row: back, meta } = roundTrip(table, row, serverOwned(table, row));
        expect(back).toEqual(expected(table, row));
        expect(meta).toEqual({ version: 1, syncTxid: '734', serverUpdatedAt: META.server_updated_at, deletedAt: null });
        // Second passage : idempotent.
        expect(roundTrip(table, back, serverOwned(table, back)).row).toEqual(back);
      }
    });
  }

  it('la ligne écrite contient TOUTES les colonnes écrites (null pour un champ absent) : état final complet', () => {
    const full = fullRows();
    for (const table of CLOUD_TABLES) {
      const min = minimalRow(table, full[table] as unknown as Record<string, unknown>);
      const { values, key } = serializeRow(table, min);
      const writable = (Object.values(MAPPING[table].fields as Record<string, ColumnSpec | { kind: string }>).filter((f) => f.kind === 'column') as ColumnSpec[])
        .filter((c) => c.writable || MAPPING[table].sqlKey.includes(c.column))
        .map((c) => c.column);
      expect(Object.keys(values).sort()).toEqual(writable.sort());
      expect(Object.keys(key)).toEqual([...MAPPING[table].sqlKey]);
      for (const [field, f] of Object.entries(MAPPING[table].fields as Record<string, ColumnSpec | { kind: string }>)) {
        if (f.kind === 'column' && (f as ColumnSpec).presence !== 'required' && (f as ColumnSpec).writable) expect(values[(f as ColumnSpec).column], `${table}.${field}`).toBeNull();
      }
    }
  });

  it('valeurs nulles : null et undefined équivalents pour un champ non obligatoire ; refusés pour un champ obligatoire', () => {
    const tx = fullRows().transactions as unknown as Record<string, unknown>;
    // Facultatif (`notes?`) à null → NULL → absent à la lecture.
    const { row } = roundTrip('transactions', { ...tx, notes: null });
    expect(row).not.toHaveProperty('notes');
    // `categoryId: ID | null` absent → NULL → null.
    const { categoryId: _c, ...noCat } = tx;
    expect(roundTrip('transactions', noCat).row.categoryId).toBeNull();
    // `subcategoryId?: ID | null` (règle récurrente) absent → null à la lecture (exception documentée).
    const { subcategoryId: _s, ...rule } = fullRows().recurringRules as unknown as Record<string, unknown>;
    expect(roundTrip('recurringRules', rule).row.subcategoryId).toBeNull();
    // Obligatoire.
    expectMappingError(() => serializeRow('transactions', { ...tx, label: null }), 'missing_column', 'label');
    const { amount: _a, ...noAmount } = tx;
    expectMappingError(() => serializeRow('transactions', noAmount), 'missing_column', 'amount');
    // NULL dans une colonne obligatoire à la lecture.
    const sqlRow = asServerRow('transactions', tx);
    expectMappingError(() => deserializeRow('transactions', { ...sqlRow, amount: null }), 'invalid_value', 'amount');
  });

  it('tableaux : vides, valeurs spéciales du texte (unicode, guillemets, retours à la ligne)', () => {
    const tx = fullRows().transactions as unknown as Record<string, unknown>;
    for (const tags of [[], ['é', '"', "'", '\\', ',', '{}', 'NULL', '\n', '👍']]) expect(roundTrip('transactions', { ...tx, tags }).row.tags).toEqual(tags);
    const settings = fullRows().settings as unknown as Record<string, unknown>;
    expect(roundTrip('settings', { ...settings, budgetAlertThresholds: [] }).row.budgetAlertThresholds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Dates et horodatages
// ---------------------------------------------------------------------------

describe('mapping : dates et horodatages', () => {
  const rate = () => fullRows().rates as unknown as Record<string, unknown>;

  it('écriture : forme canonique UTC « Z » (millisecondes), même instant quel que soit le fuseau fourni', () => {
    const cases: [string, string][] = [
      ['2026-10-31T12:34:56.789Z', '2026-10-31T12:34:56.789Z'],
      ['2026-10-31T12:34:56.789+00:00', '2026-10-31T12:34:56.789Z'],
      ['2026-10-31T13:34:56.789+01:00', '2026-10-31T12:34:56.789Z'],
      ['2026-10-31T07:04:56.789-05:30', '2026-10-31T12:34:56.789Z'],
      ['2026-10-31T14:34:56.789+0200', '2026-10-31T12:34:56.789Z'],
      ['2026-10-31T14:34:56+02', '2026-10-31T12:34:56.000Z'],
      ['2026-10-31 12:34:56.789+00', '2026-10-31T12:34:56.789Z'],
      ['2026-10-31T12:34Z', '2026-10-31T12:34:00.000Z'],
      ['2026-10-31T12:34:56.789000Z', '2026-10-31T12:34:56.789Z'], // microsecondes nulles
      ['2026-10-31T12:34:56.7Z', '2026-10-31T12:34:56.700Z'],
      ['2026-10-31T23:30:00-01:00', '2026-11-01T00:30:00.000Z'], // changement de jour
      ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ];
    for (const [input, out] of cases) {
      const { values } = serializeRow('rates', { ...rate(), createdAt: input });
      expect(values.created_at, input).toBe(out);
      expect(new Date(values.created_at as string).getTime()).toBe(new Date(input.replace(' ', 'T').replace(/\+(\d{2})$/, '+$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime());
    }
  });

  it('lecture : « +00:00 » (PostgREST) et microsecondes nulles → forme du client', () => {
    const base = asServerRow('rates', rate());
    for (const pg of ['2026-10-31T12:34:56.789+00:00', '2026-10-31T12:34:56.789000+00:00', '2026-10-31 12:34:56.789+00', '2026-10-31T14:34:56.789+02:00']) {
      expect(deserializeRow('rates', { ...base, created_at: pg }).row.createdAt, pg).toBe('2026-10-31T12:34:56.789Z');
    }
    expect(deserializeRow('rates', { ...base, created_at: '2026-10-31T12:34:56+00:00' }).row.createdAt).toBe('2026-10-31T12:34:56.000Z');
  });

  it('refus : sans fuseau (ambigu), précision perdue, format ou date invalides', () => {
    for (const bad of ['2026-10-31T12:34:56', '2026-10-31T12:34:56.789', '2026-10-31', '2026-10-31T12:34:56.7891Z', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-31T25:00:00Z', '31/10/2026 12:00 Z', '', 1730000000000, null, new Date(TS)]) {
      if (bad === null) continue;
      expectMappingError(() => serializeRow('rates', { ...rate(), createdAt: bad }), 'invalid_value', 'createdAt');
    }
    expectMappingError(() => serializeRow('rates', { ...rate(), createdAt: null }), 'missing_column', 'createdAt');
    // À la lecture : précision inférieure à la milliseconde non nulle → refus (perte).
    expectMappingError(() => deserializeRow('rates', { ...asServerRow('rates', rate()), created_at: '2026-10-31T12:34:56.789123+00:00' }), 'invalid_value', 'created_at');
  });

  it('dates AAAA-MM-JJ et mois AAAA-MM : conservés à l’identique ; formats invalides refusés', () => {
    const r = rate();
    expect(roundTrip('rates', { ...r, date: '2024-02-29' }).row.date).toBe('2024-02-29');
    for (const bad of ['2026-02-30', '2026-2-01', '2026-10-31T00:00:00Z', '01/03/2026', 20260301]) expectMappingError(() => serializeRow('rates', { ...r, date: bad }), 'invalid_value', 'date');
    const b = fullRows().budgets as unknown as Record<string, unknown>;
    expect(roundTrip('budgets', { ...b, month: '2026-01' }).row.month).toBe('2026-01');
    for (const bad of ['2026-1', '2026-10-01', '202610', 'oct.']) expectMappingError(() => serializeRow('budgets', { ...b, month: bad }), 'invalid_value', 'month');
  });

  it('métadonnée serveur_updated_at : conservée telle que renvoyée (microsecondes comprises)', () => {
    const sql = { ...asServerRow('rates', rate()), server_updated_at: '2026-11-01T10:00:00.123456+00:00', deleted_at: '2026-11-01T11:00:00.5+00:00' };
    expect(deserializeRow('rates', sql).meta).toMatchObject({ serverUpdatedAt: '2026-11-01T10:00:00.123456+00:00', deletedAt: '2026-11-01T11:00:00.5+00:00' });
    expectMappingError(() => deserializeRow('rates', { ...sql, server_updated_at: 'hier' }), 'invalid_value', 'server_updated_at');
  });
});

// ---------------------------------------------------------------------------
// 5. Occurrences : clé composée
// ---------------------------------------------------------------------------

describe('mapping : échéances (clé « <ruleId>:<dueDate> » ↔ (rule_id, due_date))', () => {
  const ruleId = 'abcdef33-3333-4333-8333-33333333333f';

  it('même format que le domaine (`occurrenceId`) ; conversion dans les deux sens', () => {
    expect(occurrenceKey(ruleId, '2026-03-31')).toBe(occurrenceId(ruleId, '2026-03-31'));
    expect(parseOccurrenceKey(`${ruleId}:2026-03-31`)).toEqual({ ruleId, dueDate: '2026-03-31' });
    expect(toSqlKey('occurrences', `${ruleId}:2026-03-31`)).toEqual({ rule_id: ruleId, due_date: '2026-03-31' });
    expect(fromSqlKey('occurrences', { rule_id: ruleId, due_date: '2026-03-31' })).toBe(`${ruleId}:2026-03-31`);
  });

  it('écriture : pas de colonne id ; lecture : id reconstruit', () => {
    const occ = fullRows().occurrences as unknown as Record<string, unknown>;
    const { values, key } = serializeRow('occurrences', occ);
    expect(values).not.toHaveProperty('id');
    expect(key).toEqual({ rule_id: occ.ruleId, due_date: occ.dueDate });
    expect(roundTrip('occurrences', occ).row.id).toBe(occ.id);
  });

  it('id incohérent avec ruleId / dueDate → refus (key_mismatch)', () => {
    const occ = fullRows().occurrences as unknown as Record<string, unknown>;
    expectMappingError(() => serializeRow('occurrences', { ...occ, id: `${occ.ruleId}:2026-04-30` }), 'key_mismatch', 'id');
    expectMappingError(() => serializeRow('occurrences', { ...occ, id: undefined }), 'key_mismatch', 'id');
  });

  it('clés mal formées refusées (sans ambiguïté possible)', () => {
    for (const bad of [ruleId, `${ruleId}:2026-03-31:x`, `x:${ruleId}:2026-03-31`, `${ruleId}2026-03-31`, `${ruleId}:2026-02-30`, `${ruleId.toUpperCase()}:2026-03-31`, `:2026-03-31`, '', 42, [ruleId, '2026-03-31']]) {
      expectMappingError(() => toSqlKey('occurrences', bad as never), 'key_mismatch');
    }
    expectMappingError(() => fromSqlKey('occurrences', { rule_id: ruleId }), 'key_mismatch');
    expectMappingError(() => fromSqlKey('occurrences', { id: `${ruleId}:2026-03-31` }), 'key_mismatch');
  });

  it('autres clés : paramètres (user_id), notifications ([userId, id]), clé simple (id)', () => {
    expect(toSqlKey('settings', U)).toEqual({ user_id: U });
    expect(fromSqlKey('settings', { user_id: U })).toBe(U);
    expect(toSqlKey('notificationStates', [U, 'budget:x:2026-10:90'])).toEqual({ user_id: U, id: 'budget:x:2026-10:90' });
    expect(fromSqlKey('notificationStates', { user_id: U, id: 'budget:x:2026-10:90' })).toEqual([U, 'budget:x:2026-10:90']);
    expect(toSqlKey('users', U)).toEqual({ id: U });
    expect(toSqlKey('accounts', U)).toEqual({ id: U });
    expectMappingError(() => toSqlKey('notificationStates', U), 'key_mismatch');
    expectMappingError(() => toSqlKey('accounts', 'pas-un-uuid'), 'invalid_value');
    expectMappingError(() => toSqlKey('meta', 'schemaVersion'), 'excluded_table');
  });
});

// ---------------------------------------------------------------------------
// 6. users ↔ profiles
// ---------------------------------------------------------------------------

describe('mapping : users ↔ profiles', () => {
  it('profil en mise à jour seule : seules id (clé) et display_name sont écrites ; email et created_at jamais', () => {
    const user = fullRows().users;
    const s = serializeRow('users', user);
    expect(s.sqlTable).toBe('profiles');
    expect(s.write).toBe('update-only');
    expect(s.values).toEqual({ id: U, display_name: 'Sara' });
    expect(MAPPING.users.fields.createdAt).toMatchObject({ column: 'created_at', writable: false });
    expect(Object.values(MAPPING).filter((m) => m.write === 'update-only').map((m) => m.sqlTable)).toEqual(['profiles']);
  });

  it('lecture : created_at fixé par le serveur (inscription) ; email absent (fait foi dans auth.users)', () => {
    const user = fullRows().users;
    const { row } = roundTrip('users', user, { created_at: '2026-09-01T08:00:00+00:00' });
    expect(row).toEqual({ id: U, displayName: 'Sara', createdAt: '2026-09-01T08:00:00.000Z' });
    expect(row).not.toHaveProperty('email');
  });

  it('propriétaire : profil = utilisateur courant (id), sinon refus', () => {
    expect(() => serializeRow('users', fullRows().users, { userId: U })).not.toThrow();
    expectMappingError(() => serializeRow('users', fullRows().users, { userId: OTHER }), 'owner_mismatch', 'id');
  });

  it('paramètres : id = userId obligatoire ; pas de colonne id ; id reconstruit à la lecture', () => {
    const s = fullRows().settings as unknown as Record<string, unknown>;
    expect(serializeRow('settings', s).values).not.toHaveProperty('id');
    expect(serializeRow('settings', s).key).toEqual({ user_id: U });
    expect(roundTrip('settings', s).row.id).toBe(U);
    expectMappingError(() => serializeRow('settings', { ...s, id: OTHER }), 'key_mismatch', 'id');
    expectMappingError(() => serializeRow('settings', { ...s, id: 'local-user' }), 'key_mismatch', 'id');
  });
});

// ---------------------------------------------------------------------------
// 7–8. meta et pièces jointes
// ---------------------------------------------------------------------------

describe('mapping : exclusions (meta, fichiers joints)', () => {
  it('meta : refusée explicitement partout', () => {
    expectMappingError(() => assertCloudTable('meta'), 'excluded_table');
    expectMappingError(() => serializeRow('meta', { key: 'schemaVersion', value: 1 }), 'excluded_table');
    expectMappingError(() => deserializeRow('meta' as CloudTableName, {}), 'excluded_table');
    expectMappingError(() => sqlTableOf('meta'), 'excluded_table');
    expect(Object.keys(MAPPING)).not.toContain('meta');
  });

  it('tables inconnues refusées (noms SQL, variantes, prototype)', () => {
    for (const t of ['profiles', 'user_settings', 'Accounts', 'account', 'auth', '__proto__', 'constructor', 'toString', '']) expectMappingError(() => assertCloudTable(t), 'unknown_table');
  });

  it('attachments : le fichier (blob) n’est jamais transmis ; seules les métadonnées le sont', () => {
    const a = fullRows().attachments;
    const { values } = serializeRow('attachments', a);
    expect(values).toEqual({ id: a.id, user_id: U, name: 'facture.pdf', mime_type: 'application/pdf', size: 5242880, created_at: TS });
    expect(Object.values(values).some((v) => typeof v === 'object' && v !== null && !Array.isArray(v))).toBe(false);
    expect(JSON.stringify(values)).not.toContain('PDF-1.4');
    const { row } = roundTrip('attachments', a);
    expect(row).not.toHaveProperty('blob');
    expect(row).toEqual(toCloudRow('attachments', a));
    // Sans fichier local (ex. ligne relue) : accepté de la même façon.
    const { blob: _b, ...noBlob } = a;
    expect(serializeRow('attachments', noBlob).values).toEqual(values);
  });

  it('données binaires refusées dans toute colonne', () => {
    const tx = fullRows().transactions as unknown as Record<string, unknown>;
    for (const bin of [new Blob(['x']), new Uint8Array([1, 2]), new ArrayBuffer(2)]) {
      expectMappingError(() => serializeRow('transactions', { ...tx, notes: bin }), 'invalid_value', 'notes');
      expectMappingError(() => serializeRow('transactions', { ...tx, tags: bin }), 'invalid_value', 'tags');
    }
    expectMappingError(() => serializeRow('attachments', { ...fullRows().attachments, name: new Blob(['x']) }), 'invalid_value', 'name');
  });
});

// ---------------------------------------------------------------------------
// 9–10. Colonnes inconnues et métadonnées serveur
// ---------------------------------------------------------------------------

describe('mapping : colonnes inconnues et métadonnées serveur', () => {
  const acc = () => fullRows().accounts as unknown as Record<string, unknown>;

  it('champ TS inconnu refusé, même de valeur undefined ; noms SQL refusés côté TS', () => {
    for (const k of ['foo', 'Order', 'sort_order', 'user_id', 'initial_balance', 'attachmentPath', '__proto__x']) {
      expectMappingError(() => serializeRow('accounts', { ...acc(), [k]: 1 }), 'unknown_column', k);
    }
    expectMappingError(() => serializeRow('accounts', { ...acc(), extra: undefined }), 'unknown_column', 'extra');
    expectMappingError(() => assertKnownFields('accounts', { ...acc(), foo: 1 }), 'unknown_column', 'foo');
  });

  it('colonne SQL inconnue ou absente refusée à la lecture (dérive de schéma)', () => {
    const sql = asServerRow('accounts', acc());
    expectMappingError(() => deserializeRow('accounts', { ...sql, extra: 1 }), 'unknown_column', 'extra');
    expectMappingError(() => deserializeRow('accounts', { ...sql, sortOrder: 1 }), 'unknown_column', 'sortOrder');
    for (const k of ['description', 'sort_order', 'version', 'sync_txid', 'server_updated_at', 'deleted_at']) {
      const { [k]: _x, ...missing } = sql;
      expectMappingError(() => deserializeRow('accounts', missing), 'missing_column', k);
    }
  });

  it('métadonnées serveur fournies par le client : refusées (snake_case et camelCase), sur toutes les tables', () => {
    const full = fullRows();
    for (const table of CLOUD_TABLES) {
      for (const k of ['version', 'sync_txid', 'server_updated_at', 'deleted_at', 'syncTxid', 'serverUpdatedAt', 'deletedAt']) {
        expectMappingError(() => serializeRow(table, { ...(full[table] as object), [k]: k === 'version' ? 99 : null }), 'forbidden_column', k);
      }
    }
  });

  it('lecture : métadonnées séparées de la ligne métier ; xid8 conservé sans perte', () => {
    const sql = { ...asServerRow('accounts', acc()), version: '42', sync_txid: '18446744073709551615', deleted_at: '2026-11-01T10:00:00+00:00' };
    const { row, meta } = deserializeRow('accounts', sql);
    expect(meta).toEqual({ version: 42, syncTxid: '18446744073709551615', serverUpdatedAt: META.server_updated_at, deletedAt: '2026-11-01T10:00:00+00:00' });
    for (const k of ['version', 'syncTxid', 'serverUpdatedAt', 'deletedAt', ...SERVER_METADATA_COLUMNS]) expect(row).not.toHaveProperty(k);
    expect(deserializeRow('accounts', { ...sql, sync_txid: 12 }).meta.syncTxid).toBe('12');
    for (const bad of [-1, 1.5, 'abc', null]) expectMappingError(() => deserializeRow('accounts', { ...sql, sync_txid: bad }), 'invalid_value', 'sync_txid');
    for (const bad of [null, 1.5, '9007199254740993']) expectMappingError(() => deserializeRow('accounts', { ...sql, version: bad }), 'invalid_value', 'version');
  });

  it('propriétaire : ligne d’un autre utilisateur refusée si l’utilisateur courant est indiqué', () => {
    expect(() => serializeRow('accounts', acc(), { userId: U })).not.toThrow();
    expectMappingError(() => serializeRow('accounts', acc(), { userId: OTHER }), 'owner_mismatch', 'userId');
    expectMappingError(() => serializeRow('accounts', { ...acc(), userId: 'local-user' }), 'invalid_value', 'userId'); // identifiant local (Edge) : pas un UUID
  });
});

// ---------------------------------------------------------------------------
// 11. Montants et taux
// ---------------------------------------------------------------------------

describe('mapping : montants (bigint) et taux (double precision)', () => {
  const tx = () => fullRows().transactions as unknown as Record<string, unknown>;
  const rate = () => fullRows().rates as unknown as Record<string, unknown>;

  it('montants : entiers sûrs conservés exactement (jusqu’à ±(2^53 − 1)), jamais convertis en chaîne', () => {
    for (const amount of [1, 99, 100, MAX_AMOUNT, Number.MAX_SAFE_INTEGER]) {
      const { values } = serializeRow('transactions', { ...tx(), amount, interestAmount: 0 });
      expect(values.amount).toBe(amount);
      expect(typeof values.amount).toBe('number');
      expect(roundTrip('transactions', { ...tx(), amount, interestAmount: 0 }).row.amount).toBe(amount);
    }
    for (const v of [-Number.MAX_SAFE_INTEGER, -1, 0]) expect(roundTrip('accounts', { ...fullRows().accounts, initialBalance: v }).row.initialBalance).toBe(v);
  });

  it('montants : non entiers, non sûrs, non numériques refusés à l’écriture', () => {
    for (const bad of [1.5, 0.1, Number.MAX_SAFE_INTEGER + 1, 2 ** 63, Number.NaN, Number.POSITIVE_INFINITY, '100', 10n, true, [100]]) {
      expectMappingError(() => serializeRow('transactions', { ...tx(), amount: bad }), 'invalid_value', 'amount');
    }
  });

  it('lecture d’un bigint : nombre ou chaîne décimale exacte ; au-delà de 2^53 − 1 refusé (aucune perte silencieuse)', () => {
    const sql = asServerRow('transactions', tx());
    expect(deserializeRow('transactions', { ...sql, amount: '9007199254740991' }).row.amount).toBe(Number.MAX_SAFE_INTEGER);
    expect(deserializeRow('transactions', { ...sql, amount: '000123' }).row.amount).toBe(123);
    for (const bad of ['9007199254740992', '9007199254740993', '12345678901234567890', 9007199254740992, '1e3', '1.0', ' 1', 1.5]) {
      expectMappingError(() => deserializeRow('transactions', { ...sql, amount: bad }), 'invalid_value', 'amount');
    }
  });

  it('taux : nombres JavaScript conservés bit à bit (sérialisation JSON comprise)', () => {
    for (const r of [10.86, 0.1 + 0.2, 1 / 3, 9.98, 1e-12, 5e-324, 1.7976931348623157e308, 2.220446049250313e-16, 123456789.12345679]) {
      const back = roundTrip('rates', { ...rate(), rate: r }).row.rate;
      expect(Object.is(back, r), String(r)).toBe(true);
    }
    const debt = fullRows().debts as unknown as Record<string, unknown>;
    for (const r of [3.95, 0, 12.345678901234567]) expect(Object.is(roundTrip('debts', { ...debt, interestRate: r }).row.interestRate, r)).toBe(true);
  });

  it('taux : NaN et ±Infinity refusés (JSON les transformerait en null) ; chaînes refusées', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '10.86']) {
      expectMappingError(() => serializeRow('rates', { ...rate(), rate: bad }), 'invalid_value', 'rate');
      expectMappingError(() => deserializeRow('rates', { ...asServerRow('rates', rate()), rate: bad }), 'invalid_value', 'rate');
    }
    expectMappingError(() => serializeRow('settings', { ...fullRows().settings, budgetAlertThresholds: [50, Number.NaN] }), 'invalid_value', 'budgetAlertThresholds[1]');
  });

  it('entiers 32 et 16 bits : bornes du type SQL respectées', () => {
    const acc = fullRows().accounts as unknown as Record<string, unknown>;
    expect(roundTrip('accounts', { ...acc, order: 2 ** 31 - 1 }).row.order).toBe(2 ** 31 - 1);
    expect(roundTrip('accounts', { ...acc, order: -(2 ** 31) }).row.order).toBe(-(2 ** 31));
    for (const bad of [2 ** 31, -(2 ** 31) - 1, 0.5]) expectMappingError(() => serializeRow('accounts', { ...acc, order: bad }), 'invalid_value', 'order');
    const s = fullRows().settings as unknown as Record<string, unknown>;
    expect(roundTrip('settings', { ...s, weekStartsOn: 0 }).row.weekStartsOn).toBe(0);
    expectMappingError(() => serializeRow('settings', { ...s, weekStartsOn: 2 ** 15 }), 'invalid_value', 'weekStartsOn');
  });
});

// ---------------------------------------------------------------------------
// 12. Jeu de démonstration
// ---------------------------------------------------------------------------

describe('mapping : jeu de démonstration', () => {
  const SNAPSHOT_TABLES = {
    settings: 'settings', accounts: 'accounts', categories: 'categories', transactions: 'transactions', budgets: 'budgets', goals: 'goals',
    goalContributions: 'goalContributions', recurringRules: 'recurringRules', occurrences: 'occurrences', debts: 'debts', debtPayments: 'debtPayments',
    assets: 'assets', valuations: 'valuations', rates: 'rates', notificationStates: 'notificationStates',
  } as const;

  it('100 % des lignes convertibles aller-retour, sans perte, avec contrôle du propriétaire', () => {
    const demo = generateDemoData(U, '2026-10-15');
    let total = 0;
    const perTable: Record<string, number> = {};
    const normalized: Record<string, number> = {};
    for (const [key, table] of Object.entries(SNAPSHOT_TABLES)) {
      const value = demo[key as keyof typeof demo];
      const rows = (Array.isArray(value) ? value : [value]) as unknown as Record<string, unknown>[];
      for (const row of rows) {
        serializeRow(table, row, { userId: U });
        const { row: back } = roundTrip(table, row);
        expect(back, `${table} ${String(row.id)}`).toEqual(expected(table, row));
        // Écarts avec la ligne d'origine (clés `undefined` retirées) : seule l'exception
        // documentée `recurringRules.subcategoryId` absent → null est autorisée.
        const strict = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
        for (const k of new Set([...Object.keys(strict), ...Object.keys(back)])) {
          const a = strict[k];
          const b = (back as Record<string, unknown>)[k];
          if (JSON.stringify(a) === JSON.stringify(b)) continue;
          const exception = `${table}.${k}:${a === undefined ? 'absent' : JSON.stringify(a)}→${JSON.stringify(b)}`;
          normalized[exception] = (normalized[exception] ?? 0) + 1;
        }
        total++;
      }
      perTable[table] = rows.length;
    }
    expect(total).toBeGreaterThan(100);
    expect(Object.keys(normalized)).toEqual(['recurringRules.subcategoryId:absent→null']);
    // Toutes les tables alimentées par la démo sont exercées.
    for (const t of ['accounts', 'categories', 'transactions', 'budgets', 'goals', 'recurringRules', 'debts', 'debtPayments', 'assets', 'valuations', 'rates']) expect(perTable[t], t).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Cas limites
// ---------------------------------------------------------------------------

describe('mapping : cas limites et valeurs invalides', () => {
  const acc = () => fullRows().accounts as unknown as Record<string, unknown>;

  it('UUID : forme canonique en minuscules exigée (PostgreSQL renvoie des minuscules)', () => {
    const mixed = 'abcdef01-2345-4678-89ab-cdef01234567';
    expect(serializeRow('accounts', { ...acc(), id: mixed }).values.id).toBe(mixed);
    expectMappingError(() => serializeRow('accounts', { ...acc(), id: mixed.toUpperCase() }), 'invalid_value', 'id');
    for (const bad of ['', 'abc', '00000000-0000-4000-8000-00000000000', '{00000000-0000-4000-8000-000000000001}', 42]) expectMappingError(() => serializeRow('accounts', { ...acc(), id: bad }), 'invalid_value', 'id');
  });

  it('texte : caractère NUL refusé (PostgreSQL le rejette) ; type incorrect refusé', () => {
    expectMappingError(() => serializeRow('accounts', { ...acc(), name: 'a\u0000b' }), 'invalid_value', 'name');
    expectMappingError(() => serializeRow('transactions', { ...fullRows().transactions, tags: ['ok', 'a\u0000'] }), 'invalid_value', 'tags[1]');
    expectMappingError(() => serializeRow('accounts', { ...acc(), name: 42 }), 'invalid_value', 'name');
    expectMappingError(() => serializeRow('transactions', { ...fullRows().transactions, tags: 'a,b' }), 'invalid_value', 'tags');
  });

  it('booléens stricts', () => {
    for (const bad of [0, 1, 'true', 'false']) expectMappingError(() => serializeRow('accounts', { ...acc(), archived: bad }), 'invalid_value', 'archived');
  });

  it('entrées non conformes : ligne absente, tableau, nombre', () => {
    for (const bad of [null, undefined, [], 42, 'ligne']) {
      expectMappingError(() => serializeRow('accounts', bad), 'invalid_value');
      expectMappingError(() => deserializeRow('accounts', bad), 'invalid_value');
    }
  });

  it('pas de règle métier dans le mapping : valeurs refusées par les CHECK SQL mais de bon type acceptées', () => {
    // Le mapping ne contrôle que la représentation ; les contraintes métier sont à RepositoryCore et au schéma.
    expect(() => serializeRow('accounts', { ...acc(), type: 'inconnu', currency: 'euro', name: '' })).not.toThrow();
    expect(() => serializeRow('transactions', { ...fullRows().transactions, amount: -5 })).not.toThrow();
  });

  it('la ligne d’entrée n’est jamais modifiée', () => {
    const a = fullRows().attachments;
    const copy = { ...a };
    serializeRow('attachments', a);
    expect(a).toEqual(copy);
    expect(a.blob).toBe(copy.blob);
  });

  it('messages d’erreur : table et champ identifiés, sans divulguer de données au-delà de 40 caractères', () => {
    try {
      serializeRow('accounts', { ...acc(), name: 'x'.repeat(200) + '\u0000' });
    } catch (e) {
      expect((e as MappingError).message).toMatch(/^Mapping accounts\.name : /);
    }
    try {
      serializeRow('accounts', { ...acc(), order: 'secret'.repeat(20) });
    } catch (e) {
      expect((e as MappingError).message.length).toBeLessThan(160);
    }
  });
});

// Garde de type : `SqlRow` est bien la forme produite.
const _typecheck: SqlRow = serializeRow('rates', fullRows().rates).values;
void _typecheck;
