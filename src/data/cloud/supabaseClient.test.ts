/**
 * V2.4 — client Supabase centralisé (`cloud/supabaseClient.ts`).
 * Configuration fictive ; `fetch` et `WebSocket` sont remplacés par des sondes qui
 * échouent : toute tentative d'accès réseau serait détectée.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectBackend } from '../backend';
import { CloudConfigError, getSupabaseClient, resetSupabaseClientForTests } from './supabaseClient';

const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ANON = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ iss: 'supabase', ref: 'projetfictif', role: 'anon' })}.c2lnbmF0dXJlLWZpY3RpdmU`;
const VALID = selectBackend({ VITE_DATA_BACKEND: 'supabase', VITE_SUPABASE_URL: 'https://projetfictif.supabase.co', VITE_SUPABASE_ANON_KEY: ANON });

let fetchProbe: ReturnType<typeof vi.fn>;
let sockets = 0;

beforeEach(() => {
  resetSupabaseClientForTests();
  sockets = 0;
  fetchProbe = vi.fn(() => Promise.reject(new Error('accès réseau interdit pendant le test')));
  vi.stubGlobal('fetch', fetchProbe);
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        sockets++;
        throw new Error('WebSocket interdit pendant le test');
      }
    },
  );
});

afterEach(() => {
  resetSupabaseClientForTests();
  vi.unstubAllGlobals();
});

describe('V2.4 — client Supabase', () => {
  it.each([
    ['backend local (défaut)', selectBackend({})],
    ['backend inconnu', selectBackend({ VITE_DATA_BACKEND: 'cloud' })],
    ['supabase sans configuration', selectBackend({ VITE_DATA_BACKEND: 'supabase' })],
    ['supabase, configuration incomplète', selectBackend({ VITE_DATA_BACKEND: 'supabase', VITE_SUPABASE_URL: 'https://projetfictif.supabase.co' })],
    ['supabase, clé service_role', selectBackend({ VITE_DATA_BACKEND: 'supabase', VITE_SUPABASE_URL: 'https://projetfictif.supabase.co', VITE_SUPABASE_ANON_KEY: ANON.replace(b64u({ iss: 'supabase', ref: 'projetfictif', role: 'anon' }), b64u({ iss: 'supabase', ref: 'projetfictif', role: 'service_role' })) })],
  ])('refusé : %s (CloudConfigError, aucune valeur de configuration dans le message)', (_label, selection) => {
    expect(() => getSupabaseClient(selection)).toThrow(CloudConfigError);
    try {
      getSupabaseClient(selection);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(ANON);
      expect(String((e as Error).message)).not.toContain('projetfictif');
    }
  });

  it('application (environnement sans configuration Cloud) : client refusé, aucune création implicite', () => {
    // La sélection réelle n'est jamais « supabase + configuration valide » dans l'environnement de test.
    expect(() => getSupabaseClient()).toThrow(CloudConfigError);
  });

  it('configuration valide : client créé une seule fois, sans aucune requête réseau ni WebSocket', async () => {
    const client = getSupabaseClient(VALID);
    expect(client).toBeTruthy();
    expect(typeof client.rpc).toBe('function');
    expect(getSupabaseClient(VALID)).toBe(client);
    // Laisse s'exécuter l'initialisation asynchrone du client (session lue en mémoire uniquement).
    await new Promise((r) => setTimeout(r, 50));
    await client.auth.stopAutoRefresh();
    expect(fetchProbe).not.toHaveBeenCalled();
    expect(sockets).toBe(0);
  });

  it('contrôle de la sonde : un appel du client passerait par fetch (intercepté, jamais émis)', async () => {
    const client = getSupabaseClient(VALID);
    const { error } = await client.rpc('sonde_inexistante');
    expect(error).toBeTruthy();
    expect(fetchProbe).toHaveBeenCalledTimes(1);
    await client.auth.stopAutoRefresh();
  });

  it('V3.7 — flux PKCE : le client est en mode PKCE et l’inscription envoie un défi S256 avec l’adresse de retour', async () => {
    const client = getSupabaseClient(VALID);
    expect((client.auth as unknown as { flowType: string }).flowType).toBe('pkce');
    await client.auth.signUp({ email: 'fictif@example.com', password: 'mot-de-passe-fictif', options: { emailRedirectTo: 'http://localhost:5173/' } });
    const call = fetchProbe.mock.calls.find(([url]) => String(url).includes('/auth/v1/signup'));
    expect(call).toBeTruthy();
    const [url, init] = call as [string, RequestInit];
    expect(new URL(url).searchParams.get('redirect_to')).toBe('http://localhost:5173/');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.code_challenge_method).toBe('s256');
    expect(typeof body.code_challenge).toBe('string');
    expect((body.code_challenge as string).length).toBeGreaterThanOrEqual(43);
    await client.auth.stopAutoRefresh();
  });
});
