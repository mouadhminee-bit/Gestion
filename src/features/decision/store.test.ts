/**
 * Decision Lab — stockage sessionStorage : sauvegarde / relecture, limite de 50, données corrompues,
 * versions inconnues, stockage indisponible ou en erreur, snapshots indépendants, isolation des
 * données financières réelles. Stockage simulé et données entièrement fictives.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { account, ctxOf, emptySnapshot, tx } from '@/test/fixtures';
import { buildInitialSituation } from '@/domain/calc/decisionSituation';
import type { DecisionInput } from '@/domain/calc/decision';
import { createSnapshot, type DecisionSnapshot } from './snapshot';
import * as store from './store';
import {
  clearSimulations,
  DECISION_QUARANTINE_KEY,
  DECISION_STORE_FORMAT,
  DECISION_STORE_KEY,
  deleteSimulation,
  getSimulation,
  loadSimulations,
  MAX_SIMULATIONS,
  saveSimulation,
  type StorageLike,
} from './store';

/** sessionStorage simulé, avec pannes programmables. */
class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  failGet = false;
  failSet: 'quota' | 'error' | 'silent' | 'truncateOnce' | null = null;
  /** Limite la panne d'écriture à une clé (null : toutes). */
  failSetKey: string | null = null;
  getItem(k: string): string | null {
    if (this.failGet) throw new Error('lecture refusée');
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.failSet && (this.failSetKey === null || this.failSetKey === k)) {
      if (this.failSet === 'silent') return;
      if (this.failSet === 'truncateOnce') {
        // Écriture partielle (valeur tronquée), une seule fois : la suivante réussit.
        this.failSet = null;
        this.data.set(k, v.slice(0, Math.floor(v.length / 2)));
        return;
      }
      const e = new Error('échec');
      e.name = this.failSet === 'quota' ? 'QuotaExceededError' : 'SecurityError';
      throw e;
    }
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

const recurring: DecisionInput = { kind: 'recurring', monthlyAmount: 50_000 };
const stamp = (k: number) => new Date(Date.UTC(2026, 10, 9, 10, 0, 0) + k * 60_000).toISOString();
const snap = (k: number, over: { id?: string; createdAt?: string } = {}): DecisionSnapshot =>
  createSnapshot({
    name: `Simulation ${k}`,
    situation: { cash: 1_000_000 + k, netWorth: 2_000_000, monthlySavings: 10_000 },
    horizonMonths: 12,
    variants: [{ id: 'v', decision: recurring }],
    id: over.id ?? `sim-${String(k).padStart(3, '0')}`,
    createdAt: over.createdAt ?? stamp(k),
  });
const rawStore = (st: FakeStorage) => JSON.parse(st.data.get(DECISION_STORE_KEY)!) as { formatVersion: number; simulations: Record<string, any>[] };
const seed = (st: FakeStorage, simulations: unknown[], formatVersion: unknown = DECISION_STORE_FORMAT) => st.data.set(DECISION_STORE_KEY, JSON.stringify({ formatVersion, simulations }));

describe('sauvegarde et relecture', () => {
  it('enregistre, relit à l\'identique, snapshots gelés et triés par date de création', () => {
    const st = new FakeStorage();
    expect(loadSimulations(st)).toEqual({ simulations: [], issues: [], writable: true });
    const b = saveSimulation(snap(2), st);
    const a = saveSimulation(snap(1), st);
    expect(a).toMatchObject({ ok: true, count: 2, issues: [] });
    expect(b.ok).toBe(true);
    const loaded = loadSimulations(st);
    expect(loaded.issues).toEqual([]);
    expect(loaded.simulations).toEqual([snap(1), snap(2)]);
    expect(Object.isFrozen(loaded.simulations[0].results.reference.cash)).toBe(true);
    expect(getSimulation('sim-002', st)).toEqual(snap(2));
    expect(getSimulation('inconnu', st)).toBeNull();
    expect(rawStore(st).formatVersion).toBe(DECISION_STORE_FORMAT);
    expect([...st.data.keys()]).toEqual([DECISION_STORE_KEY]);
  });

  it('refuse un snapshot invalide sans rien écrire', () => {
    const st = new FakeStorage();
    const bad = { ...JSON.parse(JSON.stringify(snap(1))), name: '' };
    const r = saveSimulation(bad, st);
    expect(r).toMatchObject({ ok: false, issue: { code: 'invalidSnapshot' } });
    expect(st.data.size).toBe(0);
    expect(saveSimulation(null, st)).toMatchObject({ ok: false, issue: { code: 'invalidSnapshot' } });
  });

  it('suppression explicite et vidage', () => {
    const st = new FakeStorage();
    for (const k of [1, 2, 3]) saveSimulation(snap(k), st);
    expect(deleteSimulation('sim-002', st)).toEqual({ ok: true, count: 2 });
    expect(deleteSimulation('sim-002', st)).toEqual({ ok: false, issue: { code: 'notFound', id: 'sim-002' } });
    expect(loadSimulations(st).simulations.map((s) => s.id)).toEqual(['sim-001', 'sim-003']);
    expect(clearSimulations(st)).toEqual({ ok: true, count: 0 });
    expect(loadSimulations(st)).toEqual({ simulations: [], issues: [], writable: true });
  });
});

describe('snapshots indépendants, jamais écrasés', () => {
  it('un identifiant déjà présent est refusé ; l\'original reste intact', () => {
    const st = new FakeStorage();
    saveSimulation(snap(1), st);
    const before = st.data.get(DECISION_STORE_KEY);
    const other = createSnapshot({ name: 'Autre contenu', situation: { cash: 1, netWorth: 1, monthlySavings: 0 }, horizonMonths: 6, variants: [{ id: 'v', decision: recurring }], id: 'sim-001', createdAt: stamp(9) });
    expect(saveSimulation(other, st)).toEqual({ ok: false, issue: { code: 'duplicateId', id: 'sim-001' } });
    expect(st.data.get(DECISION_STORE_KEY)).toBe(before);
    expect(getSimulation('sim-001', st)!.name).toBe('Simulation 1');
  });

  it('aucune API de mise à jour', () => {
    expect(Object.keys(store).filter((k) => typeof (store as Record<string, unknown>)[k] === 'function').sort()).toEqual(['clearSimulations', 'deleteSimulation', 'getSimulation', 'loadSimulations', 'saveSimulation']);
  });

  it('enregistrer une simulation ne modifie pas les autres ; un recalcul s\'ajoute', () => {
    const st = new FakeStorage();
    saveSimulation(snap(1), st);
    const first = JSON.stringify(rawStore(st).simulations[0]);
    const recalcul = createSnapshot({ name: 'Simulation 1 (recalcul)', situation: { cash: 9, netWorth: 9, monthlySavings: 0 }, horizonMonths: 24, variants: [{ id: 'v', decision: recurring }], createdAt: stamp(5) });
    expect(saveSimulation(recalcul, st)).toMatchObject({ ok: true, count: 2 });
    expect(JSON.stringify(rawStore(st).simulations[0])).toBe(first);
    expect(loadSimulations(st).simulations.map((s) => s.name)).toEqual(['Simulation 1', 'Simulation 1 (recalcul)']);
  });

  it('modifier l\'objet après l\'enregistrement, ou un snapshot relu, ne change pas le stockage', () => {
    const st = new FakeStorage();
    const draft = JSON.parse(JSON.stringify(snap(1))) as Record<string, any>;
    const r = saveSimulation(draft, st);
    draft.name = 'modifié';
    draft.results.variants[0].cashDelta[12] = 0;
    expect(getSimulation('sim-001', st)).toEqual(snap(1));
    if (r.ok) expect(() => ((r.snapshot as { name: string }).name = 'x')).toThrow(TypeError);
    const loaded = loadSimulations(st).simulations[0];
    expect(() => (loaded.hypotheses.situation as { cash: number }).cash++).toThrow(TypeError);
    expect(getSimulation('sim-001', st)).toEqual(snap(1));
  });
});

describe('limite de 50 simulations : refus explicite, aucune suppression automatique', () => {
  const fill = (st: FakeStorage, n = MAX_SIMULATIONS) => {
    for (let k = 1; k <= n; k++) expect(saveSimulation(snap(k), st)).toMatchObject({ ok: true, count: k });
  };
  const limitReached = (count = MAX_SIMULATIONS) => ({ ok: false, issue: { code: 'limitReached', limit: MAX_SIMULATIONS, count } });

  it('50 simulations sont conservées', () => {
    const st = new FakeStorage();
    fill(st);
    const ids = loadSimulations(st).simulations.map((s) => s.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('sim-001');
    expect(ids[49]).toBe('sim-050');
  });

  it('la 51e est refusée avec une erreur métier explicite ; aucune donnée existante n\'est perdue', () => {
    const st = new FakeStorage();
    fill(st);
    const before = st.data.get(DECISION_STORE_KEY);
    expect(saveSimulation(snap(51), st)).toEqual(limitReached());
    // Même une simulation plus récente, ou plus ancienne que toutes les autres, est refusée.
    expect(saveSimulation(snap(99, { id: 'ancienne', createdAt: stamp(-500) }), st)).toEqual(limitReached());
    expect(st.data.get(DECISION_STORE_KEY)).toBe(before);
    expect(st.data.has(DECISION_QUARANTINE_KEY)).toBe(false);
    const loaded = loadSimulations(st);
    expect(loaded.issues).toEqual([]);
    expect(loaded.simulations).toEqual(Array.from({ length: 50 }, (_, k) => snap(k + 1)));
    expect(getSimulation('sim-051', st)).toBeNull();
  });

  it('après une suppression explicite, un nouvel enregistrement redevient possible', () => {
    const st = new FakeStorage();
    fill(st);
    expect(deleteSimulation('sim-010', st)).toEqual({ ok: true, count: 49 });
    expect(saveSimulation(snap(51), st)).toMatchObject({ ok: true, count: 50 });
    expect(saveSimulation(snap(52), st)).toEqual(limitReached());
    const ids = loadSimulations(st).simulations.map((s) => s.id);
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain('sim-010');
    expect(ids).toContain('sim-051');
  });

  it('le refus pour doublon reste prioritaire et explicite à la limite', () => {
    const st = new FakeStorage();
    fill(st);
    expect(saveSimulation(snap(3), st)).toEqual({ ok: false, issue: { code: 'duplicateId', id: 'sim-003' } });
  });

  it('stockage contenant plus de 50 entrées (altéré) : toutes conservées, dépassement signalé, ajout refusé', () => {
    const st = new FakeStorage();
    seed(st, Array.from({ length: 53 }, (_, k) => snap(k + 1)));
    const loaded = loadSimulations(st);
    expect(loaded.simulations).toHaveLength(53);
    expect(loaded.issues).toEqual([{ code: 'overLimit', limit: MAX_SIMULATIONS, count: 53 }]);
    expect(loaded.writable).toBe(true);
    expect(saveSimulation(snap(60), st)).toEqual(limitReached(53));
    // Une suppression explicite ne fait disparaître que la simulation visée ; aucune quarantaine.
    expect(deleteSimulation('sim-001', st)).toEqual({ ok: true, count: 52 });
    expect(loadSimulations(st).simulations.map((s) => s.id)).toEqual(Array.from({ length: 52 }, (_, k) => `sim-${String(k + 2).padStart(3, '0')}`));
    expect(st.data.has(DECISION_QUARANTINE_KEY)).toBe(false);
  });
});

describe('données corrompues, incomplètes ou incompatibles', () => {
  it('JSON corrompu : lecture vide signalée, puis écriture possible avec quarantaine du contenu', () => {
    const st = new FakeStorage();
    st.data.set(DECISION_STORE_KEY, '{"formatVersion":1,"simulations":[{"id":');
    expect(loadSimulations(st)).toEqual({ simulations: [], issues: [{ code: 'corruptedJson' }], writable: true });
    expect(st.data.get(DECISION_STORE_KEY)).toBe('{"formatVersion":1,"simulations":[{"id":'); // la lecture ne modifie rien
    const r = saveSimulation(snap(1), st);
    expect(r).toMatchObject({ ok: true, count: 1, issues: [{ code: 'corruptedJson' }] });
    expect(st.data.get(DECISION_QUARANTINE_KEY)).toBe('{"formatVersion":1,"simulations":[{"id":');
    expect(loadSimulations(st)).toMatchObject({ simulations: [snap(1)], issues: [] });
  });

  for (const [label, value] of [
    ['tableau', '[]'],
    ['nombre', '42'],
    ['null', 'null'],
    ['texte', '"abc"'],
    ['sans version', '{"simulations":[]}'],
    ['version textuelle', '{"formatVersion":"1","simulations":[]}'],
    ['version nulle', '{"formatVersion":0,"simulations":[]}'],
    ['version décimale', '{"formatVersion":1.5,"simulations":[]}'],
    ['simulations non tableau', '{"formatVersion":1,"simulations":{}}'],
    ['clé inconnue', '{"formatVersion":1,"simulations":[],"extra":true}'],
  ] as const) {
    it(`enveloppe invalide (${label}) : lecture vide, aucune exception`, () => {
      const st = new FakeStorage();
      st.data.set(DECISION_STORE_KEY, value);
      expect(loadSimulations(st)).toEqual({ simulations: [], issues: [{ code: 'invalidEnvelope' }], writable: true });
      expect(getSimulation('x', st)).toBeNull();
    });
  }

  it('version inconnue plus récente : lecture vide, écriture, suppression et vidage refusés, contenu préservé', () => {
    const st = new FakeStorage();
    const future = JSON.stringify({ formatVersion: DECISION_STORE_FORMAT + 1, simulations: [{ nouveau: 'format' }] });
    st.data.set(DECISION_STORE_KEY, future);
    const issue = { code: 'unsupportedVersion', details: [`formatVersion ${DECISION_STORE_FORMAT + 1}`] };
    expect(loadSimulations(st)).toEqual({ simulations: [], issues: [issue], writable: false });
    expect(saveSimulation(snap(1), st)).toEqual({ ok: false, issue });
    expect(deleteSimulation('x', st)).toEqual({ ok: false, issue });
    expect(clearSimulations(st)).toEqual({ ok: false, issue });
    expect(st.data.get(DECISION_STORE_KEY)).toBe(future);
    expect(st.data.has(DECISION_QUARANTINE_KEY)).toBe(false);
  });

  it('entrées invalides parmi des valides : valides conservées, invalides signalées avec leur position', () => {
    const st = new FakeStorage();
    const missing = JSON.parse(JSON.stringify(snap(2)));
    delete missing.results;
    const nan = JSON.parse(JSON.stringify(snap(3)));
    nan.hypotheses.situation.cash = null; // NaN sérialisé
    const badKind = JSON.parse(JSON.stringify(snap(4)));
    badKind.hypotheses.variants[0].decision.kind = 'inconnu';
    const badDate = JSON.parse(JSON.stringify(snap(5)));
    badDate.createdAt = 'hier';
    seed(st, [snap(1), missing, nan, 'pas un objet', badKind, badDate, null, snap(6), snap(1)]);
    const loaded = loadSimulations(st);
    expect(loaded.simulations.map((s) => s.id)).toEqual(['sim-001', 'sim-006']);
    expect(loaded.writable).toBe(true);
    expect(loaded.issues.map((i) => [i.code, i.index])).toEqual([
      ['invalidSnapshot', 1],
      ['invalidSnapshot', 2],
      ['invalidSnapshot', 3],
      ['invalidSnapshot', 4],
      ['invalidSnapshot', 5],
      ['invalidSnapshot', 6],
      ['duplicateStoredId', 8],
    ]);
    expect(loaded.issues[0].details!.join()).toMatch(/results : champ manquant/);
    expect(loaded.issues[1].details!.join()).toMatch(/situation\.cash : entier attendu/);

    // Première écriture : le contenu brut (entrées ignorées comprises) part en quarantaine.
    const before = st.data.get(DECISION_STORE_KEY)!;
    const r = saveSimulation(snap(7), st);
    expect(r).toMatchObject({ ok: true, count: 3 });
    if (r.ok) expect(r.issues).toHaveLength(7);
    expect(st.data.get(DECISION_QUARANTINE_KEY)).toBe(before);
    expect(loadSimulations(st)).toMatchObject({ issues: [], simulations: [{ id: 'sim-001' }, { id: 'sim-006' }, { id: 'sim-007' }] });
  });
});

describe('sessionStorage indisponible ou en erreur', () => {
  const g = globalThis as { sessionStorage?: unknown };
  afterEach(() => {
    delete g.sessionStorage;
  });
  const unavailable = { simulations: [], issues: [{ code: 'storageUnavailable' }], writable: false };
  const refused = { ok: false, issue: { code: 'storageUnavailable' } };

  it('absent (stockage null ou environnement sans sessionStorage)', () => {
    expect(loadSimulations(null)).toEqual(unavailable);
    expect(saveSimulation(snap(1), null)).toEqual(refused);
    expect(deleteSimulation('x', null)).toEqual(refused);
    expect(clearSimulations(null)).toEqual(refused);
    expect(getSimulation('x', null)).toBeNull();
    // Stockage par défaut : `globalThis.sessionStorage` n'existe pas dans cet environnement de test.
    expect(g.sessionStorage).toBeUndefined();
    expect(loadSimulations()).toEqual(unavailable);
    expect(saveSimulation(snap(1))).toEqual(refused);
  });

  it('accès à sessionStorage refusé (exception à la lecture de la propriété)', () => {
    Object.defineProperty(g, 'sessionStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });
    expect(loadSimulations()).toEqual(unavailable);
    expect(saveSimulation(snap(1))).toEqual(refused);
    expect(clearSimulations()).toEqual(refused);
  });

  it('stockage par défaut : utilise globalThis.sessionStorage quand il existe', () => {
    const st = new FakeStorage();
    Object.defineProperty(g, 'sessionStorage', { configurable: true, value: st });
    expect(saveSimulation(snap(1))).toMatchObject({ ok: true, count: 1 });
    expect(loadSimulations().simulations).toEqual([snap(1)]);
    expect(st.data.has(DECISION_STORE_KEY)).toBe(true);
  });

  it('lecture en erreur : indisponible, sans exception', () => {
    const st = new FakeStorage();
    saveSimulation(snap(1), st);
    st.failGet = true;
    expect(loadSimulations(st)).toEqual(unavailable);
    expect(saveSimulation(snap(2), st)).toEqual(refused);
  });

  it('quota dépassé à l\'écriture : erreur explicite, contenu précédent intact', () => {
    const st = new FakeStorage();
    saveSimulation(snap(1), st);
    const before = st.data.get(DECISION_STORE_KEY);
    st.failSet = 'quota';
    expect(saveSimulation(snap(2), st)).toEqual({ ok: false, issue: { code: 'quotaExceeded' } });
    expect(deleteSimulation('sim-001', st)).toEqual({ ok: false, issue: { code: 'quotaExceeded' } });
    st.failSet = null;
    expect(st.data.get(DECISION_STORE_KEY)).toBe(before);
    expect(loadSimulations(st).simulations).toEqual([snap(1)]);
  });

  it('écriture en erreur ou ignorée silencieusement : writeFailed', () => {
    const st = new FakeStorage();
    st.failSet = 'error';
    expect(saveSimulation(snap(1), st)).toEqual({ ok: false, issue: { code: 'writeFailed' } });
    st.failSet = 'silent';
    expect(saveSimulation(snap(1), st)).toEqual({ ok: false, issue: { code: 'writeFailed' } });
    expect(st.data.size).toBe(0);
  });

  it('écriture partielle détectée à la relecture : le contenu précédent est rétabli', () => {
    const st = new FakeStorage();
    saveSimulation(snap(1), st);
    const before = st.data.get(DECISION_STORE_KEY);
    st.failSet = 'truncateOnce';
    expect(saveSimulation(snap(2), st)).toEqual({ ok: false, issue: { code: 'writeFailed' } });
    expect(st.data.get(DECISION_STORE_KEY)).toBe(before);
    expect(loadSimulations(st)).toMatchObject({ simulations: [snap(1)], issues: [] });
    // Stockage vide au départ : l'écriture partielle est retirée.
    const empty = new FakeStorage();
    empty.failSet = 'truncateOnce';
    expect(saveSimulation(snap(1), empty)).toEqual({ ok: false, issue: { code: 'writeFailed' } });
    expect(empty.data.has(DECISION_STORE_KEY)).toBe(false);
  });

  it('quarantaine impossible : l\'écriture principale réussit quand même', () => {
    const st = new FakeStorage();
    st.data.set(DECISION_STORE_KEY, 'corrompu');
    st.failSet = 'quota';
    st.failSetKey = DECISION_QUARANTINE_KEY;
    expect(saveSimulation(snap(1), st)).toMatchObject({ ok: true, count: 1 });
    expect(st.data.has(DECISION_QUARANTINE_KEY)).toBe(false);
  });
});

describe('isolation des données financières réelles', () => {
  it('seules les clés dédiées sont écrites ; les autres clés de l\'application ne changent pas', () => {
    const st = new FakeStorage();
    const others: [string, string][] = [
      ['nexora.month', '2026-11'],
      ['nexora.tx-filters', '{"accountId":"acc-1"}'],
      ['nexora.analytics', '{"preset":"month"}'],
      ['nexora.lastAccount', 'acc-1'],
    ];
    for (const [k, v] of others) st.data.set(k, v);
    st.data.set(DECISION_STORE_KEY, 'corrompu');
    saveSimulation(snap(1), st);
    saveSimulation(snap(2), st);
    deleteSimulation('sim-001', st);
    clearSimulations(st);
    for (const [k, v] of others) expect(st.data.get(k)).toBe(v);
    expect([...st.data.keys()].filter((k) => !others.some(([o]) => o === k))).toEqual([DECISION_QUARANTINE_KEY]);
  });

  it('simuler et enregistrer à partir de données réelles ne les modifie pas', () => {
    const bank = account({ id: 'bank', initialBalance: 1_000_000 });
    const data = emptySnapshot({
      accounts: [bank],
      transactions: [tx({ accountId: 'bank', type: 'income', amount: 800_000, date: '2026-09-05' }), tx({ accountId: 'bank', type: 'expense', amount: 300_000, date: '2026-09-10' })],
    });
    const freeze = (o: unknown): void => {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.values(o).forEach(freeze);
        Object.freeze(o);
      }
    };
    freeze(data);
    const before = JSON.stringify(data);
    const situation = buildInitialSituation(ctxOf(data), data, '2026-11-09');
    const st = new FakeStorage();
    const s = createSnapshot({ name: 'Depuis mes données', situation, horizonMonths: 24, variants: [{ id: 'v', decision: recurring }] });
    expect(saveSimulation(s, st).ok).toBe(true);
    expect(JSON.stringify(data)).toBe(before);
    // Le snapshot est autonome : aucun identifiant de compte ou de transaction n'y figure.
    const stored = st.data.get(DECISION_STORE_KEY)!;
    expect(stored).not.toContain('bank');
    expect(stored).not.toMatch(/accountId|transaction|budget/i);
    expect(getSimulation(s.id, st)!.hypotheses.situation).toEqual({ cash: 1_500_000, netWorth: 1_500_000, monthlySavings: 500_000 });
  });

  it('le module de stockage n\'importe aucune couche de données', () => {
    for (const file of ['store.ts', 'snapshot.ts']) {
      const src = readFileSync(join(process.cwd(), 'src/features/decision', file), 'utf8');
      // Seules les lignes d'import comptent (les commentaires citent ces couches pour les exclure).
      const imports = src.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l) || /^\s*\}?\s*from '/.test(l));
      expect(imports.length, file).toBeGreaterThan(0);
      for (const line of imports) expect(line, file).not.toMatch(/@\/data|dexie|repository|AppContext/i);
      // Aucun accès à un autre stockage que sessionStorage (hors commentaires).
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/indexedDB|localStorage/);
    }
  });
});
