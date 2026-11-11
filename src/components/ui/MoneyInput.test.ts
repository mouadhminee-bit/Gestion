// @vitest-environment jsdom
/**
 * MoneyInput — sortie du champ : comportement par défaut inchangé pour tous les écrans existants,
 * option explicite `keepInvalidText`, et `onBlur` de l'appelant ajouté (jamais substitué) quel que
 * soit l'ordre des propriétés.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoneyInput } from './Field';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

const values: (number | null)[] = [];
function Harness(props: { keepInvalidText?: boolean; onBlur?: () => void; allowNegative?: boolean }) {
  const [value, setValue] = useState<number | null>(150_000);
  return h(MoneyInput, {
    'aria-label': 'montant',
    currency: 'MAD',
    value,
    onChange: (v: number | null) => {
      values.push(v);
      setValue(v);
    },
    ...props,
  });
}

async function render(props: Parameters<typeof Harness>[0] = {}) {
  values.length = 0;
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

describe('MoneyInput — comportement par défaut (écrans existants)', () => {
  it('saisie valide : centimes exacts, texte remis en forme à la sortie du champ', async () => {
    const el = await render();
    expect(el.value).toBe('1500');
    await type(el, '1234,5');
    expect(values.at(-1)).toBe(123_450);
    await blur(el);
    expect(el.value).toBe('1234,50');
  });

  it('saisie non interprétable : valeur null, texte effacé à la sortie du champ (inchangé)', async () => {
    const el = await render();
    await type(el, '1,2,3');
    expect(values.at(-1)).toBeNull();
    await blur(el);
    expect(el.value).toBe('');
  });

  it('montant négatif sans allowNegative : rendu positif (inchangé)', async () => {
    const el = await render();
    await type(el, '-25');
    expect(values.at(-1)).toBe(2_500);
  });

  it('onBlur de l\'appelant : appelé en plus, sans désactiver la remise en forme ni l\'effacement', async () => {
    const onBlur = vi.fn();
    const el = await render({ onBlur });
    await type(el, '1,2,3');
    await blur(el);
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(el.value).toBe(''); // auparavant, un onBlur fourni remplaçait ce comportement
    await type(el, '7,5');
    await blur(el);
    expect(onBlur).toHaveBeenCalledTimes(2);
    expect(el.value).toBe('7,50');
  });
});

describe('MoneyInput — option keepInvalidText', () => {
  it('saisie non interprétable conservée telle quelle après la perte de focus', async () => {
    const onBlur = vi.fn();
    const el = await render({ keepInvalidText: true, onBlur, allowNegative: true });
    await type(el, '1,2,3');
    await blur(el);
    expect(el.value).toBe('1,2,3');
    expect(values.at(-1)).toBeNull();
    expect(onBlur).toHaveBeenCalledTimes(1);
    await type(el, '-');
    await blur(el);
    expect(el.value).toBe('-');
  });

  it('correction : une saisie valide redevient remise en forme ; champ vidé reste vide', async () => {
    const el = await render({ keepInvalidText: true, allowNegative: true });
    await type(el, '1,2,3');
    await blur(el);
    await type(el, '-42,1');
    expect(values.at(-1)).toBe(-4_210);
    await blur(el);
    expect(el.value).toBe('-42,10');
    await type(el, '');
    expect(values.at(-1)).toBeNull();
    await blur(el);
    expect(el.value).toBe('');
  });
});
