import { td } from './core';

/**
 * Objet de libellés traduits à la lecture (getters) : `LABELS[clé]` et
 * `Object.entries(LABELS)` renvoient toujours la langue active.
 */
export function lazyLabels<K extends string>(prefix: string, keys: readonly K[]): Record<K, string> {
  const obj = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(obj, k, { enumerable: true, get: () => td(`${prefix}.${k}`) });
  return obj;
}

/** Nom localisé d'une devise (Intl), repli sur le code. */
export function currencyName(code: string, lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}
