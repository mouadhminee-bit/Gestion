/**
 * Cohérence entre `apply_changeset` (migration 8, Lot 4.4) et le code TypeScript :
 * la liste blanche SQL est exactement celle du mapping (étape 4.2), et l'enveloppe attendue
 * par la fonction est celle du protocole v1 (`transport.ts`). Aucune base n'est utilisée :
 * le texte de la migration est analysé.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOUD_TABLES, EXCLUDED_TABLES, MAPPING, SERVER_METADATA_COLUMNS, type ColumnSpec } from './mapping';
import { CHANGESET_PROTOCOL } from './transport';

const migration = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261101000800_apply_changeset.sql'), 'utf8');

/** Lignes `('table', array[...], array[...], 'mode')` de l'insertion dans private.changeset_tables. */
function whitelist(): Map<string, { key: string[]; write: string[]; mode: string }> {
  const block = /insert into private\.changeset_tables \(sql_table, key_cols, write_cols, write_mode\) values\n([\s\S]*?);\n/.exec(migration);
  expect(block, 'insertion de la liste blanche trouvée').not.toBeNull();
  const out = new Map<string, { key: string[]; write: string[]; mode: string }>();
  const list = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  for (const m of block![1].matchAll(/\('([a-z_]+)', array\[([^\]]*)\], array\[([^\]]*)\], '([a-z-]+)'\)/g)) {
    out.set(m[1], { key: list(m[2]), write: list(m[3]), mode: m[4] });
  }
  return out;
}

describe('apply_changeset ↔ code TypeScript', () => {
  it('liste blanche SQL ≡ mapping : 18 tables, clés, colonnes écrites, mode d’écriture', () => {
    const wl = whitelist();
    expect(wl.size).toBe(18);
    expect(new Set(wl.keys())).toEqual(new Set(CLOUD_TABLES.map((t) => MAPPING[t].sqlTable)));
    for (const t of CLOUD_TABLES) {
      const spec = MAPPING[t];
      const entry = wl.get(spec.sqlTable)!;
      const cols = (Object.values(spec.fields as Record<string, ColumnSpec | { kind: string }>).filter((f) => f.kind === 'column') as ColumnSpec[])
        .filter((c) => c.writable || spec.sqlKey.includes(c.column))
        .map((c) => c.column);
      expect(entry.key, `${t} : clé`).toEqual([...spec.sqlKey]);
      expect(entry.write, `${t} : colonnes écrites`).toEqual(cols);
      expect(entry.mode, `${t} : mode`).toBe(spec.write);
      for (const meta of SERVER_METADATA_COLUMNS) expect(entry.write, `${t} : ${meta} jamais écrite par le client`).not.toContain(meta);
    }
  });

  it('tables exclues (meta) absentes côté serveur ; aucune table meta créée', () => {
    const wl = whitelist();
    for (const t of Object.keys(EXCLUDED_TABLES)) expect(wl.has(t)).toBe(false);
    expect(migration).not.toMatch(/create table[^;]*\bmeta\b/i);
  });

  it('enveloppe du protocole v1 : mêmes champs et même version que transport.ts', () => {
    expect(CHANGESET_PROTOCOL).toBe(1);
    expect(migration).toContain("p_changeset -> 'protocol' is distinct from '1'::jsonb");
    expect(migration).toContain("array['protocol', 'changesetId', 'userId', 'ops']");
    expect(migration).toContain("k not in ('table', 'type', 'key', 'expectedVersion', 'row')");
    expect(migration).toContain("v_type not in ('put', 'delete')");
    // Confirmation : changesetId, status, versions[{ table, key, version, deleted }].
    expect(migration).toMatch(/jsonb_build_object\('changesetId', v_id, 'versions', to_jsonb\(v_versions\)\)/);
    expect(migration).toMatch(/'table', v_spec\.sql_table, 'key', v_op -> 'key', 'version', v_new_version, 'deleted', v_op ->> 'type' = 'delete'/);
    expect(migration).toContain("jsonb_build_object('status', 'replayed')");
    expect(migration).toContain("jsonb_build_object('changesetId', v_id, 'status', 'abandoned')");
  });

  it('les migrations qualifiées (1 à 7) ne sont pas modifiées par la migration 8', () => {
    expect(migration).not.toMatch(/\b(alter|drop)\s+table\s+public\.\w+\s+(add|drop|alter)\s+column/i);
    expect(migration).not.toMatch(/drop\s+(policy|trigger|function)\b/i);
  });
});
