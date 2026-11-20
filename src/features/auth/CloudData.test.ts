// @vitest-environment jsdom
/**
 * V3.4-c — chargement initial lié à la session, dans l'interface (`CloudGate`) — UN onglet.
 *  - [UI] React (jsdom) + VRAI client Supabase (supabase-js, auth-js) sur un stockage de
 *    session partagé ; serveur PostgREST / Auth simulé ; caches dans fake-indexeddb.
 *  - Les vérifications portent sur le contenu RÉEL des bases IndexedDB et sur les requêtes
 *    effectivement envoyées au serveur simulé.
 * Plusieurs onglets : `CloudMultiTab.test.ts`. Aucune requête réelle, aucun accès DEV/PROD.
 */
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { IDBKeyRange } from 'fake-indexeddb';
import { act, createElement as h, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NexoraDB } from '@/data/db';
import { CloudCacheDB, cloudCacheName } from '@/data/cloud/CloudCacheDB';
import { MAPPING, CLOUD_TABLES } from '@/data/cloud/mapping';
import fr from '@/i18n/locales/fr';
import { simBrowser, type SimBrowser } from '@/test/cloudBrowser';
import type { RecordedRequest } from '@/test/postgrestSimulator';
import { userToken } from '@/test/postgrestSimulator';
import { seed } from '@/test/cloudData';
import type { AuthPort } from '@/data/cloud/auth';
import type { CloudDataPort, CloudLoadOutcome } from '@/data/cloud/cloudLoadCycle';
import { CloudGate } from './CloudApp';
import { stubWorkspace } from '@/test/cloudWorkspaceStub';
import { useCloudData, type CloudDataState } from './useCloudData';
import type { CloudSessionState } from './useCloudSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;

const mounted: { root: Root; host: HTMLElement }[] = [];
const browsers: SimBrowser[] = [];

/** Un onglet affiché : vrai client du SDK, `CloudGate` réel. */
async function openTab(b: SimBrowser, wrap: (n: ReactNode) => ReactNode = (n) => n) {
  const { client, cloud } = b.tab();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(wrap(h(CloudGate, { auth: client.auth, cloud, workspace: stubWorkspace, timeoutMs: 2000 }))));
  return {
    client,
    host,
    text: () => host.textContent ?? '',
    button: (label: string) => [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(label)) ?? null,
    async close() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** Attend qu'une condition soit vraie (timers réels, rendus React compris). */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 4000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`délai dépassé : ${what}`);
    await act(async () => new Promise((r) => setTimeout(r, 5)));
  }
}
async function click(el: Element | null) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
}

const rest = (b: SimBrowser) => b.sim.requests.filter((r) => r.path.startsWith('/rest/v1/'));
const isGet = (t: keyof typeof MAPPING) => (r: RecordedRequest) => r.method === 'GET' && r.path === `/rest/v1/${MAPPING[t].sqlTable}`;
const cacheOf = (b: SimBrowser, uid: string) => new CloudCacheDB(cloudCacheName(uid), { userId: uid, dexie: { indexedDB: b.factory, IDBKeyRange } });
async function dump(db: Dexie) {
  const out: Record<string, unknown[]> = {};
  for (const t of [...db.tables].sort((a, b) => a.name.localeCompare(b.name))) out[t.name] = await t.toArray();
  db.close();
  return out;
}
const accountsOf = async (b: SimBrowser, uid: string) => {
  const c = cacheOf(b, uid);
  const n = await c.table('accounts').count();
  c.close();
  return n;
};

/** Navigateur, utilisateur connecté (session stockée) et données sur le serveur. */
async function signedIn() {
  const b = simBrowser();
  browsers.push(b);
  const uid = randomUUID();
  await seed(b.sim.server, uid);
  b.seedSession(uid);
  return { b, uid };
}

/** Onglet chargé jusqu'à l'espace Cloud. */
async function ready(b: SimBrowser) {
  const tab = await openTab(b);
  await until(() => tab.text().includes(fr['cloud.title']), 'espace Cloud');
  return tab;
}

let networkProbe: ReturnType<typeof vi.fn>;
beforeEach(() => {
  networkProbe = vi.fn(() => Promise.reject(new Error('réseau réel interdit pendant les tests')));
  vi.stubGlobal('fetch', networkProbe);
});
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
  for (const b of browsers.splice(0)) await b.close();
  expect(networkProbe).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('V3.4-c [UI] — ouverture et restauration de session', () => {
  it('session restaurée : vérification par Auth, écran de chargement (aucun accès), puis espace Cloud ; cache relu = serveur', async () => {
    const { b, uid } = await signedIn();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    b.sim.onRequest = async (r) => {
      if (isGet('budgets')(r)) await gate;
    };
    const tab = await openTab(b);
    await until(() => tab.text().includes(fr['cloud.loading']), 'écran de chargement');
    expect(tab.text()).not.toContain(fr['cloud.title']);
    expect(b.sim.requests[0]).toMatchObject({ method: 'GET', path: '/auth/v1/user' });
    release();
    await until(() => tab.text().includes(fr['cloud.title']), 'espace Cloud');
    expect(rest(b)).toHaveLength(36);
    expect(await accountsOf(b, uid)).toBe(b.sim.server.rows(uid, 'accounts').length);
    expect(await b.databases()).toEqual([cloudCacheName(uid)]);
  });

  it('T17 StrictMode (effets exécutés deux fois) : UN seul chargement, 36 lectures', async () => {
    const { b } = await signedIn();
    const tab = await openTab(b, (n) => h(StrictMode, null, n));
    await until(() => tab.text().includes(fr['cloud.title']), 'espace Cloud');
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(rest(b)).toHaveLength(36);
  });

  it('T18 renouvellement du jeton (TOKEN_REFRESHED, même utilisateur) : aucun nouveau chargement', async () => {
    const { b } = await signedIn();
    const tab = await ready(b);
    const session = (await tab.client.auth.getSession()).data.session;
    await act(async () => (tab.client.auth as unknown as { _notifyAllSubscribers: (e: string, s: unknown, broadcast?: boolean) => Promise<void> })._notifyAllSubscribers('TOKEN_REFRESHED', session, false));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(tab.text()).toContain(fr['cloud.title']);
    expect(rest(b)).toHaveLength(36);
  });

  it('nouvelle ouverture de session APRÈS purge : caches des autres utilisateurs supprimés, « nexora » intacte, chargement réussi', async () => {
    const { b, uid } = await signedIn();
    const local = new NexoraDB('nexora', { indexedDB: b.factory, IDBKeyRange });
    await local.table('accounts').put({ id: 'compte-local', userId: 'local', name: 'Local' });
    const localBefore = await dump(local);
    const stranger = randomUUID();
    const other = cacheOf(b, stranger);
    await other.table('accounts').put({ id: 'x', userId: stranger });
    other.close();
    await ready(b);
    expect(await b.databases()).toEqual([cloudCacheName(uid), 'nexora'].sort());
    expect(await dump(new NexoraDB('nexora', { indexedDB: b.factory, IDBKeyRange }))).toEqual(localBefore);
  });
});

describe('V3.4-c [UI] — erreurs de chargement (D-3) : cache conservé, aucun accès, « Réessayer »', () => {
  async function failingReload(failure: (b: SimBrowser) => void) {
    const { b, uid } = await signedIn();
    const first = await ready(b);
    await first.close(); // rechargement de la page : nouvel onglet, même navigateur
    const before = await dump(cacheOf(b, uid));
    failure(b);
    const tab = await openTab(b);
    await until(() => tab.text().includes(fr['cloud.loadError.title']), 'écran d’erreur');
    expect(tab.text()).not.toContain(fr['cloud.title']);
    expect(await b.databases()).toContain(cloudCacheName(uid));
    expect(await dump(cacheOf(b, uid))).toEqual(before);
    return { b, uid, tab };
  }

  it('panne réseau : « service injoignable », cache CONSERVÉ à l’identique ; « Réessayer » relance un chargement complet', async () => {
    const { b, tab } = await failingReload((b) => {
      let once = true;
      b.sim.onRequest = (r) => {
        if (once && isGet('debts')(r)) {
          once = false;
          b.sim.respondNext({ network: true });
        }
      };
    });
    expect(tab.text()).toContain(fr['cloud.loadError.unavailable']);
    expect(tab.button(fr['auth.logout'])).toBeTruthy();
    const before = rest(b).length;
    await click(tab.button(fr['auth.retry']));
    await until(() => tab.text().includes(fr['cloud.title']), 'espace Cloud après nouvel essai');
    expect(rest(b).length - before).toBe(36);
  });

  it('erreur 5xx : « service injoignable », cache CONSERVÉ', async () => {
    const { tab } = await failingReload((b) => {
      b.sim.onRequest = (r) => {
        if (isGet('goals')(r)) b.sim.respondNext({ status: 503, body: '{"code":"PGRST002","message":"x"}' });
      };
    });
    expect(tab.text()).toContain(fr['cloud.loadError.unavailable']);
  });

  it('données incohérentes (doublon) : « échec du chargement », cache CONSERVÉ', async () => {
    const { tab } = await failingReload((b) => {
      b.sim.onRequest = (r) => {
        if (!isGet('accounts')(r)) return;
        const uid = b.storedUserId()!;
        const rows = b.sim.server.sqlRows(uid, 'accounts');
        const dup = [...rows, rows[0]];
        b.sim.respondNext({ status: 200, body: JSON.stringify(dup), headers: { 'Content-Range': `0-${dup.length - 1}/${dup.length}` } });
      };
    });
    expect(tab.text()).toContain(fr['cloud.loadError.failed']);
  });

  it('401, session VALIDE selon Auth : « accès refusé », cache CONSERVÉ, aucune déconnexion', async () => {
    const { b, uid, tab } = await failingReload((b) => {
      b.sim.onRequest = (r) => {
        if (isGet('assets')(r)) b.sim.respondNext({ status: 401, body: '{"code":"PGRST303","message":"JWT expired"}' });
      };
    });
    expect(tab.text()).toContain(fr['cloud.loadError.denied']);
    expect(b.storedUserId()).toBe(uid);
  });

  it('401, Auth injoignable pendant la vérification : « service injoignable », cache CONSERVÉ, session conservée', async () => {
    const { b, uid, tab } = await failingReload((b) => {
      let verified = false;
      b.sim.onRequest = (r) => {
        if (r.path === '/auth/v1/user') {
          if (verified) b.sim.respondNext({ network: true }); // vérification après le 401
          verified = true;
        }
        if (isGet('assets')(r)) b.sim.respondNext({ status: 401, body: '{"code":"PGRST303","message":"JWT expired"}' });
      };
    });
    expect(tab.text()).toContain(fr['cloud.loadError.unavailable']);
    expect(b.storedUserId()).toBe(uid);
  });

  it('401, session RÉVOQUÉE selon Auth (session_not_found) : déconnexion locale, « session expirée », cache SUPPRIMÉ', async () => {
    const { b, uid } = await signedIn();
    const first = await ready(b);
    await first.close();
    b.sim.onRequest = (r) => {
      if (isGet('assets')(r)) {
        b.sim.revokedSessions.add(uid);
        b.sim.respondNext({ status: 401, body: '{"code":"PGRST303","message":"JWT expired"}' });
      }
    };
    const tab = await openTab(b);
    await until(() => !!tab.host.querySelector('#auth-email'), 'écran de connexion');
    expect(tab.text()).toContain(fr['auth.err.sessionExpired']);
    expect(b.storedUserId()).toBeNull();
    await until(async () => !(await b.databases()).includes(cloudCacheName(uid)), 'cache supprimé');
  });

  it('T26 vérification de session impossible au démarrage (réseau) : aucun accès, AUCUNE suppression, cache conservé', async () => {
    const { b, uid } = await signedIn();
    const first = await ready(b);
    await first.close();
    const before = await dump(cacheOf(b, uid));
    b.sim.respondNext({ network: true }); // GET /auth/v1/user
    const tab = await openTab(b);
    await until(() => tab.text().includes(fr['auth.err.verifyFailed']), 'erreur de vérification');
    expect(await dump(cacheOf(b, uid))).toEqual(before);
    expect(b.storedUserId()).toBe(uid);
  });
});

describe('V3.4-c [hook] — règles de suppression de `useCloudData` (D-3), états de session imposés', () => {
  /** Rend `useCloudData` avec un état de session imposé par le test ; port de données espionné. */
  async function harness() {
    const deleted: string[] = [];
    const loads: string[] = [];
    const cloud: CloudDataPort = {
      load: async (uid) => {
        loads.push(uid);
        return { status: 'loaded', summary: { userId: uid, rowCounts: {}, versionCount: 0, deletedCount: 0 }, purge: { supported: true, deleted: 0, pending: 0 } } as unknown as CloudLoadOutcome;
      },
      deleteCache: async (uid) => {
        deleted.push(uid);
        return 'deleted';
      },
    };
    const auth = { getUser: async () => ({ data: { user: null }, error: null }), signOut: async () => ({ error: null }) } as unknown as AuthPort;
    let seen: CloudDataState = { status: 'idle' };
    function Probe({ session }: { session: CloudSessionState }) {
      seen = useCloudData(session, cloud, auth).state;
      return null;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    const show = async (session: CloudSessionState) => {
      await act(async () => root.render(h(Probe, { session })));
      await act(async () => new Promise((r) => setTimeout(r, 10)));
    };
    return { deleted, loads, show, state: () => seen };
  }
  const user = (id: string) => ({ status: 'signedIn' as const, user: { id, email: 'x@exemple.invalid' } });

  it('vérification impossible (réseau) ou en cours APRÈS un chargement : accès retiré, AUCUNE suppression ; fin de session : suppression', async () => {
    const t = await harness();
    const uid = randomUUID();
    await t.show(user(uid));
    expect(t.state()).toEqual({ status: 'ready', userId: uid });
    await t.show({ status: 'error', message: 'auth.err.network' });
    expect(t.state()).toEqual({ status: 'idle' });
    await t.show({ status: 'checking' });
    expect(t.deleted).toEqual([]);
    await t.show(user(uid));
    expect(t.loads).toEqual([uid, uid]);
    await t.show({ status: 'signedOut' });
    expect(t.deleted).toEqual([uid]);
  });

  it('changement de compte : suppression du cache de l’ancien utilisateur avant le chargement du nouveau ; renouvellement (même uid) : rien', async () => {
    const t = await harness();
    const [u1, u2] = [randomUUID(), randomUUID()];
    await t.show(user(u1));
    await t.show(user(u1)); // nouvel objet utilisateur, même uid (renouvellement du jeton)
    expect(t.loads).toEqual([u1]);
    await t.show(user(u2));
    expect(t.deleted).toEqual([u1]);
    expect(t.loads).toEqual([u1, u2]);
    expect(t.state()).toEqual({ status: 'ready', userId: u2 });
  });
});

describe('V3.4-c [UI] — fin de session et changement de compte (D-3, D6)', () => {
  it('déconnexion volontaire depuis l’espace Cloud : écran de connexion, révocation envoyée, cache SUPPRIMÉ', async () => {
    const { b, uid } = await signedIn();
    const tab = await ready(b);
    await click(tab.button(fr['auth.logout']));
    await until(() => !!tab.host.querySelector('#auth-email'), 'écran de connexion');
    expect(tab.text()).not.toContain(fr['auth.err.sessionExpired']);
    expect(b.sim.requests.some((r) => r.method === 'POST' && r.path === '/auth/v1/logout')).toBe(true);
    await until(async () => !(await b.databases()).includes(cloudCacheName(uid)), 'cache supprimé');
  });

  it('T30 « Se déconnecter » depuis l’écran d’erreur, HORS LIGNE (révocation impossible) : session locale et cache SUPPRIMÉS', async () => {
    const { b, uid } = await signedIn();
    b.sim.onRequest = (r) => {
      if (isGet('rates')(r) || r.path === '/auth/v1/logout') b.sim.respondNext({ network: true });
    };
    const tab = await openTab(b);
    await until(() => tab.text().includes(fr['cloud.loadError.unavailable']), 'écran d’erreur');
    await click(tab.button(fr['auth.logout']));
    await until(() => !!tab.host.querySelector('#auth-email'), 'écran de connexion');
    expect(b.storedUserId()).toBeNull();
    await until(async () => !(await b.databases()).includes(cloudCacheName(uid)), 'cache supprimé');
  });

  it('T20 session restaurée refusée dès la vérification (révoquée) : aucun chargement, cache de cet utilisateur SUPPRIMÉ', async () => {
    const { b, uid } = await signedIn();
    const first = await ready(b);
    await first.close();
    b.sim.revokedSessions.add(uid);
    const from = rest(b).length;
    const tab = await openTab(b);
    await until(() => !!tab.host.querySelector('#auth-email'), 'écran de connexion');
    expect(tab.text()).toContain(fr['auth.err.sessionExpired']);
    expect(rest(b).length).toBe(from);
    await until(async () => !(await b.databases()).includes(cloudCacheName(uid)), 'cache supprimé');
  });

  it('T19 changement de compte dans l’onglet : chargement de l’ancien invalidé, son cache SUPPRIMÉ, nouveau compte chargé, aucune donnée de l’ancien', async () => {
    const { b, uid } = await signedIn();
    const u2 = randomUUID();
    await seed(b.sim.server, u2);
    const tab = await ready(b);
    const from = b.sim.requests.length;
    await act(async () => {
      await tab.client.auth.setSession({ access_token: userToken(u2), refresh_token: 'rafraichissement-fictif' });
    });
    await until(async () => (await b.databases()).join() === cloudCacheName(u2) && tab.text().includes(fr['cloud.title']), 'compte 2 chargé');
    const after = b.sim.requests.slice(from).filter((r) => r.path.startsWith('/rest/v1/'));
    expect(after).toHaveLength(36);
    for (const r of after) expect(new URLSearchParams(r.query).toString()).toContain(u2);
    const cache2 = await dump(cacheOf(b, u2));
    expect(JSON.stringify(cache2)).not.toContain(uid);
    expect(cache2.accounts).toHaveLength(b.sim.server.rows(u2, 'accounts').length);
    expect(CLOUD_TABLES.length).toBe(18);
  });
});
