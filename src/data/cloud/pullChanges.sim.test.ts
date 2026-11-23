/**
 * V4.1 (migration 9, M9) — récupération des changements sur le serveur SIMULÉ
 * (`MemoryTransport.pull` derrière `POST /rest/v1/rpc/pull_changes`), avec le vrai SDK.
 *
 * Même contrat que `public.pull_changes`, qualifié sur PostgreSQL (suites SQL 07 et 12, suite
 * HTTP) : intervalle `curseur ≤ sync_txid < borne`, lignes actives et supprimées, pages
 * (sync_txid, table, clé), `xid8` en texte, refus `PT400 invalid_pull`, isolation. Les
 * transactions concurrentes (borne retenue par une transaction en cours) ne sont pas
 * modélisées en mémoire : elles relèvent des suites PostgreSQL.
 * Aucun code client de synchronisation n'est testé ici (V4.2).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryTransport, PULL_MAX_LIMIT } from './MemoryTransport';
import { postgrestSimulator, simClient } from '@/test/postgrestSimulator';
import { commitAs, seed } from '@/test/cloudData';
import { CLOUD_TABLES, deserializeRow, sqlTableOf, tableOfSql } from './mapping';
import type { Account } from '@/domain/types';
import type { ChangeOp } from './transport';

type Item = { table: string; key: Record<string, unknown>; row: Record<string, unknown> };
type Page = { bound: string; rows: Item[]; next: { txid: string; table: string; key: string } | null };

const sortKey = (e: Item) => (e.table === 'user_settings' ? String(e.key.user_id) : e.table === 'recurring_occurrences' ? `${e.key.rule_id}|${e.key.due_date}` : String(e.key.id));
const ordered = (rows: Item[]) =>
  rows.every((e, i) => {
    if (i === 0) return true;
    const p = rows[i - 1];
    const a = BigInt(p.row.sync_txid as string), b = BigInt(e.row.sync_txid as string);
    return a !== b ? a < b : p.table !== e.table ? p.table < e.table : sortKey(p) < sortKey(e);
  });

function setup() {
  const server = new MemoryTransport();
  const sim = postgrestSimulator(server);
  const client = (uid: string | null) => simClient(sim.fetch, uid ? { uid } : null);
  return { server, sim, client };
}

async function pullAll(client: ReturnType<typeof simClient>, cursor: string, limit = PULL_MAX_LIMIT) {
  let bound: string | null = null;
  let after: Page['next'] = null;
  const rows: Item[] = [];
  let pages = 0;
  for (;;) {
    const { data, error } = await client.rpc('pull_changes', { p_cursor: cursor, p_bound: bound, p_after: after, p_limit: limit });
    if (error) throw new Error(`pull_changes : ${error.code} ${error.message}`);
    const page = data as Page;
    if (bound !== null) expect(page.bound).toBe(bound); // borne constante dans un intervalle
    bound = page.bound;
    rows.push(...page.rows);
    pages++;
    if (page.next && after && JSON.stringify(page.next) === JSON.stringify(after)) throw new Error('pagination sans progression');
    after = page.next;
    if (!after) break;
    if (pages > 10_000) throw new Error('pagination sans fin');
  }
  return { bound: bound!, rows, pages };
}

const account = (uid: string, name: string): Account =>
  ({ id: randomUUID(), userId: uid, name, type: 'bank', currency: 'MAD', initialBalance: 0, initialBalanceDate: '2026-03-01', archived: false, includeInTotal: true, color: '#fff', order: 0, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }) as Account;

describe('V4.1 — pull_changes sur le serveur simulé (vrai SDK)', () => {
  it('récupération complète : toutes les lignes de l’utilisateur (18 tables), xid8 en texte, ordre strict, < borne', async () => {
    const { server, client } = setup();
    const a = randomUUID();
    await seed(server, a);
    const full = await pullAll(client(a), '0');
    expect(full.bound).toMatch(/^\d+$/);
    const tables = new Set(full.rows.map((e) => e.table));
    expect(tables.size).toBe(18);
    expect(full.rows.every((e) => (e.row.user_id ?? e.row.id) === a)).toBe(true);
    expect(full.rows.every((e) => typeof e.row.sync_txid === 'string' && BigInt(e.row.sync_txid as string) < BigInt(full.bound))).toBe(true);
    expect(ordered(full.rows)).toBe(true);
    // Même nombre de lignes que la lecture du serveur (lignes supprimées comprises), table par table.
    for (const t of CLOUD_TABLES) expect(full.rows.filter((e) => e.table === sqlTableOf(t))).toHaveLength(server.sqlRows(a, t).length);
  });

  it('pagination : pages de 3 = une page de 1 000 (mêmes lignes, même ordre, aucune en double), next nul à la fin', async () => {
    const { server, client } = setup();
    const a = randomUUID();
    await seed(server, a);
    const one = await pullAll(client(a), '0');
    const paged = await pullAll(client(a), '0', 3);
    expect(paged.pages).toBe(Math.ceil(one.rows.length / 3));
    const sig = (rows: Item[]) => rows.map((e) => `${e.table}:${sortKey(e)}:${e.row.version}`);
    expect(sig(paged.rows)).toEqual(sig(one.rows));
    expect(new Set(sig(paged.rows)).size).toBe(paged.rows.length);
  });

  it('au-delà de 1 000 lignes : plusieurs pages pleines, rien ne manque', async () => {
    const { server, client } = setup();
    const a = randomUUID();
    server.registerUser(a);
    const ops: ChangeOp[] = Array.from({ length: 2500 }, (_, i) => {
      const row = account(a, `C${i}`);
      return { table: 'accounts', type: 'put', key: row.id, expectedVersion: null, row: row as unknown as Record<string, unknown> };
    });
    await commitAs(server, a, ops);
    const full = await pullAll(client(a), '0', 1000);
    expect(full.pages).toBe(3);
    expect(full.rows.filter((e) => e.table === 'accounts')).toHaveLength(2500);
    expect(ordered(full.rows)).toBe(true);
  });

  it('incrémental : depuis la borne, seulement les lignes modifiées ou supprimées depuis (un sync_txid par lot)', async () => {
    const { server, client } = setup();
    const a = randomUUID();
    const data = await seed(server, a);
    const first = await pullAll(client(a), '0');
    const acc = account(a, 'Nouvelle');
    const victimId = String(data.budgets![0].id);
    const vVictim = server.entry(a, 'budgets', victimId)!.version;
    await commitAs(server, a, [
      { table: 'accounts', type: 'put', key: acc.id, expectedVersion: null, row: acc as unknown as Record<string, unknown> },
      { table: 'budgets', type: 'delete', key: victimId, expectedVersion: vVictim },
    ]);
    const inc = await pullAll(client(a), first.bound);
    expect(inc.rows.map((e) => `${e.table}:${e.key.id}`).sort()).toEqual([`accounts:${acc.id}`, `budgets:${victimId}`].sort());
    expect(inc.rows.find((e) => e.table === 'budgets')!.row.deleted_at).not.toBeNull();
    expect(new Set(inc.rows.map((e) => e.row.sync_txid)).size).toBe(1); // même lot, même transaction
    expect(BigInt(inc.bound)).toBeGreaterThan(BigInt(first.bound));
    const again = await pullAll(client(a), inc.bound);
    expect(again.rows).toEqual([]);
    expect(again.pages).toBe(1);
  });

  it('isolation : aucune ligne d’un autre utilisateur', async () => {
    const { server, client } = setup();
    const a = randomUUID();
    const b = randomUUID();
    await seed(server, a);
    await seed(server, b);
    const pa = await pullAll(client(a), '0');
    const pb = await pullAll(client(b), '0');
    expect(pa.rows.every((e) => (e.row.user_id ?? e.row.id) === a)).toBe(true);
    expect(pb.rows.every((e) => (e.row.user_id ?? e.row.id) === b)).toBe(true);
    expect(pa.rows.length).toBeGreaterThan(0);
  });

  it.each([
    ['curseur non numérique', { p_cursor: 'abc' }],
    ['curseur nul', { p_cursor: null }],
    ['limite 0', { p_cursor: '0', p_limit: 0 }],
    ['limite 1 001', { p_cursor: '0', p_limit: 1001 }],
    ['borne future', { p_cursor: '0', p_bound: '999999999' }],
    ['curseur > borne', { p_cursor: '5', p_bound: '3' }],
    ['p_after sans borne', { p_cursor: '0', p_after: { txid: '2', table: 'accounts', key: 'x' } }],
    ['p_after avec un champ inconnu', { p_cursor: '0', p_bound: '2', p_after: { txid: '1', table: 'accounts', key: 'x', y: 1 } }],
  ])('refus %s : 400 PT400 invalid_pull', async (_label, args) => {
    const { server, client } = setup();
    const a = randomUUID();
    server.registerUser(a);
    const { error } = await client(a).rpc('pull_changes', args);
    expect(error?.code).toBe('PT400');
    expect(error?.message).toBe('invalid_pull');
  });

  it('sans session : refusé (aucune ligne)', async () => {
    const { server, client } = setup();
    const a = randomUUID();
    await seed(server, a);
    const { data, error } = await client(null).rpc('pull_changes', { p_cursor: '0' });
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });

  it('les lignes renvoyées se convertissent par le mapping existant (format filaire de lecture)', async () => {
    const { server, client } = setup();
    const a = randomUUID();
    await seed(server, a);
    const full = await pullAll(client(a), '0');
    for (const e of full.rows) expect(() => deserializeRow(tableOfSql(e.table), e.row)).not.toThrow();
  });
});
