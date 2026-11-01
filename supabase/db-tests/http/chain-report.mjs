#!/usr/bin/env node
// =============================================================================
// Chaîne numérique complète (étape 3b) : pour chaque taux envoyé par l'API, assemble
//   1. le JSON envoyé par JavaScript (et ses bits IEEE-754) ;
//   2. la lecture du corps par PostgREST (json_to_recordset — vérifiée par 10_api_serialization.sql) ;
//   3. les bits réellement stockés (float8send) ;
//   4. la valeur relue directement en SQL (réglage de la session, puis extra_float_digits = 1) ;
//   5. les réglages de sérialisation des sessions de l'API (serveur, rôles) ;
//   6. les réponses JSON brutes de PostgREST (écriture et lecture) ;
//   7. la valeur reconstruite par JavaScript (et ses bits),
// puis désigne l'étape de la perte éventuelle.
// Lancé par scripts/qualify-supabase.sh (pile locale uniquement). Aucune dépendance.
// Usage : node chain-report.mjs <chain.json> <rapport.md>   (variable DB_CONTAINER)
// =============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [chainPath, outPath] = process.argv.slice(2);
const container = process.env.DB_CONTAINER;
if (!chainPath || !outPath || !container) {
  console.error('Usage : DB_CONTAINER=<conteneur> node chain-report.mjs <chain.json> <rapport.md>');
  process.exit(2);
}
const chain = JSON.parse(readFileSync(chainPath, 'utf8'));
const sql = (q) =>
  execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', container, 'psql', '-X', '-q', '-tA', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-c', q], { encoding: 'utf8' }).trim();
const ident = (s) => (/^[a-z_]+$/.test(s) ? s : (() => { throw new Error(`identifiant refusé : ${s}`); })());
const uuid = (s) => (/^[0-9a-f-]{36}$/.test(s) ? s : (() => { throw new Error(`uuid refusé : ${s}`); })());

const server = sql("select format('%s (source : %s, fichier : %s)', setting, source, coalesce(sourcefile, '—')) from pg_settings where name = 'extra_float_digits'");
const roles = sql("select string_agg(format('%s → %s', rolname, coalesce(array_to_string(rolconfig, ', '), 'aucun réglage')), ' ; ' order by rolname) from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator')");

const rows = chain.map((c) => {
  const where = `from public.${ident(c.table)} where id = '${uuid(c.id)}'`;
  const stored = sql(`select encode(float8send(${ident(c.column)}), 'hex') ${where}`);
  const sqlSession = sql(`select ${ident(c.column)}::text ${where}`);
  const sqlExact = sql(`set extra_float_digits = 1; select ${ident(c.column)}::text ${where}`);
  const losses = [];
  if (stored !== c.bits_js) losses.push('écriture/stockage');
  if (c.write_bits !== c.bits_js) losses.push('sérialisation (réponse d\'écriture)');
  if (c.read_bits !== c.bits_js) losses.push('sérialisation (réponse de lecture)');
  return { ...c, stored, sqlSession, sqlExact, verdict: losses.length ? `PERTE : ${losses.join(', ')}` : 'exact de bout en bout' };
});

const md = [
  '## Chaîne numérique (taux de change et d\'intérêt)',
  '',
  `* Étape 5 — réglage du serveur hérité par les sessions : \`extra_float_digits = ${server}\``,
  `* Étape 5 — réglages des rôles endossés par PostgREST : ${roles}`,
  '* Étape 2 — PostgREST lit le corps JSON par `json_to_recordset` ; lecture vérifiée sur les bits par `10_api_serialization.sql`.',
  '',
  '| Valeur | 1. JSON envoyé (bits JS) | 3. Bits stockés | 4. SQL : session / `extra_float_digits = 1` | 6. Réponse écriture / lecture (brutes) | 7. Valeur JS relue (bits) | Verdict |',
  '|---|---|---|---|---|---|---|',
  ...rows.map((r) =>
    `| ${r.label} | \`${r.sent_json}\` (\`${r.bits_js}\`) | \`${r.stored}\` | \`${r.sqlSession}\` / \`${r.sqlExact}\` | \`${r.write_raw}\` / \`${r.read_raw}\` | \`${r.read_value}\` (\`${r.read_bits}\`) | ${r.verdict} |`),
  '',
].join('\n');
writeFileSync(outPath, md);
console.log(md);
process.exit(rows.some((r) => r.verdict !== 'exact de bout en bout') ? 1 : 0);
