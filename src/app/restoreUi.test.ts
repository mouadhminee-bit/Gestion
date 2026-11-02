// @vitest-environment jsdom
/**
 * Restauration côté interface (React, jsdom, fake-indexeddb, données fictives).
 *
 *  - 18 : les filtres / le mois mémorisés ne masquent plus les données restaurées ;
 *  - 19 : le contexte (instantané, KPI) est recalculé dès la fin de la restauration ;
 *  - 12 : des paramètres incomplets en base ne provoquent pas d'écran blanc ;
 *  - parcours complet de la page Paramètres : aperçu, sauvegarde de sécurité
 *    téléchargée, restauration, réinitialisation des états mémorisés.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { NexoraDB } from '@/data/db';
import { LocalRepository } from '@/data/repository';
import { generateDemoData } from '@/data/demo';
import { AppProvider, useApp, useSnapshot } from '@/app/AppContext';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Dialog';
import { TransactionFormProvider } from '@/features/transactions/TransactionForm';
import Transactions from '@/pages/Transactions';
import Settings from '@/pages/Settings';
import { RestoreUndoBanner } from '@/features/backup/RestoreUndo';
import { undoStore } from '@/data/backup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildContext, summarizePeriod } from '@/domain/calc/ledger';
import { monthPeriod, monthKey, todayISO } from '@/domain/dates';
import { LAST_ACCOUNT_KEY, MONTH_KEY, SESSION_KEYS_RESET_ON_RESTORE } from './uiState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// API absentes de jsdom, utilisées par les composants (aucun effet sur les données).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
Element.prototype.scrollIntoView ??= () => {};
// jsdom : Blob/File sans text() (présent dans tous les navigateurs ciblés).
Blob.prototype.text ??= function (this: Blob) {
  return new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsText(this);
  });
};
window.scrollTo = (() => {}) as never;

let seq = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  undoStore.clear(); // après le démontage : aucune mise à jour hors act()
  container?.remove();
  root = null;
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function newRepo(today = todayISO('Africa/Casablanca')) {
  const repo = new LocalRepository(new NexoraDB(`ui-${++seq}`), 'local-user');
  await repo.replaceWithSnapshot(generateDemoData(repo.userId, today, 'Test'));
  return repo;
}

/** Probe : expose le contexte courant (mois, nombre d'opérations, KPI du mois). */
function Probe() {
  const { data, ctx, month } = useApp();
  const kpi = summarizePeriod(ctx, data.transactions, monthPeriod(month));
  return h('output', { 'data-testid': 'probe', 'data-month': month, 'data-tx': data.transactions.length, 'data-income': kpi.income, 'data-expenses': kpi.grossExpenses, 'data-locale': data.settings.locale });
}

function Harness({ repo, children }: { repo: LocalRepository; children: ReactNode }) {
  const snapshot = useSnapshot(repo);
  if (!snapshot) return h('p', null, 'loading');
  return h(
    MemoryRouter,
    null,
    h(TooltipProvider, null, h(ToastProvider, null, h(ConfirmProvider, null, h(AppProvider, { repo, data: snapshot, children: h(TransactionFormProvider, null, h(RestoreUndoBanner), children, h(Probe)) })))),
  );
}

async function render(repo: LocalRepository, page: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(h(Harness, { repo, children: page })));
  await waitFor(() => !!probe());
}

const probe = () => document.querySelector<HTMLElement>('[data-testid="probe"]');
const rows = () => container!.querySelectorAll('input[type="checkbox"]').length;

async function waitFor(cond: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('délai dépassé');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

describe('restauration — interface', () => {
  it('18-19 page Transactions : filtre mémorisé sur un compte de l’ancien jeu → données restaurées visibles, KPI recalculés', async () => {
    const repo = await newRepo();
    const before = (await repo.snapshot())!;
    const oldAccount = before.accounts[0].id;
    // Filtre mémorisé (sessionStorage) sur un compte de l'ancien jeu de données.
    sessionStorage.setItem('nexora.tx-filters', JSON.stringify({ period: 'all', accountId: oldAccount }));
    await render(repo, h(Transactions));
    await waitFor(() => rows() > 0);

    // Autre jeu de données (identifiants différents), restauré directement par le repository.
    const other = await newRepo('2026-05-20');
    const file = JSON.parse(JSON.stringify(await other.exportBackup()));
    const otherSnap = (await other.snapshot())!;
    expect(otherSnap.accounts.some((a) => a.id === oldAccount)).toBe(false);
    await act(async () => repo.restoreBackup(file));
    await waitFor(() => probe()!.dataset.tx === String(otherSnap.transactions.length));

    // Le filtre obsolète est ignoré : la liste n'est pas vide.
    await waitFor(() => rows() > 0);
    expect(rows()).toBeGreaterThan(0);
    // KPI du mois affiché recalculés sur les données restaurées.
    const month = probe()!.dataset.month!;
    const expected = summarizePeriod(buildContext(otherSnap), otherSnap.transactions, monthPeriod(month));
    expect(Number(probe()!.dataset.income)).toBe(expected.income);
    expect(Number(probe()!.dataset.expenses)).toBe(expected.grossExpenses);
  });

  it('12 paramètres incomplets en base (écrits sans validation) : pas d’écran blanc, valeurs par défaut en mémoire', async () => {
    const repo = await newRepo();
    const s = (await repo.getSettings())!;
    const broken = { ...s } as Record<string, unknown>;
    delete broken.locale;
    delete broken.budgetAlertThresholds;
    broken.dateFormat = null;
    await repo.db.settings.put(broken as never); // contourne volontairement la validation
    await render(repo, h(Transactions));
    expect(probe()!.dataset.locale).toBeTruthy();
    expect(container!.textContent).not.toBe('');
    expect((await repo.getSettings())!.locale).toBeUndefined(); // la base n'est pas modifiée par l'affichage
  });

  it('parcours Paramètres : aperçu, sauvegarde de sécurité téléchargée, restauration, filtres et mois réinitialisés', async () => {
    const repo = await newRepo();
    const other = await newRepo('2026-03-10');
    const otherSnap = (await other.snapshot())!;
    const backup = JSON.stringify(await other.exportBackup());
    sessionStorage.setItem('nexora.tx-filters', JSON.stringify({ accountId: 'x' }));
    sessionStorage.setItem('nexora.analytics', JSON.stringify({ categoryId: 'y' }));
    sessionStorage.setItem('nexora.analytics.recurringTab', JSON.stringify('budget'));
    sessionStorage.setItem(MONTH_KEY, '2030-01');
    localStorage.setItem(LAST_ACCOUNT_KEY, 'compte-obsolete');
    const downloads: string[] = [];
    URL.createObjectURL = (() => 'blob:x') as never;
    URL.revokeObjectURL = (() => {}) as never;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });

    await render(repo, h(Settings));
    const input = container!.querySelector<HTMLInputElement>('[data-testid="restore-input"]')!;
    const file = new File([backup], 'sauvegarde.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));

    // Aperçu affiché, aucune écriture avant confirmation.
    await waitFor(() => !!document.querySelector('[data-testid="restore-preview"]'));
    const preview = document.querySelector('[data-testid="restore-preview"]')!;
    const tr = preview.querySelector('tr[data-table="transactions"]')!;
    expect(tr.textContent).toContain(String(otherSnap.transactions.length));
    expect(downloads).toEqual([]);
    expect((await repo.snapshot())!.accounts.map((a) => a.id)).not.toEqual(otherSnap.accounts.map((a) => a.id));

    const confirmBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Restaurer')!;
    await act(async () => confirmBtn.click());
    await waitFor(() => probe()!.dataset.tx === String(otherSnap.transactions.length));

    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^nexora-securite-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
    for (const k of SESSION_KEYS_RESET_ON_RESTORE) expect(sessionStorage.getItem(k), k).toBeNull();
    expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBeNull();
    // Mois positionné sur des données restaurées (ici, le mois courant n'en contient pas).
    const latest = otherSnap.transactions.map((t) => t.date).filter((d) => d <= todayISO('Africa/Casablanca')).sort().at(-1)!;
    const expectedMonth = otherSnap.transactions.some((t) => t.date.slice(0, 7) === monthKey(todayISO('Africa/Casablanca'))) ? monthKey(todayISO('Africa/Casablanca')) : latest.slice(0, 7);
    expect(sessionStorage.getItem(MONTH_KEY)).toBe(expectedMonth);
    expect(probe()!.dataset.month).toBe(expectedMonth);
    expect(Number(probe()!.dataset.income) + Number(probe()!.dataset.expenses)).toBeGreaterThan(0);
  });

  it('parcours Paramètres : fichier invalide → message, aucune écriture, aucun téléchargement', async () => {
    const repo = await newRepo();
    const before = JSON.stringify((await repo.exportBackup()).data);
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    await render(repo, h(Settings));
    const input = container!.querySelector<HTMLInputElement>('[data-testid="restore-input"]')!;
    const bad = { app: 'nexora', schemaVersion: 1, exportedAt: '2026-01-01T00:00:00Z', data: { settings: [{}], Transactions: [] } };
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(bad)], 'x.json')], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await waitFor(() => /Sauvegarde refusée/.test(document.body.textContent ?? ''));
    expect(document.body.textContent).toMatch(/Table inconnue : Transactions/);
    expect(document.querySelector('[data-testid="restore-preview"]')).toBeNull();
    expect(downloads).toEqual([]);
    expect(JSON.stringify((await repo.exportBackup()).data)).toBe(before);
  });

  // --- Annulation immédiate (P18) ------------------------------------------------------
  // jsdom : import.meta.url n'est pas une URL file: ; vitest s'exécute à la racine du dépôt.
  const V1 = readFileSync(join(process.cwd(), 'src/data/backup/__fixtures__/backup-v1-2026-10-31.json'), 'utf8');
  const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  const banner = () => document.querySelector('[data-testid="restore-undo-banner"]');

  async function restoreFixtureViaSettings(repo: LocalRepository, downloads: string[]) {
    URL.createObjectURL = (() => 'blob:x') as never;
    URL.revokeObjectURL = (() => {}) as never;
    // Téléchargement silencieusement ignoré par le navigateur : aucun fichier n'est enregistré.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    await render(repo, h(Settings));
    const input = container!.querySelector<HTMLInputElement>('[data-testid="restore-input"]')!;
    Object.defineProperty(input, 'files', { value: [new File([V1], 'v1.json', { type: 'application/json' })], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await waitFor(() => !!document.querySelector('[data-testid="restore-preview"]'));
    expect(document.querySelector('[data-testid="undo-availability"]')!.textContent).toMatch(/pourrez revenir/);
    await act(async () => button('Restaurer')!.click());
    await waitFor(() => probe()!.dataset.tx === '270' && !!banner());
  }

  async function confirmUndo() {
    await act(async () => button('Annuler la restauration')!.click());
    await waitFor(() => !!button('Revenir à l’état précédent') || !!button("Revenir à l'état précédent"));
    await act(async () => (button("Revenir à l'état précédent") ?? button('Revenir à l’état précédent'))!.click());
  }

  it('P18 téléchargement ignoré : bandeau d’annulation, retour exact à l’état précédent, interface réinitialisée', async () => {
    const repo = await newRepo();
    const before = JSON.stringify((await repo.exportBackup()).data);
    const txBefore = (await repo.snapshot())!.transactions.length;
    const downloads: string[] = [];
    await restoreFixtureViaSettings(repo, downloads);
    expect(downloads).toHaveLength(1); // demandé… mais rien n'a été enregistré
    expect(banner()!.textContent).toMatch(/tant que cette page reste ouverte/);
    sessionStorage.setItem('nexora.tx-filters', JSON.stringify({ accountId: 'id-du-jeu-restaure' }));
    await confirmUndo();
    await waitFor(() => probe()!.dataset.tx === String(txBefore) && !banner());
    expect(JSON.stringify((await repo.exportBackup()).data)).toBe(before);
    expect(sessionStorage.getItem('nexora.tx-filters')).toBeNull();
    expect(undoStore.get()).toBeNull();
    expect(document.body.textContent).toMatch(/État précédent rétabli/);
  });

  it('P18 modification après restauration : avertissement avant confirmation', async () => {
    const repo = await newRepo();
    await restoreFixtureViaSettings(repo, []);
    const s = (await repo.snapshot())!;
    await act(async () => repo.updateAccount(s.accounts[0].id, { name: 'Modifié après restauration' }));
    await act(async () => button('Annuler la restauration')!.click());
    await waitFor(() => !!document.querySelector('[data-testid="undo-changed"]'));
    expect(document.querySelector('[data-testid="undo-changed"]')!.textContent).toMatch(/seront perdues/);
  });

  it('P18 échec de l’annulation (quota) : message, données restaurées intactes, bandeau conservé, nouvel essai réussi', async () => {
    const repo = await newRepo();
    const before = JSON.stringify((await repo.exportBackup()).data);
    await restoreFixtureViaSettings(repo, []);
    const restored = JSON.stringify((await repo.exportBackup()).data);
    vi.spyOn(repo.db.accounts, 'bulkPut').mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));
    await confirmUndo();
    await waitFor(() => /L'annulation a échoué/.test(document.body.textContent ?? ''));
    expect(JSON.stringify((await repo.exportBackup()).data)).toBe(restored);
    expect(banner()).not.toBeNull();
    await confirmUndo();
    await waitFor(() => !banner());
    expect(JSON.stringify((await repo.exportBackup()).data)).toBe(before);
  });
});
