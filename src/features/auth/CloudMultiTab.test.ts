// @vitest-environment jsdom
/**
 * V3.4-c — PLUSIEURS ONGLETS (T37, T39, T42) : deux `CloudGate` affichés dans le même
 * navigateur simulé, chacun avec son VRAI client Supabase (auth-js 2.119), un stockage de
 * session partagé, une même fabrique IndexedDB (fake-indexeddb) et le serveur simulé.
 *
 * Environnement jsdom : `window` et `document` existent, le SDK crée donc son
 * `BroadcastChannel` — l'implémentation RÉELLE de Node (aucune simulation de remplacement).
 * Ces tests multi-CLIENTS ne valent pas validation multi-onglets dans un vrai navigateur,
 * prévue en V3.7. Aucune requête réelle, aucun accès DEV/PROD.
 */
import { randomUUID } from 'node:crypto';
import Dexie from 'dexie';
import { IDBKeyRange } from 'fake-indexeddb';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudCacheDB, cloudCacheName } from '@/data/cloud/CloudCacheDB';
import { MAPPING } from '@/data/cloud/mapping';
import fr from '@/i18n/locales/fr';
import { simBrowser, type SimBrowser } from '@/test/cloudBrowser';
import { userToken, type RecordedRequest } from '@/test/postgrestSimulator';
import { seed } from '@/test/cloudData';
import { CloudGate } from './CloudApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;

const mounted: { root: Root; host: HTMLElement }[] = [];
const browsers: SimBrowser[] = [];

async function openTab(b: SimBrowser) {
  const { client, cloud } = b.tab();
  const events: string[] = [];
  client.auth.onAuthStateChange((e) => void events.push(e));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(h(CloudGate, { auth: client.auth, cloud, timeoutMs: 2000 })));
  return {
    client,
    host,
    events,
    text: () => host.textContent ?? '',
    signInScreen: () => !!host.querySelector('#auth-email'),
    button: (label: string) => [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(label)) ?? null,
  };
}
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
const settle = () => act(async () => new Promise((r) => setTimeout(r, 60)));
const rest = (b: SimBrowser) => b.sim.requests.filter((r) => r.path.startsWith('/rest/v1/'));
const cacheOf = (b: SimBrowser, uid: string) => new CloudCacheDB(cloudCacheName(uid), { userId: uid, dexie: { indexedDB: b.factory, IDBKeyRange } });
async function dump(db: Dexie) {
  const out: Record<string, unknown[]> = {};
  for (const t of [...db.tables].sort((a, b) => a.name.localeCompare(b.name))) out[t.name] = await t.toArray();
  db.close();
  return out;
}

/** Requête suspendue (une seule fois) jusqu'à `release()`. */
function pauseOnce(b: SimBrowser, match: (r: RecordedRequest) => boolean) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached = false;
  let used = false;
  b.sim.onRequest = async (r) => {
    if (used || !match(r)) return;
    used = true;
    reached = true;
    await gate;
  };
  return { release: () => release(), reached: () => reached };
}

/** Écritures du chargeur (transactions sur le cache), avec le nom de la base. */
function spyWrites() {
  const names: string[] = [];
  const original = CloudCacheDB.prototype.transaction;
  vi.spyOn(CloudCacheDB.prototype, 'transaction').mockImplementation(function (this: CloudCacheDB, ...args: unknown[]) {
    names.push(this.name);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as never);
  return names;
}

async function signedIn() {
  const b = simBrowser();
  browsers.push(b);
  const uid = randomUUID();
  await seed(b.sim.server, uid);
  b.seedSession(uid);
  return { b, uid };
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

describe('V3.4-c [multi-onglets, jsdom] — session partagée (T37) et diffusion (T42)', () => {
  it('T37 deux onglets, même compte : la session stockée est partagée et restaurée (vérifiée) dans chaque onglet ; chacun charge ; un seul cache, contenu = serveur', async () => {
    const { b, uid } = await signedIn();
    const a = await openTab(b);
    await until(() => a.text().includes(fr['cloud.title']), 'onglet A prêt');
    const tabB = await openTab(b);
    await until(() => tabB.text().includes(fr['cloud.title']), 'onglet B prêt');
    expect(b.sim.requests.filter((r) => r.path === '/auth/v1/user')).toHaveLength(2); // une vérification par onglet
    expect(rest(b)).toHaveLength(72); // un chargement complet par onglet
    expect(await b.databases()).toEqual([cloudCacheName(uid)]);
    const cache = await dump(cacheOf(b, uid));
    expect(cache.accounts).toHaveLength(b.sim.server.rows(uid, 'accounts').length);
  });

  it('T42 BroadcastChannel RÉEL du SDK sous jsdom : la déconnexion de B est reçue par A (SIGNED_OUT), la session relue par A vaut null, A revient à la connexion, cache SUPPRIMÉ', async () => {
    const { b, uid } = await signedIn();
    const a = await openTab(b);
    await until(() => a.text().includes(fr['cloud.title']), 'onglet A prêt');
    const tabB = await openTab(b);
    await until(() => tabB.text().includes(fr['cloud.title']), 'onglet B prêt');
    expect((a.client.auth as unknown as { broadcastChannel: unknown }).broadcastChannel).toBeInstanceOf(BroadcastChannel);
    expect((tabB.client.auth as unknown as { broadcastChannel: unknown }).broadcastChannel).toBeInstanceOf(BroadcastChannel);
    await click(tabB.button(fr['auth.logout']));
    await until(() => a.events.includes('SIGNED_OUT'), 'SIGNED_OUT reçu par A');
    expect((await a.client.auth.getSession()).data.session).toBeNull();
    await until(() => a.signInScreen() && tabB.signInScreen(), 'écran de connexion dans les deux onglets');
    await until(async () => !(await b.databases()).includes(cloudCacheName(uid)), 'cache supprimé');
  });

  it('T38 / T42 chargement EN COURS dans A, déconnexion dans B : A n’envoie plus aucune requête, n’écrit rien, et le cache n’est PAS recréé', async () => {
    const { b, uid } = await signedIn();
    const tabB = await openTab(b);
    await until(() => tabB.text().includes(fr['cloud.title']), 'onglet B prêt');
    const pause = pauseOnce(b, (r) => r.method === 'GET' && r.path === `/rest/v1/${MAPPING.budgets.sqlTable}`);
    const a = await openTab(b);
    await until(() => pause.reached(), 'lecture de A suspendue');
    expect(a.text()).toContain(fr['cloud.loading']);
    const writes = spyWrites();
    await click(tabB.button(fr['auth.logout']));
    await until(() => a.events.includes('SIGNED_OUT'), 'SIGNED_OUT reçu par A');
    await until(async () => !(await b.databases()).includes(cloudCacheName(uid)), 'cache supprimé');
    const sentBefore = rest(b).length;
    pause.release(); // l'ancien chargement de A reprend…
    await settle();
    expect(rest(b).length).toBe(sentBefore); // … sans aucune nouvelle requête
    expect(writes).toEqual([]); // … sans aucune écriture
    expect(await b.databases()).not.toContain(cloudCacheName(uid)); // … et sans recréer le cache
    expect(a.signInScreen()).toBe(true);
  });

  it('ancien chargement qui tente de TERMINER après la déconnexion (suspendu sur la dernière contre-vérification) : aucune écriture, cache non recréé', async () => {
    const { b, uid } = await signedIn();
    const tabB = await openTab(b);
    await until(() => tabB.text().includes(fr['cloud.title']), 'onglet B prêt');
    const pause = pauseOnce(b, (r) => r.method === 'HEAD' && r.path === `/rest/v1/${MAPPING.notificationStates.sqlTable}`);
    const a = await openTab(b);
    await until(() => pause.reached(), 'contre-vérification de A suspendue');
    const writes = spyWrites();
    await click(tabB.button(fr['auth.logout']));
    await until(() => a.events.includes('SIGNED_OUT'), 'SIGNED_OUT reçu par A');
    await until(async () => !(await b.databases()).includes(cloudCacheName(uid)), 'cache supprimé');
    pause.release();
    await settle();
    expect(writes).toEqual([]);
    expect(await b.databases()).not.toContain(cloudCacheName(uid));
  });
});

describe('V3.4-c [multi-onglets, jsdom] — comptes différents (T39)', () => {
  it('T39 B ouvre une session d’un AUTRE compte : A reçoit SIGNED_IN (diffusion), invalide l’ancien utilisateur, supprime son cache et charge le nouveau ; aucune donnée de l’ancien', async () => {
    const { b, uid } = await signedIn();
    const u2 = randomUUID();
    await seed(b.sim.server, u2);
    const a = await openTab(b);
    await until(() => a.text().includes(fr['cloud.title']), 'onglet A prêt');
    const tabB = await openTab(b);
    await until(() => tabB.text().includes(fr['cloud.title']), 'onglet B prêt');
    const writes = spyWrites();
    await act(async () => {
      await tabB.client.auth.setSession({ access_token: userToken(u2), refresh_token: 'rafraichissement-fictif' });
    });
    await until(async () => (await b.databases()).join() === cloudCacheName(u2) && a.text().includes(fr['cloud.title']) && tabB.text().includes(fr['cloud.title']) && writes.length === 2, 'compte 2 chargé dans les deux onglets');
    expect(a.events).toContain('SIGNED_IN');
    expect(writes).toEqual([cloudCacheName(u2), cloudCacheName(u2)]);
    const cache2 = await dump(cacheOf(b, u2));
    expect(JSON.stringify(cache2)).not.toContain(uid);
    expect(cache2.accounts).toHaveLength(b.sim.server.rows(u2, 'accounts').length);
  });

  it('changement de compte PENDANT le chargement de A : l’ancien chargement n’écrit rien, son cache est supprimé, le nouveau compte est chargé', async () => {
    const { b, uid } = await signedIn();
    const u2 = randomUUID();
    await seed(b.sim.server, u2);
    const tabB = await openTab(b);
    await until(() => tabB.text().includes(fr['cloud.title']), 'onglet B prêt');
    const pause = pauseOnce(b, (r) => r.method === 'GET' && r.path === `/rest/v1/${MAPPING.goals.sqlTable}` && r.query.includes(uid));
    const a = await openTab(b);
    await until(() => pause.reached(), 'lecture de A (ancien compte) suspendue');
    const writes = spyWrites();
    await act(async () => {
      await tabB.client.auth.setSession({ access_token: userToken(u2), refresh_token: 'rafraichissement-fictif' });
    });
    await until(() => a.events.includes('SIGNED_IN'), 'SIGNED_IN reçu par A');
    pause.release();
    await until(async () => (await b.databases()).join() === cloudCacheName(u2) && a.text().includes(fr['cloud.title']) && writes.length === 2, 'compte 2 chargé');
    await settle();
    expect(writes.every((n) => n === cloudCacheName(u2))).toBe(true); // jamais d'écriture pour l'ancien compte
    expect(await b.databases()).toEqual([cloudCacheName(u2)]);
    expect(JSON.stringify(await dump(cacheOf(b, u2)))).not.toContain(uid);
  });
});
