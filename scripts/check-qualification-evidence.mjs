#!/usr/bin/env node
// =============================================================================
// Contrôle des preuves de qualification 3b AVANT leur ajout à Git.
//
//   node scripts/check-qualification-evidence.mjs [répertoire]   (défaut : docs/qualification)
//
// Fichiers contrôlés : 3b-local-report.md, 3b-local-sql.json, 3b-local-http.json.
//
// 1. Recherche de secrets et de données personnelles — AUCUNE valeur trouvée n'est affichée :
//    seuls le fichier, la ligne, la règle et la longueur de la correspondance sont indiqués.
// 2. Contrôle que les identités sont fictives (@example.test) et que les URL sont locales.
// 3. Cohérence des résultats entre les trois fichiers.
// Code de sortie : 0 = fichiers propres et cohérents ; 1 = constat bloquant ; 2 = usage.
// Aucune dépendance ; lecture seule.
// =============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'docs/qualification';
const names = { report: '3b-local-report.md', sql: '3b-local-sql.json', http: '3b-local-http.json' };
const paths = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, join(dir, n)]));
const missing = Object.values(paths).filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`Fichier(s) absent(s) : ${missing.join(', ')}`);
  process.exit(2);
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
  check(precision.length === 8 && precision.every((x) => x.ok), `${names.http} : contrôles de précision ${summary.precision} (8/8 attendu)`);
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
check(summary.migrations === 7, `${names.report} : ${summary.migrations ?? 0} migration(s) appliquée(s) (7 attendues)`);
const exactChain = (report.match(/exact de bout en bout/g) ?? []).length;
summary.chain = exactChain;
check(exactChain === 4 && !/PERTE :/.test(report), `${names.report} : chaîne numérique ${exactChain}/4 exacte`);
check(/Code de sortie HTTP \/ chaîne numérique \/ comparaison \| 0 \/ 0 \/ 0 \|/.test(report), `${names.report} : codes de sortie non nuls`);

// ---------------------------------------------------------------------------
console.log('Contrôle des preuves de qualification 3b');
for (const l of info) console.log(`  · ${l}`);
console.log(`  Résultats : SQL ${summary.sqlTotal ?? '?'} (échecs ${summary.sqlFailed ?? '?'}, PostgreSQL ${summary.sqlVersion ?? '?'}) ; ` +
  `HTTP ${summary.httpTotal ?? '?'} (échecs ${summary.httpFailed ?? '?'}) ; précision ${summary.precision ?? '?'} ; ` +
  `identiques PG16/PG17 ${summary.identical ?? '?'} ; migrations ${summary.migrations ?? '?'} ; chaîne exacte ${summary.chain}/4`);
if (findings.length) {
  console.log(`\nCONSTATS DE SÉCURITÉ (${findings.length}) — valeurs NON affichées :`);
  for (const f of findings) console.log(`  ✗ ${f.file}:${f.line} — ${f.rule} (${f.length} caractères)`);
}
if (problems.length) {
  console.log(`\nINCOHÉRENCES (${problems.length}) :`);
  for (const p of problems) console.log(`  ✗ ${p}`);
}
const okAll = !findings.length && !problems.length;
console.log(okAll ? '\nVERDICT : fichiers propres et cohérents — ajout à Git possible.' : '\nVERDICT : NE PAS AJOUTER ces fichiers (voir les constats ci-dessus).');
process.exit(okAll ? 0 : 1);
