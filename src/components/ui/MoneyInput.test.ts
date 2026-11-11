// @vitest-environment jsdom
/**
 * MoneyInput — saisie selon la locale active (A1) : séparateurs de la locale, saisie ambiguë ou non
 * valide jamais convertie ni effacée (signalée), remise en forme d'une saisie acceptée, `onBlur` /
 * `onFocus` de l'appelant ajoutés (jamais substitués), motif transmis à l'appelant (`onIssue`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoneyInput, useAmountGuard } from './Field';
import type { AmountInputIssue } from '@/domain/money';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

const values: (number | null)[] = [];
const issues: (AmountInputIssue | null)[] = [];
type HarnessProps = { onBlur?: () => void; allowNegative?: boolean; locale?: string; currency?: string; showIssue?: boolean; initial?: number | null; external?: number };
let setExternal: ((v: number | null) => void) | null = null;
function Harness({ initial = 150_000, currency = 'MAD', ...props }: HarnessProps) {
  const [value, setValue] = useState<number | null>(initial);
  setExternal = setValue;
  return h(MoneyInput, {
    'aria-label': 'montant',
    currency,
    value,
    onChange: (v: number | null) => {
      values.push(v);
      setValue(v);
    },
    onIssue: (i: AmountInputIssue | null) => issues.push(i),
    ...props,
  });
}

async function render(props: HarnessProps = {}) {
  values.length = 0;
  issues.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(h(Harness, props)));
  return container.querySelector('input')!;
}
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const type = (el: HTMLInputElement, text: string) =>
  act(async () => {
    setValue.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const blur = (el: HTMLInputElement) => act(async () => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
const focus = (el: HTMLInputElement) => act(async () => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
const message = () => container!.querySelector('[data-testid="money-input-issue"]')?.textContent ?? null;

describe('MoneyInput — locale fr-MA (point = milliers, virgule = décimale)', () => {
  it.each([
    ['180.000', 18_000_000, '180000'],
    ['180.000,50', 18_000_050, '180000,50'],
    ['1.500.000,75', 150_000_075, '1500000,75'],
    ['180,50', 18_050, '180,50'],
    ['0,01', 1, '0,01'],
    ['0', 0, '0'],
    ['180 000', 18_000_000, '180000'],
  ])('« %s » → %i centimes, réaffiché « %s » (valeur retenue visible)', async (text, minor, shown) => {
    const el = await render({ locale: 'fr-MA' });
    await type(el, text);
    expect(values.at(-1)).toBe(minor);
    expect(issues.at(-1) ?? null).toBeNull(); // aucun refus transmis
    await blur(el);
    expect(el.value).toBe(shown);
    expect(el.getAttribute('aria-invalid')).toBeNull();
    expect(message()).toBeNull();
  });

  it.each([
    ['180.50', 'ambiguous', 'Montant ambigu : utilisez le format 1.234,56.'],
    ['180,500', 'ambiguous', 'Montant ambigu : utilisez le format 1.234,56.'],
    ['1,500.50', 'ambiguous', 'Montant ambigu : utilisez le format 1.234,56.'],
    ['1,2,3', 'invalid', 'Montant non valide. Format attendu : 1.234,56.'],
    ['12,5000', 'precision', 'Trop de décimales pour cette devise (2 au maximum).'],
    ['90071992547409,92', 'tooLarge', 'Montant trop élevé.'],
  ])('« %s » : refusé (%s), conservé tel quel, signalé — jamais converti', async (text, issue, expected) => {
    const el = await render({ locale: 'fr-MA' });
    await type(el, text);
    expect(values.at(-1)).toBeNull();
    expect(issues.at(-1)).toBe(issue);
    await blur(el);
    expect(el.value).toBe(text);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(message()).toBe(expected);
    expect(el.getAttribute('aria-describedby')).toBe(container!.querySelector('[data-testid="money-input-issue"]')!.id);
  });

  it('message masqué pendant la saisie (champ actif), affiché à la sortie du champ', async () => {
    const el = await render({ locale: 'fr-MA' });
    await focus(el);
    await type(el, '180.50');
    expect(message()).toBeNull();
    await blur(el);
    expect(message()).toContain('Montant ambigu');
    // Correction : le message disparaît, la valeur est retenue.
    await type(el, '180,50');
    expect(values.at(-1)).toBe(18_050);
    expect(issues.at(-1) ?? null).toBeNull(); // aucun refus transmis
    expect(message()).toBeNull();
  });

  it('showIssue=false : aucun message sous le champ, motif transmis à l\'appelant', async () => {
    const el = await render({ locale: 'fr-MA', showIssue: false });
    await type(el, '180.50');
    await blur(el);
    expect(message()).toBeNull();
    expect(issues.at(-1)).toBe('ambiguous');
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('MoneyInput — autres locales', () => {
  it.each([
    ['en-US', '180,000', 18_000_000, '180000'],
    ['en-US', '180,000.50', 18_000_050, '180000.50'],
    ['en-US', '180.50', 18_050, '180.50'],
    ['de-DE', '180.000,50', 18_000_050, '180000,50'],
    ['fr-FR', '180 000,50', 18_000_050, '180000,50'],
    ['fr-FR', '12.50', 1_250, '12,50'],
    ['de-CH', "1'234.56", 123_456, '1234.56'],
    ['hi-IN', '12,34,567.50', 123_456_750, '1234567.50'],
    ['ar-SA', '١٬٢٣٤٫٥٦', 123_456, '1234٫56'],
  ])('%s : « %s » → %i, réaffiché « %s »', async (locale, text, minor, shown) => {
    const el = await render({ locale });
    await type(el, text);
    expect(values.at(-1)).toBe(minor);
    await blur(el);
    expect(el.value).toBe(shown);
  });

  it.each([
    ['en-US', '180.000', 'Montant ambigu : utilisez le format 1,234.56.'],
    ['en-US', '180,50', 'Montant ambigu : utilisez le format 1,234.56.'],
    ['de-DE', '180.50', 'Montant ambigu : utilisez le format 1.234,56.'],
    ['fr-FR', '180.000', 'Montant ambigu : utilisez le format 1 234,56.'],
  ])('%s : « %s » refusé et signalé avec l\'exemple de la locale', async (locale, text, expected) => {
    const el = await render({ locale });
    await type(el, text);
    expect(values.at(-1)).toBeNull();
    await blur(el);
    expect(el.value).toBe(text);
    expect(message()).toBe(expected);
  });

  it('valeur initiale affichée avec le séparateur décimal de la locale (relue à l\'identique)', async () => {
    expect((await render({ locale: 'en-US', initial: 150_050 })).value).toBe('1500.50');
    act(() => root?.unmount());
    expect((await render({ locale: 'fr-MA', initial: 150_050 })).value).toBe('1500,50');
  });

  it('devise sans décimales (JPY) et à trois décimales (TND)', async () => {
    let el = await render({ locale: 'fr-MA', currency: 'JPY', initial: null });
    await type(el, '1.500');
    expect(values.at(-1)).toBe(1_500);
    await type(el, '12,5');
    expect(issues.at(-1)).toBe('precision');
    act(() => root?.unmount());
    el = await render({ locale: 'fr-MA', currency: 'TND', initial: null });
    await type(el, '1,500');
    expect(values.at(-1)).toBe(1_500);
    await type(el, '1.500');
    expect(values.at(-1)).toBe(1_500_000);
  });
});

describe('MoneyInput — comportements conservés', () => {
  it('montant négatif sans allowNegative : rendu positif ; avec allowNegative : négatif', async () => {
    let el = await render({ locale: 'fr-MA' });
    await type(el, '-25');
    expect(values.at(-1)).toBe(2_500);
    act(() => root?.unmount());
    el = await render({ locale: 'fr-MA', allowNegative: true });
    await type(el, '-42,1');
    expect(values.at(-1)).toBe(-4_210);
    await blur(el);
    expect(el.value).toBe('-42,10');
  });

  it('champ vidé : valeur null, aucune erreur', async () => {
    const el = await render({ locale: 'fr-MA' });
    await type(el, '');
    expect(values.at(-1)).toBeNull();
    expect(issues.at(-1) ?? null).toBeNull(); // aucun refus transmis
    await blur(el);
    expect(el.value).toBe('');
    expect(el.getAttribute('aria-invalid')).toBeNull();
  });

  it('lettres et symboles ignorés à la saisie', async () => {
    const el = await render({ locale: 'fr-MA' });
    await type(el, '12,50 DH');
    expect(values.at(-1)).toBe(1_250);
  });

  it('onBlur de l\'appelant : appelé en plus, sans désactiver la remise en forme', async () => {
    const onBlur = vi.fn();
    const el = await render({ locale: 'fr-MA', onBlur });
    await type(el, '1,2,3');
    await blur(el);
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(el.value).toBe('1,2,3'); // refusée : conservée et signalée
    await type(el, '7,5');
    await blur(el);
    expect(onBlur).toHaveBeenCalledTimes(2);
    expect(el.value).toBe('7,50');
  });

  it('valeur modifiée de l\'extérieur : texte resynchronisé', async () => {
    const el = await render({ locale: 'fr-MA' });
    await act(async () => setExternal!(99_999));
    expect(el.value).toBe('999,99');
  });

  it('hors AppProvider sans locale : convention par défaut de l\'application (fr-MA en français)', async () => {
    const el = await render({ initial: null });
    await type(el, '180.000');
    expect(values.at(-1)).toBe(18_000_000);
  });
});

describe('MoneyInput — saisie refusée jamais remplacée en silence par l\'écran (A1)', () => {
  /** Écran qui remplace un montant vide par 0 (comme le solde initial d'un compte). */
  function Coercing() {
    const [value, setValue] = useState<number>(150_000);
    const guard = useAmountGuard();
    return h('div', null, [
      h(MoneyInput, { key: 'm', 'aria-label': 'montant', locale: 'fr-MA', currency: 'MAD', value, onChange: (v: number | null) => setValue(v ?? 0), onIssue: guard.track('m') }),
      h('output', { key: 'o', 'data-value': value, 'data-blocked': String(guard.blocked) }),
    ]);
  }
  const out = () => container!.querySelector('output')!;

  it('« 1.50 » refusé : le texte reste, l\'écran est bloqué ; corrigé : débloqué, valeur retenue', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(h(Coercing)));
    const el = container.querySelector('input')!;
    await type(el, '1.50');
    await blur(el);
    expect(el.value).toBe('1.50'); // jamais réécrit en « 0 »
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(out().dataset.value).toBe('0'); // valeur de l'écran…
    expect(out().dataset.blocked).toBe('true'); // …mais enregistrement bloqué
    await type(el, '1.500');
    await blur(el);
    expect(out().dataset.value).toBe('150000');
    expect(out().dataset.blocked).toBe('false');
    expect(el.value).toBe('1500');
  });

  it('champ refusé retiré de l\'écran : il ne bloque plus le formulaire', async () => {
    let setShown: (v: boolean) => void = () => {};
    function Host() {
      const [shown, set] = useState(true);
      setShown = set;
      const guard = useAmountGuard();
      return h('div', null, [
        shown ? h(MoneyInput, { key: 'm', 'aria-label': 'montant', locale: 'fr-MA', currency: 'MAD', value: null, onChange: () => {}, onIssue: guard.track('m') }) : null,
        h('output', { key: 'o', 'data-blocked': String(guard.blocked) }),
      ]);
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(h(Host)));
    await type(container.querySelector('input')!, '1,2,3');
    expect(out().dataset.blocked).toBe('true');
    await act(async () => setShown(false));
    expect(out().dataset.blocked).toBe('false');
  });
});
