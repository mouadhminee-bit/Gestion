/**
 * Traduction de l'interface.
 *
 * - Le dictionnaire français (`locales/fr.ts`) est la source : il définit toutes les
 *   clés. Chaque autre langue doit fournir exactement les mêmes clés (vérifié par
 *   TypeScript via le type `Messages`).
 * - `t()` est une fonction pure (sans React) utilisable aussi par le domaine
 *   (insights, assistant, validations). L'application est remontée lors d'un
 *   changement de langue : aucun texte n'est mis en cache au mauvais endroit.
 * - Pluriels : un message peut être un objet { one, few, many, other… } choisi via
 *   Intl.PluralRules à partir de la variable `count`.
 * - Les autres langues sont chargées à la demande (un fichier JS par langue).
 */
import fr from './locales/fr';
import type { Lang } from './languages';
import { isLang, languageInfo } from './languages';

export interface PluralMsg {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}
export type Msg = string | PluralMsg;
export type MessageKey = keyof typeof fr;
export type Messages = { [K in MessageKey]: Msg };
export type Vars = Record<string, string | number>;

let current: Messages = fr;
let currentLang: Lang = 'fr';
const cache = new Map<Lang, Messages>([['fr', fr]]);
const loaders = import.meta.glob<{ default: Messages }>(['./locales/*.ts', '!./locales/fr.ts']);

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function t(key: MessageKey, vars?: Vars): string {
  const msg: Msg | undefined = current[key] ?? fr[key];
  if (msg == null) return key;
  if (typeof msg === 'string') return interpolate(msg, vars);
  const count = Number(vars?.count ?? 0);
  if (count === 0 && msg.zero) return interpolate(msg.zero, vars);
  const rule = new Intl.PluralRules(currentLang).select(count) as keyof PluralMsg;
  return interpolate(msg[rule] ?? msg.other, vars);
}

/** Variante pour des clés construites dynamiquement (ex : `txType.${type}`). */
export function td(key: string, vars?: Vars): string {
  return t(key as MessageKey, vars);
}

export function getLang(): Lang {
  return currentLang;
}

export function getDir(): 'ltr' | 'rtl' {
  return languageInfo(currentLang).dir;
}

export async function loadMessages(lang: Lang): Promise<Messages> {
  const cached = cache.get(lang);
  if (cached) return cached;
  const loader = loaders[`./locales/${lang}.ts`];
  if (!loader) return fr;
  const mod = await loader();
  cache.set(lang, mod.default);
  return mod.default;
}

/** Active une langue (charge son dictionnaire si nécessaire). */
export async function setLanguage(lang: Lang): Promise<void> {
  const target = isLang(lang) ? lang : 'fr';
  current = await loadMessages(target);
  currentLang = target;
}

/** Pour les tests : active un dictionnaire déjà chargé. */
export function activateMessages(lang: Lang, messages: Messages) {
  cache.set(lang, messages);
  current = messages;
  currentLang = lang;
}
