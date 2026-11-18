#!/usr/bin/env node
// =============================================================================
// NEXORA — exécution des contrôles de sécurité par mutation (Lot 0).
//
//   node scripts/security-mutations/run.mjs            toutes les mutations
//   node scripts/security-mutations/run.mjs M5 M10     sélection (préfixe d'identifiant)
//   node scripts/security-mutations/run.mjs --list     liste, sans rien exécuter
//
// Pour chaque exécution :
//  1. copie `supabase/` et `scripts/` dans un dossier temporaire NEUF (mkdtemp, hors dépôt) ;
//  2. applique la mutation à la COPIE de la migration 8 (le dépôt n'est jamais modifié) ;
//  3. lance `scripts/db-test.sh` dans cette copie (PostgreSQL éphémère, détruit par le script) ;
//  4. supprime le dossier temporaire qu'il a lui-même créé, et lui seul.
// Un TÉMOIN (copie sans mutation) est exécuté d'abord : il doit réussir sans aucun échec,
// sinon l'environnement est jugé inutilisable et rien n'est conclu.
//
// Verdict par mutation :
//  * DÉTECTÉE   : toutes les suites ont tourné et au moins une assertion échoue ;
//  * NON PROBANT : une suite s'est interrompue (erreur SQL) — échec d'exécution, pas une preuve ;
//  * NON DÉTECTÉE : toutes les assertions réussissent malgré l'affaiblissement (trou de test).
// Code de sortie : 0 si toutes les mutations sélectionnées sont DÉTECTÉES, 1 sinon, 2 en cas
// d'usage ou d'environnement invalide.
//
// Prérequis : binaires serveur PostgreSQL 16 (variable PG_BIN, défaut
// /usr/lib/postgresql/16/bin), psql, bash ; voir scripts/security-mutations/README.md.
// Aucune connexion réseau, aucune base distante, aucun projet hébergé.
// =============================================================================
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_FILE, MUTATIONS, mutate } from './mutations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);

if (args.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(30)} ${m.description} (observé : ${m.observed} échecs)`);
  process.exit(0);
}
const selected = args.length ? MUTATIONS.filter((m) => args.some((a) => m.id === a || m.id.startsWith(`${a}_`))) : MUTATIONS;
if (!selected.length || selected.length < args.length) {
  console.error(`Sélection invalide : ${args.join(' ')} (voir --list).`);
  process.exit(2);
}
const pgBin = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
if (!existsSync(join(pgBin, 'postgres'))) {
  console.error(`PostgreSQL introuvable dans ${pgBin} (variable PG_BIN) : voir scripts/security-mutations/README.md.`);
  process.exit(2);
}

/** Copie de travail isolée ; renvoie son chemin. Refuse tout chemin situé dans le dépôt. */
function workingCopy(label) {
  const dir = mkdtempSync(join(tmpdir(), `nexora-mutation-${label}-`));
  const real = realpathSync(dir);
  const rel = relative(realpathSync(ROOT), real);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`dossier temporaire dans le dépôt refusé : ${real}`);
  }
  const skip = (src) => !/[/\\]supabase[/\\]\.(temp|branches)([/\\]|$)/.test(src);
  cpSync(join(ROOT, 'supabase'), join(dir, 'supabase'), { recursive: true, filter: skip });
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  // scripts/db-test.sh lance le serveur sous l'utilisateur postgres lorsqu'il tourne en root.
  spawnSync('chmod', ['-R', 'a+rX', dir]);
  chmodSync(dir, 0o755);
  return dir;
}

/** Exécute les suites SQL dans une copie ; renvoie le bilan analysé. */
function runSuites(dir) {
  const r = spawnSync('bash', ['scripts/db-test.sh'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PG_BIN: pgBin }, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const bilan = out.match(/Bilan : (\d+) assertions, (\d+) échec/);
  const interrupted = /^psql:.*ERROR/m.test(out) || !bilan;
  const failingFiles = [...out.matchAll(/^\s*(\S+\.sql)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*$/gm)].filter((m) => Number(m[3]) > 0).map((m) => `${m[1]} : ${m[3]}`);
  return { status: r.status, total: bilan ? Number(bilan[1]) : null, failed: bilan ? Number(bilan[2]) : null, interrupted, failingFiles, firstError: (out.match(/^psql:.*ERROR.*$/m) ?? [null])[0] };
}

function withCopy(label, fn) {
  const dir = workingCopy(label);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // uniquement le dossier créé ci-dessus
  }
}

console.log(`Contrôles par mutation — ${selected.length} mutation(s), PostgreSQL : ${pgBin}`);
const control = withCopy('temoin', (dir) => runSuites(dir));
if (control.interrupted || control.failed !== 0) {
  console.error(`TÉMOIN EN ÉCHEC (${control.failed ?? '?'} échec(s)${control.interrupted ? ', interrompu' : ''}) : environnement inutilisable, aucune conclusion possible.`);
  if (control.firstError) console.error(control.firstError);
  process.exit(2);
}
console.log(`Témoin sans mutation : ${control.total} assertions, 0 échec.`);

let ok = true;
for (const m of selected) {
  const res = withCopy(m.id, (dir) => {
    const file = join(dir, MIGRATION_FILE);
    writeFileSync(file, mutate(m.id, readFileSync(file, 'utf8')));
    return runSuites(dir);
  });
  const verdict = res.interrupted ? 'NON PROBANT (suite interrompue)' : res.failed > 0 ? 'DÉTECTÉE' : 'NON DÉTECTÉE';
  if (verdict !== 'DÉTECTÉE') ok = false;
  console.log(`${m.id.padEnd(30)} ${verdict.padEnd(32)} ${res.failed ?? '?'} échec(s) sur ${res.total ?? '?'} (observé au Lot 0 : ${m.observed})`);
  if (res.failingFiles.length) console.log(`  ${res.failingFiles.join(' · ')}`);
  if (res.interrupted && res.firstError) console.log(`  ${res.firstError.slice(0, 220)}`);
}
console.log(ok ? 'VERDICT : toutes les mutations sont détectées.' : 'VERDICT : au moins une mutation n\'est pas détectée de façon probante.');
process.exit(ok ? 0 : 1);
