// @vitest-environment jsdom
/**
 * Prévisions — simulateur : un montant refusé (non valide, ambigu) n'est jamais remplacé par 0 dans
 * le calcul. Tant qu'une saisie est refusée, aucun résultat de scénario n'est affiché ; un champ vide
 * et un zéro saisi sont distincts ; la correction ou la réinitialisation rétablit le calcul.
 * Application réelle (jsdom, fake-indexeddb), données de démonstration fictives.
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
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s/g, ' ');
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
/** Champ du simulateur par son libellé (Field sans htmlFor : l'entrée suit le libellé). */
const field = (label: string) => {
  const l = [...document.querySelectorAll('label')].find((x) => x.textContent?.trim() === label);
  if (!l) throw new Error(`libellé absent : ${label}`);
  return l.parentElement!.querySelector<HTMLInputElement>('input')!;
};
const type = (label: string, value: string) =>
  act(async () => {
    const el = field(label);
    setValue.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const blur = (label: string) => act(async () => field(label).dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
/** Écart « Scénario − Actuel » de la ligne Dépenses du résultat. */
const expensesGap = () => {
  const row = [...document.querySelectorAll('[data-testid="fc-sim-result"] tbody tr')].find((tr) => tr.querySelector('td')?.textContent === 'Dépenses');
  return text(row?.querySelectorAll('td')[3] ?? null);
};

async function renderForecast() {
  const db = new NexoraDB(`forecast-amounts-${Date.now()}`);
  setDB(db);
  await new LocalRepository(db, LOCAL_USER_ID).replaceWithSnapshot(generateDemoData(LOCAL_USER_ID, todayISO(), 'Test'));
  window.location.hash = '#/forecast';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(h(App)));
  await waitFor(() => !!$('[data-testid="fc-sim-result"]'));
}

describe('Prévisions — simulateur : montants refusés jamais remplacés par 0', () => {
  it('valide, zéro saisi, vide, non valide, ambigu, correction, réinitialisation', async () => {
    await renderForecast();
    expect(expensesGap()).toBe('0,00 DH');

    // Montant valide : pris en compte.
    await type('Nouvelle dépense récurrente', '500');
    expect(expensesGap()).toBe('+500,00 DH');

    // Zéro saisi explicitement : conservé à l'écran (distinct d'un champ vide), sans effet sur le calcul.
    await type('Hausse de loyer (par mois)', '0');
    await blur('Hausse de loyer (par mois)');
    expect(field('Hausse de loyer (par mois)').value).toBe('0');
    expect(expensesGap()).toBe('+500,00 DH');
    expect($('[data-testid="fc-sim-blocked"]')).toBeNull();

    // Champ vidé : aucun changement de dépense.
    await type('Nouvelle dépense récurrente', '');
    expect(field('Nouvelle dépense récurrente').value).toBe('');
    expect(expensesGap()).toBe('0,00 DH');

    // Montant non valide : texte conservé, signalé, et AUCUN résultat de scénario (pas de calcul avec 0).
    await type('Achat important (ponctuel)', '1,2,3');
    await blur('Achat important (ponctuel)');
    expect(field('Achat important (ponctuel)').value).toBe('1,2,3');
    expect(field('Achat important (ponctuel)').getAttribute('aria-invalid')).toBe('true');
    expect(text($('[data-testid="money-input-issue"]'))).toBe('Montant non valide. Format attendu : 1.234,56.');
    expect(text($('[data-testid="fc-sim-blocked"]'))).toBe('Simulation suspendue : corrigez les montants signalés pour afficher le résultat du scénario.');
    expect($('[data-testid="fc-sim-result"]')).toBeNull();
    // Une autre saisie valide pendant l'erreur ne fait pas réapparaître de résultat.
    await type('Nouvelle dépense récurrente', '300');
    expect($('[data-testid="fc-sim-result"]')).toBeNull();

    // Correction : le résultat revient, avec les montants corrigés.
    await type('Achat important (ponctuel)', '1.500');
    expect($('[data-testid="fc-sim-blocked"]')).toBeNull();
    expect(expensesGap()).toBe('+300,00 DH');

    // Montant ambigu (« 180.50 » en fr-MA) : même blocage.
    await type('Revenus +/– (par mois)', '180.50');
    await blur('Revenus +/– (par mois)');
    expect(text($('[data-testid="money-input-issue"]'))).toBe('Montant ambigu : utilisez le format 1.234,56.');
    expect($('[data-testid="fc-sim-result"]')).toBeNull();

    // Réinitialisation : champs recréés (texte refusé effacé), calcul rétabli sur le scénario vide.
    const reset = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Réinitialiser')!;
    await act(async () => reset.click());
    expect(field('Revenus +/– (par mois)').value).toBe('');
    expect(field('Achat important (ponctuel)').value).toBe('');
    expect($('[data-testid="fc-sim-blocked"]')).toBeNull();
    expect(expensesGap()).toBe('0,00 DH');
  });
});
