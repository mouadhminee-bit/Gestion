// @vitest-environment jsdom
/**
 * Decision Lab — étape E5.3 : parcours « Nouvelle décision » (React, jsdom). Données fictives.
 * Vérifie le rendu des quatre formulaires, les erreurs au niveau des champs, la conservation des
 * saisies, l'entrée produite (exactement le contrat du moteur) et l'absence de toute écriture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '@/app/AppContext';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Dialog';
import { NexoraDB } from '@/data/db';
import { LocalRepository } from '@/data/repository';
import { validateDecision, type DecisionInput } from '@/domain/calc/decision';
import { activateMessages } from '@/i18n/core';
import ar from '@/i18n/locales/ar';
import fr from '@/i18n/locales/fr';
import DecisionLab from '@/pages/DecisionLab';
import { account, emptySnapshot, UID } from '@/test/fixtures';
import { DecisionBuilder } from './DecisionBuilder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
Element.prototype.scrollIntoView ??= () => {};

let seq = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let repo: LocalRepository;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  activateMessages('fr', fr);
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function render(page: 'builder' | 'page' = 'builder') {
  const data = emptySnapshot({ accounts: [account({ id: 'bank', initialBalance: 1_000_000 })] });
  const before = JSON.stringify(data);
  repo = new LocalRepository(new NexoraDB(`dl-form-${++seq}`), UID);
  const onValidated = vi.fn<(d: DecisionInput | null) => void>();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const body = page === 'builder' ? h(DecisionBuilder, { onValidated }) : h(DecisionLab);
  await act(async () => root!.render(h(MemoryRouter, null, h(TooltipProvider, null, h(ToastProvider, null, h(ConfirmProvider, null, h(AppProvider, { repo, data, children: body })))))));
  return { data, before, onValidated };
}

const card = () => document.querySelector<HTMLElement>('[data-testid="dl-decision"]')!;
const q = <T extends Element = HTMLElement>(sel: string) => card().querySelector<T>(sel);
const input = (key: string) => q<HTMLInputElement>(`#dl-f-${key.replace('.', '-')}`)!;
const fieldKeys = () => [...card().querySelectorAll<HTMLElement>('[data-testid^="dl-field-"]')].map((el) => el.dataset.testid!.replace('dl-field-', '')).filter((k) => k !== 'loan');
const fieldError = (key: string) => card().querySelector(`[data-testid="dl-field-${key}"] [role="alert"]`)?.textContent ?? null;
const button = (text: string) => [...card().querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const type = (key: string, text: string) =>
  act(async () => {
    setValue.call(input(key), text);
    input(key).dispatchEvent(new Event('input', { bubbles: true }));
  });
const blur = (key: string) => act(async () => input(key).dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
const submit = () => click(button('Valider les hypothèses'));
const choose = (kind: string) => click(q(`[data-testid="dl-kind-${kind}"]`));

describe('choix du type et rendu des formulaires', () => {
  it('quatre types proposés, avec description', async () => {
    await render();
    for (const k of ['purchase', 'recurring', 'goal', 'investment']) expect(q(`[data-testid="dl-kind-${k}"]`), k).not.toBeNull();
    expect(card().textContent).toContain('Choisissez le type de décision à simuler.');
    expect(q('[data-testid="dl-kind-purchase"]')!.textContent).toContain('Achat');
    expect(q('[data-testid="dl-kind-purchase"]')!.textContent).toContain('comptant ou à crédit');
  });

  it('champs attendus par type, obligatoires marqués, unités explicites', async () => {
    await render();
    await choose('purchase');
    expect(fieldKeys()).toEqual(['price', 'downPayment', 'fees', 'assetValue', 'insuranceMonthly', 'insuranceMonths']);
    expect(card().textContent).toContain('Montants en MAD, taux annuels en %, durées en mois.');
    for (const k of ['price', 'downPayment', 'fees']) expect(card().querySelector(`label[for="${input(k).id}"]`)!.textContent, k).toContain('*');
    expect(card().querySelector(`label[for="${input('assetValue').id}"]`)!.textContent).not.toContain('*');
    await click(q('#dl-financed'));
    expect(fieldKeys()).toEqual(['price', 'downPayment', 'fees', 'assetValue', 'loan.nominalRateBps', 'loan.months', 'insuranceMonthly', 'insuranceMonths']);
    expect(input('loan.nominalRateBps').getAttribute('inputmode')).toBe('decimal');
    expect(input('loan.months').getAttribute('inputmode')).toBe('numeric');
    expect(q(`[data-testid="dl-field-loan.nominalRateBps"]`)!.textContent).toContain('%');

    await click(button('Changer de type'));
    await choose('recurring');
    expect(fieldKeys()).toEqual(['monthlyAmount', 'startMonth', 'months']);
    await click(button('Changer de type'));
    await choose('goal');
    expect(fieldKeys()).toEqual(['target', 'effectiveRateBps', 'months']);
    await click([...card().querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Versement fixé'));
    expect(fieldKeys()).toEqual(['target', 'effectiveRateBps', 'monthlyContribution', 'deadlineMonths']);
    await click(button('Changer de type'));
    await choose('investment');
    expect(fieldKeys()).toEqual(['initialCapital', 'monthlyContribution', 'contributionMonths', 'effectiveRateBps']);
  });
});

describe('validation et entrée produite', () => {
  it('achat financé : entrée exacte, récapitulatif, retour à la modification sans perte', async () => {
    const { onValidated } = await render();
    await choose('purchase');
    await type('price', '180000');
    await type('downPayment', '30000');
    await type('fees', '1500,50');
    await click(q('#dl-financed'));
    await type('loan.nominalRateBps', '7,25');
    await type('loan.months', '48');
    await type('insuranceMonthly', '120');
    await submit();
    const expected = { kind: 'purchase', price: 18_000_000, downPayment: 3_000_000, fees: 150_050, loan: { nominalRateBps: 725, months: 48 }, insuranceMonthly: 12_000 };
    expect(onValidated).toHaveBeenLastCalledWith(expected);
    expect(onValidated.mock.lastCall![0]).toStrictEqual(expected);
    expect(validateDecision(onValidated.mock.lastCall![0]!, { horizonMonths: 480 })).toEqual([]);
    const recap = q('[data-testid="dl-decision-recap"]')!.textContent!.replace(/\s/g, ' ');
    expect(card().textContent).toContain('Hypothèses valides');
    for (const s of ['180.000,00 DH', '30.000,00 DH', '1.500,50 DH', '7,25', '48', '120,00 DH']) expect(recap, s).toContain(s);
    expect(document.body.textContent).toContain('Hypothèses valides');
    // Modifier : formulaire rouvert avec les mêmes saisies ; l'entrée validée est retirée.
    await click(button('Modifier'));
    expect(onValidated).toHaveBeenLastCalledWith(null);
    expect([input('price').value, input('fees').value, input('loan.nominalRateBps').value, input('loan.months').value]).toEqual(['180000', '1500,50', '7,25', '48']);
    await submit();
    expect(onValidated.mock.lastCall![0]).toStrictEqual(expected);
  });

  it('dépense récurrente, objectif et placement : entrées exactes', async () => {
    const { onValidated } = await render();
    await choose('recurring');
    await type('monthlyAmount', '500');
    await type('months', '12');
    await submit();
    expect(onValidated.mock.lastCall![0]).toStrictEqual({ kind: 'recurring', monthlyAmount: 50_000, months: 12 });

    await click(button('Changer de type'));
    expect(onValidated).toHaveBeenLastCalledWith(null);
    await choose('goal');
    await type('target', '60000');
    await type('effectiveRateBps', '3');
    await type('months', '24');
    await submit();
    expect(onValidated.mock.lastCall![0]).toStrictEqual({ kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 300, months: 24 });

    await click(button('Changer de type'));
    await choose('investment');
    await type('initialCapital', '20000');
    await type('monthlyContribution', '1500');
    await type('effectiveRateBps', '6');
    await submit();
    expect(onValidated.mock.lastCall![0]).toStrictEqual({ kind: 'investment', initialCapital: 2_000_000, monthlyContribution: 150_000, effectiveRateBps: 600 });
  });

  it('changer de type conserve les saisies de chaque type', async () => {
    await render();
    await choose('recurring');
    await type('monthlyAmount', '750');
    await type('startMonth', '3');
    await click(button('Changer de type'));
    await choose('investment');
    await type('initialCapital', '1000');
    await click(button('Changer de type'));
    await choose('recurring');
    expect([input('monthlyAmount').value, input('startMonth').value]).toEqual(['750', '3']);
    await click(button('Changer de type'));
    await choose('investment');
    expect(input('initialCapital').value).toBe('1000');
  });
});

describe('erreurs au niveau des champs', () => {
  it('champs obligatoires vides', async () => {
    const { onValidated } = await render();
    await choose('purchase');
    await submit();
    for (const k of ['price', 'downPayment', 'fees']) expect(fieldError(k), k).toBe('Ce champ est obligatoire.');
    expect(fieldError('assetValue')).toBeNull();
    expect(input('price').getAttribute('aria-invalid')).toBe('true');
    expect(onValidated).not.toHaveBeenCalled();
    expect(q('[data-testid="dl-form-purchase"]')).not.toBeNull();
  });

  it('règles du moteur affichées sous le champ concerné (crédit, apport, bornes, négatif)', async () => {
    await render();
    await choose('purchase');
    await type('price', '1000');
    await type('downPayment', '200');
    await type('fees', '-5');
    await submit();
    expect(fieldError('fees')).toBe('Cette valeur ne peut pas être négative.');
    await type('fees', '0');
    await submit();
    expect(card().querySelector('[data-testid="dl-field-loan"] [role="alert"]')!.textContent).toBe('Le prix dépasse l\'apport : activez le crédit qui finance la différence.');
    await click(q('#dl-financed'));
    await type('loan.nominalRateBps', '35');
    await type('loan.months', '600');
    await submit();
    expect(fieldError('loan.nominalRateBps')).toBe('Le taux doit être compris entre 0 et 30 %.');
    expect(fieldError('loan.months')).toBe('480 mois au maximum.');
    await type('downPayment', '2000');
    await type('loan.nominalRateBps', '5');
    await type('loan.months', '12');
    await submit();
    expect(fieldError('downPayment')).toBe('L\'apport ne peut pas dépasser le prix.');
  });

  it('crédit non amortissable : message explicite', async () => {
    await render();
    await choose('purchase');
    await type('price', '0,99');
    await type('downPayment', '0');
    await type('fees', '0');
    await click(q('#dl-financed'));
    await type('loan.nominalRateBps', '12');
    await type('loan.months', '480');
    await submit();
    expect(card().querySelector('[data-testid="dl-field-loan"] [role="alert"]')!.textContent).toContain('ne peut pas être remboursé');
  });

  it('zéro refusé là où le moteur l\'exige ; placement vide ; erreur globale', async () => {
    await render();
    await choose('recurring');
    await type('monthlyAmount', '0');
    await submit();
    expect(fieldError('monthlyAmount')).toBe('Cette valeur doit être supérieure à zéro.');
    await click(button('Changer de type'));
    await choose('investment');
    await type('initialCapital', '0');
    await type('monthlyContribution', '0');
    await type('effectiveRateBps', '0');
    await submit();
    expect(fieldError('initialCapital')).toBe('Indiquez un capital initial ou un versement mensuel.');
    await type('initialCapital', '90071992547409,91');
    await type('effectiveRateBps', '30');
    await submit();
    expect(q('[data-testid="dl-form-error"]')!.textContent).toBe('Ces montants sont trop élevés pour être simulés.');
  });

  it('saisies invalides conservées après la perte de focus, puis corrigées', async () => {
    const { onValidated } = await render();
    await choose('goal');
    await type('target', '6,0,0');
    await blur('target');
    expect(input('target').value).toBe('6,0,0');
    // Motif précis, avec un exemple au format de la locale (fr-MA par défaut).
    expect(fieldError('target')).toBe('Montant non valide. Format attendu : 1.234,56.');
    await type('effectiveRateBps', '3,125');
    await type('months', 'deux ans');
    await submit();
    expect(input('effectiveRateBps').value).toBe('3,125');
    expect(input('months').value).toBe('deux ans');
    expect(fieldError('effectiveRateBps')).toBe('Cette valeur n\'est pas valide.');
    expect(fieldError('months')).toBe('Cette valeur n\'est pas valide.');
    // Saisie ambiguë (« 60.00 » : décimale ou milliers ?) : refusée et signalée, jamais convertie.
    await type('target', '60.00');
    await blur('target');
    expect(input('target').value).toBe('60.00');
    expect(fieldError('target')).toBe('Montant ambigu : utilisez le format 1.234,56.');
    // Format de la locale (point = milliers) : accepté.
    await type('target', '60.000');
    await submit();
    expect(fieldError('target')).toBeNull();
    // Correction : chaque erreur disparaît dès la nouvelle saisie, puis validation.
    await type('target', '60000');
    expect(fieldError('target')).toBeNull();
    await type('effectiveRateBps', '3,12');
    await type('months', '24');
    await submit();
    expect(onValidated.mock.lastCall![0]).toStrictEqual({ kind: 'goal', mode: 'effort', target: 6_000_000, effectiveRateBps: 312, months: 24 });
  });
});

describe('intégration et sécurité', () => {
  it('dans la page : sous la situation initiale ; aucune écriture dans les données ni les stockages', async () => {
    const { data, before } = await render('page');
    const storages = () => JSON.stringify([Object.entries(sessionStorage).sort(), Object.entries(localStorage).sort()]);
    const storagesBefore = storages();
    const situation = document.querySelector('[data-testid="dl-situation"]')!;
    expect(situation.compareDocumentPosition(card()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await choose('investment');
    await type('initialCapital', '20000');
    await type('monthlyContribution', '1500');
    await type('effectiveRateBps', '6');
    await submit();
    expect(q('[data-testid="dl-decision-ready"]')).not.toBeNull();
    expect(JSON.stringify(data)).toBe(before);
    expect(await repo.snapshot()).toBeNull();
    expect(storages()).toBe(storagesBefore);
    // Aucune simulation n'est encore enregistrée à cette étape.
    expect(document.querySelectorAll('[data-testid="dl-simulation"]')).toHaveLength(0);
  });

  it('arabe (RTL) : libellés et erreurs traduits', async () => {
    activateMessages('ar', ar);
    await render();
    await click(q('[data-testid="dl-kind-goal"]'));
    expect(card().textContent).toContain(ar['dl.f.target']);
    expect(card().textContent).toContain(ar['dl.f.effectiveRate']);
    await click(button(ar['dl.form.validate'] as string));
    expect(fieldError('target')).toBe(ar['dl.err.required']);
    // Les règles du moteur sont vérifiées une fois tous les champs lisibles.
    await type('target', '60000');
    await type('months', '24');
    await type('effectiveRateBps', '40');
    await click(button(ar['dl.form.validate'] as string));
    expect(fieldError('effectiveRateBps')).toBe((ar['dl.err.rateOutOfRange'] as string).replace('{max}', '30'));
  });
});
