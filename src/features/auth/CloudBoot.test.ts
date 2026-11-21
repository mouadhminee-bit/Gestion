// @vitest-environment jsdom
/**
 * V3.7 — ordre de démarrage du mode Cloud (Plan directeur V1, V3.2) : l'échange du code PKCE
 * (`auth.initialize()` du SDK) est TERMINÉ avant le montage du HashRouter.
 *
 * L'application entière (`App`) est rendue en mode Cloud avec un double du client Supabase dont
 * l'initialisation est retenue ; le `HashRouter` est instrumenté (chaque rendu est journalisé avec
 * l'adresse courante). On vérifie l'ORDRE (journal), pas seulement l'absence de route visible.
 * Cas : code échangé ; lien ouvert dans un autre navigateur (code non échangé) ; lien expiré
 * (erreur dans le fragment) ; code refusé ; initialisation trop longue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fr from '@/i18n/locales/fr';
import { authCallbackNotice, cleanAuthCallbackHref, readAuthCallback } from './authCallback';

const H = vi.hoisted(() => ({
  log: [] as string[],
  initialize: null as null | (() => Promise<{ error: unknown }>),
}));

vi.mock('react-router-dom', async (orig) => {
  const m = await orig<typeof import('react-router-dom')>();
  const { createElement } = await import('react');
  return {
    ...m,
    HashRouter: (props: Parameters<typeof m.HashRouter>[0]) => {
      H.log.push(`routeur:${window.location.search}${window.location.hash}`);
      return createElement(m.HashRouter, props);
    },
  };
});

vi.mock('@/data/backend', async (orig) => {
  const m = await orig<typeof import('@/data/backend')>();
  const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const anon = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ iss: 'supabase', ref: 'projetfictif', role: 'anon' })}.c2lnbmF0dXJl`;
  const sel = m.selectBackend({ VITE_DATA_BACKEND: 'supabase', VITE_SUPABASE_URL: 'https://projetfictif.supabase.co', VITE_SUPABASE_ANON_KEY: anon });
  return { ...m, getBackendSelection: () => sel };
});

vi.mock('@/data/cloud/supabaseClient', () => {
  const auth = {
    initialize: () => {
      H.log.push('initialize:appel');
      return H.initialize!();
    },
    onAuthStateChange(cb: (e: string, s: null) => void) {
      H.log.push('session:abonnement');
      setTimeout(() => cb('INITIAL_SESSION', null), 0);
      return { data: { subscription: { unsubscribe() {} } } };
    },
    getUser: async () => ({ data: { user: null }, error: null }),
    signInWithPassword: async () => ({ data: { user: null, session: null }, error: null }),
    signUp: async () => ({ data: { user: null, session: null }, error: null }),
    signOut: async () => ({ error: null }),
  };
  return { getSupabaseClient: () => ({ auth, from: () => ({}), rpc: async () => ({}) }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;

let root: Root | null = null;
let host: HTMLElement | null = null;
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
};
const text = () => host?.textContent ?? '';

/** Initialisation retenue : `finish(error, removeCode)` imite la fin de `_initialize` du SDK. */
function holdInitialize() {
  let release!: (v: { error: unknown }) => void;
  const p = new Promise<{ error: unknown }>((r) => (release = r));
  H.initialize = () => p;
  return {
    finish(error: unknown = null, removeCode = false) {
      if (removeCode) {
        const u = new URL(window.location.href);
        u.searchParams.delete('code');
        window.history.replaceState(window.history.state, '', u.toString()); // ce que fait le SDK après un échange réussi
      }
      H.log.push('initialize:fin');
      release({ error });
    },
  };
}

async function renderApp() {
  const { App } = await import('@/App');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(h(App)));
  // Module Cloud chargé à la demande (lazy) : attendre l'appel d'initialisation.
  for (let i = 0; i < 200 && !H.log.includes('initialize:appel'); i++) await flush(1);
  await flush();
}

beforeEach(() => {
  H.log.length = 0;
  H.initialize = null;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, '', '/');
});

describe('V3.7 — échange du code PKCE AVANT le montage du HashRouter', () => {
  it('code échangé : aucun routeur pendant l’initialisation ; routeur monté après, adresse sans code', async () => {
    window.history.replaceState(null, '', '/?code=code-fictif');
    const init = holdInitialize();
    await renderApp();
    expect(H.log).toContain('initialize:appel');
    expect(H.log.some((l) => l.startsWith('routeur:'))).toBe(false); // pas monté, même invisible
    expect(H.log).not.toContain('session:abonnement'); // barrière de session non montée non plus
    expect(text()).toContain(fr['auth.checking']);
    init.finish(null, true);
    await flush();
    const iFin = H.log.indexOf('initialize:fin');
    const iRouter = H.log.findIndex((l) => l.startsWith('routeur:'));
    expect(iFin).toBeGreaterThanOrEqual(0);
    expect(iRouter).toBeGreaterThan(iFin);
    expect(H.log.filter((l) => l.startsWith('routeur:')).every((l) => !l.includes('code='))).toBe(true);
    expect(window.location.search).toBe('');
    expect(document.querySelector('#auth-email')).not.toBeNull();
    expect(text()).not.toContain(fr['auth.link.noSession']);
    expect(text()).not.toContain(fr['auth.link.invalid']);
  });

  it('lien ouvert dans un autre navigateur (code non échangé) : code retiré AVANT le routeur, « session non ouverte, connectez-vous »', async () => {
    window.history.replaceState(null, '', '/?code=code-fictif');
    const init = holdInitialize();
    await renderApp();
    init.finish(null, false); // pas de vérificateur : le SDK n'échange rien et laisse le code
    await flush();
    const routers = H.log.filter((l) => l.startsWith('routeur:'));
    expect(routers.length).toBeGreaterThan(0);
    expect(routers.every((l) => !l.includes('code='))).toBe(true);
    expect(window.location.search).toBe('');
    expect(document.querySelector('#auth-email')).not.toBeNull();
    expect(text()).toContain(fr['auth.link.noSession']);
  });

  it('lien expiré (erreur dans le fragment) : fragment jamais vu par le routeur, « lien invalide ou expiré »', async () => {
    window.history.replaceState(null, '', '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    const init = holdInitialize();
    await renderApp();
    expect(H.log.some((l) => l.startsWith('routeur:'))).toBe(false);
    init.finish(new Error('Email link is invalid or has expired'));
    await flush();
    const routers = H.log.filter((l) => l.startsWith('routeur:'));
    expect(routers.length).toBeGreaterThan(0);
    expect(routers.every((l) => !l.includes('error'))).toBe(true);
    expect(window.location.hash).toBe('#/');
    expect(text()).toContain(fr['auth.link.invalid']);
    expect(text()).not.toContain('otp_expired');
  });

  it('code refusé à l’échange (expiré) : « lien invalide ou expiré », code retiré', async () => {
    window.history.replaceState(null, '', '/?code=code-perime');
    const init = holdInitialize();
    await renderApp();
    init.finish(new Error('invalid flow state, flow state has expired'), false);
    await flush();
    expect(H.log.filter((l) => l.startsWith('routeur:')).every((l) => !l.includes('code='))).toBe(true);
    expect(window.location.search).toBe('');
    expect(text()).toContain(fr['auth.link.invalid']);
  });

  it('initialisation trop longue : écran d’erreur SANS routeur ; nouvel essai → routeur après la fin', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.history.replaceState(null, '', '/?code=code-fictif');
      const init = holdInitialize();
      await renderApp();
      await act(async () => vi.advanceTimersByTime(16_000));
      await flush();
      expect(text()).toContain(fr['auth.err.verifyFailed']);
      expect(H.log.some((l) => l.startsWith('routeur:'))).toBe(false);
      init.finish(null, true);
      const retry = [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes(fr['auth.retry']))!;
      await act(async () => retry.click());
      await flush();
      expect(H.log.findIndex((l) => l.startsWith('routeur:'))).toBeGreaterThan(H.log.indexOf('initialize:fin'));
      expect(document.querySelector('#auth-email')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sans retour de lien : aucun message, adresse et route conservées', async () => {
    window.history.replaceState(null, '', '/#/settings');
    const init = holdInitialize();
    await renderApp();
    init.finish(null);
    await flush();
    expect(H.log.findIndex((l) => l.startsWith('routeur:'))).toBeGreaterThan(H.log.indexOf('initialize:fin'));
    expect(H.log.find((l) => l.startsWith('routeur:'))).toBe('routeur:#/settings');
    expect(text()).not.toContain(fr['auth.link.noSession']);
    expect(text()).not.toContain(fr['auth.link.invalid']);
  });
});

describe('V3.7 — lecture et nettoyage du retour de lien', () => {
  it.each([
    ['http://h/', 'none'],
    ['http://h/#/accounts', 'none'],
    ['http://h/?code=abc', 'code'],
    ['http://h/?code=abc#/', 'code'],
    ['http://h/#error=access_denied&error_code=otp_expired', 'error'],
    ['http://h/?error=server_error&error_description=x', 'error'],
    ['http://h/#access_token=a&refresh_token=b&type=signup', 'tokens'],
  ])('%s → %s', (href, kind) => {
    expect(readAuthCallback(href).kind).toBe(kind);
  });

  it('nettoyage : paramètres d’authentification retirés, route conservée, fragment non-route → #/', () => {
    expect(cleanAuthCallbackHref('http://h/?code=abc')).toBe('http://h/');
    expect(cleanAuthCallbackHref('http://h/?code=abc&x=1#/settings')).toBe('http://h/?x=1#/settings');
    expect(cleanAuthCallbackHref('http://h/#error=access_denied&error_code=otp_expired')).toBe('http://h/#/');
    expect(cleanAuthCallbackHref('http://h/#access_token=a&refresh_token=b')).toBe('http://h/#/');
    expect(cleanAuthCallbackHref('http://h/#/accounts')).toBe('http://h/#/accounts');
  });

  it('message : selon le retour et l’issue de l’échange', () => {
    expect(authCallbackNotice({ kind: 'none' }, null, false)).toBeUndefined();
    expect(authCallbackNotice({ kind: 'code' }, null, false)).toBeUndefined();
    expect(authCallbackNotice({ kind: 'code' }, null, true)).toBe('auth.link.noSession');
    expect(authCallbackNotice({ kind: 'code' }, new Error('x'), true)).toBe('auth.link.invalid');
    expect(authCallbackNotice({ kind: 'error' }, null, false)).toBe('auth.link.invalid');
    expect(authCallbackNotice({ kind: 'tokens' }, new Error('Not a valid PKCE flow url.'), false)).toBe('auth.link.invalid');
  });
});
