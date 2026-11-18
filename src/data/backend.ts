/**
 * Sélection du backend de données et configuration Supabase (V2.4).
 *
 * Source unique : les variables Vite `VITE_DATA_BACKEND`, `VITE_SUPABASE_URL` et
 * `VITE_SUPABASE_ANON_KEY` (voir `.env.example`). Aucune valeur n'est codée en dur.
 *
 *  - `local` (défaut : variable absente ou vide) : base IndexedDB `nexora`, comportement
 *    inchangé ;
 *  - `supabase` : la configuration Cloud est lue et validée, mais le cloud N'EST PAS ACTIVÉ
 *    dans cette version (ni authentification, ni lecture, ni écriture) : le backend effectif
 *    reste `local` ;
 *  - toute autre valeur : refusée explicitement, backend `local`.
 *
 * La lecture de la configuration ne lève jamais d'exception : une configuration absente,
 * incomplète ou invalide est signalée par des messages qui ne contiennent AUCUNE valeur de
 * configuration, et le mode local continue de fonctionner.
 *
 * Clé : seule une clé PUBLIQUE est admise (JWT de rôle `anon` ou clé `sb_publishable_…`) ;
 * une clé `service_role` ou `sb_secret_…` est refusée. Ce contrôle protège contre une erreur
 * de configuration ; il ne vérifie pas la signature (impossible côté navigateur).
 */
import type { NexoraRepository } from './contracts';
import { getDB } from './db';
import { LocalRepository } from './repository';
import { LOCAL_USER_ID } from '@/domain/settings';

export type DataBackend = 'local' | 'supabase';

export interface SupabaseConfig {
  /** Adresse racine du projet (origine, sans chemin). */
  readonly url: string;
  /** Clé publique du projet (anon / publishable). */
  readonly anonKey: string;
}

export type SupabaseConfigStatus =
  | { readonly status: 'ok'; readonly config: SupabaseConfig }
  | { readonly status: 'absent' }
  | { readonly status: 'incomplete'; readonly missing: readonly string[] }
  | { readonly status: 'invalid'; readonly problems: readonly string[] };

export interface BackendSelection {
  /** Backend demandé par `VITE_DATA_BACKEND` (`unknown` : valeur non reconnue). */
  readonly requested: DataBackend | 'unknown';
  /** Backend réellement utilisé : toujours `local` tant que le cloud n'est pas activé. */
  readonly effective: 'local';
  readonly supabase: SupabaseConfigStatus;
  /** Diagnostics, sans aucune valeur de configuration. */
  readonly notices: readonly string[];
}

/** Variables lues (sous-ensemble de `import.meta.env`). */
export interface BackendEnv {
  readonly VITE_DATA_BACKEND?: unknown;
  readonly VITE_SUPABASE_URL?: unknown;
  readonly VITE_SUPABASE_ANON_KEY?: unknown;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Valeur de `VITE_DATA_BACKEND` : absente ou vide → `local` ; valeurs exactes uniquement (non-texte : inconnue). */
export function parseDataBackend(value: unknown): DataBackend | 'unknown' {
  if (value === undefined || value === null) return 'local';
  if (typeof value !== 'string') return 'unknown';
  const v = value.trim();
  if (v === '' || v === 'local') return 'local';
  if (v === 'supabase') return 'supabase';
  return 'unknown';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Contrôle de l'URL : renvoie l'origine normalisée, ou le problème constaté. */
function checkUrl(raw: string): { url: string } | { problem: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { problem: 'VITE_SUPABASE_URL : URL invalide' };
  }
  if (u.username || u.password) return { problem: 'VITE_SUPABASE_URL : identifiants interdits dans l’URL' };
  const secure = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
  if (!secure) return { problem: 'VITE_SUPABASE_URL : https requis (http admis uniquement pour une pile locale)' };
  if (u.pathname !== '/' || u.search || u.hash) return { problem: 'VITE_SUPABASE_URL : adresse racine du projet attendue (sans chemin ni paramètres)' };
  return { url: u.origin };
}

/** Rôle porté par un JWT (non vérifié), ou `undefined` si ce n'est pas un JWT lisible. */
function jwtRole(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
    const role = (payload as { role?: unknown } | null)?.role;
    return typeof role === 'string' ? role : undefined;
  } catch {
    return undefined;
  }
}

/** Contrôle de la clé : seule une clé publique est admise. Renvoie le problème, ou `null`. */
function checkAnonKey(key: string): string | null {
  if (/\s/.test(key)) return 'VITE_SUPABASE_ANON_KEY : espaces interdits';
  if (key.startsWith('sb_secret_')) return 'VITE_SUPABASE_ANON_KEY : clé secrète refusée (seule une clé publique est admise dans le navigateur)';
  if (key.startsWith('sb_publishable_')) return key.length > 'sb_publishable_'.length ? null : 'VITE_SUPABASE_ANON_KEY : clé publique vide';
  const role = jwtRole(key);
  if (role === undefined) return 'VITE_SUPABASE_ANON_KEY : format non reconnu (clé publique « anon » ou « publishable » attendue)';
  if (role === 'service_role') return 'VITE_SUPABASE_ANON_KEY : clé « service_role » refusée (seule une clé publique est admise dans le navigateur)';
  if (role !== 'anon') return 'VITE_SUPABASE_ANON_KEY : rôle autre que « anon » refusé';
  return null;
}

/** Lit et valide la configuration Supabase, sans jamais lever d'exception. */
export function readSupabaseConfig(env: BackendEnv): SupabaseConfigStatus {
  const url = text(env.VITE_SUPABASE_URL);
  const anonKey = text(env.VITE_SUPABASE_ANON_KEY);
  if (!url && !anonKey) return { status: 'absent' };
  const missing = [...(url ? [] : ['VITE_SUPABASE_URL']), ...(anonKey ? [] : ['VITE_SUPABASE_ANON_KEY'])];
  if (missing.length) return { status: 'incomplete', missing };
  const problems: string[] = [];
  const checkedUrl = checkUrl(url);
  if ('problem' in checkedUrl) problems.push(checkedUrl.problem);
  const keyProblem = checkAnonKey(anonKey);
  if (keyProblem) problems.push(keyProblem);
  if (problems.length || 'problem' in checkedUrl) return { status: 'invalid', problems };
  return { status: 'ok', config: { url: checkedUrl.url, anonKey } };
}

const LOCAL_USED = 'mode local utilisé';

/** Sélectionne le backend à partir des variables, sans jamais lever d'exception. */
export function selectBackend(env: BackendEnv): BackendSelection {
  const requested = parseDataBackend(env.VITE_DATA_BACKEND);
  const supabase = readSupabaseConfig(env);
  const notices: string[] = [];
  if (requested === 'unknown') notices.push(`VITE_DATA_BACKEND : valeur non reconnue (admises : local, supabase) — ${LOCAL_USED}.`);
  if (requested === 'supabase') {
    if (supabase.status === 'ok') notices.push(`Backend « supabase » demandé : configuration Cloud valide, mais le cloud n’est pas encore activé dans cette version — ${LOCAL_USED}.`);
    else if (supabase.status === 'absent') notices.push(`Backend « supabase » demandé sans configuration Cloud (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) — ${LOCAL_USED}.`);
    else if (supabase.status === 'incomplete') notices.push(`Backend « supabase » demandé : configuration Cloud incomplète (manquant : ${supabase.missing.join(', ')}) — ${LOCAL_USED}.`);
    else notices.push(`Backend « supabase » demandé : configuration Cloud invalide (${supabase.problems.join(' ; ')}) — ${LOCAL_USED}.`);
  }
  return { requested, effective: 'local', supabase, notices };
}

let current: BackendSelection | null = null;

/** Sélection de l'application, calculée une fois à partir de `import.meta.env`. */
export function getBackendSelection(): BackendSelection {
  if (!current) {
    try {
      // Accès explicites : seules ces trois variables sont incluses dans le build.
      current = selectBackend({
        VITE_DATA_BACKEND: import.meta.env.VITE_DATA_BACKEND,
        VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
        VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
      });
    } catch {
      current = { requested: 'unknown', effective: 'local', supabase: { status: 'absent' }, notices: [`Configuration du backend illisible — ${LOCAL_USED}.`] };
    }
  }
  return current;
}

let reported = false;

/**
 * Repository de l'application selon la sélection. Le backend effectif est toujours `local`
 * dans cette version : même construction qu'avant V2.4 (base `nexora`, utilisateur local).
 * Les diagnostics éventuels sont signalés une seule fois dans la console.
 */
export function createRepository(selection: BackendSelection = getBackendSelection()): NexoraRepository {
  if (!reported && selection.notices.length) {
    reported = true;
    for (const n of selection.notices) console.warn(`[NEXORA] ${n}`);
  }
  return new LocalRepository(getDB(), LOCAL_USER_ID);
}
