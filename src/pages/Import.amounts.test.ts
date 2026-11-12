// @vitest-environment jsdom
/**
 * Import CSV — parcours complet dans l'application réelle (jsdom, fake-indexeddb, données fictives) :
 * format des nombres détecté sur le fichier, choix explicite quand il ne peut pas l'être, valeurs
 * d'origine conservées, montants ambigus ou incompatibles signalés et jamais importés, montants
 * enregistrés exacts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '@/App';
import { NexoraDB, setDB } from '@/data/db';
import { LocalRepository } from '@/data/repository';
import { generateDemoData } from '@/data/demo';
import { LOCAL_USER_ID } from '@/domain/settings';
import { todayISO } from '@/domain/dates';
import ar from '@/i18n/locales/ar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo = (() => {}) as never;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let repo: LocalRepository;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  setDB(null);
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = '';
});

async function waitFor(cond: () => boolean, timeout = 6000) {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeout) throw new Error('délai dépassé');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s/g, ' ').replace(/[⁦-⁩]/g, '');
const button = (label: string | RegExp) => [...document.querySelectorAll('button')].find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')));
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());

/** Fichier : en-tête puis lignes « date;libellé;montant ». Libellés uniques (pas de doublon avec la démo). */
const csv = (rows: [string, string][]) => ['Date;Libellé;Montant', ...rows.map(([label, amount], i) => `0${(i % 9) + 1}/10/2026;${label};${amount}`)].join('\n');

/** Libellés des boutons du parcours, selon la langue de l'interface. */
const LABELS = {
  fr: { continue: 'Continuer', check: 'Vérifier les lignes', see: 'Voir les transactions' },
  ar: { continue: ar['imp.continue'] as string, check: ar['imp.checkRows'] as string, see: ar['imp.seeTransactions'] as string },
};
let L = LABELS.fr;

async function openImport(content: string, lang: 'fr' | 'ar' = 'fr') {
  L = LABELS[lang];
  const db = new NexoraDB(`import-amounts-${Date.now()}-${Math.random()}`);
  setDB(db);
  repo = new LocalRepository(db, LOCAL_USER_ID);
  const snapshot = generateDemoData(LOCAL_USER_ID, todayISO(), 'Test');
  snapshot.settings.language = lang;
  localStorage.setItem('nexora.lang', lang);
  await repo.replaceWithSnapshot(snapshot);
  window.location.hash = '#/import';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(h(App)));
  await waitFor(() => !!$('input[type="file"]'));
  const file = new File([content], 'releve.csv', { type: 'text/csv' });
  if (!file.text) Object.defineProperty(file, 'text', { value: async () => content });
  const input = $('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await waitFor(() => !!button(L.continue));
  await click(button(L.continue)); // aperçu → formats
  await waitFor(() => !!$('[data-testid="imp-number-status"]'));
}
const status = () => $('[data-testid="imp-number-status"]')!;
const chooseFormat = (value: 'auto' | 'decimalComma' | 'decimalPoint') =>
  act(async () => {
    const sel = $('[data-testid="imp-number-format"]') as HTMLSelectElement;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    set.call(sel, value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
/** Formats → catégories → vérification des lignes. */
async function toCheck(importLabel: RegExp = /^Importer/) {
  await click(button(L.continue));
  await waitFor(() => !!button(L.check));
  await click(button(L.check));
  await waitFor(() => !!button(importLabel));
}
/** Montant interprété de l'aperçu, ligne par ligne : élément isolant (<bdi>) et texte affiché. */
const previewAmounts = () =>
  [...document.querySelectorAll('[data-testid="imp-preview"] tr')].map((tr) => {
    const bdi = tr.querySelectorAll('td')[3].querySelector('[data-testid="imp-preview-amount"]');
    return bdi ? { tag: bdi.tagName, dir: bdi.getAttribute('dir'), text: (bdi.textContent ?? '').replace(/\s/g, ' ') } : null;
  });
const rowFor = (label: string) => [...document.querySelectorAll('tbody tr')].find((tr) => (tr.querySelector('input:not([type])') as HTMLInputElement | null)?.value === label || [...tr.querySelectorAll('input')].some((i) => (i as HTMLInputElement).value === label))!;
async function importedAmounts(): Promise<Record<string, number>> {
  const snap = await repo.snapshot();
  return Object.fromEntries(snap!.transactions.filter((t) => t.tags?.includes('import')).map((t) => [t.label, t.type === 'expense' ? -t.amount : t.amount]));
}

describe('Import CSV — format des nombres déterminé sur le fichier', () => {
  it('convention détectée (virgule décimale) : « 1.500 » lu 1 500,00 ; texte et vide signalés ; valeurs d\'origine affichées', async () => {
    await openImport(csv([['Courses', '-245,30'], ['Remboursement', '12,00'], ['Prime', '1 200,00'], ['Vente', '1.500'], ['Ligne cassée', 'abc'], ['Sans montant', '']]));
    expect(status().dataset.status).toBe('detected');
    expect(text(status())).toBe('Format détecté d\'après les montants du fichier : 1.234,56.');
    expect((button('Continuer') as HTMLButtonElement).disabled).toBe(false);
    // Aperçu : valeur du fichier à côté du montant interprété.
    const preview = [...document.querySelectorAll('[data-testid="imp-preview"] tr')].map((tr) => [...tr.querySelectorAll('td')].slice(2).map((td) => text(td)));
    expect(preview[0]).toEqual(['-245,30', '-245,30 DH']);
    expect(preview[3]).toEqual(['1.500', '+1.500,00 DH']);
    expect(preview[4]).toEqual(['abc', 'invalide']);
    // Montant interprété isolé (<bdi>, direction déduite du contenu) ; « invalide » ne l'est pas.
    const shown = previewAmounts();
    expect(shown[0]).toEqual({ tag: 'BDI', dir: null, text: '-245,30 DH' });
    expect(shown[3]).toEqual({ tag: 'BDI', dir: null, text: '+1.500,00 DH' });
    expect(shown[4]).toBeNull();
    await toCheck();
    expect(text(rowFor('Ligne cassée'))).toContain('Montant non reconnu « abc »');
    expect(text(rowFor('Sans montant'))).toContain('Montant invalide');
    expect(text(rowFor('Vente').querySelector('[data-testid="imp-raw-amount"]'))).toBe('Fichier : 1.500');
    await click(button(/^Importer 4 opération/));
    await waitFor(() => !!button('Voir les transactions'));
    expect(await importedAmounts()).toEqual({ Courses: -24_530, Remboursement: 1_200, Prime: 120_000, Vente: 150_000 });
  });

  it('convention indéterminable : choix obligatoire avant de continuer ; montants lus selon le choix', async () => {
    await openImport(csv([['Vente A', '1.500'], ['Vente B', '180.000'], ['Café', '-45']]));
    expect(status().dataset.status).toBe('uncertain');
    expect(status().getAttribute('role')).toBe('alert');
    expect(text(status())).toContain('des montants comme « 1.500 » peuvent se lire de deux façons');
    expect((button('Continuer') as HTMLButtonElement).disabled).toBe(true);
    // Aperçu : aucun montant ambigu interprété tant que le format n'est pas choisi.
    const parsed = () => [...document.querySelectorAll('[data-testid="imp-preview"] tr')].map((tr) => text(tr.querySelectorAll('td')[3]));
    expect(parsed()).toEqual(['invalide', 'invalide', '-45,00 DH']);
    await chooseFormat('decimalComma');
    expect(status().dataset.status).toBe('chosen');
    expect(parsed()).toEqual(['+1.500,00 DH', '+180.000,00 DH', '-45,00 DH']);
    expect((button('Continuer') as HTMLButtonElement).disabled).toBe(false);
    await toCheck();
    await click(button(/^Importer 3 opération/));
    await waitFor(() => !!button('Voir les transactions'));
    expect(await importedAmounts()).toEqual({ 'Vente A': 150_000, 'Vente B': 18_000_000, Café: -4_500 });
  });

  it('autre choix explicite (point décimal) : « 1.500 » lu 1,50 — la convention choisie, jamais devinée', async () => {
    await openImport(csv([['Vente A', '1.500'], ['Café', '-45']]));
    await chooseFormat('decimalPoint');
    await toCheck();
    await click(button(/^Importer 2 opération/));
    await waitFor(() => !!button('Voir les transactions'));
    expect(await importedAmounts()).toEqual({ 'Vente A': 150, Café: -4_500 });
  });

  it('conventions mélangées : conflit signalé, choix obligatoire ; montants incompatibles non importés', async () => {
    await openImport(csv([['Courses', '245,30'], ['Essence', '245.30'], ['Vente', '1.500'], ['Loyer', '-4.000,00']]));
    expect(status().dataset.status).toBe('conflict');
    expect(text(status())).toContain('mélange deux conventions de nombres (ex. « 245,30 » et « 245.30 »)');
    expect((button('Continuer') as HTMLButtonElement).disabled).toBe(true);
    await chooseFormat('decimalComma');
    await toCheck();
    expect(text(rowFor('Essence'))).toContain('Montant « 245.30 » incompatible avec le format choisi');
    expect((rowFor('Essence').querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    await click(button(/^Importer 3 opération/));
    await waitFor(() => !!button('Voir les transactions'));
    expect(await importedAmounts()).toEqual({ Courses: 24_530, Vente: 150_000, Loyer: -400_000 });
  });

  it('lettres et notation scientifique refusées explicitement, jamais nettoyées ; valeur citée isolée', async () => {
    await openImport(csv([['Salaire', 'MAD 1 200,00'], ['Loyer', '-245,30'], ['Frais', '(45,00)'], ['Science', '1e5'], ['Référence', 'abc123'], ['Mélange', '12abc34']]));
    // Trois montants prouvent la virgule décimale ; les montants refusés ne comptent pas.
    expect(status().dataset.status).toBe('detected');
    await toCheck();
    expect(text(rowFor('Science'))).toContain('Montant non reconnu « 1e5 »');
    expect(text(rowFor('Référence'))).toContain('Montant non reconnu « abc123 »');
    expect(text(rowFor('Mélange'))).toContain('Montant non reconnu « 12abc34 »');
    // Valeur du fichier isolée dans le message (signe et séparateurs à leur place en arabe).
    expect(rowFor('Science').textContent).toContain('⁨1e5⁩');
    for (const label of ['Science', 'Référence', 'Mélange']) expect((rowFor(label).querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    await click(button(/^Importer 3 opération/));
    await waitFor(() => !!button('Voir les transactions'));
    expect(await importedAmounts()).toEqual({ Salaire: 120_000, Loyer: -24_530, Frais: -4_500 });
  });

  it('arabe : montants interprétés de l\'aperçu isolés (signe à gauche du nombre) ; valeurs enregistrées identiques', async () => {
    await openImport(csv([['Salaire', '1 200,00'], ['Loyer', '-245,30'], ['Nul', '0,00'], ['Cassé', 'abc']]), 'ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(status().dataset.status).toBe('detected');
    // Chaque montant formaté est dans un <bdi> sans direction imposée : le contenu (« -245,30 DH »)
    // fixe sa direction de gauche à droite, au lieu de s'afficher « DH 245,30- » dans la phrase arabe.
    const shown = previewAmounts();
    expect(shown.slice(0, 3)).toEqual([
      { tag: 'BDI', dir: null, text: '+1.200,00 DH' },
      { tag: 'BDI', dir: null, text: '-245,30 DH' },
      { tag: 'BDI', dir: null, text: '0,00 DH' },
    ]);
    expect(shown[3]).toBeNull(); // montant non interprété : texte « غير صالح », sans montant
    expect(text(document.querySelectorAll('[data-testid="imp-preview"] tr')[3].querySelectorAll('td')[3])).toBe(ar['imp.invalid']);
    await toCheck(/^استيراد/);
    await click(button(/^استيراد/));
    await waitFor(() => !!button(L.see));
    expect(await importedAmounts()).toEqual({ Salaire: 120_000, Loyer: -24_530 });
  });

  it('fichier usuel sans montant ambigu : aucun choix demandé, comportement inchangé', async () => {
    await openImport(csv([['Supermarché', '-245,30'], ['Vente vélo', '1 200,00'], ['Taxi', '-45']]));
    expect(status().dataset.status).toBe('notNeeded');
    expect((button('Continuer') as HTMLButtonElement).disabled).toBe(false);
    await toCheck();
    await click(button(/^Importer 3 opération/));
    await waitFor(() => !!button('Voir les transactions'));
    expect(await importedAmounts()).toEqual({ Supermarché: -24_530, 'Vente vélo': 120_000, Taxi: -4_500 });
  });
});
