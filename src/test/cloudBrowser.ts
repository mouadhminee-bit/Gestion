/**
 * Navigateur SIMULÉ pour les tests du cycle de session Cloud (V3.4-c) — RÉSERVÉ AUX TESTS.
 *
 * Un « navigateur » = un stockage de session partagé (comme `localStorage`), une clé de
 * stockage unique (donc un `BroadcastChannel` du SDK propre à ce navigateur), une fabrique
 * IndexedDB propre (fake-indexeddb) et le serveur PostgREST / Auth simulé. Un « onglet » =
 * un VRAI client Supabase (supabase-js, auth-js) branché sur ce stockage et ce serveur.
 * Sous jsdom, le SDK crée son `BroadcastChannel` (implémentation réelle de Node) : une
 * déconnexion dans un onglet est diffusée aux autres, comme dans un navigateur. Cela ne
 * remplace pas une validation multi-onglets dans un vrai navigateur (V3.7).
 */
import { randomUUID } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HttpReadSource } from '@/data/cloud/HttpReadSource';
import { MemoryTransport, REGISTERED_AT } from '@/data/cloud/MemoryTransport';
import { createCloudDataPort, type CloudDataPort } from '@/data/cloud/cloudLoadCycle';
import { SIM_ANON_KEY, SIM_URL, postgrestSimulator, userToken } from './postgrestSimulator';

export function simBrowser(options: { maxRows?: number } = {}) {
  const sim = postgrestSimulator(new MemoryTransport(), options);
  const factory = new IDBFactory();
  const storageKey = `sb-test-${randomUUID()}`;
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const clients: SupabaseClient[] = [];

  return {
    sim,
    factory,
    storageKey,
    /** Session enregistrée dans le stockage partagé (comme après une connexion). */
    seedSession(uid: string, token = userToken(uid)) {
      const now = Math.floor(Date.now() / 1000);
      store.set(
        storageKey,
        JSON.stringify({
          access_token: token,
          refresh_token: 'rafraichissement-fictif',
          expires_in: 3600,
          expires_at: now + 3600,
          token_type: 'bearer',
          user: { id: uid, aud: 'authenticated', role: 'authenticated', email: `${uid.slice(0, 8)}@exemple.invalid`, app_metadata: {}, user_metadata: {}, created_at: REGISTERED_AT },
        }),
      );
    },
    /** Session retirée du stockage partagé sans passer par un client (onglet fermé entre-temps…). */
    dropSession() {
      store.delete(storageKey);
    },
    /** Utilisateur de la session stockée (ou `null`). */
    storedUserId(): string | null {
      const raw = store.get(storageKey);
      return raw ? (JSON.parse(raw) as { user: { id: string } }).user.id : null;
    },
    /** Nouvel onglet : vrai client Supabase sur le stockage partagé. */
    tab() {
      const client = createClient(SIM_URL, SIM_ANON_KEY, {
        auth: { storage, storageKey, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: sim.fetch },
      });
      clients.push(client);
      const cloud: CloudDataPort = createCloudDataPort({ source: new HttpReadSource(client), indexedDB: factory, IDBKeyRange });
      return { client, cloud };
    },
    /** Noms des bases IndexedDB de ce navigateur. */
    async databases(): Promise<string[]> {
      return (await factory.databases()).map((d) => d.name ?? '').sort();
    },
    /** Libère les clients (abonnements, `BroadcastChannel`). */
    async close() {
      for (const c of clients) await (c.auth as unknown as { dispose?: () => Promise<void> }).dispose?.();
    },
  };
}

export type SimBrowser = ReturnType<typeof simBrowser>;
