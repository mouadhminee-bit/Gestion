#!/usr/bin/env node
// =============================================================================
// Qualification HTTP (étapes 3b puis 4.6) : RLS, privilèges et protocole ChangeSet via la
// VRAIE pile Supabase locale, avec DEUX utilisateurs réellement authentifiés (inscription
// GoTrue, jetons JWT signés par GoTrue, appels PostgREST via Kong).
//
// État final du schéma (migration 8, décision D4-1) : un utilisateur authentifié LIT ses
// lignes par l'API REST (et, migration 9, par /rpc/pull_changes) et n'ÉCRIT que par
// /rpc/apply_changeset. Toute écriture directe
// (POST / PATCH / DELETE sur une table) doit être refusée : ces cas sont des tests de refus.
//
// Données entièrement fictives (@example.test). Aucune dépendance (Node ≥ 22, fetch).
// Lancé par scripts/qualify-supabase.sh — REFUSE toute cible autre que la pile locale.
//
// Variables : SUPABASE_API_URL (doit être http://127.0.0.1:54321), SUPABASE_ANON_KEY,
//             RESULTS_JSON (fichier de sortie), CHAIN_JSON (chaîne numérique des taux).
// =============================================================================
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.SUPABASE_API_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const OUT = process.env.RESULTS_JSON;
const ALLOWED_API = ['http://127.0.0.1:54321', 'http://localhost:54321'];
if (!ALLOWED_API.includes(API)) {
  console.error(`REFUS : cible « ${API} » non autorisée. Seule la pile Supabase locale (${ALLOWED_API.join(', ')}) est acceptée.`);
  process.exit(3);
}
if (!ANON) {
  console.error('REFUS : SUPABASE_ANON_KEY manquante.');
  process.exit(3);
}

const results = [];
const ok = (cond, name, detail) => {
  results.push({ file: 'H1_http_rls.mjs', name, ok: Boolean(cond), detail: detail == null ? null : String(detail).slice(0, 500) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' — ' + String(detail).slice(0, 300)}`);
};

async function call(method, path, { token, body, prefer, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      apikey: ANON,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const rest = (method, table, opts) => call(method, `/rest/v1/${table}`, opts);
const code = (r) => (r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? r.json.code : undefined);
const describe = (r) => `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`;

// ---------------------------------------------------------------------------
// Protocole ChangeSet v1 (docs/LOT4_PLAN.md § 7) par l'API
// ---------------------------------------------------------------------------
// Liste blanche lue dans la migration elle-même : aucune seconde définition des colonnes.
const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '20261101000800_apply_changeset.sql');
const SPEC = {};
{
  const names = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const m of readFileSync(MIGRATION, 'utf8').matchAll(/^\s*\('(\w+)', array\[([^\]]*)\], array\[([^\]]*)\], '(upsert|update-only)'\)/gm)) {
    SPEC[m[1]] = { key: names(m[2]), cols: names(m[3]), mode: m[4] };
  }
}
if (Object.keys(SPEC).length !== 18) {
  console.error(`REFUS : liste blanche illisible dans la migration 8 (${Object.keys(SPEC).length} tables lues, 18 attendues).`);
  process.exit(3);
}
const TABLES = Object.keys(SPEC).filter((t) => t !== 'profiles'); // les 17 tables portant user_id

/** Ligne au format du protocole : exactement les colonnes écrites (absentes = null). */
const fullRow = (table, partial) => {
  const unknown = Object.keys(partial).filter((k) => !SPEC[table].cols.includes(k));
  if (unknown.length) throw new Error(`${table} : colonne(s) hors liste blanche dans le jeu de test : ${unknown.join(', ')}`);
  return Object.fromEntries(SPEC[table].cols.map((c) => [c, partial[c] ?? null]));
};
/** Colonnes écrites d'une ligne lue par l'API (métadonnées serveur retirées). */
const writeRow = (table, row) => Object.fromEntries(SPEC[table].cols.map((c) => [c, row[c] ?? null]));
const keyOf = (table, row) => Object.fromEntries(SPEC[table].key.map((c) => [c, row[c]]));
const put = (table, row, expectedVersion = null) => ({ table, type: 'put', key: keyOf(table, row), expectedVersion, row: fullRow(table, row) });
const del = (table, row, expectedVersion) => ({ table, type: 'delete', key: keyOf(table, row), expectedVersion });
const lot = (userId, ops, changesetId = randomUUID()) => ({ protocol: 1, changesetId, userId, ops });
const apply = (u, ops, { userId = u.id, changesetId } = {}) =>
  call('POST', '/rest/v1/rpc/apply_changeset', { token: u.token, body: { p_changeset: lot(userId, ops, changesetId) } });
const resolve = (u, changesetId) => call('POST', '/rest/v1/rpc/resolve_changeset', { token: u.token, body: { p_changeset_id: changesetId } });
/** Code du protocole (message PostgREST) et détail JSON d'un refus. */
const proto = (r) => (r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? r.json.message : undefined);
const detail = (r) => {
  try {
    return typeof r.json?.details === 'string' ? JSON.parse(r.json.details) : (r.json?.details ?? null);
  } catch {
    return null;
  }
};
const refused = (r, status, protocolCode) => r.status === status && proto(r) === protocolCode;
const applied = (r, n) => r.status === 200 && r.json?.status === 'applied' && Array.isArray(r.json.versions) && (n == null || r.json.versions.length === n);

async function signUp(label) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `Qualif-${randomUUID()}`;
  let r = await call('POST', '/auth/v1/signup', { body: { email, password, data: { display_name: label } } });
  let session = r.json?.access_token ? r.json : null;
  if (!session) {
    r = await call('POST', '/auth/v1/token?grant_type=password', { body: { email, password } });
    session = r.json?.access_token ? r.json : null;
  }
  if (!session) throw new Error(`inscription de ${label} impossible : ${describe(r)}`);
  return { id: session.user.id, token: session.access_token, email };
}

// ---------------------------------------------------------------------------
// Jeu de données fictif complet d'un utilisateur, écrit en UN lot par l'API (ses propres
// droits) : les 18 tables, références circulaires comprises (contraintes différées).
// ---------------------------------------------------------------------------
const TS = '2026-10-31T12:00:00.000Z';
function seedOps(u) {
  const id = () => randomUUID();
  const ids = { acc: id(), acc2: id(), cat: id(), sub: id(), imp: id(), rule: id(), goal: id(), bud: id(), tx: id(), debt: id(), pay: id(), debtTx: id(), contrib: id(), asset: id(), val: id(), rate: id(), att: id() };
  const U = { user_id: u.id };
  const B = { ...U, created_at: TS, updated_at: TS };
  const ops = [
    { table: 'profiles', type: 'put', key: { id: u.id }, expectedVersion: 1, row: { id: u.id, display_name: 'Test' } },
    put('user_settings', { ...U, display_name: 'Test', base_currency: 'MAD', language: 'fr', locale: 'fr-MA', time_zone: 'Africa/Casablanca', date_format: 'DD/MM/YYYY', week_starts_on: 1, theme: 'dark', currency_display: 'symbol', privacy_mode: false, budget_alert_thresholds: [50, 75, 90, 100], notify_budgets: true, notify_bills: true, notify_debts: true, bill_reminder_days: 7, onboarded: true, demo_mode: false, updated_at: TS }),
    put('accounts', { ...B, id: ids.acc, name: 'Banque', type: 'bank', currency: 'MAD', initial_balance: 500000, initial_balance_date: '2026-03-01', archived: false, include_in_total: true, color: '#fff', sort_order: 0 }),
    put('accounts', { ...B, id: ids.acc2, name: 'Épargne', type: 'savings', currency: 'MAD', initial_balance: 0, initial_balance_date: '2026-03-01', archived: false, include_in_total: true, color: '#fff', sort_order: 1 }),
    put('categories', { ...B, id: ids.cat, key: 'food', name: 'Alimentation', kind: 'expense', nature: 'variable', icon: 'X', color: '#000', archived: false, sort_order: 0 }),
    put('categories', { ...B, id: ids.sub, name: 'Marché', kind: 'expense', nature: 'variable', parent_id: ids.cat, icon: 'X', color: '#000', archived: false, sort_order: 1 }),
    put('import_batches', { ...U, id: ids.imp, file_name: 'releve.csv', account_id: ids.acc, row_count: 1, imported_count: 1, skipped_count: 0, created_at: TS }),
    put('recurring_rules', { ...B, id: ids.rule, kind: 'expense', label: 'Loyer', amount: 280000, currency: 'MAD', account_id: ids.acc, category_id: ids.cat, subcategory_id: ids.sub, frequency: 'monthly', start_date: '2026-03-03', active: true }),
    put('savings_goals', { ...B, id: ids.goal, name: 'Voyage', target_amount: 100000, currency: 'MAD', saved_amount: 0, priority: 'medium', linked_account_id: ids.acc2, track_linked_account: false, status: 'active', icon: 'X', color: '#fff' }),
    put('budgets', { ...B, id: ids.bud, month: '2026-03', category_id: ids.cat, amount: 160000, currency: 'MAD' }),
    // Références circulaires dans le même lot : dépense ↔ pièce jointe, dette ↔ transaction ↔ paiement.
    put('transactions', { ...B, id: ids.tx, type: 'expense', direction: 'out', amount: 10000, currency: 'MAD', label: 'Test', date: '2026-03-10', category_id: ids.cat, subcategory_id: ids.sub, account_id: ids.acc, tags: [], status: 'cleared', recurring_rule_id: ids.rule, recurring_due_date: '2026-03-03', import_batch_id: ids.imp, counterpart_account_id: ids.acc2, attachment_id: ids.att, refund_of_id: ids.tx }),
    put('debts', { ...B, id: ids.debt, label: 'Crédit', type: 'loan', direction: 'payable', principal: 1000000, currency: 'MAD', start_date: '2026-03-01', interest_rate: 4.5, status: 'active', origin_transaction_id: ids.debtTx }),
    put('debt_payments', { ...U, id: ids.pay, debt_id: ids.debt, date: '2026-03-15', principal: 100000, interest: 5000, account_id: ids.acc, transaction_id: ids.debtTx, created_at: TS }),
    put('transactions', { ...B, id: ids.debtTx, type: 'debt', direction: 'out', amount: 105000, currency: 'MAD', label: 'Remboursement', date: '2026-03-15', account_id: ids.acc, tags: [], status: 'cleared', debt_id: ids.debt, debt_payment_id: ids.pay, interest_amount: 5000 }),
    put('goal_contributions', { ...U, id: ids.contrib, goal_id: ids.goal, date: '2026-03-10', amount: 100, created_at: TS }),
    put('recurring_occurrences', { ...U, rule_id: ids.rule, due_date: '2026-03-03', status: 'paid', transaction_id: ids.tx, updated_at: TS }),
    put('assets', { ...B, id: ids.asset, name: 'Portefeuille', type: 'investment', currency: 'MAD', linked_account_id: ids.acc2, archived: false }),
    put('asset_valuations', { ...U, id: ids.val, asset_id: ids.asset, date: '2026-03-01', value: 70000, source: 'manual', created_at: TS }),
    put('exchange_rates', { ...U, id: ids.rate, base: 'EUR', quote: 'MAD', rate: 10.86, date: '2026-03-01', source: 'manual', created_at: TS }),
    put('attachments', { ...U, id: ids.att, name: 'recu.png', mime_type: 'image/png', size: 3, created_at: TS }),
    put('notification_states', { ...U, id: 'budget:x:2026-03:90', read: true, dismissed: false, updated_at: TS }),
  ];
  return { ids, ops };
}

/** Toutes les lignes visibles par un utilisateur (les 18 tables), triées : instantané comparable. */
async function snapshot(u) {
  const out = {};
  for (const t of Object.keys(SPEC)) {
    const r = await rest('GET', `${t}?select=*`, { token: u.token });
    if (r.status !== 200) throw new Error(`lecture ${t} pour ${u.email} : ${describe(r)}`);
    out[t] = r.json.map((x) => JSON.stringify(x, Object.keys(x).sort())).sort().map((x) => JSON.parse(x));
  }
  return out;
}

const account = (userId, extra = {}) => ({ id: randomUUID(), user_id: userId, name: 'X', type: 'bank', currency: 'MAD', initial_balance: 0, initial_balance_date: '2026-03-01', archived: false, include_in_total: true, color: '#fff', sort_order: 0, created_at: TS, updated_at: TS, ...extra });

async function main() {
  // --- Comptes réels ---------------------------------------------------------
  const A = await signUp('qualif-a');
  const B = await signUp('qualif-b');
  ok(A.id !== B.id, 'deux utilisateurs distincts inscrits via GoTrue', `${A.id} / ${B.id}`);
  const parts = A.token.split('.');
  ok(parts.length === 3 && JSON.parse(Buffer.from(parts[1], 'base64url')).role === 'authenticated', 'jeton JWT réel émis par GoTrue (rôle authenticated)');

  // --- Profils créés par le déclencheur d'inscription -------------------------
  let r = await rest('GET', 'profiles?select=id,display_name,version', { token: A.token });
  ok(r.status === 200 && r.json.length === 1 && r.json[0].id === A.id, 'profil de A créé à l\'inscription et seul visible par A', describe(r));
  ok(r.json?.[0]?.display_name === 'qualif-a', 'nom du profil repris des métadonnées d\'inscription', describe(r));
  r = await rest('GET', 'user_settings?select=user_id', { token: A.token });
  ok(r.status === 200 && r.json.length === 0, 'aucun user_settings pré-créé à l\'inscription', describe(r));
  r = await rest('PATCH', `profiles?id=eq.${B.id}`, { token: A.token, body: { display_name: 'piraté' }, prefer: 'return=representation' });
  ok(r.status === 403 && code(r) === '42501', 'profiles : écriture directe refusée (A sur le profil de B)', describe(r));
  r = await rest('PATCH', `profiles?id=eq.${A.id}`, { token: A.token, body: { display_name: 'direct' }, prefer: 'return=representation' });
  ok(r.status === 403 && code(r) === '42501', 'profiles : écriture directe refusée même sur son propre profil', describe(r));
  r = await apply(A, [{ table: 'profiles', type: 'put', key: { id: B.id }, expectedVersion: 1, row: { id: B.id, display_name: 'piraté' } }]);
  ok(refused(r, 403, 'unauthorized'), 'profiles : A ne renomme pas le profil de B par le protocole (unauthorized)', describe(r));

  // --- Données des deux utilisateurs, chacune en UN lot ------------------------
  const sa = seedOps(A);
  const sb = seedOps(B);
  r = await apply(A, sa.ops);
  ok(applied(r, sa.ops.length), 'A : jeu complet (18 tables, références circulaires) appliqué en un lot', describe(r));
  r = await apply(B, sb.ops);
  ok(applied(r, sb.ops.length), 'B : jeu complet (18 tables, références circulaires) appliqué en un lot', describe(r));
  const a = sa.ids;
  const b = sb.ids;
  const beforeA = await snapshot(A);
  const beforeB = await snapshot(B);
  ok(Object.keys(SPEC).every((t) => beforeA[t].length > 0 && beforeB[t].length > 0), 'chaque utilisateur relit ses lignes dans les 18 tables');
  ok(beforeA.profiles[0]?.display_name === 'Test' && beforeA.profiles[0]?.version === 2, 'profil renommé par le protocole (version 2)', JSON.stringify(beforeA.profiles[0]));

  // --- Matrice d'isolation par table ------------------------------------------
  for (const t of TABLES) {
    const rowA = beforeA[t][0];
    const rowB = beforeB[t][0];
    const wA = writeRow(t, rowA);
    // Lecture
    r = await rest('GET', `${t}?select=user_id`, { token: B.token });
    ok(r.status === 200 && r.json.length > 0 && r.json.every((x) => x.user_id === B.id), `${t} : B ne lit que ses propres lignes`, describe(r));
    r = await rest('GET', `${t}?select=user_id&user_id=eq.${A.id}`, { token: B.token });
    ok(r.status === 200 && r.json.length === 0, `${t} : filtrer sur A ne renvoie rien à B`, describe(r));
    // Écritures directes : refusées par privilège, sur les lignes de A comme sur les siennes
    r = await rest('PATCH', `${t}?user_id=eq.${A.id}`, { token: B.token, body: { deleted_at: new Date().toISOString() }, prefer: 'return=representation' });
    ok(r.status === 403 && code(r) === '42501', `${t} : PATCH direct refusé (lignes de A)`, describe(r));
    r = await rest('PATCH', `${t}?user_id=eq.${B.id}`, { token: B.token, body: { deleted_at: new Date().toISOString() }, prefer: 'return=representation' });
    ok(r.status === 403 && code(r) === '42501', `${t} : PATCH direct refusé même sur ses lignes`, describe(r));
    r = await rest('POST', t, { token: B.token, body: writeRow(t, rowB), prefer: 'resolution=merge-duplicates' });
    ok(r.status === 403 && code(r) === '42501', `${t} : POST direct (insertion / upsert) refusé`, describe(r));
    r = await rest('DELETE', `${t}?user_id=eq.${A.id}`, { token: B.token });
    ok(r.status >= 400 && code(r) === '42501', `${t} : DELETE refusé (privilège)`, describe(r));
    r = await rest('DELETE', `${t}?user_id=eq.${B.id}`, { token: B.token });
    ok(r.status >= 400 && code(r) === '42501', `${t} : DELETE refusé même sur ses lignes`, describe(r));
    // Par le protocole
    if (SPEC[t].key.includes('user_id')) {
      r = await apply(B, [put(t, wA, rowA.version)]);
      ok(refused(r, 403, 'unauthorized'), `${t} : B ne modifie pas la ligne de A (protocole)`, describe(r));
      r = await apply(B, [del(t, wA, rowA.version)]);
      ok(refused(r, 403, 'unauthorized'), `${t} : B ne supprime pas la ligne de A (protocole)`, describe(r));
    } else {
      r = await apply(B, [put(t, { ...wA, user_id: B.id }, rowA.version)]);
      ok(refused(r, 409, 'version_conflict') && detail(r)?.conflicts?.[0]?.actualVersion === null, `${t} : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)`, describe(r));
      r = await apply(B, [del(t, wA, rowA.version)]);
      ok(refused(r, 409, 'version_conflict') && detail(r)?.conflicts?.[0]?.actualVersion === null, `${t} : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)`, describe(r));
      r = await apply(B, [put(t, { ...wA, user_id: B.id }, null)]);
      ok(refused(r, 409, 'duplicate_key') && detail(r)?.sqlstate === undefined, `${t} : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)`, describe(r));
    }
    r = await apply(B, [put(t, wA, null)]);
    ok(refused(r, 403, 'unauthorized'), `${t} : B ne peut pas écrire au nom de A`, describe(r));
    r = await apply(B, [put(t, wA, rowA.version)], { userId: A.id });
    ok(refused(r, 403, 'unauthorized'), `${t} : B ne peut pas soumettre un lot au nom de A`, describe(r));
    r = await apply(B, [put(t, { ...writeRow(t, rowB), user_id: A.id }, rowB.version)]);
    ok(refused(r, 403, 'unauthorized'), `${t} : B ne peut pas transférer sa ligne à A`, describe(r));
  }
  // Lignes de A et de B strictement identiques (toutes tables, métadonnées serveur comprises)
  const afterA = await snapshot(A);
  ok(JSON.stringify(afterA) === JSON.stringify(beforeA), 'lignes de A strictement inchangées après les tentatives de B (18 tables, versions comprises)');
  ok(JSON.stringify(await snapshot(B)) === JSON.stringify(beforeB), 'aucune tentative refusée de B n\'a modifié ses propres lignes');

  // --- Références croisées (clés composites) -----------------------------------
  const tx = (u, extra = {}) => ({ id: randomUUID(), user_id: u, type: 'income', direction: 'in', amount: 100, currency: 'MAD', label: 'X', date: '2026-03-01', account_id: b.acc, tags: [], status: 'cleared', created_at: TS, updated_at: TS, ...extra });
  const crossRefs = [
    ['transactions', tx(B.id, { account_id: a.acc }), 'compte de A'],
    ['transactions', tx(B.id, { category_id: a.cat }), 'catégorie de A'],
    ['transactions', tx(B.id, { debt_id: a.debt, type: 'debt', interest_amount: 0 }), 'dette de A'],
    ['goal_contributions', { id: randomUUID(), user_id: B.id, goal_id: a.goal, date: '2026-03-01', amount: 1, created_at: TS }, 'objectif de A'],
    ['asset_valuations', { id: randomUUID(), user_id: B.id, asset_id: a.asset, date: '2026-03-01', value: 1, source: 'manual', created_at: TS }, 'actif de A'],
    ['recurring_occurrences', { user_id: B.id, rule_id: a.rule, due_date: '2026-04-03', status: 'skipped', updated_at: TS }, 'règle récurrente de A'],
  ];
  for (const [table, row, what] of crossRefs) {
    r = await apply(B, [put(table, row)]);
    ok(r.status === 409 && code(r) === '23503', `${table} : B ne peut pas référencer ${what} (clé composite)`, describe(r));
  }
  r = await apply(B, [put('transactions', tx(B.id, { category_id: b.cat }))]);
  ok(applied(r, 1), 'contrôle positif : B référence sa propre catégorie', describe(r));

  // --- Contraintes différées remontées par PostgREST (Q6) ----------------------
  r = await apply(B, [put('transactions', tx(B.id, { type: 'debt', debt_id: randomUUID(), interest_amount: 0 }))]);
  ok(r.status === 409 && code(r) === '23503', 'Q6 référence pendante : erreur différée (23503) renvoyée à la validation', describe(r));
  const debtId = randomUUID();
  const originId = randomUUID();
  const originTx = put('transactions', tx(B.id, { id: originId, type: 'debt', debt_id: debtId, interest_amount: 0 }));
  const debtRow = put('debts', { id: debtId, user_id: B.id, label: 'Prêt', type: 'loan', direction: 'payable', principal: 1000, currency: 'MAD', start_date: '2026-03-01', status: 'active', origin_transaction_id: originId, created_at: TS, updated_at: TS });
  r = await apply(B, [originTx]);
  ok(r.status === 409 && code(r) === '23503', 'dette ↔ transaction en deux lots séparés : le premier est refusé (un lot = une transaction)', describe(r));
  r = await apply(B, [originTx, debtRow]);
  ok(applied(r, 2), 'dette ↔ transaction dans le MÊME lot : appliqué (écriture multi-tables atomique)', describe(r));
  r = await apply(B, [put('budgets', { id: randomUUID(), user_id: B.id, month: '2026-03', category_id: b.cat, amount: 1, currency: 'MAD', created_at: TS, updated_at: TS })]);
  ok(r.status >= 400 && code(r) === '23P01', 'unicité différée (budget en double) renvoyée par PostgREST', describe(r));

  // --- Atomicité : une opération invalide annule tout le lot --------------------
  const good = account(B.id);
  r = await apply(B, [put('accounts', good), put('accounts', account(B.id, { type: 'crypto' }))]);
  ok(refused(r, 400, 'invalid_row') && detail(r)?.sqlstate === '23514' && detail(r)?.op === 1, 'atomicité : lot refusé (invalid_row, CHECK 23514, opération désignée)', describe(r));
  r = await rest('GET', `accounts?id=eq.${good.id}&select=id`, { token: B.token });
  ok(r.status === 200 && r.json.length === 0, 'atomicité : l\'opération valide du lot refusé n\'a pas été écrite', describe(r));

  // --- Métadonnées serveur via l'API ------------------------------------------
  const meta = account(B.id, { created_at: '2020-01-02T03:04:05.678Z' });
  const metaOp = put('accounts', meta);
  for (const [col, value] of [['version', 999], ['sync_txid', '1'], ['server_updated_at', '2000-01-01T00:00:00Z'], ['deleted_at', '2000-01-01T00:00:00Z']]) {
    r = await apply(B, [{ ...metaOp, row: { ...metaOp.row, [col]: value } }]);
    ok(refused(r, 400, 'invalid_row'), `API : métadonnée serveur ${col} envoyée par le client → lot refusé`, describe(r));
  }
  r = await apply(B, [metaOp]);
  ok(applied(r, 1) && r.json.versions[0].version === 1 && r.json.versions[0].deleted === false, 'API : création confirmée en version 1', describe(r));
  r = await rest('GET', `accounts?id=eq.${meta.id}&select=*`, { token: B.token });
  const row = r.json?.[0];
  ok(row?.version === 1, 'API : version imposée par le serveur', describe(r));
  ok(row && row.sync_txid !== '1' && new Date(row.server_updated_at) > new Date('2020-01-01'), 'API : sync_txid et server_updated_at imposés par le serveur', describe(r));
  ok(row && new Date(row.created_at).toISOString() === '2020-01-02T03:04:05.678Z', 'API : created_at métier du client conservé à la milliseconde', row?.created_at);
  r = await apply(B, [del('accounts', meta, 1)]);
  ok(applied(r, 1) && r.json.versions[0].version === 2 && r.json.versions[0].deleted === true, 'API : suppression logique confirmée (version + 1, supprimée)', describe(r));
  r = await rest('GET', `accounts?id=eq.${meta.id}&select=id,deleted_at,version`, { token: B.token });
  ok(r.status === 200 && r.json.length === 1 && r.json[0].version === 2 && new Date(r.json[0].deleted_at) > new Date('2020-01-01'),
    'API : ligne supprimée logiquement, horodatée par le serveur, toujours lisible par son propriétaire', describe(r));
  r = await apply(B, [put('accounts', meta, 2)]);
  ok(applied(r, 1) && r.json.versions[0].version === 3 && r.json.versions[0].deleted === false, 'API : réécriture d\'une ligne supprimée = réactivation (version + 1)', describe(r));
  r = await rest('GET', `accounts?id=eq.${meta.id}&select=deleted_at`, { token: B.token });
  ok(r.json?.[0]?.deleted_at === null, 'API : ligne réactivée (deleted_at null)', describe(r));

  // --- Contrôle optimiste de version entre deux « appareils » (R3) --------------
  const shared = account(B.id, { name: 'Partagé' });
  r = await apply(B, [put('accounts', shared)]);
  r = await apply(B, [put('accounts', { ...shared, name: 'Appareil 1' }, 1)]);
  ok(applied(r, 1) && r.json.versions[0].version === 2, 'R3 : première écriture acceptée (version 1 → 2)', describe(r));
  r = await apply(B, [put('accounts', { ...shared, name: 'Appareil 2' }, 1)]);
  const conflict = detail(r)?.conflicts?.[0];
  ok(refused(r, 409, 'version_conflict') && conflict?.expectedVersion === 1 && conflict?.actualVersion === 2 && conflict?.actualDeleted === false,
    'R3 : seconde écriture sur la version périmée refusée (version_conflict, version réelle indiquée)', describe(r));
  r = await rest('GET', `accounts?id=eq.${shared.id}&select=name,version`, { token: B.token });
  ok(r.json?.[0]?.name === 'Appareil 1' && r.json?.[0]?.version === 2, 'R3 : l\'écriture acceptée n\'est pas écrasée', describe(r));
  const race = await Promise.all([
    apply(B, [put('accounts', { ...shared, name: 'Course A' }, 2)]),
    apply(B, [put('accounts', { ...shared, name: 'Course B' }, 2)]),
  ]);
  ok(race.filter((x) => applied(x, 1)).length === 1 && race.filter((x) => refused(x, 409, 'version_conflict')).length === 1,
    'R3 : deux requêtes simultanées sur la même version → exactement une acceptée, une en conflit', race.map(describe).join(' | '));
  r = await rest('GET', `accounts?id=eq.${shared.id}&select=name,version`, { token: B.token });
  ok(r.json?.[0]?.version === 3 && ['Course A', 'Course B'].includes(r.json?.[0]?.name), 'R3 : une seule des deux écritures simultanées est enregistrée (version 3)', describe(r));

  // --- Idempotence et résolution -------------------------------------------------
  const idem = randomUUID();
  const idemOps = [put('accounts', account(B.id, { name: 'Idempotent' }))];
  const first = await apply(B, idemOps, { changesetId: idem });
  const second = await apply(B, idemOps, { changesetId: idem });
  ok(applied(first, 1) && second.status === 200 && second.json?.status === 'replayed' && JSON.stringify(second.json.versions) === JSON.stringify(first.json.versions),
    'idempotence : le même lot rejoué renvoie le résultat d\'origine (replayed), sans nouvelle version', `${describe(first)} | ${describe(second)}`);
  r = await rest('GET', `accounts?name=eq.Idempotent&select=version`, { token: B.token });
  ok(r.json?.length === 1 && r.json[0].version === 1, 'idempotence : le lot rejoué n\'a été appliqué qu\'une fois', describe(r));
  r = await apply(B, [put('accounts', account(B.id))], { changesetId: idem });
  ok(refused(r, 409, 'changeset_id_reused'), 'idempotence : même identifiant, autre contenu → changeset_id_reused', describe(r));
  r = await resolve(B, idem);
  ok(r.status === 200 && r.json?.status === 'replayed', 'résolution : lot appliqué → résultat d\'origine (replayed)', describe(r));
  r = await resolve(A, idem);
  ok(r.status === 200 && r.json?.status === 'abandoned', 'résolution : l\'identifiant de lot de B est inconnu pour A (périmètre utilisateur, aucune fuite)', describe(r));
  const lost = randomUUID();
  r = await resolve(B, lost);
  ok(r.status === 200 && r.json?.status === 'abandoned', 'résolution : lot inconnu → abandonné', describe(r));
  r = await apply(B, [put('accounts', account(B.id))], { changesetId: lost });
  ok(refused(r, 409, 'changeset_abandoned'), 'résolution : un lot abandonné n\'est jamais appliqué ensuite', describe(r));

  // --- Précision des flottants par l'API (PostgREST) ----------------------------
  // Contrôle strict : les nombres JavaScript envoyés dans un lot doivent être RELUS à
  // l'identique (égalité ===, donc mêmes bits IEEE-754). apply_changeset ne renvoie que les
  // versions : la valeur est vérifiée à la lecture. Chaque étape est consignée (CHAIN_JSON) ;
  // scripts/qualify-supabase.sh y ajoute les bits stockés et relus en SQL.
  const bitsOf = (v) => { const buf = Buffer.alloc(8); buf.writeDoubleBE(v); return buf.toString('hex'); };
  const chain = [];
  const probe = async (label, table, column, id, value, write) => {
    const sentJson = JSON.stringify({ [column]: value });
    const w = await write(value);
    const readRaw = await fetch(`${API}/rest/v1/${table}?id=eq.${id}&select=${column}`, { headers: { apikey: ANON, Authorization: `Bearer ${B.token}` } }).then((x) => x.text());
    const readValue = JSON.parse(readRaw)?.[0]?.[column];
    chain.push({ label, table, column, id, value_js: String(value), bits_js: bitsOf(value), sent_json: sentJson,
      write_status: w.status, write_raw: JSON.stringify(w.json), write_returns_value: false, write_value: null, write_bits: null,
      read_raw: readRaw, read_value: String(readValue), read_bits: typeof readValue === 'number' ? bitsOf(readValue) : null });
    return { w, readRaw, readValue };
  };
  const exact = [
    ['taux 0.1 + 0.2', 0.1 + 0.2],
    ['taux 1/3', 1 / 3],
    ['taux 10.86', 10.86],
  ];
  for (const [label, value] of exact) {
    const id = randomUUID();
    const p = await probe(label, 'exchange_rates', 'rate', id, value, (v) =>
      apply(B, [put('exchange_rates', { id, user_id: B.id, base: 'USD', quote: 'MAD', rate: v, date: '2026-03-02', source: 'manual', created_at: TS })]));
    ok(applied(p.w, 1), `API ${label} : écriture par lot appliquée`, describe(p.w));
    ok(p.readValue === value, `API ${label} : valeur relue identique (${value})`, `réponse brute ${p.readRaw}`);
  }
  const rateValue = 4.123456789012345;
  r = await rest('GET', `debts?id=eq.${b.debt}&select=*`, { token: B.token });
  const debtNow = r.json[0];
  const pd = await probe("taux d'intérêt", 'debts', 'interest_rate', b.debt, rateValue, (v) =>
    apply(B, [put('debts', { ...writeRow('debts', debtNow), interest_rate: v }, debtNow.version)]));
  ok(applied(pd.w, 1), 'API taux d\'intérêt : écriture par lot appliquée', describe(pd.w));
  ok(pd.readValue === rateValue, `API taux d'intérêt : valeur relue identique (${rateValue})`, `réponse brute ${pd.readRaw}`);
  if (process.env.CHAIN_JSON) writeFileSync(process.env.CHAIN_JSON, JSON.stringify(chain, null, 2));

  // --- Limites du protocole et de la plateforme (D4-6, D4-12, P13) --------------
  const many = (n) => Array.from({ length: n }, (_, i) => put('exchange_rates', { id: randomUUID(), user_id: B.id, base: 'USD', quote: 'MAD', rate: 9 + i / 1000, date: '2026-04-01', source: 'manual', created_at: TS }));
  let t0 = Date.now();
  r = await apply(B, many(1000));
  ok(applied(r, 1000), 'limites : lot de 1 000 opérations appliqué par l\'API', `${describe(r).slice(0, 80)} — ${Date.now() - t0} ms`);
  ok(true, 'CONSTAT durée d\'un lot de 1 000 opérations par l\'API', `${Date.now() - t0} ms`);
  const big = many(5000);
  t0 = Date.now();
  r = await apply(B, big);
  ok(true, 'CONSTAT lot de 5 000 opérations (taille maximale) par l\'API', `HTTP ${r.status} ${r.json?.status ?? proto(r) ?? code(r) ?? ''} — ${(JSON.stringify(big).length / 1048576).toFixed(2)} Mio — ${Date.now() - t0} ms`);
  ok(applied(r, 5000) || r.status >= 400, 'limites : lot de 5 000 opérations appliqué en entier ou refusé en entier', describe(r).slice(0, 200));
  r = await rest('GET', 'exchange_rates?select=id&date=eq.2026-04-01&limit=1', { token: B.token });
  ok(r.status === 200 && r.json.length === 1, 'limites : lecture possible après les gros lots', describe(r));
  r = await apply(B, many(5001));
  ok(refused(r, 413, 'changeset_too_large'), 'limites : plus de 5 000 opérations → changeset_too_large (HTTP 413)', describe(r));
  const huge = account(B.id, { description: 'x'.repeat(4 * 1048576 + 1024) });
  r = await apply(B, [put('accounts', huge)]);
  ok(r.status >= 400, 'limites : lot de plus de 4 Mio refusé', describe(r).slice(0, 200));
  ok(true, 'CONSTAT refus d\'un lot de plus de 4 Mio (fonction : 413 changeset_too_large ; sinon limite de la passerelle)', `HTTP ${r.status} ${proto(r) ?? code(r) ?? ''}`);
  r = await rest('GET', `accounts?id=eq.${huge.id}&select=id`, { token: B.token });
  ok(r.status === 200 && r.json.length === 0, 'limites : rien n\'est écrit par un lot trop volumineux', describe(r));

  // --- Rôle anonyme, fonctions privées, jeton falsifié, GraphQL ----------------
  r = await rest('GET', 'accounts?select=id');
  ok(r.status >= 400 && code(r) === '42501', 'anon (clé publique sans session) : lecture refusée', describe(r));
  r = await rest('POST', 'accounts', { body: account(A.id) });
  ok(r.status >= 400, 'anon : écriture directe refusée', describe(r));
  r = await call('POST', '/rest/v1/rpc/apply_changeset', { body: { p_changeset: lot(A.id, [put('accounts', account(A.id))]) } });
  ok(r.status >= 400 && r.status !== 404 && code(r) === '42501', 'anon : apply_changeset refusé (privilège)', describe(r));
  r = await call('POST', '/rest/v1/rpc/resolve_changeset', { body: { p_changeset_id: randomUUID() } });
  ok(r.status >= 400 && r.status !== 404 && code(r) === '42501', 'anon : resolve_changeset refusé (privilège)', describe(r));
  for (const fn of ['handle_new_user', 'tg_sync_metadata', 'request_uid', 'changeset_error']) {
    r = await call('POST', `/rest/v1/rpc/${fn}`, { token: A.token, body: {} });
    ok(r.status === 404, `fonction privée ${fn} non exposée par l'API`, describe(r));
  }
  const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), sub: B.id })).toString('base64url');
  const forged = `${parts[0]}.${forgedPayload}.${parts[2]}`;
  r = await rest('GET', 'accounts?select=id', { token: forged });
  ok(r.status === 401, 'jeton modifié (sub remplacé, signature invalide) : lecture refusée', describe(r));
  r = await call('POST', '/rest/v1/rpc/apply_changeset', { token: forged, body: { p_changeset: lot(B.id, [put('accounts', account(B.id))]) } });
  ok(r.status === 401, 'jeton modifié (sub remplacé, signature invalide) : écriture refusée', describe(r));
  const gql = async (token, query) => call('POST', '/graphql/v1', { token, body: { query } });
  r = await gql(null, '{ __schema { queryType { fields { name } } } }');
  if (r.status === 404) {
    ok(true, 'CONSTAT GraphQL non exposé par cette pile', describe(r));
  } else {
    const fields = (r.json?.data?.__schema?.queryType?.fields ?? []).map((f) => f.name);
    ok(!fields.some((f) => /accounts|transactions|budgets/i.test(f)), 'GraphQL (anon) : aucune table NEXORA exposée', fields.join(', '));
    r = await gql(B.token, '{ accountsCollection { edges { node { userId } } } }');
    const nodes = r.json?.data?.accountsCollection?.edges ?? null;
    ok(nodes === null || nodes.every((e) => e.node.userId === B.id), 'GraphQL (B) : uniquement ses propres comptes', describe(r));
    r = await gql(B.token, '{ __schema { mutationType { fields { name } } } }');
    const mutations = (r.json?.data?.__schema?.mutationType?.fields ?? []).map((f) => f.name);
    ok(!mutations.some((f) => /^(insertInto|update|deleteFrom)/.test(f)), 'GraphQL (B) : aucune mutation d\'écriture directe sur les tables', mutations.join(', ') || 'aucune mutation');
    ok(true, 'CONSTAT mutations GraphQL exposées à un utilisateur authentifié', mutations.join(', ') || 'aucune');
  }

  // --- M9 (migration 9, V4.1) : récupération des changements /rpc/pull_changes ----
  // Sous l'identité de chaque utilisateur (jeton GoTrue réel) ; RLS de la plateforme.
  const pull = (u, args) => call('POST', '/rest/v1/rpc/pull_changes', { token: u?.token, body: args });
  const owner = (e) => e.row.user_id ?? e.row.id;
  const sortKey = (e) => (e.table === 'user_settings' ? e.key.user_id : e.table === 'recurring_occurrences' ? `${e.key.rule_id}|${e.key.due_date}` : e.key.id);
  const before = (x, y) => {
    const a = BigInt(x.row.sync_txid), b = BigInt(y.row.sync_txid);
    if (a !== b) return a < b;
    if (x.table !== y.table) return Buffer.compare(Buffer.from(x.table), Buffer.from(y.table)) < 0;
    return Buffer.compare(Buffer.from(sortKey(x)), Buffer.from(sortKey(y))) < 0;
  };
  /** Toutes les pages d'un intervalle [cursor, borne). */
  async function pullAll(u, cursor, limit) {
    let bound = null, after = null, pages = 0, stable = true;
    const rows = [];
    for (;;) {
      const res = await pull(u, { p_cursor: cursor, p_bound: bound, p_after: after, p_limit: limit });
      if (res.status !== 200) throw new Error(`pull_changes : ${describe(res)}`);
      if (bound !== null && res.json.bound !== bound) stable = false;
      bound = res.json.bound;
      rows.push(...res.json.rows);
      pages++;
      after = res.json.next;
      if (after === null) break;
      if (pages > 100000) throw new Error('pagination sans fin');
    }
    return { bound, rows, pages, stable };
  }
  const fullA = await pullAll(A, '0', 1000);
  ok(typeof fullA.bound === 'string' && /^\d+$/.test(fullA.bound), 'M9 A : borne renvoyée en texte (xid8)', fullA.bound);
  ok(new Set(fullA.rows.map((e) => e.table)).size === 18, 'M9 A : les 18 tables récupérées', [...new Set(fullA.rows.map((e) => e.table))].join(', '));
  ok(fullA.rows.every((e) => owner(e) === A.id), 'M9 A : uniquement ses propres lignes (aucune de B)');
  ok(fullA.rows.every((e) => typeof e.row.sync_txid === 'string' && BigInt(e.row.sync_txid) < BigInt(fullA.bound)), 'M9 A : sync_txid en texte, toujours < borne');
  const nowA = await snapshot(A);
  ok(Object.keys(SPEC).every((t) => fullA.rows.filter((e) => e.table === t).length === nowA[t].length), 'M9 A : récupération = lecture REST, table par table');
  ok(fullA.rows.every((e, i) => i === 0 || before(fullA.rows[i - 1], e)), 'M9 A : ordre strict (sync_txid, table, clé)');
  const fullB = await pullAll(B, '0', 1000);
  ok(fullB.rows.length > 0 && fullB.rows.every((e) => owner(e) === B.id), 'M9 B : uniquement ses propres lignes (aucune de A)');
  // V4.2 (décision D1) : les VALEURS renvoyées par pull_changes (to_jsonb dans la fonction) sont
  // identiques à celles de la lecture REST (sérialisation PostgREST), colonne par colonne, sur les
  // 18 tables — flottants (migration 7), dates, horodatages, tableaux et métadonnées compris.
  // Lecture REST COMPLÈTE (pages de 1 000, tri sur la clé) : une seule requête serait plafonnée
  // par la pile (max_rows), ce qui fausserait la comparaison pour B (plus de 6 000 taux).
  const norm = (x) => JSON.stringify(x, Object.keys(x).sort());
  async function restAll(u, t) {
    const order = SPEC[t].key.map((c) => `${c}.asc`).join(',');
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const res = await rest('GET', `${t}?select=*&order=${order}&offset=${offset}&limit=1000`, { token: u.token });
      if (res.status !== 200) throw new Error(`lecture complète ${t} : ${describe(res)}`);
      out.push(...res.json);
      if (res.json.length < 1000) return out;
    }
  }
  async function valueGaps(u, full) {
    const gaps = [];
    for (const t of Object.keys(SPEC)) {
      const fromPull = full.rows.filter((e) => e.table === t).map((e) => norm(e.row)).sort();
      const fromRest = (await restAll(u, t)).map(norm).sort();
      if (JSON.stringify(fromPull) !== JSON.stringify(fromRest)) gaps.push(`${t} (${fromPull.length} / ${fromRest.length})`);
    }
    return gaps;
  }
  const gapsA = await valueGaps(A, fullA);
  ok(gapsA.length === 0, 'M9 A : valeurs récupérées identiques à la lecture REST (18 tables, toutes colonnes)', gapsA.join(', ') || 'aucun écart');
  const gapsB = await valueGaps(B, fullB);
  ok(gapsB.length === 0, 'M9 B : valeurs récupérées identiques à la lecture REST (18 tables, toutes colonnes)', gapsB.join(', ') || `aucun écart (${fullB.rows.length} lignes)`);
  const pulledRates = fullB.rows.filter((e) => e.table === 'exchange_rates').map((e) => e.row.rate);
  ok(exact.every(([, v]) => pulledRates.includes(v)), 'M9 B : flottants exacts dans pull_changes (0.1 + 0.2, 1/3, 10.86)', exact.map(([l, v]) => `${l}=${pulledRates.includes(v)}`).join(' ; '));
  const pulledDebt = fullB.rows.find((e) => e.table === 'debts' && e.key.id === b.debt);
  ok(pulledDebt?.row.interest_rate === rateValue, `M9 B : taux d'intérêt exact dans pull_changes (${rateValue})`, String(pulledDebt?.row.interest_rate));
  const pagedB = await pullAll(B, '0', 97);
  ok(pagedB.pages > 1 && pagedB.stable, 'M9 B : pagination par 97 (plusieurs pages, borne constante)', `${fullB.rows.length} lignes, ${pagedB.pages} pages`);
  const sig = (rows) => rows.map((e) => `${e.table}:${sortKey(e)}:${e.row.version}`).join(',');
  ok(sig(pagedB.rows) === sig(fullB.rows), 'M9 B : pages de 97 = pages de 1 000 (mêmes lignes, même ordre, aucune en double)');
  // Changements de B (écrits par le protocole), puis récupération incrémentale depuis la borne.
  const extra = account(B.id, { name: 'M9 nouvelle' });
  const victim = beforeB.budgets[0];
  const vVictim = (await rest('GET', `budgets?select=version&id=eq.${victim.id}`, { token: B.token })).json[0].version;
  r = await apply(B, [put('accounts', extra), del('budgets', victim, vVictim)]);
  ok(applied(r, 2), 'M9 B : lot de changements (création + suppression) appliqué', describe(r));
  const incB = await pullAll(B, fullB.bound, 1000);
  ok(incB.rows.length === 2 && incB.rows.some((e) => e.table === 'accounts' && e.key.id === extra.id && e.row.deleted_at === null)
     && incB.rows.some((e) => e.table === 'budgets' && e.key.id === victim.id && e.row.deleted_at !== null),
    'M9 B : récupération incrémentale = exactement la création et la suppression (deleted_at renseigné)', `${incB.rows.length} lignes`);
  ok(BigInt(incB.bound) >= BigInt(fullB.bound), 'M9 B : la borne ne recule pas');
  const incA = await pullAll(A, fullA.bound, 1000);
  ok(incA.rows.length === 0, 'M9 A : les changements de B n\'apparaissent pas dans la récupération de A', `${incA.rows.length} lignes`);
  // Refus.
  r = await pull(null, { p_cursor: '0' });
  ok(r.status >= 400 && r.status !== 404 && code(r) === '42501', 'M9 anon : pull_changes refusé (privilège)', describe(r));
  r = await pull({ token: forged }, { p_cursor: '0' });
  ok(r.status === 401, 'M9 jeton modifié (sub remplacé, signature invalide) : récupération refusée', describe(r));
  r = await pull(A, { p_cursor: 'abc' });
  ok(refused(r, 400, 'invalid_pull'), 'M9 curseur invalide : 400 invalid_pull', describe(r));
  r = await pull(A, { p_cursor: '0', p_limit: 1001 });
  ok(refused(r, 400, 'invalid_pull'), 'M9 limite > 1 000 : 400 invalid_pull', describe(r));
  r = await pull(A, { p_cursor: '0', p_bound: String(BigInt(fullA.bound) + 1000000n) });
  ok(refused(r, 400, 'invalid_pull'), 'M9 borne future : 400 invalid_pull', describe(r));

  // --- Contrôle final : les lignes de A n'ont jamais bougé -----------------------
  ok(JSON.stringify(await snapshot(A)) === JSON.stringify(beforeA), 'fin de suite : lignes de A strictement inchangées (18 tables, versions comprises)');
}

main()
  .catch((e) => ok(false, 'exécution de la suite HTTP', e.stack || e.message))
  .finally(() => {
    const failed = results.filter((x) => !x.ok).length;
    if (OUT) writeFileSync(OUT, JSON.stringify({ server_version: 'Supabase API (PostgREST/GoTrue)', results }, null, 2));
    console.log(`Bilan HTTP : ${results.length} assertions, ${failed} échec(s)`);
    process.exitCode = failed ? 1 : 0;
  });
