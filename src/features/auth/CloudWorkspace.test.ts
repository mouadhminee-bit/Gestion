// @vitest-environment jsdom
/**
 * V3.5 — branchement de `CloudRepository` et onboarding Cloud, dans l'interface RÉELLE :
 * `CloudApp` → barrière de session → chargement initial (V3.4) → espace de données
 * (`CloudRepository(uid, HttpTransport)` + lecteur d'affichage, option O1) → `Workspace`
 * (onboarding ou application NEXORA).
 *
 * Vrai client Supabase (supabase-js, auth-js) ; serveur PostgREST / Auth simulé (lecture et
 * fonctions d'écriture `apply_changeset` / `resolve_changeset`) ; caches dans fake-indexeddb.
 * Données fictives ; aucune requête réelle, aucun accès DEV/PROD. Le comportement d'un vrai
 * navigateur (IndexedDB, multi-onglets) relève de V3.7.
 */
import { randomUUID } from 'node:crypto';
import { IDBKeyRange } from 'fake-indexeddb';
import { act, createElement as h, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Dialog';
import { selectBackend } from '@/data/backend';
import { cloudCacheName } from '@/data/cloud/CloudCacheDB';
import { CloudFeatureUnavailableError, createCloudWorkspacePort, type CloudWorkspace, type CloudWorkspacePort } from '@/data/cloud/cloudWorkspace';
import { HttpTransport } from '@/data/cloud/HttpTransport';
import type { CloudTransport } from '@/data/cloud/transport';
import { generateDemoData } from '@/data/demo';
import { LAST_ACCOUNT_KEY, MONTH_KEY } from '@/app/uiState';
import fr from '@/i18n/locales/fr';
import { simBrowser, type SimBrowser } from '@/test/cloudBrowser';
import { seed, TODAY } from '@/test/cloudData';
import type { RecordedRequest } from '@/test/postgrestSimulator';
import CloudApp from './CloudApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// API absentes de jsdom, utilisées par les composants (aucun effet sur les données).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo = (() => {}) as never;

vi.setConfig({ testTimeout: 30_000 });

const mounted: { root: Root; host: HTMLElement }[] = [];
const browsers: SimBrowser[] = [];

beforeEach(() => {
  window.location.hash = '#/';
});

afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
  for (const b of browsers.splice(0)) await b.close();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

/** Attend qu'une condition soit vraie (timers réels, rendus React compris). */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 6000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`délai dépassé : ${what}`);
    await act(async () => new Promise((r) => setTimeout(r, 5)));
  }
}

const isApply = (r: RecordedRequest) => r.method === 'POST' && r.path === '/rest/v1/rpc/apply_changeset';
const applied = (b: SimBrowser) => b.sim.requests.filter(isApply);
const opTables = (r: RecordedRequest) => [...new Set((r.body as { p_changeset: { ops: { table: string }[] } }).p_changeset.ops.map((o) => o.table))].sort();

/** Un onglet de l'application en mode Cloud (fournisseurs de `App`, `CloudApp` réel). */
async function openApp(b: SimBrowser, options: { wrapTransport?: (t: CloudTransport) => CloudTransport; strict?: boolean } = {}) {
  const { client, cloud } = b.tab();
  const http = new HttpTransport(client);
  const port = createCloudWorkspacePort({ transport: options.wrapTransport ? options.wrapTransport(http) : http, indexedDB: b.factory, IDBKeyRange });
  const spaces: CloudWorkspace[] = [];
  const closed: string[] = [];
  const workspace: CloudWorkspacePort = {
    open(userId) {
      const s = port.open(userId);
      spaces.push(s);
      return { ...s, close: () => (closed.push(userId), s.close()) };
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const app = h(I18nProvider, null, h(TooltipProvider, null, h(ToastProvider, null, h(ConfirmProvider, null, h(CloudApp, { selection: selectBackend({}), auth: client.auth, cloud, workspace })))));
  await act(async () => root.render(options.strict ? h(StrictMode, null, app) : app));
  const text = () => host.textContent ?? '';
  const button = (label: string) => [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(label)) ?? null;
  return {
    client,
    host,
    spaces,
    closed,
    text,
    button,
    /** Dernier espace de données ouvert (dépôt d'écriture de la session). */
    space: () => spaces[spaces.length - 1],
    async click(label: string) {
      const el = button(label);
      expect(el, `bouton « ${label} »`).toBeTruthy();
      await act(async () => el!.click());
    },
    async type(input: HTMLInputElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    async go(path: string) {
      await act(async () => {
        window.location.hash = `#${path}`;
      });
    },
  };
}
type AppTab = Awaited<ReturnType<typeof openApp>>;

/** Application affichée (coque de navigation présente). */
const inApp = (tab: AppTab) => tab.text().includes(fr['nav.settings']) && !tab.text().includes(fr['onb.fresh']);

/** Nouvel utilisateur (profil créé à l'inscription, aucune autre donnée), session stockée. */
function newUser() {
  const b = simBrowser();
  browsers.push(b);
  const uid = randomUUID();
  b.sim.server.registerUser(uid);
  b.seedSession(uid);
  return { b, uid };
}

/** Onboarding Cloud complet par l'interface (prénom, puis « Démarrer »). */
async function onboard(tab: AppTab, name = 'Sara') {
  await until(() => tab.text().includes(fr['onb.fresh']), 'accueil Cloud');
  await tab.click(fr['onb.fresh']);
  await tab.type(tab.host.querySelector('input') as HTMLInputElement, name);
  await tab.click(fr['onb.start']);
}

describe('V3.5 — onboarding Cloud (nouvel utilisateur)', () => {
  it('T1–T3 : chargement, accueil sans démo, onboarding par lots via HttpTransport, application affichée sans rechargement', async () => {
    const { b, uid } = newUser();
    const tab = await openApp(b);
    await until(() => tab.text().includes(fr['onb.fresh']), 'accueil Cloud');
    // T1 : espace ouvert APRÈS le chargement, sur le cache de l'utilisateur ; démo désactivée.
    expect(tab.spaces.map((s) => s.userId)).toEqual([uid]);
    expect(tab.text()).not.toContain(fr['onb.demo']);
    expect(tab.button(fr['auth.logout'])).toBeTruthy();
    expect(applied(b)).toHaveLength(0); // aucune écriture avant l'action de l'utilisateur

    await onboard(tab);
    // T3 : l'application remplace l'accueil sans rechargement (lecteur suivi par Dexie).
    await until(() => inApp(tab), 'application après onboarding');

    // T2 : 1er lot = profil + paramètres + catégories initiales (jamais `meta`), puis les lots
    // des paramètres, du premier compte et de la fin d'onboarding (parcours inchangé, A1).
    const lots = applied(b);
    expect(lots.map(opTables)).toEqual([['categories', 'profiles', 'user_settings'], ['user_settings'], ['accounts'], ['user_settings']]);
    for (const r of lots) expect(JSON.stringify(r.body)).not.toContain('schemaVersion');
    const server = b.sim.server;
    expect(server.rows(uid, 'settings')).toHaveLength(1);
    expect((server.rows(uid, 'settings')[0] as { onboarded: boolean; displayName: string }).onboarded).toBe(true);
    expect((server.rows(uid, 'settings')[0] as { displayName: string }).displayName).toBe('Sara');
    expect(server.rows(uid, 'accounts')).toHaveLength(1);
    expect(server.rows(uid, 'categories').length).toBeGreaterThan(0);
    // Affichage = données confirmées du serveur.
    const snap = await tab.space().reader.snapshot();
    expect(snap?.accounts.map((a) => a.id)).toEqual(server.rows(uid, 'accounts').map((a) => (a as { id: string }).id));
    expect(snap?.categories).toHaveLength(server.rows(uid, 'categories').length);
    // Base locale jamais ouverte : seules les bases de ce navigateur, et uniquement le cache.
    expect(await b.databases()).toEqual([cloudCacheName(uid)]);
  });

  it('T3 : une écriture n’apparaît qu’une fois confirmée par le serveur, puis sans rechargement', async () => {
    const { b } = newUser();
    let hold: Promise<void> | null = null;
    let release = () => {};
    const tab = await openApp(b, {
      wrapTransport: (t) => ({
        kind: t.kind,
        async commit(c) {
          // Lot APPLIQUÉ par le serveur, confirmation retenue : il ne doit pas être affiché.
          const r = await t.commit(c);
          if (hold) await hold;
          return r;
        },
        resolve: (id, u) => t.resolve(id, u),
      }),
    });
    await onboard(tab);
    await until(() => inApp(tab), 'application');
    await tab.go('/accounts');
    await until(() => tab.text().includes(fr['nav.accounts']), 'page des comptes');
    hold = new Promise<void>((r) => (release = r));
    const before = applied(b).length;
    let done = false;
    const pending = tab.space().repo.createAccount({ name: 'Épargne Cloud', type: 'savings', currency: 'MAD', initialBalance: 0, initialBalanceDate: TODAY, archived: false, includeInTotal: true, color: '#5271FF', order: 1 }).then(() => (done = true));
    await until(() => applied(b).length === before + 1, 'lot envoyé');
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(done).toBe(false);
    expect(b.sim.server.rows(tab.space().userId, 'accounts')).toHaveLength(2); // appliqué côté serveur…
    expect(tab.text()).not.toContain('Épargne Cloud'); // …mais non confirmé à l'appareil : invisible
    hold = null;
    release();
    await pending;
    await until(() => tab.text().includes('Épargne Cloud'), 'compte affiché après confirmation');
  });

  it('T5 : onboarding interrompu (réseau) → message traduit, accueil conservé ; la reprise aboutit sans doublon', async () => {
    const { b, uid } = newUser();
    let n = 0;
    b.sim.onRequest = (r) => {
      if (isApply(r) && ++n === 2) b.sim.respondNext({ network: true }); // 2e lot : réponse perdue
    };
    const tab = await openApp(b);
    await onboard(tab);
    await until(() => tab.text().includes(fr['cloud.write.unconfirmed']), 'message d’enregistrement non confirmé');
    expect(tab.text()).not.toContain('Failed to fetch');
    expect(tab.text()).not.toContain('settings');
    expect(inApp(tab)).toBe(false);
    // Reprise : la saisie est conservée ; le lot non confirmé est résolu avant toute écriture.
    await tab.click(fr['onb.start']);
    await until(() => inApp(tab), 'application après reprise');
    expect(b.sim.requests.some((r) => r.path === '/rest/v1/rpc/resolve_changeset')).toBe(true);
    expect(b.sim.server.rows(uid, 'accounts')).toHaveLength(1);
    expect(b.sim.server.rows(uid, 'settings')).toHaveLength(1);
  });
});

describe('V3.5 — utilisateur déjà configuré, désactivations, compte', () => {
  async function existingUser() {
    const b = simBrowser();
    browsers.push(b);
    const uid = randomUUID();
    await seed(b.sim.server, uid, { settings: [{ ...generateDemoData(uid, TODAY).settings, onboarded: true, displayName: 'Nadia' }] } as never);
    b.seedSession(uid);
    return { b, uid };
  }

  it('T4 : utilisateur configuré → application directement, aucune écriture', async () => {
    const { b } = await existingUser();
    const before = applied(b).length;
    const tab = await openApp(b, { strict: true });
    await until(() => inApp(tab), 'application');
    expect(tab.text()).not.toContain(fr['onb.fresh']);
    expect(applied(b).length).toBe(before);
    // Mode strict : chaque montage a son propre espace ; les précédents sont fermés.
    expect(tab.closed.length).toBe(tab.spaces.length - 1);
  });

  it('T7 : démo, restauration et pièces jointes indisponibles (interface ET dépôt) ; export conservé', async () => {
    const { b } = await existingUser();
    const tab = await openApp(b);
    await until(() => inApp(tab), 'application');
    await tab.go('/settings');
    await until(() => tab.text().includes(fr['set.exportBackup']), 'paramètres');
    expect(tab.host.querySelector('[data-testid="restore-input"]')).toBeNull();
    expect(tab.text()).not.toContain(fr['set.restoreBackup']);
    expect(tab.text()).not.toContain(fr['set.resetDemo']);
    expect(tab.text()).toContain(fr['cloud.limited']);
    // Formulaire d'opération : aucun champ de pièce jointe.
    await tab.click(fr['shell.addTransaction']);
    await until(() => !!document.querySelector('[role="dialog"]'), 'formulaire');
    const more = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-expanded="false"]');
    expect(more).toBeTruthy();
    await act(async () => more!.click()); // section « plus d'options » (notes, pièce jointe)
    await until(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').includes(fr['common.notes']), 'options détaillées');
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain(fr['form.attachment']);
    expect(document.querySelector('[role="dialog"] input[type="file"]')).toBeNull();
    // Dépôt : refus explicite, aucune requête.
    const repo = tab.space().repo;
    const before = b.sim.requests.length;
    await expect(repo.addAttachment(randomUUID(), new File(['x'], 'r.pdf', { type: 'application/pdf' }))).rejects.toBeInstanceOf(CloudFeatureUnavailableError);
    await expect(repo.restoreBackup({})).rejects.toBeInstanceOf(CloudFeatureUnavailableError);
    await expect(repo.replaceWithSnapshot(generateDemoData(repo.userId, TODAY))).rejects.toBeInstanceOf(CloudFeatureUnavailableError);
    expect(b.sim.requests.length).toBe(before);
    expect((await tab.space().reader.snapshot())?.transactions).toHaveLength(0);
  });

  it('T8 : déconnexion depuis « Compte » → connexion, cache supprimé, états d’interface effacés', async () => {
    const { b, uid } = await existingUser();
    sessionStorage.setItem('nexora.tx-filters', JSON.stringify({ q: 'loyer Nadia' }));
    sessionStorage.setItem(MONTH_KEY, '2026-03');
    localStorage.setItem(LAST_ACCOUNT_KEY, randomUUID());
    const tab = await openApp(b);
    await until(() => inApp(tab), 'application');
    await tab.go('/settings');
    await until(() => tab.text().includes(fr['cloud.signedInAs'].replace('{email}', `${uid.slice(0, 8)}@exemple.invalid`)), 'section Compte');
    await tab.click(fr['auth.logout']);
    await until(() => !!tab.host.querySelector('#auth-email'), 'écran de connexion');
    await until(async () => !(await b.databases()).includes(cloudCacheName(uid)), 'cache supprimé');
    expect(tab.closed).toEqual([uid]);
    expect(sessionStorage.getItem('nexora.tx-filters')).toBeNull();
    expect(sessionStorage.getItem(MONTH_KEY)).toBeNull();
    expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBeNull();
  });

  it('T8 : changement de compte → nouvel espace pour B, espace de A fermé, aucune donnée de A affichée', async () => {
    const { b, uid } = await existingUser();
    const u2 = randomUUID();
    await seed(b.sim.server, u2, { settings: [{ ...generateDemoData(u2, TODAY).settings, onboarded: true, displayName: 'Karim' }] } as never);
    const tab = await openApp(b);
    await until(() => inApp(tab), 'application A');
    await act(async () => {
      await tab.client.auth.setSession({ access_token: (await import('@/test/postgrestSimulator')).userToken(u2), refresh_token: 'rafraichissement-fictif' });
    });
    await until(() => tab.spaces.length === 2 && inApp(tab), 'application B');
    expect(tab.spaces.map((s) => s.userId)).toEqual([uid, u2]);
    expect(tab.closed).toEqual([uid]);
    await until(async () => (await b.databases()).join() === cloudCacheName(u2), 'seul le cache de B subsiste');
    expect((await tab.space().reader.snapshot())?.settings.displayName).toBe('Karim');
  });

  it('T9 : déconnexion dans un autre onglet → retour à la connexion, aucun écran d’erreur bloquant', async () => {
    const { b, uid } = await existingUser();
    const tabA = await openApp(b);
    await until(() => inApp(tabA), 'application onglet A');
    const tabB = await openApp(b);
    await until(() => inApp(tabB), 'application onglet B');
    await tabB.go('/settings');
    await until(() => !!tabB.button(fr['auth.logout']), 'section Compte B');
    await tabB.click(fr['auth.logout']);
    await until(() => !!tabA.host.querySelector('#auth-email'), 'onglet A : écran de connexion');
    expect(tabA.text()).not.toContain(fr['app.error.title']);
    await until(async () => !(await b.databases()).includes(cloudCacheName(uid)), 'cache supprimé');
  });
});
