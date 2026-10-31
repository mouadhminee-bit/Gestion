#!/usr/bin/env node
// =============================================================================
// Qualification HTTP (étape 3b) : RLS et privilèges via la VRAIE pile Supabase locale,
// avec DEUX utilisateurs réellement authentifiés (inscription GoTrue, jetons JWT signés par
// GoTrue, appels PostgREST via Kong).
//
// Données entièrement fictives (@example.test). Aucune dépendance (Node ≥ 22, fetch).
// Lancé par scripts/qualify-supabase.sh — REFUSE toute cible autre que la pile locale.
//
// Variables : SUPABASE_API_URL (doit être http://127.0.0.1:54321), SUPABASE_ANON_KEY,
//             RESULTS_JSON (fichier de sortie).
// =============================================================================
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

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
// Jeu de données fictif complet d'un utilisateur, créé PAR L'API (ses propres droits)
// ---------------------------------------------------------------------------
const TS = '2026-10-31T12:00:00.000Z';
async function seed(u) {
  const id = () => randomUUID();
  const ids = { acc: id(), acc2: id(), cat: id(), sub: id(), imp: id(), rule: id(), goal: id(), bud: id(), tx: id(), debt: id(), pay: id(), debtTx: id(), contrib: id(), asset: id(), val: id(), rate: id(), att: id() };
  const U = { user_id: u.id };
  const steps = [
    ['user_settings', { ...U, display_name: 'Test', base_currency: 'MAD', language: 'fr', locale: 'fr-MA', time_zone: 'Africa/Casablanca', date_format: 'DD/MM/YYYY', week_starts_on: 1, theme: 'dark', currency_display: 'symbol', privacy_mode: false, budget_alert_thresholds: [50, 75, 90, 100], notify_budgets: true, notify_bills: true, notify_debts: true, bill_reminder_days: 7, onboarded: true, demo_mode: false, updated_at: TS }],
    ['accounts', [
      { ...U, id: ids.acc, name: 'Banque', type: 'bank', currency: 'MAD', initial_balance: 500000, initial_balance_date: '2026-03-01', archived: false, include_in_total: true, color: '#fff', sort_order: 0, created_at: TS, updated_at: TS },
      { ...U, id: ids.acc2, name: 'Épargne', type: 'savings', currency: 'MAD', initial_balance: 0, initial_balance_date: '2026-03-01', archived: false, include_in_total: true, color: '#fff', sort_order: 1, created_at: TS, updated_at: TS }]],
    ['categories', { ...U, id: ids.cat, key: 'food', name: 'Alimentation', kind: 'expense', nature: 'variable', parent_id: null, icon: 'X', color: '#000', archived: false, sort_order: 0, created_at: TS, updated_at: TS }],
    ['categories', { ...U, id: ids.sub, key: null, name: 'Marché', kind: 'expense', nature: 'variable', parent_id: ids.cat, icon: 'X', color: '#000', archived: false, sort_order: 1, created_at: TS, updated_at: TS }],
    ['import_batches', { ...U, id: ids.imp, file_name: 'releve.csv', account_id: ids.acc, row_count: 1, imported_count: 1, skipped_count: 0, created_at: TS }],
    ['recurring_rules', { ...U, id: ids.rule, kind: 'expense', label: 'Loyer', amount: 280000, currency: 'MAD', account_id: ids.acc, category_id: ids.cat, subcategory_id: ids.sub, frequency: 'monthly', start_date: '2026-03-03', active: true, created_at: TS, updated_at: TS }],
    ['savings_goals', { ...U, id: ids.goal, name: 'Voyage', target_amount: 100000, currency: 'MAD', saved_amount: 0, priority: 'medium', linked_account_id: ids.acc2, track_linked_account: false, status: 'active', icon: 'X', color: '#fff', created_at: TS, updated_at: TS }],
    ['budgets', { ...U, id: ids.bud, month: '2026-03', category_id: ids.cat, amount: 160000, currency: 'MAD', created_at: TS, updated_at: TS }],
    ['transactions', { ...U, id: ids.tx, type: 'expense', direction: 'out', amount: 10000, currency: 'MAD', label: 'Test', date: '2026-03-10', category_id: ids.cat, subcategory_id: ids.sub, account_id: ids.acc, tags: [], status: 'cleared', recurring_rule_id: ids.rule, recurring_due_date: '2026-03-03', import_batch_id: ids.imp, created_at: TS, updated_at: TS }],
    ['debts', { ...U, id: ids.debt, label: 'Crédit', type: 'loan', direction: 'payable', principal: 1000000, currency: 'MAD', start_date: '2026-03-01', interest_rate: 4.5, status: 'active', created_at: TS, updated_at: TS }],
    ['debt_payments', { ...U, id: ids.pay, debt_id: ids.debt, date: '2026-03-15', principal: 100000, interest: 5000, account_id: ids.acc, created_at: TS }],
    ['transactions', { ...U, id: ids.debtTx, type: 'debt', direction: 'out', amount: 105000, currency: 'MAD', label: 'Remboursement', date: '2026-03-15', account_id: ids.acc, tags: [], status: 'cleared', debt_id: ids.debt, debt_payment_id: ids.pay, interest_amount: 5000, created_at: TS, updated_at: TS }],
    ['goal_contributions', { ...U, id: ids.contrib, goal_id: ids.goal, date: '2026-03-10', amount: 100, created_at: TS }],
    ['recurring_occurrences', { ...U, rule_id: ids.rule, due_date: '2026-03-03', status: 'paid', transaction_id: ids.tx, updated_at: TS }],
    ['assets', { ...U, id: ids.asset, name: 'Portefeuille', type: 'investment', currency: 'MAD', linked_account_id: ids.acc2, archived: false, created_at: TS, updated_at: TS }],
    ['asset_valuations', { ...U, id: ids.val, asset_id: ids.asset, date: '2026-03-01', value: 70000, source: 'manual', created_at: TS }],
    ['exchange_rates', { ...U, id: ids.rate, base: 'EUR', quote: 'MAD', rate: 10.86, date: '2026-03-01', source: 'manual', created_at: TS }],
    ['attachments', { ...U, id: ids.att, name: 'recu.png', mime_type: 'image/png', size: 3, created_at: TS }],
    ['notification_states', { ...U, id: 'budget:x:2026-03:90', read: true, dismissed: false, updated_at: TS }],
  ];
  for (const [table, body] of steps) {
    const r = await rest('POST', table, { token: u.token, body, prefer: 'return=minimal' });
    if (r.status !== 201) throw new Error(`création ${table} pour ${u.email} : ${describe(r)}`);
  }
  // Références circulaires complétées après coup (chaque requête PostgREST = une transaction)
  for (const [table, filter, body] of [
    ['debt_payments', `id=eq.${ids.pay}`, { transaction_id: ids.debtTx }],
    ['debts', `id=eq.${ids.debt}`, { origin_transaction_id: ids.debtTx }],
    ['transactions', `id=eq.${ids.tx}`, { attachment_id: ids.att, refund_of_id: ids.tx }],
  ]) {
    const r = await call('PATCH', `/rest/v1/${table}?${filter}`, { token: u.token, body, prefer: 'return=minimal' });
    if (r.status !== 204) throw new Error(`liaison ${table} : ${describe(r)}`);
  }
  return ids;
}

const TABLES = ['user_settings', 'accounts', 'categories', 'import_batches', 'transactions', 'attachments', 'budgets', 'savings_goals', 'goal_contributions', 'recurring_rules', 'recurring_occurrences', 'debts', 'debt_payments', 'assets', 'asset_valuations', 'exchange_rates', 'notification_states'];

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
  ok(r.status === 200 && r.json.length === 0, 'A ne peut pas renommer le profil de B', describe(r));

  // --- Données des deux utilisateurs ------------------------------------------
  const a = await seed(A);
  const b = await seed(B);
  ok(true, 'jeu de données complet créé par chaque utilisateur via l\'API (18 tables)');

  // --- Matrice d'isolation par table ------------------------------------------
  for (const t of TABLES) {
    r = await rest('GET', `${t}?select=user_id`, { token: B.token });
    ok(r.status === 200 && r.json.length > 0 && r.json.every((x) => x.user_id === B.id), `${t} : B ne lit que ses propres lignes`, describe(r));
    r = await rest('GET', `${t}?select=user_id&user_id=eq.${A.id}`, { token: B.token });
    ok(r.status === 200 && r.json.length === 0, `${t} : filtrer sur A ne renvoie rien à B`, describe(r));
    r = await rest('PATCH', `${t}?user_id=eq.${A.id}`, { token: B.token, body: { deleted_at: new Date().toISOString() }, prefer: 'return=representation' });
    ok(r.status === 200 && r.json.length === 0, `${t} : B ne modifie aucune ligne de A`, describe(r));
    r = await rest('DELETE', `${t}?user_id=eq.${A.id}`, { token: B.token });
    ok(r.status >= 400 && code(r) === '42501', `${t} : DELETE refusé (privilège)`, describe(r));
    r = await rest('DELETE', `${t}?user_id=eq.${B.id}`, { token: B.token });
    ok(r.status >= 400 && code(r) === '42501', `${t} : DELETE refusé même sur ses lignes`, describe(r));
    r = await rest('PATCH', `${t}?user_id=eq.${B.id}`, { token: B.token, body: { user_id: A.id } });
    ok(r.status >= 400 && code(r) === '42501', `${t} : B ne peut pas transférer ses lignes à A`, describe(r));
  }
  // Lignes de A intactes (vérifiées par A)
  r = await rest('GET', 'accounts?select=deleted_at,user_id', { token: A.token });
  ok(r.status === 200 && r.json.length === 2 && r.json.every((x) => x.deleted_at === null), 'lignes de A intactes après les tentatives de B', describe(r));

  // --- Insertion au nom d'autrui, upsert, références croisées -----------------
  const acc = (u, extra = {}) => ({ id: randomUUID(), user_id: u, name: 'X', type: 'bank', currency: 'MAD', initial_balance: 0, initial_balance_date: '2026-03-01', archived: false, include_in_total: true, color: '#fff', sort_order: 0, created_at: TS, updated_at: TS, ...extra });
  r = await rest('POST', 'accounts', { token: B.token, body: acc(A.id) });
  ok(r.status === 403 && code(r) === '42501', 'B ne peut pas insérer une ligne au nom de A (RLS with check)', describe(r));
  r = await rest('POST', 'accounts', { token: B.token, body: acc(B.id, { id: a.acc }), prefer: 'resolution=merge-duplicates,return=representation' });
  ok(r.status >= 400, 'upsert de B sur l\'identifiant d\'un compte de A : refusé', describe(r));
  r = await rest('GET', `accounts?id=eq.${a.acc}&select=user_id,name,version`, { token: A.token });
  ok(r.json?.[0]?.user_id === A.id && r.json?.[0]?.name === 'Banque', 'compte de A inchangé après l\'upsert de B', describe(r));
  const tx = (u, extra = {}) => ({ id: randomUUID(), user_id: u, type: 'income', direction: 'in', amount: 100, currency: 'MAD', label: 'X', date: '2026-03-01', account_id: b.acc, tags: [], status: 'cleared', created_at: TS, updated_at: TS, ...extra });
  const crossRefs = [
    ['transactions', tx(B.id, { account_id: a.acc }), 'compte de A'],
    ['transactions', tx(B.id, { category_id: a.cat }), 'catégorie de A'],
    ['transactions', tx(B.id, { debt_id: a.debt, type: 'debt', interest_amount: 0 }), 'dette de A'],
    ['goal_contributions', { id: randomUUID(), user_id: B.id, goal_id: a.goal, date: '2026-03-01', amount: 1, created_at: TS }, 'objectif de A'],
    ['asset_valuations', { id: randomUUID(), user_id: B.id, asset_id: a.asset, date: '2026-03-01', value: 1, source: 'manual', created_at: TS }, 'actif de A'],
    ['recurring_occurrences', { user_id: B.id, rule_id: a.rule, due_date: '2026-04-03', status: 'skipped', updated_at: TS }, 'règle récurrente de A'],
  ];
  for (const [table, body, what] of crossRefs) {
    r = await rest('POST', table, { token: B.token, body });
    ok(r.status === 409 && code(r) === '23503', `${table} : B ne peut pas référencer ${what} (clé composite)`, describe(r));
  }
  r = await rest('POST', 'transactions', { token: B.token, body: tx(B.id, { category_id: b.cat }) });
  ok(r.status === 201, 'contrôle positif : B référence sa propre catégorie', describe(r));

  // --- Contraintes différées remontées par PostgREST (Q6) ----------------------
  r = await rest('POST', 'transactions', { token: B.token, body: tx(B.id, { type: 'debt', debt_id: randomUUID(), interest_amount: 0 }) });
  ok(r.status === 409 && code(r) === '23503', 'Q6 référence pendante : erreur différée (23503) renvoyée à la validation', describe(r));
  const debtId = randomUUID();
  const originId = randomUUID();
  r = await rest('POST', 'transactions', { token: B.token, body: tx(B.id, { id: originId, type: 'debt', debt_id: debtId, interest_amount: 0 }) });
  ok(r.status === 409, 'dette ↔ transaction en deux requêtes séparées : la première est refusée (chaque requête est une transaction)', describe(r));
  r = await rest('POST', 'budgets', { token: B.token, body: { id: randomUUID(), user_id: B.id, month: '2026-03', category_id: b.cat, amount: 1, currency: 'MAD', created_at: TS, updated_at: TS } });
  ok(r.status >= 400 && code(r) === '23P01', 'unicité différée (budget en double) renvoyée par PostgREST', describe(r));

  // --- Métadonnées serveur via l'API ------------------------------------------
  r = await rest('POST', 'accounts', { token: B.token, body: acc(B.id, { version: 999, sync_txid: '1', server_updated_at: '2000-01-01T00:00:00Z', created_at: '2020-01-02T03:04:05.678Z' }), prefer: 'return=representation' });
  const row = r.json?.[0];
  ok(r.status === 201 && row?.version === 1, 'API : version imposée par le serveur (999 ignoré)', describe(r));
  ok(row && row.sync_txid !== '1' && new Date(row.server_updated_at) > new Date('2020-01-01'), 'API : sync_txid et server_updated_at imposés par le serveur', describe(r));
  ok(row && new Date(row.created_at).toISOString() === '2020-01-02T03:04:05.678Z', 'API : created_at métier du client conservé à la milliseconde', row?.created_at);
  r = await call('PATCH', `/rest/v1/accounts?id=eq.${row?.id}`, { token: B.token, body: { deleted_at: '2000-01-01T00:00:00Z' }, prefer: 'return=representation' });
  ok(r.status === 200 && r.json[0]?.version === 2 && new Date(r.json[0].deleted_at) > new Date('2020-01-01'), 'API : suppression logique horodatée par le serveur, version + 1', describe(r));
  r = await rest('GET', `accounts?id=eq.${row?.id}&select=id`, { token: B.token });
  ok(r.status === 200 && r.json.length === 1, 'API : ligne supprimée logiquement toujours lisible par son propriétaire', describe(r));

  // --- Rôle anonyme, fonctions privées, jeton falsifié, GraphQL ----------------
  r = await rest('GET', 'accounts?select=id');
  ok(r.status >= 400 && code(r) === '42501', 'anon (clé publique sans session) : lecture refusée', describe(r));
  r = await rest('POST', 'accounts', { body: acc(A.id) });
  ok(r.status >= 400, 'anon : écriture refusée', describe(r));
  r = await call('POST', '/rest/v1/rpc/handle_new_user', { token: A.token, body: {} });
  ok(r.status === 404, 'fonction privée handle_new_user non exposée par l\'API', describe(r));
  r = await call('POST', '/rest/v1/rpc/tg_sync_metadata', { token: A.token, body: {} });
  ok(r.status === 404, 'fonction privée tg_sync_metadata non exposée par l\'API', describe(r));
  const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), sub: B.id })).toString('base64url');
  r = await rest('GET', 'accounts?select=id', { token: `${parts[0]}.${forgedPayload}.${parts[2]}` });
  ok(r.status === 401, 'jeton modifié (sub remplacé, signature invalide) : refusé', describe(r));
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
  }
}

main()
  .catch((e) => ok(false, 'exécution de la suite HTTP', e.stack || e.message))
  .finally(() => {
    const failed = results.filter((x) => !x.ok).length;
    if (OUT) writeFileSync(OUT, JSON.stringify({ server_version: 'Supabase API (PostgREST/GoTrue)', results }, null, 2));
    console.log(`Bilan HTTP : ${results.length} assertions, ${failed} échec(s)`);
    process.exitCode = failed ? 1 : 0;
  });
