// @vitest-environment jsdom
/**
 * Decision Lab — étape E5.2 : situation financière initiale dans la page (React, jsdom).
 * Données entièrement fictives ; horloge figée (la base d'épargne dépend des mois écoulés).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '@/app/AppContext';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Dialog';
import { NexoraDB } from '@/data/db';
import { LocalRepository } from '@/data/repository';
import { buildInitialSituation } from '@/domain/calc/decisionSituation';
import type { DataSnapshot } from '@/domain/types';
import { activateMessages } from '@/i18n/core';
import ar from '@/i18n/locales/ar';
import fr from '@/i18n/locales/fr';
import DecisionLab from '@/pages/DecisionLab';
import { account, ctxOf, emptySnapshot, tx, UID } from '@/test/fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
Element.prototype.scrollIntoView ??= () => {};

const TODAY = '2026-11-15';
let seq = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let repo: LocalRepository;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  activateMessages('fr', fr);
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Compte courant 15 000 DH, livret hors totaux 5 000 DH, épargne de septembre 5 000 DH. */
function fixture(over: Partial<DataSnapshot> = {}): DataSnapshot {
  return emptySnapshot({
    accounts: [account({ id: 'bank', name: 'Courant', initialBalance: 1_000_000 }), account({ id: 'livret', name: 'Livret A', type: 'savings', initialBalance: 500_000, includeInTotal: false })],
    transactions: [tx({ accountId: 'bank', type: 'income', amount: 800_000, date: '2026-09-05' }), tx({ accountId: 'bank', type: 'expense', amount: 300_000, date: '2026-09-10' })],
    ...over,
  });
}

async function render(data: DataSnapshot = fixture()) {
  repo = new LocalRepository(new NexoraDB(`dl-sit-${++seq}`), UID);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(h(MemoryRouter, null, h(TooltipProvider, null, h(ToastProvider, null, h(ConfirmProvider, null, h(AppProvider, { repo, data, children: h(DecisionLab) })))))));
  return { data, before: JSON.stringify(data) };
}

const card = () => document.querySelector<HTMLElement>('[data-testid="dl-situation"]')!;
const shown = (f: string) => card().querySelector<HTMLElement>(`[data-testid="dl-situation-value-${f}"]`);
/** Texte affiché, espaces insécables normalisées (le formatage monétaire en utilise). */
const shownText = (f: string): string => shown(f)!.textContent!.replace(/\s/g, ' ');
const source = () => card().querySelector('[data-testid="dl-situation-source"]')?.textContent;
const form = () => card().querySelector<HTMLFormElement>('[data-testid="dl-situation-form"]');
const input = (f: string) => card().querySelector<HTMLInputElement>(`#dl-situation-${f}`)!;
const fieldError = (f: string) => input(f).closest('.flex-col')!.querySelector('[role="alert"]')?.textContent ?? null;
const button = (text: string) => [...card().querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const type = (f: string, text: string) =>
  act(async () => {
    setValue.call(input(f), text);
    input(f).dispatchEvent(new Event('input', { bubbles: true }));
  });
const fill = async (cash: string, netWorth: string, savings: string) => {
  await type('cash', cash);
  await type('netWorth', netWorth);
  await type('monthlySavings', savings);
};

describe('situation initiale — affichage', () => {
  it('valeurs calculées en lecture seule à partir des données, avec unité, source et périmètre', async () => {
    const { data, before } = await render();
    const computed = buildInitialSituation(ctxOf(data), data, TODAY);
    expect(computed).toMatchObject({ cash: 1_500_000, netWorth: 2_000_000, monthlySavings: 500_000 });
    expect(shownText('cash')).toContain('15.000,00 DH');
    expect(shownText('netWorth')).toContain('20.000,00 DH');
    expect(shownText('monthlySavings')).toContain('+5.000,00 DH');
    // Trois grandeurs distinctes, chacune expliquée, avec la devise.
    expect(shownText('cash')).toContain('Trésorerie');
    expect(shownText('netWorth')).toContain('Patrimoine net');
    expect(shownText('monthlySavings')).toContain('Épargne mensuelle');
    for (const f of ['cash', 'netWorth', 'monthlySavings']) expect(shownText(f), f).toContain('en MAD');
    expect(source()).toBe('Calculée à partir de vos données');
    const notes = card().querySelector('[data-testid="dl-situation-notes"]')!.textContent!;
    expect(notes).toContain('Mois complets utilisés pour calculer l\'épargne mensuelle : 1.');
    expect(notes).toContain('Comptes non comptés dans la trésorerie');
    expect(notes).toContain('Livret A');
    expect(form()).toBeNull();
    expect(card().querySelectorAll('bdi').length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('aucune donnée : zéros, et avertissement que l\'épargne n\'a pas pu être calculée', async () => {
    await render(emptySnapshot());
    expect(shownText('cash')).toContain('0,00 DH');
    expect(card().textContent).toContain('Aucun mois complet de données');
    expect(source()).toBe('Calculée à partir de vos données');
  });

  it('données de démonstration : signalées comme telles tant que les valeurs sont calculées', async () => {
    const data = fixture();
    data.settings.demoMode = true;
    await render(data);
    expect(card().textContent).toContain(fr['common.demoData']);
    await click(button('Modifier'));
    await fill('100', '200', '3');
    await click(button('Valider la situation'));
    expect(source()).toBe('Ajustée manuellement');
    expect(card().textContent).not.toContain(fr['common.demoData']);
  });

  it('montants non convertis : avertissement', async () => {
    await render(fixture({ accounts: [account({ id: 'bank', initialBalance: 1_000_000 }), account({ id: 'usd', currency: 'USD', initialBalance: 100_000 })], transactions: [] }));
    expect(card().textContent).toContain('devise étrangère');
  });
});

describe('situation initiale — saisie et validation', () => {
  it('formulaire : trois champs obligatoires préremplis, modifiables avant validation', async () => {
    await render();
    await click(button('Modifier'));
    expect(form()).not.toBeNull();
    expect([input('cash').value, input('netWorth').value, input('monthlySavings').value]).toEqual(['15000', '20000', '5000']);
    for (const f of ['cash', 'netWorth', 'monthlySavings']) {
      expect(input(f).required, f).toBe(true);
      expect(input(f).getAttribute('inputmode')).toBe('decimal');
      expect(document.querySelector(`label[for="dl-situation-${f}"]`)!.textContent).toContain('*');
    }
    expect(card().textContent).toContain('Les trois montants sont obligatoires. Zéro et les montants négatifs sont acceptés.');
  });

  it('valeurs valides : décimales exactes, négatif et zéro acceptés ; rien n\'est écrit nulle part', async () => {
    const { data, before } = await render();
    // État des stockages du navigateur avant la saisie (l'application y range sa langue, son thème, son mois).
    const storages = () => JSON.stringify([Object.entries(sessionStorage).sort(), Object.entries(localStorage).sort()]);
    const storagesBefore = storages();
    await click(button('Modifier'));
    await fill('1234,56', '-500', '0');
    await click(button('Valider la situation'));
    expect(form()).toBeNull();
    expect(shownText('cash')).toContain('1.234,56 DH');
    expect(shownText('netWorth')).toContain('-500,00 DH');
    expect(shownText('monthlySavings')).toContain('0,00 DH');
    expect(source()).toBe('Ajustée manuellement');
    expect(document.body.textContent).toContain('Situation initiale mise à jour');
    // Données financières réelles intactes ; aucune persistance (ni base, ni stockage navigateur).
    expect(JSON.stringify(data)).toBe(before);
    expect(await repo.snapshot()).toBeNull();
    expect(storages()).toBe(storagesBefore);
    expect(Object.keys(sessionStorage).some((k) => k.startsWith('nexora.decisionLab'))).toBe(false);
    // Les notes de calcul ne s'appliquent plus à des valeurs saisies.
    expect(card().querySelector('[data-testid="dl-situation-notes"]')).toBeNull();
  });

  it('précision : 0,1 + 0,2 saisis séparément restent des centimes exacts', async () => {
    await render();
    await click(button('Modifier'));
    await fill('0,10', '0,20', '0,30');
    await click(button('Valider la situation'));
    expect(shownText('cash')).toContain('0,10 DH');
    expect(shownText('netWorth')).toContain('0,20 DH');
    expect(shownText('monthlySavings')).toContain('+0,30 DH');
  });

  it('champ vide : erreur « obligatoire » sous le champ, rien n\'est validé', async () => {
    await render();
    await click(button('Modifier'));
    await type('netWorth', '');
    await click(button('Valider la situation'));
    expect(form()).not.toBeNull();
    expect(fieldError('netWorth')).toBe('Ce montant est obligatoire.');
    expect(input('netWorth').getAttribute('aria-invalid')).toBe('true');
    expect(fieldError('cash')).toBeNull();
    expect(fieldError('monthlySavings')).toBeNull();
    // Correction puis validation : l'erreur disparaît.
    await type('netWorth', '0');
    await click(button('Valider la situation'));
    expect(form()).toBeNull();
    expect(shownText('netWorth')).toContain('0,00 DH');
  });

  it('saisie non interprétable : erreur précise (motif et format attendu), jamais effacée ni corrigée silencieusement', async () => {
    await render();
    await click(button('Modifier'));
    await type('cash', '1,2,3');
    // Sortie du champ : la saisie reste visible telle quelle et l'erreur apparaît aussitôt.
    await act(async () => input('cash').dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(input('cash').value).toBe('1,2,3');
    expect(fieldError('cash')).toBe('Montant non valide. Format attendu : 1.234,56.');
    await type('monthlySavings', '-');
    await click(button('Valider la situation'));
    expect(input('cash').value).toBe('1,2,3');
    expect(input('monthlySavings').value).toBe('-');
    expect(fieldError('cash')).toBe('Montant non valide. Format attendu : 1.234,56.');
    expect(fieldError('monthlySavings')).toBe('Montant non valide. Format attendu : 1.234,56.');
    // Corriger un champ retire son erreur sans attendre une nouvelle validation.
    await type('cash', '12');
    expect(fieldError('cash')).toBeNull();
    expect(fieldError('monthlySavings')).toBe('Montant non valide. Format attendu : 1.234,56.');
    // Après correction et sortie du champ : la saisie valide est remise en forme normalement.
    await act(async () => input('cash').dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(input('cash').value).toBe('12');
    expect(fieldError('cash')).toBeNull();
    // Validation finale : une fois tout corrigé, la situation est retenue.
    await type('monthlySavings', '-7,5');
    await click(button('Valider la situation'));
    expect(form()).toBeNull();
    expect(shownText('cash')).toContain('12,00 DH');
    expect(shownText('monthlySavings')).toContain('-7,50 DH');
    expect(source()).toBe('Ajustée manuellement');
  });

  it('valeur hors limites du moteur : erreur « trop élevé » sur le champ concerné', async () => {
    await render();
    await click(button('Modifier'));
    await fill('1000', '1000', '90000000000000');
    await click(button('Valider la situation'));
    expect(fieldError('monthlySavings')).toBe('Ce montant est trop élevé pour être simulé.');
    expect(fieldError('cash')).toBeNull();
    expect(form()).not.toBeNull();
  });

  it('annuler : les modifications sont abandonnées', async () => {
    await render();
    await click(button('Modifier'));
    await fill('1', '2', '3');
    await click(button('Annuler'));
    expect(form()).toBeNull();
    expect(shownText('cash')).toContain('15.000,00 DH');
    expect(source()).toBe('Calculée à partir de vos données');
    await click(button('Modifier'));
    expect(input('cash').value).toBe('15000'); // le brouillon repart de la situation retenue
  });

  it('revenir aux valeurs calculées ; valider des valeurs identiques n\'est pas une modification', async () => {
    await render();
    expect(button('Revenir aux valeurs calculées')).toBeUndefined();
    await click(button('Modifier'));
    await fill('1', '2', '3');
    await click(button('Valider la situation'));
    expect(source()).toBe('Ajustée manuellement');
    await click(button('Revenir aux valeurs calculées'));
    expect(shownText('cash')).toContain('15.000,00 DH');
    expect(source()).toBe('Calculée à partir de vos données');
    await click(button('Modifier'));
    await click(button('Valider la situation'));
    expect(source()).toBe('Calculée à partir de vos données');
    expect(button('Revenir aux valeurs calculées')).toBeUndefined();
  });

  it('calcul impossible (données incohérentes) : message, saisie manuelle obligatoire, sans plantage', async () => {
    const data = fixture();
    data.accounts.push(data.accounts[0]); // même compte deux fois : périmètre refusé
    await render(data);
    expect(card().querySelector('[data-testid="dl-situation-unavailable"]')!.textContent).toContain('n\'a pas pu être calculée');
    expect(form()).not.toBeNull();
    expect(button('Annuler')).toBeUndefined();
    expect(source()).toBeUndefined();
    await click(button('Valider la situation'));
    expect(fieldError('cash')).toBe('Ce montant est obligatoire.');
    await fill('100', '200', '-3');
    await click(button('Valider la situation'));
    expect(shownText('monthlySavings')).toContain('-3,00 DH');
    expect(source()).toBe('Ajustée manuellement');
    expect(button('Revenir aux valeurs calculées')).toBeUndefined();
  });
});

describe('situation initiale — langue RTL', () => {
  it('arabe : libellés et erreurs traduits, montants isolés pour l\'affichage de droite à gauche', async () => {
    activateMessages('ar', ar);
    await render();
    expect(card().textContent).toContain(ar['dl.situation.title']);
    expect(shownText('cash')).toContain(ar['dl.situation.cash']);
    expect(source()).toBe(ar['dl.situation.source.computed']);
    for (const f of ['cash', 'netWorth', 'monthlySavings']) expect(shown(f)!.querySelector('bdi')!.textContent, f).toMatch(/DH$/);
    await click(button(ar['common.edit'] as string));
    await type('cash', '');
    await click(button(ar['dl.situation.validate'] as string));
    expect(fieldError('cash')).toBe(ar['dl.situation.err.required']);
  });
});
