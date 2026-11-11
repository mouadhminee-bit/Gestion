// @vitest-environment jsdom
/**
 * A1 — écran existant (Comptes) : une saisie de montant ambiguë n'est jamais enregistrée sous une
 * autre valeur. L'écran remplace un montant vide par 0 ; tant que la saisie est refusée, le texte
 * reste visible et signalé, et l'enregistrement est bloqué. Application réelle (jsdom,
 * fake-indexeddb), données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '@/App';
import { NexoraDB, setDB } from '@/data/db';
import { LocalRepository } from '@/data/repository';
import { generateDemoData } from '@/data/demo';
import { LOCAL_USER_ID } from '@/domain/settings';

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

async function waitFor(cond: () => boolean, timeout = 5000) {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeout) throw new Error('délai dépassé');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const type = (el: HTMLInputElement, text: string) =>
  act(async () => {
    setValue.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('Comptes : solde initial saisi « 1.50 » (fr-MA)', () => {
  it('refusé, conservé, signalé ; enregistrement bloqué ; corrigé « 1.500 » : enregistré 1 500,00', async () => {
    const db = new NexoraDB(`amount-guard-${Date.now()}`);
    setDB(db);
    const repo = new LocalRepository(db, LOCAL_USER_ID);
    await repo.replaceWithSnapshot(generateDemoData(LOCAL_USER_ID, '2026-11-15', 'Test'));
    const before = (await repo.snapshot())!.accounts.length;
    window.location.hash = '#/accounts';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(h(App)));
    await waitFor(() => !!button('Nouveau compte'));
    await click(button('Nouveau compte'));
    await waitFor(() => !!document.querySelector('[role="dialog"] input[inputmode="decimal"]'));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await type(dialog.querySelector<HTMLInputElement>('input[placeholder="Ex : Compte courant"]')!, 'Épargne test');
    const amount = dialog.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    await type(amount, '1.50');
    await act(async () => amount.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(amount.value).toBe('1.50');
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    expect(dialog.querySelector('[data-testid="money-input-issue"]')!.textContent).toBe('Montant ambigu : utilisez le format 1.234,56.');
    await click(button('Enregistrer'));
    await waitFor(() => document.body.textContent!.includes('Corrigez les montants signalés avant d\'enregistrer.'));
    expect((await repo.snapshot())!.accounts.length).toBe(before); // rien n'est enregistré
    // Correction au format de la locale : accepté et enregistré à la bonne valeur.
    await type(amount, '1.500');
    await click(button('Enregistrer'));
    await waitFor(() => !document.querySelector('[role="dialog"]'));
    const saved = (await repo.snapshot())!.accounts.find((a) => a.name === 'Épargne test')!;
    expect(saved.initialBalance).toBe(150_000);
  });
});
