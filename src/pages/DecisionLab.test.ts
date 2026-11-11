// @vitest-environment jsdom
/**
 * Decision Lab — étape E5.1 : navigation, route chargée à la demande et page « Mes simulations »
 * (React, jsdom, fake-indexeddb). Le store E4 réel est utilisé avec le `sessionStorage` de jsdom ;
 * données entièrement fictives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from '@/App';
import { NAV, NAV_GROUPS, navLabel } from '@/app/nav';
import { AppProvider } from '@/app/AppContext';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Dialog';
import { NexoraDB, setDB } from '@/data/db';
import { LocalRepository } from '@/data/repository';
import { generateDemoData } from '@/data/demo';
import { DECISION_ENGINE_VERSION, type DecisionInput } from '@/domain/calc/decision';
import { LOCAL_USER_ID } from '@/domain/settings';
import { createSnapshot, type DecisionSnapshot } from '@/features/decision/snapshot';
import { DECISION_QUARANTINE_KEY, DECISION_STORE_FORMAT, DECISION_STORE_KEY, loadSimulations, MAX_SIMULATIONS, saveSimulation } from '@/features/decision/store';
import fr from '@/i18n/locales/fr';
import { emptySnapshot, UID } from '@/test/fixtures';
import DecisionLab from './DecisionLab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// API absentes de jsdom, utilisées par les composants (aucun effet sur les données).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo = (() => {}) as never;

let seq = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = '';
});

async function waitFor(cond: () => boolean, timeout = 4000) {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeout) throw new Error('délai dépassé');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const all = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());

const credit: DecisionInput = { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_000, loan: { nominalRateBps: 700, months: 48 } };
const comptant: DecisionInput = { kind: 'purchase', price: 18_000_000, downPayment: 18_000_000, fees: 150_000 };
const recurring: DecisionInput = { kind: 'recurring', monthlyAmount: 50_000 };
const stamp = (k: number) => new Date(Date.UTC(2026, 10, 9, 10, 0, 0) + k * 60_000).toISOString();
const small = (k: number): DecisionSnapshot =>
  createSnapshot({ name: `Simulation ${k}`, situation: { cash: 1_000_000, netWorth: 2_000_000, monthlySavings: 10_000 }, horizonMonths: 12, variants: [{ id: 'v', decision: recurring }], id: `sim-${String(k).padStart(3, '0')}`, createdAt: stamp(k) });
const car = (): DecisionSnapshot =>
  createSnapshot({
    name: 'Voiture : comptant ou crédit',
    situation: { cash: 5_000_000, netWorth: 30_000_000, monthlySavings: 400_000 },
    horizonMonths: 60,
    startMonth: '2026-11',
    variants: [
      { id: 'credit', label: 'Crédit 48 mois', decision: credit },
      { id: 'comptant', decision: comptant },
    ],
    id: 'car',
    createdAt: stamp(500),
  });
const seedRaw = (simulations: unknown[], formatVersion: unknown = DECISION_STORE_FORMAT) => sessionStorage.setItem(DECISION_STORE_KEY, JSON.stringify({ formatVersion, simulations }));

/** Page seule, dans les mêmes fournisseurs que l'application (données financières fictives, figées). */
async function renderPage() {
  const data = emptySnapshot();
  const repo = new LocalRepository(new NexoraDB(`dl-${++seq}`), UID);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const tree: ReactNode = h(MemoryRouter, null, h(TooltipProvider, null, h(ToastProvider, null, h(ConfirmProvider, null, h(AppProvider, { repo, data, children: h(DecisionLab) })))));
  await act(async () => root!.render(tree));
  await waitFor(() => !!q('dl-session-warning'));
  return { data, before: JSON.stringify(data) };
}

describe('Decision Lab — navigation', () => {
  it('entrée dans le groupe Intelligence, après Prévisions, sans décaler les trois premières positions', () => {
    expect(NAV.slice(0, 3).map((n) => n.key)).toEqual(['dashboard', 'transactions', 'budgets']);
    const i = NAV.findIndex((n) => n.key === 'decisionLab');
    expect(NAV[i]).toMatchObject({ to: '/decision-lab', group: 'analyse' });
    expect(NAV[i - 1].key).toBe('forecast');
    expect(NAV_GROUPS.analyse).toBe('Intelligence');
    expect(navLabel(NAV[i])).toBe('Decision Lab');
    expect(NAV.filter((n) => n.to === '/decision-lab')).toHaveLength(1);
  });

  it('route /decision-lab de l\'application : page chargée à la demande, lien de navigation actif', async () => {
    const db = new NexoraDB(`dl-app-${++seq}`);
    setDB(db);
    try {
      await new LocalRepository(db, LOCAL_USER_ID).replaceWithSnapshot(generateDemoData(LOCAL_USER_ID, '2026-11-15', 'Test'));
      saveSimulation(car());
      window.location.hash = '#/decision-lab';
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root!.render(h(App)));
      await waitFor(() => !!q('dl-session-warning'));
      expect(document.querySelector('h1')!.textContent).toBe('Decision Lab');
      expect(all('dl-simulation')).toHaveLength(1);
      const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href="#/decision-lab"]')];
      expect(links.length).toBeGreaterThan(0);
      expect(links.some((a) => a.getAttribute('aria-current') === 'page')).toBe(true);
      expect(links[0].textContent).toContain('Decision Lab');
    } finally {
      act(() => root?.unmount());
      root = null;
      setDB(null);
    }
  });

  it('la page est déclarée en chargement différé dans App.tsx', () => {
    const src = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(src).toContain("const DecisionLab = lazy(() => import('@/pages/DecisionLab'));");
    expect(src).toContain('<Route path="/decision-lab" element={<DecisionLab />} />');
  });
});

describe('Decision Lab — Mes simulations', () => {
  it('liste vide : état vide, compteur 0 / 50, avertissement de durée de vie, aucune erreur', async () => {
    await renderPage();
    expect(document.querySelector('h1')!.textContent).toBe('Decision Lab');
    expect(q('dl-session-warning')!.textContent).toContain('Simulations conservées dans cet onglet uniquement');
    expect(q('dl-session-warning')!.textContent).toContain('disparaissent à la fermeture de l\'onglet');
    expect(q('dl-empty')!.textContent).toContain('Aucune simulation');
    expect(q('dl-empty')!.textContent).toContain('Les simulations que vous enregistrerez apparaîtront ici.');
    expect(q('dl-count')!.textContent).toBe(`0 / ${MAX_SIMULATIONS}`);
    expect(all('dl-simulation')).toHaveLength(0);
    for (const id of ['dl-storage-unavailable', 'dl-unsupported-version', 'dl-corrupted', 'dl-ignored', 'dl-over-limit', 'dl-limit-reached']) expect(q(id), id).toBeNull();
  });

  it('liste remplie : simulations du store, de la plus récente à la plus ancienne', async () => {
    for (const k of [1, 2, 3]) saveSimulation(small(k));
    saveSimulation(car());
    await renderPage();
    expect(all('dl-simulation').map((el) => el.dataset.id)).toEqual(['car', 'sim-003', 'sim-002', 'sim-001']);
    expect(q('dl-count')!.textContent).toBe(`4 / ${MAX_SIMULATIONS}`);
    const first = all('dl-simulation')[0];
    expect(first.textContent).toContain('Voiture : comptant ou crédit');
    expect(first.textContent).toContain('60'); // horizon
    expect(first.textContent).toContain('2026'); // date de création et mois de départ
    expect(q('dl-empty')).toBeNull();
    expect(q('dl-limit-reached')).toBeNull();
  });

  it('consultation d\'une comparaison : hypothèses du snapshot, puis résultats comparés relus sans recalcul (E5.5)', async () => {
    const snap = car();
    saveSimulation(snap);
    await renderPage();
    expect(q('dl-details')).toBeNull();
    expect(q('dl-comparison-badge')!.textContent).toBe('Comparaison');
    await click(button('Détails'));
    const details = q('dl-details')!;
    expect(details.textContent).toContain('Situation initiale');
    expect(details.textContent).toContain('50.000,00'); // trésorerie initiale (format par défaut fr-MA)
    expect(details.textContent).toContain('300.000,00'); // patrimoine initial
    const variants = all('dl-variant');
    expect(variants).toHaveLength(2);
    expect(variants[0].textContent).toContain('Crédit 48 mois');
    expect(variants[0].textContent).toContain('Achat');
    expect(variants[1].textContent).toContain('comptant'); // sans libellé : identifiant
    expect(variants[1].textContent).toContain('Achat');
    expect(details.textContent).toContain('+4.000,00'); // épargne mensuelle de référence
    // Résultats comparés : lus dans le snapshot (aucun moteur appelé), une synthèse par variante.
    const results = details.querySelector<HTMLElement>('[data-testid="dl-cmp-results"]')!;
    expect(results.textContent).toContain('Comparaison sur 60 mois');
    expect(all('dl-cmp-summary').map((el) => el.dataset.variant)).toEqual(['A', 'B']);
    expect(details.querySelector('[data-testid="dl-results"]')).toBeNull(); // pas l'affichage d'une simulation simple
    const fmt = (c: number) => (Math.abs(c) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    for (const v of snap.results.variants) {
      for (const amount of [v.endOfHorizon.cashDelta, v.endOfHorizon.netWorthDelta, v.lowestCash.value]) expect(results.textContent).toContain(fmt(amount));
    }
    // Séries d'un snapshot enregistré : pas de détail mensuel du moteur (capital restant dû non stocké).
    expect(details.querySelector('[data-testid="dl-cmp-chart-extra"]')).toBeNull();
    expect(q('dl-cmp-limits')!.textContent).toContain('le capital restant dû mois par mois ne le sont pas');
    await click(button('Détails'));
    expect(q('dl-details')).toBeNull();
  });

  it('snapshot d\'une autre version du moteur : affiché tel quel, avec un avertissement', async () => {
    seedRaw([{ ...JSON.parse(JSON.stringify(small(1))), engineVersion: DECISION_ENGINE_VERSION + 1 }, small(2)]);
    await renderPage();
    const items = all('dl-simulation');
    expect(items).toHaveLength(2);
    expect(items.find((el) => el.dataset.id === 'sim-001')!.textContent).toContain('Calculée avec une autre version du moteur');
    expect(items.find((el) => el.dataset.id === 'sim-002')!.textContent).not.toContain('Calculée avec une autre version du moteur');
  });
});

describe('Decision Lab — suppression', () => {
  const deleteButton = (id: string) => document.querySelector(`[data-id="${id}"] button[aria-label^="Supprimer"]`);

  it('confirmation demandée ; annuler ne supprime rien', async () => {
    for (const k of [1, 2]) saveSimulation(small(k));
    const { before, data } = await renderPage();
    const raw = sessionStorage.getItem(DECISION_STORE_KEY);
    await click(deleteButton('sim-001'));
    expect(document.body.textContent).toContain('Supprimer cette simulation ?');
    expect(document.body.textContent).toContain('« Simulation 1 » sera supprimée définitivement');
    await click(button('Annuler'));
    expect(sessionStorage.getItem(DECISION_STORE_KEY)).toBe(raw);
    expect(all('dl-simulation')).toHaveLength(2);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('confirmer supprime uniquement la simulation visée, dans le store et à l\'écran', async () => {
    for (const k of [1, 2, 3]) saveSimulation(small(k));
    const { before, data } = await renderPage();
    await click(deleteButton('sim-002'));
    await click(button('Supprimer'));
    await waitFor(() => all('dl-simulation').length === 2);
    expect(all('dl-simulation').map((el) => el.dataset.id)).toEqual(['sim-003', 'sim-001']);
    expect(loadSimulations().simulations.map((s) => s.id)).toEqual(['sim-001', 'sim-003']);
    expect(q('dl-count')!.textContent).toBe(`2 / ${MAX_SIMULATIONS}`);
    expect(document.body.textContent).toContain('Simulation supprimée');
    // Aucune donnée financière réelle touchée ; seule la clé dédiée est écrite.
    expect(JSON.stringify(data)).toBe(before);
    expect(Object.keys(sessionStorage).filter((k) => k !== 'nexora.month')).toEqual([DECISION_STORE_KEY]);
  });

  it('échec d\'écriture : message d\'erreur, simulation conservée', async () => {
    for (const k of [1, 2]) saveSimulation(small(k));
    await renderPage();
    const raw = sessionStorage.getItem(DECISION_STORE_KEY);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === DECISION_STORE_KEY) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      return original.call(this, k, v);
    });
    await click(deleteButton('sim-001'));
    await click(button('Supprimer'));
    await waitFor(() => document.body.textContent!.includes('La simulation n\'a pas pu être supprimée.'));
    expect(all('dl-simulation')).toHaveLength(2);
    expect(sessionStorage.getItem(DECISION_STORE_KEY)).toBe(raw);
  });
});

describe('Decision Lab — limite, stockage indisponible, données invalides', () => {
  it('limite de 50 atteinte : avertissement explicite, les 50 simulations restent affichées', async () => {
    for (let k = 1; k <= MAX_SIMULATIONS; k++) saveSimulation(small(k));
    const raw = sessionStorage.getItem(DECISION_STORE_KEY);
    await renderPage();
    expect(q('dl-limit-reached')!.textContent).toContain('Limite de 50 simulations atteinte');
    expect(q('dl-limit-reached')!.textContent).toContain('Aucune simulation n\'est supprimée automatiquement');
    expect(q('dl-count')!.textContent).toBe('50 / 50');
    expect(all('dl-simulation')).toHaveLength(50);
    expect(sessionStorage.getItem(DECISION_STORE_KEY)).toBe(raw); // afficher ne modifie rien
    // Supprimer une simulation lève l'avertissement.
    await click(document.querySelector('[data-id="sim-001"] button[aria-label^="Supprimer"]'));
    await click(button('Supprimer'));
    await waitFor(() => all('dl-simulation').length === 49);
    expect(q('dl-limit-reached')).toBeNull();
  });

  it('plus de 50 entrées (stockage altéré) : toutes affichées, dépassement signalé', async () => {
    seedRaw(Array.from({ length: 52 }, (_, k) => small(k + 1)));
    await renderPage();
    expect(all('dl-simulation')).toHaveLength(52);
    expect(q('dl-over-limit')!.textContent).toContain('52 simulations pour une limite de 50');
    expect(q('dl-limit-reached')).toBeNull();
  });

  it('stockage indisponible : message d\'erreur, ni liste ni état vide trompeur', async () => {
    const original = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      if (k === DECISION_STORE_KEY) throw new Error('SecurityError');
      return original.call(this, k);
    });
    await renderPage();
    expect(q('dl-storage-unavailable')!.textContent).toContain('Le stockage de l\'onglet est indisponible');
    expect(q('dl-storage-unavailable')!.getAttribute('role')).toBe('alert');
    expect(all('dl-simulation')).toHaveLength(0);
    expect(q('dl-empty')).toBeNull();
  });

  it('entrées invalides ou en double : ignorées et comptées, les valides restent affichées', async () => {
    const missing = JSON.parse(JSON.stringify(small(2)));
    delete missing.results;
    const badAmount = JSON.parse(JSON.stringify(small(3)));
    badAmount.hypotheses.situation.cash = 'beaucoup';
    seedRaw([small(1), missing, badAmount, small(4), small(1)]);
    const raw = sessionStorage.getItem(DECISION_STORE_KEY);
    await renderPage();
    expect(all('dl-simulation').map((el) => el.dataset.id)).toEqual(['sim-004', 'sim-001']);
    expect(q('dl-ignored')!.textContent).toContain('Simulations illisibles ignorées : 3.');
    expect(q('dl-count')!.textContent).toBe('2 / 50');
    // La lecture ne modifie pas le stockage : rien n'est supprimé ni mis en quarantaine à l'affichage.
    expect(sessionStorage.getItem(DECISION_STORE_KEY)).toBe(raw);
    expect(sessionStorage.getItem(DECISION_QUARANTINE_KEY)).toBeNull();
  });

  it('contenu corrompu : message, aucune liste, aucun plantage', async () => {
    sessionStorage.setItem(DECISION_STORE_KEY, '{"formatVersion":1,"simulations":[{');
    await renderPage();
    expect(q('dl-corrupted')!.textContent).toContain('illisibles');
    expect(all('dl-simulation')).toHaveLength(0);
    expect(q('dl-empty')).toBeNull();
    expect(sessionStorage.getItem(DECISION_STORE_KEY)).toBe('{"formatVersion":1,"simulations":[{');
  });

  it('version de format plus récente : message, contenu préservé', async () => {
    seedRaw([{ futur: true }], DECISION_STORE_FORMAT + 1);
    const raw = sessionStorage.getItem(DECISION_STORE_KEY);
    await renderPage();
    expect(q('dl-unsupported-version')!.textContent).toContain('version plus récente');
    expect(all('dl-simulation')).toHaveLength(0);
    expect(sessionStorage.getItem(DECISION_STORE_KEY)).toBe(raw);
  });
});

describe('Decision Lab — traductions', () => {
  // Toutes les langues, chargées comme dans i18n.test.ts. Le contrôle porte sur les clés UTILISÉES par
  // cette page et la navigation : il reste valable quand E5.4 / E5.5 ajouteront leurs propres clés.
  const modules = import.meta.glob<{ default: Record<string, unknown> }>('../i18n/locales/*.ts', { eager: true });
  const locales = Object.entries(modules).map(([path, mod]) => [path.replace(/^.*\/(\w+)\.ts$/, '$1'), mod.default] as const);
  const src = readFileSync(join(process.cwd(), 'src/pages/DecisionLab.tsx'), 'utf8');
  const used = [...new Set([...[...src.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]), 'nav.decisionLab', 'dl.kind.purchase', 'dl.kind.recurring', 'dl.kind.goal', 'dl.kind.investment'])];
  const vars = (m: unknown) => [...String(typeof m === 'string' ? m : JSON.stringify(m)).matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();

  it('chaque clé utilisée existe dans le dictionnaire source', () => {
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(key in fr, key).toBe(true);
  });

  it('chaque clé utilisée existe dans les 24 langues, non vide, avec les mêmes variables', () => {
    expect(locales).toHaveLength(24);
    for (const [lang, messages] of locales) {
      for (const key of used) {
        expect(key in messages, `${lang} ${key}`).toBe(true);
        expect(String(messages[key]).trim(), `${lang} ${key}`).not.toBe('');
        expect(vars(messages[key]), `${lang} ${key}`).toEqual(vars((fr as Record<string, unknown>)[key]));
      }
    }
  });

  it('parité exacte des clés entre les 24 langues', () => {
    const ref = Object.keys(fr).sort();
    for (const [lang, messages] of locales) expect(Object.keys(messages).sort(), lang).toEqual(ref);
  });
});
