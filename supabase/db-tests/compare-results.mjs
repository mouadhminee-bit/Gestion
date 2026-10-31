#!/usr/bin/env node
// Compare deux exports de résultats SQL (RESULTS_JSON de scripts/db-test.sh), assertion par
// assertion (clé : fichier + nom + rang d'occurrence). Sortie : résumé texte et, si demandé,
// un rapport Markdown. Code de sortie 1 si une assertion de la référence manque, échoue,
// ou si la cible contient des échecs.
//
// Usage : node supabase/db-tests/compare-results.mjs <reference.json> <cible.json> [--md <rapport.md>]
import { readFileSync, writeFileSync } from 'node:fs';

const [refPath, targetPath, ...rest] = process.argv.slice(2);
if (!refPath || !targetPath) {
  console.error('Usage : compare-results.mjs <reference.json> <cible.json> [--md <rapport.md>]');
  process.exit(2);
}
const mdPath = rest[0] === '--md' ? rest[1] : null;

const load = (p) => {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const seen = new Map();
  const map = new Map();
  for (const r of j.results ?? []) {
    const base = `${r.file} :: ${r.name}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    map.set(n > 1 ? `${base} #${n}` : base, r);
  }
  return { version: j.server_version, map, total: (j.results ?? []).length, failed: (j.results ?? []).filter((r) => !r.ok).length };
};

const ref = load(refPath);
const tgt = load(targetPath);
const missing = [...ref.map.keys()].filter((k) => !tgt.map.has(k));
const extra = [...tgt.map.keys()].filter((k) => !ref.map.has(k));
const regressions = [...ref.map.keys()].filter((k) => tgt.map.has(k) && ref.map.get(k).ok && !tgt.map.get(k).ok);
const improvements = [...ref.map.keys()].filter((k) => tgt.map.has(k) && !ref.map.get(k).ok && tgt.map.get(k).ok);
const identical = ref.map.size - missing.length - regressions.length - improvements.length;

const perFile = {};
for (const [k, r] of tgt.map) {
  perFile[r.file] ??= { ok: 0, ko: 0 };
  perFile[r.file][r.ok ? 'ok' : 'ko']++;
}

const lines = [];
lines.push(`Référence : ${refPath} (PostgreSQL ${ref.version}) — ${ref.total} assertions, ${ref.failed} échec(s)`);
lines.push(`Cible     : ${targetPath} (PostgreSQL ${tgt.version}) — ${tgt.total} assertions, ${tgt.failed} échec(s)`);
lines.push(`Identiques : ${identical} · manquantes : ${missing.length} · en plus : ${extra.length} · régressions : ${regressions.length} · améliorations : ${improvements.length}`);
for (const k of missing) lines.push(`  MANQUANTE   ${k}`);
for (const k of regressions) lines.push(`  RÉGRESSION  ${k} — ${tgt.map.get(k).detail ?? ''}`);
for (const k of extra) lines.push(`  EN PLUS     ${k} — ${tgt.map.get(k).ok ? 'ok' : 'ÉCHEC ' + (tgt.map.get(k).detail ?? '')}`);
console.log(lines.join('\n'));

if (mdPath) {
  const md = [
    `| | Référence | Cible |`,
    `|---|---|---|`,
    `| Version PostgreSQL | ${ref.version} | ${tgt.version} |`,
    `| Assertions | ${ref.total} | ${tgt.total} |`,
    `| Échecs | ${ref.failed} | ${tgt.failed} |`,
    '',
    `Identiques : **${identical}** · manquantes : **${missing.length}** · en plus : **${extra.length}** · régressions : **${regressions.length}**`,
    '',
    '| Fichier | Réussies | Échecs |',
    '|---|---|---|',
    ...Object.entries(perFile).sort().map(([f, c]) => `| ${f} | ${c.ok} | ${c.ko} |`),
    '',
    ...(missing.length + regressions.length + extra.length
      ? ['| Écart | Assertion | Détail |', '|---|---|---|',
         ...missing.map((k) => `| manquante | ${k} | |`),
         ...regressions.map((k) => `| régression | ${k} | ${String(tgt.map.get(k).detail ?? '').replaceAll('|', '/')} |`),
         ...extra.map((k) => `| en plus | ${k} | ${tgt.map.get(k).ok ? 'ok' : String(tgt.map.get(k).detail ?? '').replaceAll('|', '/')} |`)]
      : ['Aucun écart.']),
  ].join('\n');
  writeFileSync(mdPath, md + '\n');
}

process.exit(missing.length || regressions.length || tgt.failed ? 1 : 0);
