// =============================================================================
// Tests de régression du contrôleur de preuves (scripts/check-qualification-evidence.mjs).
//
//   node --test scripts/check-qualification-evidence.test.mjs
//
// Chaque test copie les preuves dans un dossier temporaire NEUF hors du dépôt, les altère, puis
// lance le contrôleur. Les preuves originales ne sont jamais modifiées (vérifié à la fin), et
// le contrôleur ne doit jamais modifier les copies qu'il analyse (vérifié à chaque appel).
// Aucune dépendance (node:test).
// =============================================================================
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-qualification-evidence.mjs');
const EVIDENCE = join(ROOT, 'docs', 'qualification');
const PREFIXES = ['3b-local', 'lot4-local', 'v41-local', 'v42-local'];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const evidenceHashes = () => Object.fromEntries(readdirSync(EVIDENCE).map((f) => [f, sha(join(EVIDENCE, f))]));

let sandbox;
let originals;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'nexora-evidence-test-'));
  originals = evidenceHashes();
});
after(() => {
  rmSync(sandbox, { recursive: true, force: true }); // uniquement le dossier créé par ces tests
});

let n = 0;
/** Copie les trois fichiers d'un jeu de preuves dans un dossier neuf, applique `alter`, renvoie le dossier. */
function evidenceCopy(prefix, alter = () => {}) {
  const dir = join(sandbox, `cas-${++n}`);
  mkdirSync(dir);
  for (const k of ['report.md', 'sql.json', 'http.json']) cpSync(join(EVIDENCE, `${prefix}-${k}`), join(dir, `${prefix}-${k}`));
  const io = {
    json: (k, fn) => { const p = join(dir, `${prefix}-${k}.json`); const j = JSON.parse(readFileSync(p, 'utf8')); fn(j); writeFileSync(p, JSON.stringify(j)); },
    report: (fn) => { const p = join(dir, `${prefix}-report.md`); writeFileSync(p, fn(readFileSync(p, 'utf8'))); },
  };
  alter(io);
  return dir;
}

/** Lance le contrôleur (éventuellement une copie de celui-ci) et vérifie qu'il n'a rien modifié. */
function check(dir, prefix, checker = CHECKER) {
  const files = readdirSync(dir).map((f) => join(dir, f));
  const before = files.map(sha);
  const r = spawnSync(process.execPath, [checker, dir, prefix], { encoding: 'utf8' });
  assert.deepEqual(files.map(sha), before, 'le contrôleur a modifié les preuves analysées');
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const rejected = (res, ...fragments) => {
  assert.equal(res.code, 1, `preuve altérée acceptée :\n${res.out}`);
  for (const f of fragments) assert.match(res.out, f, `message attendu absent (${f}) :\n${res.out}`);
};

/** Ajuste les compteurs du rapport pour masquer une suppression (le cas que l'ancien contrôleur laissait passer). */
const maskSql = (io, total) => io.report((t) => t.replace(/\| Assertions \| (\d+) \| \d+ \|/, `| Assertions | $1 | ${total} |`));
const maskHttp = (io, total) => io.report((t) => t.replace(/Bilan HTTP : \d+ assertions/, `Bilan HTTP : ${total} assertions`));

describe('preuves complètes', () => {
  for (const prefix of PREFIXES) {
    test(`${prefix} : acceptées`, () => {
      const res = check(evidenceCopy(prefix), prefix);
      assert.equal(res.code, 0, res.out);
      assert.match(res.out, /référence [0-9a-f]{16}… \(épinglée\)/);
    });
  }
});

describe('altérations rejetées (lot4-local)', () => {
  const P = 'lot4-local';

  test('assertion SQL passée de true à false', () => {
    rejected(check(evidenceCopy(P, (io) => io.json('sql', (j) => { j.results[42].ok = false; })), P), /1 échec/);
  });

  test('assertion SQL supprimée, compteur du rapport ajusté', () => {
    let total;
    rejected(check(evidenceCopy(P, (io) => { io.json('sql', (j) => { j.results.splice(100, 1); total = j.results.length; }); maskSql(io, total); }), P),
      /1 assertion\(s\) attendue\(s\) absente\(s\)/, /attendues par la référence/);
  });

  test('suite SQL 02 (isolation) supprimée, compteur du rapport ajusté', () => {
    let total;
    rejected(check(evidenceCopy(P, (io) => { io.json('sql', (j) => { j.results = j.results.filter((r) => r.file !== '02_isolation.sql'); total = j.results.length; }); maskSql(io, total); }), P),
      /suite 02_isolation\.sql — 0 assertion\(s\), 402 attendue\(s\) \(SUITE ABSENTE\)/, /matrice d'isolation/);
  });

  test('isolation HTTP supprimée, bilan du rapport ajusté', () => {
    let total;
    rejected(check(evidenceCopy(P, (io) => { io.json('http', (j) => { j.results = j.results.filter((r) => !/ : B | B ne | de A | lignes de A /.test(r.name)); total = j.results.length; }); maskHttp(io, total); }), P),
      /isolation entre deux utilisateurs authentifiés/, /complétude HTTP/);
  });

  test('jusqu\'à 140 assertions HTTP d\'isolation retirées (précision conservée), bilan ajusté', () => {
    let total;
    let removed;
    const dir = evidenceCopy(P, (io) => {
      io.json('http', (j) => { const before = j.results.length; let k = 0; j.results = j.results.filter((r) => !(/ : B /.test(r.name) && k++ < 140)); total = j.results.length; removed = before - total; });
      maskHttp(io, total);
    });
    assert.ok(removed > 100, `retrait trop faible pour être significatif (${removed})`);
    rejected(check(dir, P), new RegExp(`${removed} assertion\\(s\\) attendue\\(s\\) absente\\(s\\)`));
  });

  test('catégorie critique supprimée : contrôles de clé canonique (migration 8)', () => {
    let total;
    rejected(check(evidenceCopy(P, (io) => { io.json('sql', (j) => { j.results = j.results.filter((r) => !/forme canonique|même ligne visée deux fois|clé canonique/.test(r.name)); total = j.results.length; }); maskSql(io, total); }), P),
      /contrôle de clé canonique \(migration 8\)/);
  });

  test('catégorie critique supprimée : contrôles de précision renommés', () => {
    rejected(check(evidenceCopy(P, (io) => io.json('http', (j) => { for (const r of j.results) if (/^API .*identique/.test(r.name)) r.name = `x${r.name}`; })), P),
      /précision des nombres/, /non référencée\(s\) \(ajout ou renommage\)/);
  });

  test('fichier SQL réduit à 10 assertions, rapport ajusté', () => {
    rejected(check(evidenceCopy(P, (io) => { io.json('sql', (j) => { j.results = j.results.slice(0, 10); }); maskSql(io, 10); }), P),
      /10 assertions dans lot4-local-sql\.json, 1847 attendues/);
  });

  test('compteur du rapport modifié seul', () => {
    rejected(check(evidenceCopy(P, (io) => maskSql(io, 1900)), P), /nombre d'assertions SQL du rapport/);
  });

  test('assertion renommée', () => {
    rejected(check(evidenceCopy(P, (io) => io.json('sql', (j) => { j.results[7].name += ' (modifiée)'; })), P), /absente\(s\)/, /non référencée\(s\)/);
  });

  test('assertion ajoutée', () => {
    rejected(check(evidenceCopy(P, (io) => { io.json('sql', (j) => { j.results.push({ file: '02_isolation.sql', name: 'test ajouté', ok: true, detail: null }); }); maskSql(io, 1848); }), P),
      /non référencée\(s\)/);
  });

  test('version PostgreSQL incorrecte', () => {
    rejected(check(evidenceCopy(P, (io) => io.json('sql', (j) => { j.server_version = '16.15'; })), P), /version serveur inattendue/);
  });

  test('migration 8 retirée du rapport', () => {
    rejected(check(evidenceCopy(P, (io) => io.report((t) => t.replace(' 20261101000800`', '`'))), P), /migration\(s\) appliquée\(s\)/, /≠ référence/);
  });

  test('migration remplacée par une autre dans le rapport', () => {
    rejected(check(evidenceCopy(P, (io) => io.report((t) => t.replace('20261101000800`', '20261101000900`'))), P), /≠ référence/);
  });

  test('empreinte des migrations du rapport différente du dépôt', () => {
    const fake = 'a'.repeat(64);
    rejected(check(evidenceCopy(P, (io) => io.report((t) => t.replace('| Fichiers SQL interrompus |', `| Empreinte des migrations | \`${fake}\` |\n| Fichiers SQL interrompus |`))), P),
      /empreinte des migrations du rapport/);
  });
});

describe('référence de complétude protégée', () => {
  /** Copie autonome : contrôleur + références + migrations (le contrôleur lit la référence à côté de lui). */
  function checkerCopy(alterReference) {
    const root = join(sandbox, `racine-${++n}`);
    cpSync(join(ROOT, 'scripts', 'check-qualification-evidence.mjs'), join(root, 'scripts', 'check-qualification-evidence.mjs'));
    cpSync(join(ROOT, 'scripts', 'qualification-reference'), join(root, 'scripts', 'qualification-reference'), { recursive: true });
    cpSync(join(ROOT, 'supabase', 'migrations'), join(root, 'supabase', 'migrations'), { recursive: true });
    const p = join(root, 'scripts', 'qualification-reference', 'lot4-local.json');
    const ref = JSON.parse(readFileSync(p, 'utf8'));
    alterReference(ref);
    writeFileSync(p, `${JSON.stringify(ref, null, 2)}\n`);
    return join(root, 'scripts', 'check-qualification-evidence.mjs');
  }

  test('référence et preuves réduites ENSEMBLE : refusé (empreinte épinglée)', () => {
    let total;
    const dir = evidenceCopy('lot4-local', (io) => { io.json('sql', (j) => { j.results = j.results.filter((r) => r.file !== '02_isolation.sql'); total = j.results.length; }); maskSql(io, total); });
    const checker = checkerCopy((ref) => {
      ref.sql.signatures = ref.sql.signatures.filter((s) => !s.startsWith('02_isolation.sql'));
      delete ref.sql.files['02_isolation.sql'];
      ref.sql.total = total;
      ref.categories = ref.categories.filter((c) => c.id !== 'sql-isolation');
    });
    rejected(check(dir, 'lot4-local', checker), /référence lot4-local\.json modifiée/);
  });

  test('référence absente : refusé', () => {
    const root = join(sandbox, `racine-${++n}`);
    cpSync(CHECKER, join(root, 'scripts', 'check-qualification-evidence.mjs'));
    cpSync(join(ROOT, 'supabase', 'migrations'), join(root, 'supabase', 'migrations'), { recursive: true });
    rejected(check(evidenceCopy('lot4-local'), 'lot4-local', join(root, 'scripts', 'check-qualification-evidence.mjs')), /référence absente/);
  });

  test('--print-reference n\'écrit rien et reproduit exactement la référence versionnée', () => {
    for (const prefix of PREFIXES) {
      const r = spawnSync(process.execPath, [CHECKER, '--print-reference', EVIDENCE, prefix], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, readFileSync(join(ROOT, 'scripts', 'qualification-reference', `${prefix}.json`), 'utf8'));
    }
  });
});

describe('intégrité', () => {
  test('preuves originales du dépôt inchangées', () => {
    assert.deepEqual(evidenceHashes(), originals);
  });
});
