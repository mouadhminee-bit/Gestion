/**
 * V3.5 (critère « 0 requête vers Supabase en mode local ») — graphe des imports STATIQUES de
 * l'application depuis `src/main.tsx` : le mode local ne charge aucun module Cloud. Le mode
 * Cloud n'est atteint que par l'import DYNAMIQUE de `features/auth/CloudApp` (`App.tsx`).
 * Les imports de type seul (`import type`, `export type`) sont effacés à la compilation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // paquet
  if (/\.(css|svg|png|json)$/.test(spec)) return 'asset';
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (existsSync(candidate) && candidate.match(/\.(ts|tsx)$/)) return candidate;
  throw new Error(`import non résolu : ${spec} (${relative(ROOT, from)})`);
}

/** Spécificateurs importés STATIQUEMENT pour leur valeur (hors `import type` / `export type`). */
function staticImports(code: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const m of code.matchAll(re)) {
    if (m[5]) out.push(m[5]);
    else if (!m[2]) out.push(m[4]);
  }
  return out;
}

function staticGraph(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    for (const spec of staticImports(readFileSync(f, 'utf8'))) {
      const target = resolveSpecifier(f, spec);
      if (target === 'asset') continue;
      if (target) queue.push(target);
      else packages.add(spec);
    }
  }
  return { files: [...files].map((f) => relative(ROOT, f)), packages: [...packages] };
}

describe('V3.5 — le mode local ne charge aucun module Cloud', () => {
  const g = staticGraph(join(SRC, 'main.tsx'));

  it('graphe statique : ni `data/cloud`, ni `features/auth`, ni le SDK Supabase', () => {
    expect(g.files).toContain('src/app/Workspace.tsx');
    expect(g.files).toContain('src/pages/Onboarding.tsx');
    expect(g.files.filter((f) => f.startsWith('src/data/cloud/') || f.startsWith('src/features/auth/'))).toEqual([]);
    expect(g.packages.filter((p) => p.startsWith('@supabase/'))).toEqual([]);
  });

  it('le mode Cloud n’est atteint que par l’import dynamique de `CloudApp`', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/lazy\(\(\) => import\('@\/features\/auth\/CloudApp'\)\)/);
    expect(staticImports(app).some((s) => s.includes('features/auth') || s.includes('data/cloud'))).toBe(false);
  });
});
