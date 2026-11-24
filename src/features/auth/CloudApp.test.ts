// @vitest-environment jsdom
/**
 * V2.5 — barrière d'authentification et écrans (React, jsdom).
 *
 * Le SDK est remplacé par un double (`AuthPort`) qui reproduit ses événements
 * (INITIAL_SESSION, SIGNED_IN, SIGNED_OUT…) ; aucune requête réseau, aucun compte réel.
 * Les essais réels contre NEXORA-DEV sont faits séparément (compte de test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, type AuthChangeEvent, type Session } from '@supabase/supabase-js';
import type { AuthPort } from '@/data/cloud/auth';
import type { CloudDataPort, CloudLoadOutcome } from '@/data/cloud/cloudLoadCycle';
import { selectBackend } from '@/data/backend';
import fr from '@/i18n/locales/fr';
import CloudApp, { CloudGate } from './CloudApp';
import { stubWorkspace } from '@/test/cloudWorkspaceStub';
import type { CloudWorkspacePort } from '@/data/cloud/cloudWorkspace';
import type { NexoraRepository } from '@/data/contracts';
import { ToastProvider } from '@/components/ui/Toast';
import { App } from '@/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
Element.prototype.scrollIntoView ??= () => {};

const EMAIL = 'compte-test@exemple.invalid';
const session = (email = EMAIL, id = 'u-1'): Session =>
  ({ access_token: 'jeton-fictif', refresh_token: 'jeton-fictif', expires_in: 3600, token_type: 'bearer', user: { id, email, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' } }) as unknown as Session;

type Listener = (event: AuthChangeEvent, s: Session | null) => void;
type Result<T> = Promise<T>;

/**
 * Double du SDK : événements et réponses contrôlés par le test. Il reproduit deux
 * comportements du SDK réel constatés sur NEXORA-DEV (auth-js 2.119) :
 *  - `getUser` refusé (403 session_not_found → AuthSessionMissingError) : le SDK supprime la
 *    session et émet SIGNED_OUT AVANT de rendre la main ;
 *  - `signOut({ scope: 'local' })` : la session de l'appareil est supprimée (SIGNED_OUT) AVANT
 *    la requête de révocation ; une erreur réseau n'empêche donc pas la déconnexion locale.
 */
function fakeAuth(o: {
  stored?: Session | null;
  emitInitial?: boolean;
  getUser?: () => Result<{ data: { user: Session['user'] | null }; error: unknown }>;
  signIn?: (email: string, password: string) => Result<{ data: { user: unknown; session: Session | null }; error: unknown }>;
  signUp?: (email: string) => Result<{ data: { user: unknown; session: Session | null }; error: unknown }>;
  /** Réponse du service à la révocation (après suppression locale). */
  signOut?: () => Result<{ error: unknown }>;
  /** Échec AVANT toute suppression locale (ex. lecture de session impossible). */
  signOutFailsBeforeRemoval?: unknown;
} = {}) {
  const listeners = new Set<Listener>();
  let current: Session | null = o.stored ?? null;
  const calls = { subscribe: 0, unsubscribe: 0, getUser: 0, signIn: [] as string[], signUp: [] as unknown[], signOut: [] as unknown[] };
  const emit = (e: AuthChangeEvent, s: Session | null) => [...listeners].forEach((l) => l(e, s));
  const port = {
    initialize: async () => ({ error: null }),
    onAuthStateChange(cb: Listener) {
      calls.subscribe++;
      listeners.add(cb);
      if (o.emitInitial !== false) queueMicrotask(() => listeners.has(cb) && cb('INITIAL_SESSION', current));
      return { data: { subscription: { id: String(calls.subscribe), callback: cb, unsubscribe: () => (calls.unsubscribe++, listeners.delete(cb)) } } };
    },
    async getUser() {
      calls.getUser++;
      const r = o.getUser ? await o.getUser() : current ? { data: { user: current.user }, error: null } : { data: { user: null }, error: new AuthSessionMissingError() };
      if (r.error instanceof AuthSessionMissingError) {
        current = null;
        emit('SIGNED_OUT', null); // SDK réel : _removeSession() avant de rendre la main
      }
      return r;
    },
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      calls.signIn.push(email);
      const r = o.signIn ? await o.signIn(email, password) : { data: { user: session(email).user, session: session(email) }, error: null };
      if (r.data.session) {
        current = r.data.session;
        emit('SIGNED_IN', current);
      }
      return r;
    },
    async signUp(args: { email: string }) {
      calls.signUp.push(args);
      const r = o.signUp ? await o.signUp(args.email) : { data: { user: { id: 'u-2' }, session: null }, error: null };
      if (r.data.session) {
        current = r.data.session;
        emit('SIGNED_IN', current);
      }
      return r;
    },
    async signOut(args: { scope?: string }) {
      calls.signOut.push(args);
      if (o.signOutFailsBeforeRemoval) return { error: o.signOutFailsBeforeRemoval };
      // SDK réel (scope local) : suppression locale et SIGNED_OUT, puis révocation auprès du service.
      current = null;
      emit('SIGNED_OUT', null);
      return o.signOut ? o.signOut() : { error: null };
    },
  };
  // V3.4-c : données Cloud chargées instantanément (ces tests portent sur l'authentification ; le
  // chargement réel est couvert par CloudData.test.ts et CloudMultiTab.test.ts).
  const loaded = { status: 'loaded', summary: { userId: '', rowCounts: {}, versionCount: 0, deletedCount: 0 }, purge: { supported: true, deleted: 0, pending: 0 } } as unknown as CloudLoadOutcome;
  const cloud: CloudDataPort = { load: async () => loaded, deleteCache: async () => 'deleted' };
  return { port: port as unknown as AuthPort, cloud, listeners, calls, emit };
}

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  vi.restoreAllMocks();
});

async function render(node: ReactNode) {
  root = createRoot(host);
  await act(async () => root!.render(node));
  await flush();
}

/** Laisse s'exécuter microtâches et minuteries courtes (vérification différée). */
async function flush(ms = 0) {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, ms)));
}

const text = () => host.textContent ?? '';
const $ = <T extends Element>(sel: string) => host.querySelector<T>(sel);
const emailInput = () => $<HTMLInputElement>('#auth-email');
const submitButton = () => $<HTMLButtonElement>('button[type="submit"]');

async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function fillAndSubmit(email: string, password: string, times = 1) {
  await type(emailInput()!, email);
  await type($<HTMLInputElement>('#auth-password')!, password);
  const form = $<HTMLFormElement>('form')!;
  await act(async () => {
    for (let i = 0; i < times; i++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function click(el: Element | null) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await flush();
}

const buttonByText = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) ?? null;

describe('V2.5 — mode local : aucune authentification', () => {
  it('l’application locale s’ouvre directement (accueil local), sans écran de connexion ni appel au SDK', async () => {
    const fetchProbe = vi.fn(() => Promise.reject(new Error('réseau interdit')));
    vi.stubGlobal('fetch', fetchProbe);
    try {
      await render(h(App));
      for (let i = 0; i < 50 && !text().includes(fr['onb.demo']); i++) await flush(20);
      expect(text()).toContain(fr['onb.demo']);
      expect(emailInput()).toBeNull();
      expect(text()).not.toContain(fr['auth.title.login']);
      expect(fetchProbe).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('V2.5 — barrière d’authentification (mode Cloud)', () => {
  it('sans session : écran de connexion uniquement', async () => {
    const f = fakeAuth();
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    expect(emailInput()).toBeTruthy();
    expect(text()).toContain(fr['auth.title.login']);
    expect(text()).not.toContain(fr['cloud.title']);
    expect(f.calls.getUser).toBe(0);
  });

  it('vérification en cours : écran d’attente borné (ni formulaire ni espace Cloud), puis erreur et nouvel essai', async () => {
    const f = fakeAuth({ emitInitial: false });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace, timeoutMs: 80 }));
    expect(text()).toContain(fr['auth.checking']);
    expect(emailInput()).toBeNull();
    expect(text()).not.toContain(fr['cloud.title']);
    await flush(40);
    expect(text()).toContain(fr['auth.err.verifyFailed']);
    expect(text()).toContain(fr['auth.err.timeout']);
    expect(text()).not.toContain(fr['cloud.title']);
    await click(buttonByText(fr['auth.retry']));
    expect(f.calls.subscribe).toBe(2);
    expect(f.calls.unsubscribe).toBe(1);
    expect(f.listeners.size).toBe(1);
  });

  it('session restaurée (actualisation) : vérifiée par le serveur, puis accès à l’espace Cloud', async () => {
    const f = fakeAuth({ stored: session() });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    expect(f.calls.getUser).toBe(1);
    expect(text()).toContain(fr['cloud.title']);
    expect(text()).toContain(EMAIL);
    expect(emailInput()).toBeNull();
  });

  it('session restaurée révoquée (comportement réel du SDK : SIGNED_OUT pendant la vérification) : écran de connexion « session expirée »', async () => {
    const f = fakeAuth({ stored: session(), getUser: async () => ({ data: { user: null }, error: new AuthSessionMissingError() }) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    expect(f.calls.getUser).toBe(1);
    expect(emailInput()).toBeTruthy();
    expect(text()).toContain(fr['auth.err.sessionExpired']);
    expect(text()).not.toContain(fr['cloud.title']);
  });

  it('session restaurée refusée sans suppression par le SDK (JWT invalide) : déconnexion locale, « session expirée »', async () => {
    const f = fakeAuth({ stored: session(), getUser: async () => ({ data: { user: null }, error: new AuthApiError('invalid JWT', 403, 'bad_jwt') }) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    expect(f.calls.signOut).toEqual([{ scope: 'local' }]);
    expect(emailInput()).toBeTruthy();
    expect(text()).toContain(fr['auth.err.sessionExpired']);
    expect(text()).not.toContain(fr['cloud.title']);
  });

  it('vérification impossible (réseau) : aucun accès, message et nouvel essai', async () => {
    let fail = true;
    const f = fakeAuth({ stored: session(), getUser: async () => (fail ? { data: { user: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) } : { data: { user: session().user }, error: null }) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    expect(text()).toContain(fr['auth.err.network']);
    expect(text()).not.toContain(fr['cloud.title']);
    expect(f.calls.signOut).toEqual([]);
    fail = false;
    await click(buttonByText(fr['auth.retry']));
    expect(text()).toContain(fr['cloud.title']);
  });

  it('SIGNED_IN émis pendant la vérification (restauration par le SDK) : jamais accepté sans vérification', async () => {
    const f = fakeAuth({ stored: session(), emitInitial: false, getUser: async () => ({ data: { user: null }, error: new AuthApiError('bad jwt', 401, 'bad_jwt') }) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await act(async () => f.emit('SIGNED_IN', session()));
    await flush();
    expect(f.calls.getUser).toBe(1);
    expect(text()).not.toContain(fr['cloud.title']);
    expect(emailInput()).toBeTruthy();
  });

  it('session devenue invalide pendant l’utilisation (SIGNED_OUT non demandé) : retour à la connexion', async () => {
    const f = fakeAuth({ stored: session() });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    expect(text()).toContain(fr['cloud.title']);
    await act(async () => f.emit('SIGNED_OUT', null));
    await flush();
    expect(emailInput()).toBeTruthy();
    expect(text()).toContain(fr['auth.err.sessionExpired']);
  });

  it('un seul abonnement actif (StrictMode compris), retiré au démontage', async () => {
    const f = fakeAuth();
    await render(h(StrictMode, null, h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace })));
    expect(f.listeners.size).toBe(1);
    expect(f.calls.subscribe - f.calls.unsubscribe).toBe(1);
    await act(async () => root!.unmount());
    root = null;
    expect(f.listeners.size).toBe(0);
    expect(f.calls.subscribe).toBe(f.calls.unsubscribe);
  });
});

describe('V2.5 — connexion, inscription, déconnexion', () => {
  it('connexion réussie : espace Cloud ; double soumission → une seule requête', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeAuth({ signIn: async (email) => (await gate, { data: { user: session(email).user, session: session(email) }, error: null }) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await fillAndSubmit(EMAIL, 'mot-de-passe-fictif', 3);
    expect(f.calls.signIn).toEqual([EMAIL]);
    expect(submitButton()!.disabled).toBe(true);
    await act(async () => release());
    await flush();
    expect(text()).toContain(fr['cloud.title']);
    expect(text()).toContain(EMAIL);
  });

  it('identifiants invalides : message clair, formulaire réactivé, aucun accès', async () => {
    const f = fakeAuth({ signIn: async () => ({ data: { user: null, session: null }, error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials') }) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await fillAndSubmit(EMAIL, 'mauvais');
    expect(text()).toContain(fr['auth.err.invalidCredentials']);
    expect(submitButton()!.disabled).toBe(false);
    expect(text()).not.toContain(fr['cloud.title']);
  });

  it('saisie incomplète : aucune requête', async () => {
    const f = fakeAuth();
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await fillAndSubmit('', '');
    expect(text()).toContain(fr['auth.err.required']);
    expect(f.calls.signIn).toEqual([]);
  });

  it('inscription avec confirmation d’e-mail exigée : marche à suivre, retour à la connexion, aucun accès', async () => {
    const f = fakeAuth();
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await click(buttonByText(fr['auth.toSignup']));
    expect(text()).toContain(fr['auth.title.signup']);
    await fillAndSubmit(EMAIL, 'mot-de-passe-fictif');
    expect(f.calls.signUp).toHaveLength(1);
    expect(f.calls.signUp[0]).toMatchObject({ email: EMAIL, options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
    expect(text()).toContain(fr['auth.confirmSent'].replace('{email}', EMAIL));
    expect(text()).toContain(fr['auth.title.login']);
    expect(text()).not.toContain(fr['cloud.title']);
  });

  it('inscription sans confirmation (session immédiate) : accès à l’espace Cloud', async () => {
    const f = fakeAuth({ signUp: async (email) => ({ data: { user: session(email).user, session: session(email) }, error: null }) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await click(buttonByText(fr['auth.toSignup']));
    await fillAndSubmit(EMAIL, 'mot-de-passe-fictif');
    expect(text()).toContain(fr['cloud.title']);
  });

  it('inscription refusée par le service : message traduit, jamais le texte brut', async () => {
    const f = fakeAuth({ signUp: async () => ({ data: { user: null, session: null }, error: new AuthApiError(`Email address "${EMAIL}" cannot be used`, 400, 'email_address_not_authorized') }) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await click(buttonByText(fr['auth.toSignup']));
    await fillAndSubmit(EMAIL, 'mot-de-passe-fictif');
    expect(text()).toContain(fr['auth.err.emailNotAuthorized']);
    expect(text()).not.toContain('cannot be used');
  });

  it('déconnexion : session invalidée (scope local), retour à l’écran de connexion sans message d’expiration', async () => {
    const f = fakeAuth({ stored: session() });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await click(buttonByText(fr['auth.logout']));
    expect(f.calls.signOut).toEqual([{ scope: 'local' }]);
    expect(emailInput()).toBeTruthy();
    expect(text()).not.toContain(fr['auth.err.sessionExpired']);
    expect(text()).not.toContain(fr['cloud.title']);
  });

  it('déconnexion hors ligne : la session de l’appareil est supprimée d’abord, retour à la connexion', async () => {
    const f = fakeAuth({ stored: session(), signOut: async () => ({ error: new AuthRetryableFetchError('Failed to fetch', 0) }) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await click(buttonByText(fr['auth.logout']));
    expect(emailInput()).toBeTruthy();
    expect(text()).not.toContain(fr['cloud.title']);
    expect(text()).not.toContain(fr['auth.err.sessionExpired']);
  });

  it('déconnexion impossible avant suppression locale : message, l’utilisateur reste connecté et peut réessayer', async () => {
    const f = fakeAuth({ stored: session(), signOutFailsBeforeRemoval: new AuthRetryableFetchError('Failed to fetch', 0) });
    await render(h(CloudGate, { auth: f.port, cloud: f.cloud, workspace: stubWorkspace }));
    await click(buttonByText(fr['auth.logout']));
    expect(text()).toContain(fr['auth.err.network']);
    expect(text()).toContain(fr['cloud.title']);
    expect(buttonByText(fr['auth.logout'])!.disabled).toBe(false);
  });
});

describe('V2.5 — mode Cloud sans données', () => {
  it('configuration Cloud absente ou invalide : écran bloquant, aucun formulaire', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render(h(CloudApp, { selection: selectBackend({ VITE_DATA_BACKEND: 'supabase' }) }));
    expect(text()).toContain(fr['auth.config.title']);
    expect(emailInput()).toBeNull();
  });

  it('parcours complet (connexion, espace Cloud, déconnexion) sans aucun accès IndexedDB ni requête réseau', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const fetchProbe = vi.fn(() => Promise.reject(new Error('réseau interdit')));
    vi.stubGlobal('fetch', fetchProbe);
    try {
      const f = fakeAuth();
      // V3.5 : espace de données factice (nouvel utilisateur → accueil Cloud), aucune base ouverte.
      const opened: string[] = [];
      const workspace: CloudWorkspacePort = {
        open: (userId) => (opened.push(userId), { userId, repo: {} as NexoraRepository, reader: { snapshot: async () => null }, sync: null, close() {} }),
      };
      await render(h(ToastProvider, null, h(CloudApp, { selection: selectBackend({}), auth: f.port, cloud: f.cloud, workspace })));
      await fillAndSubmit(EMAIL, 'mot-de-passe-fictif');
      for (let i = 0; i < 50 && !text().includes(fr['onb.fresh']); i++) await flush(20);
      expect(text()).toContain(fr['onb.fresh']); // accueil (onboarding) de l'application
      expect(text()).not.toContain(fr['onb.demo']); // démo désactivée en mode Cloud
      expect(opened).toHaveLength(1);
      await click(buttonByText(fr['auth.logout']));
      expect(emailInput()).toBeTruthy();
      expect(open).not.toHaveBeenCalled();
      expect(fetchProbe).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
