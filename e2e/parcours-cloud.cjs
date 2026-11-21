/**
 * V3.7 — Parcours Cloud de référence (Plan directeur V1, § 5), étapes 1 à 8, et étape 9 en option,
 * dans un vrai navigateur, contre un projet Supabase de DÉVELOPPEMENT.
 *
 *  1. création de compte (écran d'inscription, flux PKCE) ;
 *  2. confirmation de l'e-mail (boîte sandbox Mailtrap, API en lecture seule ; échange du code PKCE) ;
 *  3. connexion (mot de passe) ;
 *  4. espace personnel : chargement initial puis onboarding (premier lot = paramètres + catégories) ;
 *  5–6. création de données → stockées dans le Cloud (apply_changeset), vérifiées sur le serveur ;
 *  7. rechargement : instantané identique (hors horodatages) ;
 *  8. second appareil (contexte de navigateur indépendant) : connexion + chargement complet ;
 *  9. (si PARCOURS_B_CRED) isolation : déconnexion de A (cache supprimé), connexion de B dans le
 *     même navigateur, aucune donnée de A visible (interface et API, 18 tables), écriture de B sur
 *     une clé de A refusée.
 *
 * Aucun secret dans ce fichier : tout est lu dans l'environnement. Rien n'est affiché qui
 * contienne un jeton, un mot de passe ou une adresse e-mail.
 *
 * Usage :
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=… \
 *   MAILTRAP_API_TOKEN=… MAILTRAP_ACCOUNT_ID=… MAILTRAP_INBOX_ID=… \
 *   PARCOURS_RUN=1 PARCOURS_OUT=/chemin/hors/depot [PARCOURS_B_CRED=/chemin/compte-b.env] \
 *   BASE_URL=http://localhost:5173 node e2e/parcours-cloud.cjs
 * (application servie en mode Cloud : build avec VITE_DATA_BACKEND=supabase.)
 *
 * Garde-fou réseau (avant envoi) : 1 inscription au plus, 7 apply_changeset au plus (plafond fixe), resolve_changeset et toute autre écriture BLOQUÉS ; aucune écriture pendant
 * l'étape 9 en dehors de la tentative refusée (envoyée hors navigateur).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const DEV = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
const MT = { token: process.env.MAILTRAP_API_TOKEN, acc: process.env.MAILTRAP_ACCOUNT_ID, inbox: process.env.MAILTRAP_INBOX_ID };
const RUN = process.env.PARCOURS_RUN || '1';
const OUT = process.env.PARCOURS_OUT;
const B_CRED = process.env.PARCOURS_B_CRED || null;
/** Plafond FIXE de lots par compte (4 onboarding + 3 données) : aucune variable ne peut l'augmenter. */
const MAX_LOTS = 7;
for (const [k, v] of Object.entries({ SUPABASE_URL: DEV, SUPABASE_ANON_KEY: KEY, MAILTRAP_API_TOKEN: MT.token, MAILTRAP_ACCOUNT_ID: MT.acc, MAILTRAP_INBOX_ID: MT.inbox, PARCOURS_OUT: OUT })) {
  if (!v) { console.error(`Variable manquante : ${k}`); process.exit(2); }
}

const SQL = { users: 'profiles', settings: 'user_settings', accounts: 'accounts', categories: 'categories', transactions: 'transactions', attachments: 'attachments', importBatches: 'import_batches', budgets: 'budgets', goals: 'savings_goals', goalContributions: 'goal_contributions', recurringRules: 'recurring_rules', occurrences: 'recurring_occurrences', debts: 'debts', debtPayments: 'debt_payments', assets: 'assets', valuations: 'asset_valuations', rates: 'exchange_rates', notificationStates: 'notification_states' };
const T = { toSignup: 'Pas encore de compte ? Créer un compte', signup: 'Créer le compte', login: 'Se connecter', logout: 'Se déconnecter', confirmSent: 'un e-mail de confirmation a été envoyé', onbFresh: 'Commencer avec mes propres données', start: 'Démarrer', settings: 'Paramètres', appError: 'Un problème est survenu', loadError: 'Chargement impossible' };

const out = { run: RUN, date: new Date().toISOString(), base: BASE, controles: [], bloquees: [], lots: [], requetes: [], info: {} };
const ok = (c, m, extra) => { out.controles.push({ ok: !!c, controle: m, ...(extra ? { detail: extra } : {}) }); console.log((c ? 'PASS ' : 'FAIL ') + m + (extra ? ' ' + JSON.stringify(extra) : '')); return !!c; };
class Stop extends Error {}
const must = (c, m, extra) => { if (!ok(c, m, extra)) throw new Stop(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return Date.now() - t0; } catch {} await sleep(150); } return null; }
const text = (p) => p.locator('body').innerText().catch(() => '');
const state = async (p) => { const t = await text(p); if (await p.locator('#auth-email').count()) return 'connexion'; if (t.includes(T.loadError)) return 'erreur-chargement'; if (t.includes(T.appError)) return 'erreur-app'; if (t.includes(T.onbFresh)) return 'accueil'; if (t.includes(T.settings)) return 'application'; return 'chargement'; };
const settled = (p, ms = 30000) => until(async () => ['application', 'accueil', 'connexion', 'erreur-chargement', 'erreur-app'].includes(await state(p)), ms);
const session = (p) => p.evaluate(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^sb-.*-auth-token$/.test(k)) { const v = JSON.parse(localStorage.getItem(k)); return { uid: v.user.id, token: v.access_token, confirmed: !!v.user.email_confirmed_at }; } } return null; });
const dbs = (p) => p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort());
const bal = async (p) => (await p.locator('main').innerText().catch(() => '')).match(/Solde total aujourd’hui[\s\S]*?([\d\s.  ]+,\d{2})\s*DH/)?.[1]?.replace(/[^\d,]/g, '');

/** Contenu du cache (lecture IndexedDB brute) : lignes sans horodatages + versions serveur. */
const cacheDump = (p, uid) => p.evaluate(async ({ name, stores }) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onupgradeneeded = () => { r.transaction.abort(); rej(new Error('cache absent')); }; });
  const get = (s) => new Promise((res) => { const q = db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
  // Hors horodatages (…At). Une propriété facultative de valeur `undefined` (écrite par le client) équivaut
  // à son absence (relue du serveur) : même donnée ; toute valeur définie est comparée strictement.
  const strip = (row) => JSON.stringify(Object.keys(row).filter((k) => !/At$/.test(k) && row[k] !== undefined).sort().map((k) => [k, row[k]]));
  const o = { counts: {}, rows: {}, versions: {} };
  for (const s of stores) { const rows = await get(s); o.counts[s] = rows.length; o.rows[s] = rows.map(strip).sort(); }
  for (const v of await get('serverVersions')) (o.versions[v.table] ??= []).push(`${v.version}:${v.deleted}`);
  for (const k of Object.keys(o.versions)) o.versions[k].sort();
  db.close();
  return o;
}, { name: `nexora-cache-${uid}`, stores: Object.keys(SQL) });

async function rest(token, pathAndQuery, init = {}) {
  const r = await fetch(`${DEV}${pathAndQuery}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  let body = null; try { body = await r.json(); } catch {}
  out.requetes.push({ origine: 'controle', method: init.method || 'GET', path: pathAndQuery.split('?')[0], status: r.status });
  return { status: r.status, body };
}
/** Lecture directe sur le serveur : lignes actives et versions par table, pour `uid`. */
async function direct(token, uid) {
  const o = { counts: {}, versions: {} };
  for (const [t, sql] of Object.entries(SQL)) {
    const owner = t === 'users' ? 'id' : 'user_id';
    const { body } = await rest(token, `/rest/v1/${sql}?select=version,deleted_at&${owner}=eq.${uid}&limit=1000`);
    o.counts[t] = body.filter((x) => x.deleted_at == null).length;
    o.versions[t] = body.map((x) => `${x.version}:${x.deleted_at != null}`).sort();
  }
  return o;
}
/** Tables dont les lignes diffèrent (noms seulement, aucune valeur). */
const rowDiff = (a, b) => Object.keys(SQL).filter((t) => JSON.stringify(a.rows[t]) !== JSON.stringify(b.rows[t]));
const canonVersions = (o) => JSON.stringify(Object.keys(SQL).map((t) => [t, [...(o[t] ?? [])].sort()]));
const mt = async (p, raw) => { const r = await fetch(`https://mailtrap.io/api/accounts/${MT.acc}/inboxes/${MT.inbox}${p}`, { headers: { 'Api-Token': MT.token, Accept: raw ? '*/*' : 'application/json' } }); out.requetes.push({ origine: 'mailtrap', method: 'GET', path: p.replace(/\/messages\/\d+/, '/messages/<id>').split('?')[0], status: r.status }); return { status: r.status, body: raw ? await r.text() : await r.json().catch(() => null) }; };
const readCred = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

async function login(p, email, password) {
  await until(async () => (await state(p)) === 'connexion');
  await p.fill('#auth-email', email);
  await p.fill('#auth-password', password);
  await p.getByRole('button', { name: T.login, exact: true }).click();
  // Le formulaire reste affiché pendant la requête : attendre de quitter l'écran de connexion.
  await until(async () => (await state(p)) !== 'connexion' || (await p.locator('[role="alert"]').count()) > 0, 30000);
  await settled(p);
}
async function logout(p) {
  if ((await state(p)) === 'application') { await p.goto(BASE + '/#/settings'); await until(async () => (await p.getByRole('button', { name: T.logout }).count()) > 0); }
  await p.getByRole('button', { name: T.logout }).first().click();
  await until(async () => (await state(p)) === 'connexion');
}

(async () => {
  const credFile = path.join(OUT, `compte-parcours-${RUN}.env`);
  if (fs.existsSync(credFile)) { console.error(`ARRÊT : le compte de l'exécution ${RUN} existe déjà (une inscription par exécution).`); process.exit(2); }
  const tag = `R${RUN}-${crypto.randomBytes(3).toString('hex')}`;
  const email = `nexora-parcours-${tag.toLowerCase()}@example.com`;
  const password = crypto.randomBytes(18).toString('base64url') + 'Aa1!';
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credFile, `NEXORA_TEST_EMAIL=${email}\nNEXORA_TEST_PASSWORD=${password}\n`, { mode: 0o600 });
  out.info.marqueur = tag;

  const browser = await chromium.launch();
  const errors = [];
  const phase = { signups: 0, lots: 0, isolation: false };
  const lotBodies = [];
  const guard = async (ctx, name) => {
    await ctx.route('**/*', async (route) => {
      const req = route.request(); const u = new URL(req.url()); const m = req.method();
      const local = u.origin === BASE;
      const dev = u.origin === DEV;
      const read = dev && u.pathname.startsWith('/rest/v1/') && !u.pathname.startsWith('/rest/v1/rpc/') && ['GET', 'HEAD'].includes(m);
      const auth = dev && (['/auth/v1/token', '/auth/v1/user', '/auth/v1/logout'].includes(u.pathname) || (u.pathname === '/auth/v1/verify' && m === 'GET'));
      const signup = dev && u.pathname === '/auth/v1/signup' && m === 'POST' && phase.signups === 0 && !phase.isolation;
      const lot = dev && u.pathname === '/rest/v1/rpc/apply_changeset' && m === 'POST' && phase.lots < MAX_LOTS && !phase.isolation;
      if (local || read || auth || m === 'OPTIONS') {
        if (!local) out.requetes.push({ origine: name, method: m, path: u.pathname + (u.pathname === '/auth/v1/token' ? `?grant_type=${u.searchParams.get('grant_type')}` : '') });
        return route.continue();
      }
      if (signup) {
        phase.signups++;
        const body = JSON.parse(req.postData() || '{}');
        out.info.inscription = { redirect_to: u.searchParams.get('redirect_to'), pkce: body.code_challenge_method === 's256' && typeof body.code_challenge === 'string' };
        out.requetes.push({ origine: name, method: m, path: u.pathname });
        return route.continue();
      }
      if (lot) {
        phase.lots++;
        const raw = req.postData() || '';
        const body = JSON.parse(raw);
        const cs = body.p_changeset;
        const ops = (cs.ops || []).map((o) => `${o.type}:${o.table}`);
        lotBodies.push(body);
        const attachmentContent = /"(blob|file|content|data)"\s*:/i.test(raw) || /data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(raw);
        const entry = { n: phase.lots, ops, octets: raw.length, pieceJointe: ops.some((o) => o.endsWith(':attachments')) || attachmentContent };
        out.lots.push(entry);
        out.requetes.push({ origine: name, method: m, path: u.pathname });
        const resp = await route.fetch();
        entry.status = resp.status();
        let rb = null; try { rb = await resp.json(); } catch {}
        entry.resultat = rb && (rb.status || rb.code || null);
        return route.fulfill({ response: resp });
      }
      out.bloquees.push({ origine: name, method: m, url: u.origin + u.pathname });
      return route.abort('blockedbyclient');
    });
  };
  const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR' });
  await guard(ctx1, 'navigateur1');
  const p = await ctx1.newPage();
  p.on('pageerror', (e) => errors.push(`navigateur1: ${e.message}`));
  let code = 1;
  try {
    // 1. Création de compte.
    const before = await mt('/messages?page=1');
    const oldIds = new Set((before.body || []).map((x) => x.id));
    await p.goto(BASE + '/#/settings');
    await until(async () => (await state(p)) === 'connexion');
    must((await state(p)) === 'connexion', '0. sans session : route protégée → écran de connexion');
    await p.getByRole('button', { name: T.toSignup }).click();
    await p.fill('#auth-email', email);
    await p.fill('#auth-password', password);
    await p.getByRole('button', { name: T.signup, exact: true }).click();
    must((await until(async () => (await text(p)).includes(T.confirmSent), 20000)) !== null, '1. inscription : « e-mail de confirmation envoyé » affiché');
    must(phase.signups === 1 && out.info.inscription.pkce, '1. inscription : une seule requête, défi PKCE (S256) envoyé', out.info.inscription);
    must(out.info.inscription.redirect_to === BASE + '/', '1. inscription : adresse de retour = application', { redirect_to: out.info.inscription.redirect_to });
    must(!(await session(p)), '1. aucune session avant confirmation');

    // 2. Confirmation de l'e-mail.
    let msg = null;
    const tMail = await until(async () => { const r = await mt('/messages?page=1'); msg = (r.body || []).find((x) => !oldIds.has(x.id) && (x.to_email || '').toLowerCase() === email); return !!msg; }, 120000);
    must(msg, '2. message de confirmation reçu (sandbox)', { secondes: tMail && Math.round(tMail / 1000) });
    const html = await mt(`/messages/${msg.id}/body.html`, true);
    const link = [...(html.body || '').matchAll(/https?:\/\/[^"'<>\s]+/g)].map((m) => m[0].replace(/&amp;/g, '&')).find((l) => l.startsWith(DEV + '/auth/v1/verify'));
    must(link, '2. lien de confirmation extrait');
    const L = new URL(link);
    must(L.searchParams.get('type') === 'signup' && !!L.searchParams.get('token'), '2. lien : type=signup, jeton présent');
    out.info.jetonPrefixePkce = /^pkce_/.test(L.searchParams.get('token') || '');
    must(new URL(L.searchParams.get('redirect_to')).origin === BASE, '2. lien : retour vers l’application', { redirect_to: L.searchParams.get('redirect_to') });
    const landed = [];
    p.on('framenavigated', (f) => { if (f === p.mainFrame()) { const x = new URL(f.url()); landed.push({ origin: x.origin, code: x.searchParams.has('code'), jetonFragment: /access_token|refresh_token/.test(x.hash) }); } });
    await p.goto(link);
    await settled(p);
    const back = landed.find((x) => x.origin === BASE) || {};
    must(back.code && !back.jetonFragment, '2. retour du lien : ?code= (PKCE), aucun jeton dans l’adresse', back);
    const exch = out.requetes.find((r) => r.path === '/auth/v1/token?grant_type=pkce');
    must(exch, '2. code échangé par le SDK (POST /auth/v1/token?grant_type=pkce)');
    must(!/[?&]code=/.test(p.url()) && !/access_token/.test(p.url()), '2. code retiré de l’adresse après échange');
    const s0 = await session(p);
    must(s0 && s0.confirmed && (await state(p)) === 'accueil', '2. session ouverte, e-mail confirmé, écran d’accueil', { ecran: await state(p) });
    const uid = s0.uid;

    // 3. Connexion (mot de passe), après déconnexion.
    await logout(p);
    await login(p, email, password);
    await settled(p);
    must((await state(p)) === 'accueil' && (await session(p))?.uid === uid, '3. connexion par mot de passe : chargement initial puis écran d’accueil');
    must(out.lots.length === 0, '3. aucune écriture avant l’onboarding');

    // 4. Espace personnel : onboarding.
    await p.getByText(T.onbFresh).click();
    await p.getByPlaceholder('Ex : Sara').fill(`Parcours ${tag}`);
    await p.locator('div:has(> label:text-is("Premier compte")) input').fill(`Courant ${tag}`);
    await p.locator('input[inputmode="decimal"]').fill('1000');
    await p.getByRole('button', { name: T.start }).click();
    must((await until(async () => (await state(p)) === 'application' && (await bal(p)) === '1000,00', 30000)) !== null, '4. onboarding : application affichée, solde 1000,00', { solde: await bal(p) });
    const first = out.lots[0] || {};
    const firstTables = [...new Set((first.ops || []).map((o) => o.split(':')[1]))].sort();
    must(first.status === 200 && firstTables.includes('user_settings') && firstTables.includes('categories') && (first.ops || []).every((o) => /:(profiles|user_settings|categories)$/.test(o)), '4. premier lot = paramètres + catégories, accepté', { tables: firstTables, operations: (first.ops || []).length });
    out.info.lotsOnboarding = out.lots.length;

    // 5–6. Créer des données → stockées dans le Cloud.
    await p.keyboard.press('n');
    await p.getByLabel('Montant').fill('120,50');
    await p.getByRole('button', { name: 'Alimentation' }).first().click();
    await p.getByRole('button', { name: 'Ajouter', exact: true }).click();
    must((await until(async () => (await bal(p)) === '879,50', 20000)) !== null, '5. dépense 120,50 → solde 879,50 affiché après confirmation');
    await p.goto(BASE + '/#/accounts');
    await p.getByRole('button', { name: 'Nouveau compte' }).click();
    await p.getByPlaceholder('Ex : Compte courant').fill(`Épargne ${tag}`);
    await p.getByRole('button', { name: 'Enregistrer' }).click();
    must((await until(async () => (await p.locator('main').innerText()).includes(`Épargne ${tag}`), 20000)) !== null, '5. second compte créé et affiché');
    await p.getByRole('button', { name: 'Transférer' }).first().click();
    await p.getByLabel('Montant').fill('500');
    await p.locator('select').nth(2).selectOption({ label: `Épargne ${tag} · MAD` });
    const lotsBeforeTransfer = out.lots.length;
    await p.getByRole('button', { name: 'Ajouter', exact: true }).click();
    must((await until(async () => out.lots.length > lotsBeforeTransfer && out.lots.every((l) => l.status), 20000)) !== null, '5. transfert : lot envoyé et réponse reçue');
    await p.goto(BASE + '/#/');
    must((await until(async () => (await bal(p)) === '879,50' && /Dépenses du mois[\s\S]*?120,50/.test(await p.locator('main').innerText()), 20000)) !== null, '5. transfert : solde total inchangé (879,50), non compté en dépense');
    must(out.lots.every((l) => l.status === 200 && l.resultat === 'applied'), '6. tous les lots acceptés par le serveur (applied)', { lots: out.lots.length });
    must(out.lots.every((l) => !l.pieceJointe), '6. aucun contenu de pièce jointe dans les échanges');
    const tok = (await session(p)).token;
    const srv = await direct(tok, uid);
    let c1 = await cacheDump(p, uid);
    must(JSON.stringify(c1.counts) === JSON.stringify(srv.counts) && canonVersions(c1.versions) === canonVersions(srv.versions), '6. cache = serveur (lignes et versions, 18 tables)', { lignes: Object.values(srv.counts).reduce((a, b) => a + b, 0), comptes: srv.counts.accounts, transactions: srv.counts.transactions, categories: srv.counts.categories });
    must(srv.counts.accounts === 2 && srv.counts.transactions >= 2 && srv.counts.settings === 1, '6. données attendues présentes sur le serveur (2 comptes, dépense + transfert, paramètres)', { transactions: srv.counts.transactions });

    // 7. Recharger et retrouver la donnée.
    await p.reload();
    await settled(p);
    await until(async () => (await bal(p)) === '879,50', 20000);
    const c2 = await cacheDump(p, uid);
    must((await state(p)) === 'application' && (await bal(p)) === '879,50', '7. rechargement : session restaurée, solde 879,50');
    must(JSON.stringify(c2.rows) === JSON.stringify(c1.rows) && canonVersions(c2.versions) === canonVersions(c1.versions), '7. instantané identique après rechargement (hors horodatages)', { tablesDifferentes: rowDiff(c1, c2) });

    // 8. Second appareil : contexte indépendant.
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR' });
    await guard(ctx2, 'navigateur2');
    const q = await ctx2.newPage();
    q.on('pageerror', (e) => errors.push(`navigateur2: ${e.message}`));
    await q.goto(BASE + '/');
    must((await dbs(q)).length === 0 && !(await session(q)), '8. second appareil : aucun stockage partagé avec le premier');
    await login(q, email, password);
    await settled(q);
    await until(async () => (await bal(q)) === '879,50', 20000);
    const c3 = await cacheDump(q, uid);
    must((await state(q)) === 'application' && (await bal(q)) === '879,50' && (await q.locator('main').innerText()).length > 0, '8. second appareil : connexion, chargement complet, solde 879,50');
    must(JSON.stringify(c3.rows) === JSON.stringify(c1.rows) && canonVersions(c3.versions) === canonVersions(srv.versions), '8. second appareil : instantané identique au premier et au serveur', { tablesDifferentes: rowDiff(c1, c3) });
    await logout(q);
    must((await until(async () => !(await dbs(q)).some((n) => n.startsWith('nexora-cache-')), 10000)) !== null, '8. déconnexion du second appareil : cache supprimé');
    await ctx2.close();

    // 9. Isolation du second utilisateur (option).
    if (B_CRED) {
      phase.isolation = true;
      const lotA = lotBodies.find((b) => (b.p_changeset.ops || []).some((o) => o.table === 'accounts' && JSON.stringify(o).includes(`Épargne ${tag}`)));
      const accA = (await rest(tok, `/rest/v1/accounts?select=id,version,name&user_id=eq.${uid}`)).body;
      await logout(p);
      must((await until(async () => !(await dbs(p)).includes(`nexora-cache-${uid}`), 10000)) !== null && !(await session(p)), '9. déconnexion de A : cache de A et session supprimés');
      const B = readCred(B_CRED);
      await login(p, B.NEXORA_TEST_EMAIL, B.NEXORA_TEST_PASSWORD);
      await settled(p);
      const sb = await session(p);
      must(sb && sb.uid !== uid && ['application', 'accueil'].includes(await state(p)), '9. connexion de B dans le même navigateur');
      const pages = ['/#/', '/#/accounts', '/#/transactions', '/#/settings'];
      let seen = false;
      for (const r of pages) { await p.goto(BASE + r); await settled(p); await sleep(400); if ((await text(p)).includes(tag)) seen = true; }
      must(!seen, '9. interface de B : aucune donnée de A affichée (4 écrans)');
      const names = await dbs(p);
      must(!names.includes(`nexora-cache-${uid}`) && names.filter((n) => n.startsWith('nexora-cache-')).length === 1, '9. navigateur : seul le cache de B existe');
      const cb = await cacheDump(p, sb.uid);
      must(!JSON.stringify(cb.rows).includes(uid) && !JSON.stringify(cb.rows).includes(tag), '9. cache de B : aucune ligne ni valeur de A');
      const iso = {};
      for (const [t, sql] of Object.entries(SQL)) {
        const owner = t === 'users' ? 'id' : 'user_id';
        const a = await rest(sb.token, `/rest/v1/${sql}?select=${owner}&${owner}=eq.${uid}`);
        const all = await rest(sb.token, `/rest/v1/${sql}?select=${owner}&limit=1000`);
        iso[sql] = { lignesDeA: a.status === 200 ? a.body.length : `HTTP ${a.status}`, autresProprietaires: all.status === 200 ? all.body.filter((x) => x[owner] !== sb.uid).length : `HTTP ${all.status}` };
      }
      out.info.isolationApi = iso;
      must(Object.values(iso).every((x) => x.lignesDeA === 0 && x.autresProprietaires === 0), '9. API (jeton de B) : 0 ligne de A et 0 ligne d’un autre utilisateur sur les 18 tables', { tables: Object.keys(iso).length });
      must(lotA, '9. lot de A sur une clé de compte (capturé) disponible');
      const intrusion = JSON.parse(JSON.stringify(lotA));
      intrusion.p_changeset.changesetId = crypto.randomUUID();
      for (const k of Object.keys(intrusion.p_changeset)) if (/user/i.test(k) && typeof intrusion.p_changeset[k] === 'string') intrusion.p_changeset[k] = sb.uid;
      for (const o of intrusion.p_changeset.ops) if (o.row && typeof o.row.name === 'string') o.row.name = `Intrusion ${tag}`;
      // Clé de A : clé SQL de la table (`accounts` : {id}) désignant une ligne de A, ou clé contenant l'utilisateur A.
      const keyOfA = intrusion.p_changeset.ops.every((o) => JSON.stringify(o.key || {}).includes(uid) || accA.some((a) => a.id === o.key?.id));
      const w = await rest(sb.token, '/rest/v1/rpc/apply_changeset', { method: 'POST', body: JSON.stringify(intrusion) });
      out.info.intrusion = { cleDeA: keyOfA, status: w.status, code: w.body && (w.body.code || w.body.status || null), message: w.body && typeof w.body.message === 'string' ? w.body.message.slice(0, 120) : null };
      must(keyOfA && w.status >= 400 && !(w.body && w.body.status === 'applied'), '9. écriture de B sur une clé de A : refusée', out.info.intrusion);
      const tA = await fetch(`${DEV}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json());
      out.requetes.push({ origine: 'controle', method: 'POST', path: '/auth/v1/token?grant_type=password' });
      const accA2 = (await rest(tA.access_token, `/rest/v1/accounts?select=id,version,name&user_id=eq.${uid}`)).body;
      await rest(tA.access_token, '/auth/v1/logout?scope=local', { method: 'POST' });
      const sortById = (l) => JSON.stringify([...l].sort((x, y) => x.id.localeCompare(y.id)));
      must(sortById(accA2) === sortById(accA), '9. comptes de A inchangés après la tentative (noms et versions)');
      const intrusB = (await rest(sb.token, `/rest/v1/accounts?select=id&name=eq.${encodeURIComponent(`Intrusion ${tag}`)}`)).body;
      must(Array.isArray(intrusB) && intrusB.length === 0, '9. aucune ligne « intrusion » créée pour B');
      await logout(p);
      must((await until(async () => !(await dbs(p)).some((n) => n.startsWith('nexora-cache-')), 10000)) !== null && !(await session(p)), '9. déconnexion de B : cache et session supprimés');
    } else {
      await logout(p);
      must((await until(async () => !(await dbs(p)).some((n) => n.startsWith('nexora-cache-')), 10000)) !== null && !(await session(p)), '8. déconnexion finale : cache et session supprimés');
    }
    must(out.bloquees.length === 0, 'garde-fou jamais déclenché', { bloquees: out.bloquees });
    must(errors.length === 0, 'aucune erreur JavaScript', { erreurs: errors });
    out.info.lots = out.lots.length;
    code = 0;
  } catch (e) {
    if (!(e instanceof Stop)) ok(false, `exception : ${e.name}: ${String(e.message).split('\n')[0].slice(0, 200)}`);
    console.log('ARRÊT au premier contrôle en échec.');
    if (out.bloquees.length) console.log('requêtes bloquées :', JSON.stringify(out.bloquees));
  } finally {
    fs.writeFileSync(path.join(OUT, `parcours-${RUN}.json`), JSON.stringify(out, null, 2));
    await browser.close();
    process.exit(code);
  }
})();
