#!/usr/bin/env node
// Compare deux exports de résultats SQL (RESULTS_JSON de scripts/db-test.sh), assertion par
// assertion (clé : fichier + nom + rang d'occurrence). Sortie : résumé texte et, si demandé,
// un rapport Markdown. Code de sortie 1 si une assertion de la référence manque, échoue,
// ou si la cible contient des échecs.
//
// Usage : node supabase/db-tests/compare-results.mjs <reference.json> <cible.json> [--md <rapport.md>]
//                                                   [--declared <ecarts.json>]
//
// --declared (V4.1) : écarts DÉCLARÉS de la cible par rapport à la référence, quand une assertion
// de la référence a été remplacée volontairement (renommée ou modifiée) sans que la référence
// puisse être régénérée. Format : { "entries": [ { "missing": "<fichier :: nom>",
// "replacement": "<fichier :: nom>", "reason": "…" } ] }. Contrôle EXACT, rien n'est masqué :
//  - chaque assertion déclarée doit réellement manquer (déclaration périmée → échec) ;
//  - son remplacement doit exister dans la cible et réussir ;
//  - toute autre assertion manquante reste un échec ;
//  - les écarts déclarés et les assertions « en plus » sont listés comme NON requalifiés sur la
//    version de la référence (ils ne sont jamais comptés comme identiques).
import { readFileSync, writeFileSync } from 'node:fs';

const [refPath, targetPath, ...rest] = process.argv.slice(2);
if (!refPath || !targetPath) {
  console.error('Usage : compare-results.mjs <reference.json> <cible.json> [--md <rapport.md>]');
  process.exit(2);
}
let mdPath = null;
let declaredPath = null;
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i] === '--md') mdPath = rest[i + 1];
  else if (rest[i] === '--declared') declaredPath = rest[i + 1];
  else {
    console.error(`Option inconnue : ${rest[i]}`);
    process.exit(2);
  }
}

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

// Écarts déclarés (contrôle exact).
const declared = declaredPath ? JSON.parse(readFileSync(declaredPath, 'utf8')).entries ?? [] : [];
const declaredMissing = new Set(declared.map((d) => d.missing));
const undeclaredMissing = missing.filter((k) => !declaredMissing.has(k));
const stale = declared.filter((d) => !missing.includes(d.missing)).map((d) => d.missing);
const badReplacement = declared.filter((d) => !tgt.map.has(d.replacement) || !tgt.map.get(d.replacement).ok).map((d) => d.replacement);


const perFile = {};
for (const [k, r] of tgt.map) {
  perFile[r.file] ??= { ok: 0, ko: 0 };
  perFile[r.file][r.ok ? 'ok' : 'ko']++;
}

const lines = [];
lines.push(`Référence : ${refPath} (PostgreSQL ${ref.version}) — ${ref.total} assertions, ${ref.failed} échec(s)`);
lines.push(`Cible     : ${targetPath} (PostgreSQL ${tgt.version}) — ${tgt.total} assertions, ${tgt.failed} échec(s)`);
lines.push(`Identiques : ${identical} · manquantes : ${missing.length} (dont déclarées : ${missing.length - undeclaredMissing.length}) · en plus : ${extra.length} · régressions : ${regressions.length} · améliorations : ${improvements.length}`);
if (declaredPath) lines.push(`Écarts déclarés (${declaredPath}) : ${declared.length} — NON requalifiés sur PostgreSQL ${ref.version} ; assertions sans référence : ${extra.length}`);
for (const k of undeclaredMissing) lines.push(`  MANQUANTE   ${k}`);
for (const d of declared) lines.push(`  DÉCLARÉE    ${d.missing} → ${d.replacement} — ${d.reason}`);
for (const k of stale) lines.push(`  DÉCLARATION PÉRIMÉE (assertion toujours présente) ${k}`);
for (const k of badReplacement) lines.push(`  REMPLACEMENT ABSENT OU EN ÉCHEC ${k}`);
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
    `Identiques : **${identical}** · manquantes : **${missing.length}** (dont déclarées : **${missing.length - undeclaredMissing.length}**) · en plus : **${extra.length}** · régressions : **${regressions.length}**`,
    '',
    ...(declaredPath
      ? [`Écarts déclarés : **${declared.length}** (\`${declaredPath}\`). Ils ne sont **pas** requalifiés sur PostgreSQL ${ref.version}, pas plus que les ${extra.length} assertions « en plus » : celles-ci ne sont qualifiées que sur la cible (PostgreSQL ${tgt.version}).`, '']
      : []),
    '| Fichier | Réussies | Échecs |',
    '|---|---|---|',
    ...Object.entries(perFile).sort().map(([f, c]) => `| ${f} | ${c.ok} | ${c.ko} |`),
    '',
    ...(missing.length + regressions.length + extra.length
      ? ['| Écart | Assertion | Détail |', '|---|---|---|',
         ...undeclaredMissing.map((k) => `| manquante | ${k} | |`),
         ...declared.map((d) => `| écart déclaré (non requalifié) | ${d.missing} | remplacée par « ${d.replacement} » : ${String(d.reason).replaceAll('|', '/')} |`),
         ...stale.map((k) => `| déclaration périmée | ${k} | assertion toujours présente |`),
         ...badReplacement.map((k) => `| remplacement absent ou en échec | ${k} | |`),
         ...regressions.map((k) => `| régression | ${k} | ${String(tgt.map.get(k).detail ?? '').replaceAll('|', '/')} |`),
         ...extra.map((k) => `| en plus (sans référence) | ${k} | ${tgt.map.get(k).ok ? 'ok' : String(tgt.map.get(k).detail ?? '').replaceAll('|', '/')} |`)]
      : ['Aucun écart.']),
  ].join('\n');
  writeFileSync(mdPath, md + '\n');
}

process.exit(undeclaredMissing.length || stale.length || badReplacement.length || regressions.length || tgt.failed ? 1 : 0);
