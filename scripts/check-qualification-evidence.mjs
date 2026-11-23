#!/usr/bin/env node
// =============================================================================
// Contrôle des preuves de qualification AVANT leur ajout à Git.
//
//   node scripts/check-qualification-evidence.mjs [répertoire] [préfixe]
//   (défauts : docs/qualification, 3b-local ; Lot 4 : préfixe lot4-local)
//   node scripts/check-qualification-evidence.mjs --print-reference [répertoire] [préfixe]
//   (affiche une référence CANDIDATE sur la sortie standard ; n'écrit jamais rien)
//
// Fichiers contrôlés : <préfixe>-report.md, <préfixe>-sql.json, <préfixe>-http.json.
// Attendus selon le jeu de preuves : 3b-local = migrations 1 à 7, 8 contrôles de précision
// (écriture et lecture directes) ; lot4-local = migrations 1 à 8, 4 contrôles de précision ;
// v41-local = migrations 1 à 9 (V4.1, M9), 4 contrôles de précision, traçabilité exigée
// (lecture seule : apply_changeset ne renvoie pas la valeur écrite).
//
// 1. Recherche de secrets et de données personnelles — AUCUNE valeur trouvée n'est affichée :
//    seuls le fichier, la ligne, la règle et la longueur de la correspondance sont indiqués.
// 2. Contrôle que les identités sont fictives (@example.test) et que les URL sont locales.
// 3. Cohérence des résultats entre les trois fichiers.
// 4. COMPLÉTUDE : comparaison avec la référence versionnée
//    scripts/qualification-reference/<préfixe>.json (signatures exactes des assertions SQL et
//    HTTP, suites, catégories critiques, migrations). La référence est lue dans le DÉPÔT, jamais
//    dans le répertoire des preuves, et son empreinte SHA-256 est épinglée ci-dessous : modifier
//    les preuves, le rapport ou la référence seule ne suffit pas à faire accepter une preuve
//    incomplète. Mise à jour volontaire : scripts/qualification-reference/README.md.
// 5. Traçabilité : si le rapport indique l'empreinte des migrations, elle doit correspondre aux
//    migrations du dépôt.
// Code de sortie : 0 = fichiers propres, cohérents et complets ; 1 = constat bloquant ; 2 = usage.
// Aucune dépendance ; lecture seule (aucun fichier n'est jamais écrit).
// =============================================================================
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_DIR = join(ROOT, 'scripts', 'qualification-reference');
/**
 * Empreintes SHA-256 des références de complétude. Une référence modifiée sans mise à jour
 * volontaire de cette constante est refusée (procédure : scripts/qualification-reference/README.md).
 */
const REFERENCE_SHA256 = {
  '3b-local': 'c44e7bdd365d6c8562eb6492bf6816e266e0b240a7d3510f24e2241b827fabe2',
  'lot4-local': '39e36ad29c7895f3263e609e594348dc651c5bb032b6f1e35f9253618fd29fcc',
  'v41-local': 'e21d3f237f32d94e41fa0e288b447e98531371752162359f594580e9543bd9f6',
};
/** Jeux de preuves antérieurs à l'enregistrement de la traçabilité dans le rapport. */
const LEGACY_PREFIXES = ['3b-local', 'lot4-local'];
/**
 * Catégories critiques : utilisées pour produire une référence candidate (--print-reference) ;
 * le contrôle porte sur les comptes ENREGISTRÉS dans la référence épinglée.
 */
const CATEGORY_RULES = [
  { id: 'sql-isolation', label: 'SQL : matrice d\'isolation entre utilisateurs', scope: 'sql', file: '02_isolation.sql', pattern: '' },
  { id: 'sql-catalogue', label: 'SQL : RLS, privilèges et politiques (catalogue)', scope: 'sql', file: '01_catalog.sql', pattern: '' },
  { id: 'sql-protocole', label: 'SQL : protocole apply_changeset (migration 8)', scope: 'sql', file: '11_apply_changeset.sql', pattern: '' },
  { id: 'sql-cle-canonique', label: 'SQL : contrôle de clé canonique (migration 8)', scope: 'sql', file: '11_apply_changeset.sql', pattern: 'clé canonique|non normalisée|nombre pour une clé texte|majuscules|même ligne visée deux fois' },
  { id: 'sql-plateforme', label: 'SQL : contrôles de la plateforme Supabase', scope: 'sql', file: 'P1_supabase_platform.sql', pattern: '' },
  { id: 'http-isolation', label: 'HTTP : isolation entre deux utilisateurs authentifiés', scope: 'http', file: '', pattern: ' : B | B ne | de A | lignes de A ' },
  { id: 'http-ecriture-directe', label: 'HTTP : refus des écritures directes', scope: 'http', file: '', pattern: 'direct' },
  { id: 'http-protocole', label: 'HTTP : protocole (conflits R3, idempotence, résolution, atomicité)', scope: 'http', file: '', pattern: '^R3 |idempotence|résolution|atomicité' },
  { id: 'http-precision', label: 'HTTP : précision des nombres (chaîne JavaScript ↔ PostgreSQL)', scope: 'http', file: '', pattern: '^API .*identique' },
  { id: 'http-anonyme', label: 'HTTP : rôle anonyme et jeton falsifié', scope: 'http', file: '', pattern: '^anon|jeton modifié' },
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sig = (r) => `${r.file} :: ${r.name}`;
const countBy = (arr, key) => arr.reduce((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});
const inCategory = (c) => (r) => (!c.file || r.file === c.file) && (!c.pattern || new RegExp(c.pattern).test(r.name));
/** Empreinte des migrations : SHA-256 de la sortie de `sha256sum *.sql` (tri par nom), comme qualify-supabase.sh. */
function migrationsFingerprint() {
  const d = join(ROOT, 'supabase', 'migrations');
  const lines = readdirSync(d).filter((f) => f.endsWith('.sql')).sort().map((f) => `${sha256(readFileSync(join(d, f)))}  ${f}\n`);
  return sha256(lines.join(''));
}

const argv = process.argv.slice(2);
const printReference = argv[0] === '--print-reference';
if (printReference) argv.shift();
const dir = argv[0] ?? 'docs/qualification';
const prefix = argv[1] ?? '3b-local';
const EXPECTED = { '3b-local': { migrations: 7, precision: 8 }, 'lot4-local': { migrations: 8, precision: 4 }, 'v41-local': { migrations: 9, precision: 4 } }[prefix];
if (!EXPECTED) {
  console.error(`Préfixe inconnu « ${prefix} » (attendu : 3b-local, lot4-local ou v41-local).`);
  process.exit(2);
}
const names = { report: `${prefix}-report.md`, sql: `${prefix}-sql.json`, http: `${prefix}-http.json` };
const paths = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, join(dir, n)]));
const missing = Object.values(paths).filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`Fichier(s) absent(s) : ${missing.join(', ')}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Référence candidate (mise à jour VOLONTAIRE : rien n'est écrit, la sortie est relue puis
// enregistrée à la main, et l'empreinte épinglée ci-dessus est mise à jour dans le même commit).
// ---------------------------------------------------------------------------
if (printReference) {
  const sqlJ = JSON.parse(readFileSync(paths.sql, 'utf8'));
  const httpJ = JSON.parse(readFileSync(paths.http, 'utf8'));
  const report = readFileSync(paths.report, 'utf8');
  const failed = [...sqlJ.results, ...httpJ.results].filter((r) => !r.ok).length;
  if (failed) {
    console.error(`Référence refusée : ${failed} assertion(s) en échec dans les preuves.`);
    process.exit(1);
  }
  const scope = (j) => ({ total: j.results.length, files: countBy(j.results, (r) => r.file), signatures: j.results.map(sig).sort() });
  const migrationsLine = report.match(/\| Migrations appliquées \| `([^`]*)` \|/);
  const out = {
    format: 1,
    prefix,
    description: 'Référence de complétude : signatures exactes attendues (fichier :: nom), avec multiplicité.',
    postgresMajor: Number(String(sqlJ.server_version).split('.')[0]),
    migrations: migrationsLine ? migrationsLine[1].trim().split(/\s+/) : [],
    traceability: LEGACY_PREFIXES.includes(prefix) ? 'legacy' : 'required',
    sql: scope(sqlJ),
    http: scope(httpJ),
    // Une catégorie absente du jeu de preuves (ex. protocole de la migration 8 avant le Lot 4) n'est pas retenue.
    categories: CATEGORY_RULES.map((c) => ({ ...c, count: (c.scope === 'sql' ? sqlJ : httpJ).results.filter(inCategory(c)).length })).filter((c) => c.count > 0),
  };
  // Attendre l'écriture complète : une sortie redirigée vers un tube serait sinon tronquée.
  await new Promise((done) => process.stdout.write(`${JSON.stringify(out, null, 2)}\n`, done));
  process.exit(0);
}

const findings = []; // { file, line, rule, length } — jamais la valeur
const info = [];
const flag = (file, line, rule, length) => findings.push({ file, line, rule, length });

// Valeurs non secrètes connues de la pile LOCALE (documentées par Supabase pour le
// développement local) : tolérées mais signalées.
const LOCAL_DEFAULTS = new Set(['postgres']);
const rules = [
  ['jeton JWT', /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g],
  ['clé Supabase (publishable / secret)', /sb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}/g],
  ['jeton GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['clé AWS', /\bAKIA[0-9A-Z]{16}\b/g],
  ['clé privée', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['en-tête Authorization / Bearer', /\b(?:Authorization|Bearer)\b["']?\s*[:=]?\s*["']?(?!\[)[A-Za-z0-9._~+/-]{16,}/g],
  ['affectation de secret', /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?role[_-]?key|anon[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"',;|]{4,})/gi],
];
const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const urlRe = /\bhttps?:\/\/([A-Za-z0-9.-]+)(?::\d+)?/g;
const localHosts = new Set(['127.0.0.1', 'localhost']);
const allowedUrlHosts = new Set(['claude.ai', 'claude.com', 'github.com', 'supabase.com']); // liens documentaires

for (const [key, p] of Object.entries(paths)) {
  const text = readFileSync(p, 'utf8');
  const lines = text.split('\n');
  let masked = 0;
  lines.forEach((line, i) => {
    masked += (line.match(/\[(?:jeton|clé) masqué(?:e)?\]/g) ?? []).length;
    for (const [rule, re] of rules) {
      for (const m of line.matchAll(re)) {
        const value = m[1] ?? m[0];
        if (rule === 'affectation de secret' && LOCAL_DEFAULTS.has(value)) {
          info.push(`${names[key]}:${i + 1} valeur par défaut LOCALE (« postgres ») — non secrète, tolérée`);
          continue;
        }
        flag(names[key], i + 1, rule, m[0].length);
      }
    }
    for (const m of line.matchAll(emailRe)) {
      if (!m[0].toLowerCase().endsWith('@example.test')) flag(names[key], i + 1, 'adresse e-mail non fictive', m[0].length);
    }
    for (const m of line.matchAll(urlRe)) {
      const host = m[1].toLowerCase();
      if (!localHosts.has(host) && !allowedUrlHosts.has(host)) flag(names[key], i + 1, `URL non locale (hôte de ${host.length} caractères)`, m[0].length);
    }
  });
  info.push(`${names[key]} : ${lines.length} lignes, ${masked} marqueur(s) de masquage`);
}

// ---------------------------------------------------------------------------
// Cohérence
// ---------------------------------------------------------------------------
const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };
let sql, http;
try { sql = JSON.parse(readFileSync(paths.sql, 'utf8')); } catch { problems.push(`${names.sql} : JSON invalide`); }
try { http = JSON.parse(readFileSync(paths.http, 'utf8')); } catch { problems.push(`${names.http} : JSON invalide`); }
const report = readFileSync(paths.report, 'utf8');
const summary = {};

if (sql) {
  const r = sql.results ?? [];
  summary.sqlTotal = r.length;
  summary.sqlFailed = r.filter((x) => !x.ok).length;
  summary.sqlVersion = sql.server_version;
  check(/^17\./.test(String(sql.server_version)), `${names.sql} : version serveur inattendue (${sql.server_version})`);
  check(summary.sqlFailed === 0, `${names.sql} : ${summary.sqlFailed} échec(s)`);
}
if (http) {
  const r = http.results ?? [];
  summary.httpTotal = r.length;
  summary.httpFailed = r.filter((x) => !x.ok).length;
  const precision = r.filter((x) => /^API .*(identique)/.test(x.name));
  summary.precision = `${precision.filter((x) => x.ok).length}/${precision.length}`;
  check(summary.httpFailed === 0, `${names.http} : ${summary.httpFailed} échec(s)`);
  check(precision.length === EXPECTED.precision && precision.every((x) => x.ok), `${names.http} : contrôles de précision ${summary.precision} (${EXPECTED.precision}/${EXPECTED.precision} attendu)`);
}
const httpBilan = report.match(/Bilan HTTP : (\d+) assertions, (\d+) échec/);
check(httpBilan && http && Number(httpBilan[1]) === summary.httpTotal && Number(httpBilan[2]) === summary.httpFailed,
  `${names.report} : bilan HTTP du rapport (${httpBilan ? httpBilan[1] + '/' + httpBilan[2] : 'absent'}) ≠ ${names.http}`);
const cible = report.match(/\| Assertions \| (\d+) \| (\d+) \|/);
check(cible && sql && Number(cible[2]) === summary.sqlTotal, `${names.report} : nombre d'assertions SQL du rapport ≠ ${names.sql}`);
const identical = report.match(/Identiques : \*\*(\d+)\*\*/);
const regressions = report.match(/régressions : \*\*(\d+)\*\*/);
summary.identical = identical ? Number(identical[1]) : null;
check(regressions && Number(regressions[1]) === 0, `${names.report} : régressions PG16/PG17 non nulles ou absentes`);
const migrations = report.match(/\| Migrations appliquées \| `([^`]*)` \|/);
summary.migrations = migrations ? migrations[1].trim().split(/\s+/).length : null;
check(summary.migrations === EXPECTED.migrations, `${names.report} : ${summary.migrations ?? 0} migration(s) appliquée(s) (${EXPECTED.migrations} attendues)`);
const exactChain = (report.match(/exact de bout en bout/g) ?? []).length;
summary.chain = exactChain;
check(exactChain === 4 && !/PERTE :/.test(report), `${names.report} : chaîne numérique ${exactChain}/4 exacte`);
check(/Code de sortie HTTP \/ chaîne numérique \/ comparaison \| 0 \/ 0 \/ 0 \|/.test(report), `${names.report} : codes de sortie non nuls`);

// ---------------------------------------------------------------------------
// Complétude : référence versionnée, lue dans le dépôt et épinglée par son empreinte
// ---------------------------------------------------------------------------
const MAX_LISTED = 8;
const listed = (arr) => `${arr.slice(0, MAX_LISTED).join(' ; ')}${arr.length > MAX_LISTED ? ` ; … (+${arr.length - MAX_LISTED})` : ''}`;
const refPath = join(REFERENCE_DIR, `${prefix}.json`);
let ref = null;
if (!existsSync(refPath)) {
  problems.push(`complétude : référence absente (${refPath}) — la complétude des preuves ne peut pas être vérifiée`);
} else {
  const raw = readFileSync(refPath);
  const actual = sha256(raw);
  if (actual !== REFERENCE_SHA256[prefix]) {
    problems.push(`complétude : référence ${prefix}.json modifiée (empreinte ${actual.slice(0, 16)}… ≠ épinglée ${String(REFERENCE_SHA256[prefix]).slice(0, 16)}…) — mise à jour volontaire requise (scripts/qualification-reference/README.md)`);
  } else {
    ref = JSON.parse(raw.toString('utf8'));
    summary.reference = actual.slice(0, 16);
  }
}

/** Compare deux multiensembles de signatures ; renvoie les manquantes et les inattendues (avec multiplicité). */
function compare(expectedSigs, actualSigs) {
  const pool = countBy(actualSigs, (s) => s);
  const missingSigs = [];
  for (const s of expectedSigs) {
    if (pool[s] > 0) pool[s] -= 1;
    else missingSigs.push(s);
  }
  const unexpected = Object.entries(pool).flatMap(([s, n]) => Array(n).fill(s));
  return { missingSigs, unexpected };
}

if (ref) {
  for (const [scope, data, fileName] of [['sql', sql, names.sql], ['http', http, names.http]]) {
    if (!data) continue;
    const exp = ref[scope];
    const results = data.results ?? [];
    const { missingSigs, unexpected } = compare(exp.signatures, results.map(sig));
    check(results.length === exp.total, `complétude ${scope.toUpperCase()} : ${results.length} assertions dans ${fileName}, ${exp.total} attendues par la référence`);
    const counts = countBy(results, (r) => r.file);
    for (const [f, n] of Object.entries(exp.files)) {
      check((counts[f] ?? 0) === n, `complétude ${scope.toUpperCase()} : suite ${f} — ${counts[f] ?? 0} assertion(s), ${n} attendue(s)${counts[f] ? '' : ' (SUITE ABSENTE)'}`);
    }
    for (const f of Object.keys(counts)) check(f in exp.files, `complétude ${scope.toUpperCase()} : suite inattendue ${f} (${counts[f]} assertion(s))`);
    check(!missingSigs.length, `complétude ${scope.toUpperCase()} : ${missingSigs.length} assertion(s) attendue(s) absente(s) : ${listed(missingSigs)}`);
    check(!unexpected.length, `complétude ${scope.toUpperCase()} : ${unexpected.length} assertion(s) non référencée(s) (ajout ou renommage) : ${listed(unexpected)}`);
  }
  for (const c of ref.categories) {
    const data = c.scope === 'sql' ? sql : http;
    if (!data) continue;
    const found = (data.results ?? []).filter(inCategory(c));
    const ko = found.filter((r) => !r.ok).length;
    check(found.length === c.count && ko === 0, `catégorie critique « ${c.label} » : ${found.length} assertion(s) présente(s) dont ${ko} en échec, ${c.count} attendue(s)`);
  }
  check(sql && new RegExp(`^${ref.postgresMajor}\\.`).test(String(sql.server_version)), `${names.sql} : PostgreSQL ${sql?.server_version} ≠ version majeure ${ref.postgresMajor} de la référence`);
  const listedMigrations = migrations ? migrations[1].trim().split(/\s+/) : [];
  check(JSON.stringify(listedMigrations) === JSON.stringify(ref.migrations),
    `${names.report} : migrations appliquées ${listed(listedMigrations) || 'aucune'} ≠ référence ${listed(ref.migrations)}`);
  check(cible && Number(cible[2]) === ref.sql.total, `${names.report} : ${cible ? cible[2] : '?'} assertions SQL annoncées, ${ref.sql.total} attendues par la référence`);
  check(httpBilan && Number(httpBilan[1]) === ref.http.total, `${names.report} : ${httpBilan ? httpBilan[1] : '?'} assertions HTTP annoncées, ${ref.http.total} attendues par la référence`);
}

// ---------------------------------------------------------------------------
// Traçabilité (rapports produits depuis la remédiation du Lot 0)
// ---------------------------------------------------------------------------
const tracedMigrations = report.match(/\| Empreinte des migrations \| `([0-9a-f]{64})` \|/);
const tracedEnv = report.match(/\| Environnement \| ([^|]+) \|/);
const tracedCommit = report.match(/\| Commit testé \| `([^`]+)`/);
if (tracedMigrations) {
  const current = migrationsFingerprint();
  check(tracedMigrations[1] === current, `traçabilité : empreinte des migrations du rapport (${tracedMigrations[1].slice(0, 16)}…) ≠ migrations du dépôt (${current.slice(0, 16)}…)`);
  info.push(`traçabilité : environnement ${tracedEnv ? tracedEnv[1].trim() : '?'} ; commit ${tracedCommit ? tracedCommit[1] : '?'} ; empreinte des migrations ${tracedMigrations[1].slice(0, 16)}…`);
} else if (ref?.traceability === 'required') {
  problems.push(`traçabilité : ${names.report} n'indique ni l'environnement, ni le commit, ni l'empreinte des migrations (exigés par la référence)`);
} else {
  info.push(`traçabilité : non enregistrée dans ce rapport (preuve antérieure à son ajout) — environnement, commit et migrations non vérifiables`);
}

// ---------------------------------------------------------------------------
console.log(`Contrôle des preuves de qualification (${prefix})`);
for (const l of info) console.log(`  · ${l}`);
console.log(`  Résultats : SQL ${summary.sqlTotal ?? '?'} (échecs ${summary.sqlFailed ?? '?'}, PostgreSQL ${summary.sqlVersion ?? '?'}) ; ` +
  `HTTP ${summary.httpTotal ?? '?'} (échecs ${summary.httpFailed ?? '?'}) ; précision ${summary.precision ?? '?'} ; ` +
  `identiques PG16/PG17 ${summary.identical ?? '?'} ; migrations ${summary.migrations ?? '?'} ; chaîne exacte ${summary.chain}/4 ; ` +
  `référence ${summary.reference ? `${summary.reference}… (épinglée)` : 'NON VÉRIFIÉE'}`);
if (findings.length) {
  console.log(`\nCONSTATS DE SÉCURITÉ (${findings.length}) — valeurs NON affichées :`);
  for (const f of findings) console.log(`  ✗ ${f.file}:${f.line} — ${f.rule} (${f.length} caractères)`);
}
if (problems.length) {
  console.log(`\nINCOHÉRENCES (${problems.length}) :`);
  for (const p of problems) console.log(`  ✗ ${p}`);
}
const okAll = !findings.length && !problems.length;
console.log(okAll ? '\nVERDICT : fichiers propres, cohérents et complets — ajout à Git possible.' : '\nVERDICT : NE PAS AJOUTER ces fichiers (voir les constats ci-dessus).');
process.exit(okAll ? 0 : 1);
