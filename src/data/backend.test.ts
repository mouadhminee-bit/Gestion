/**
 * V2.4 — sélection du backend et configuration Supabase (`data/backend.ts`).
 * Aucun accès réseau : toutes les configurations sont fictives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository, getBackendSelection, parseDataBackend, readSupabaseConfig, selectBackend, type BackendEnv } from './backend';
import { LocalRepository } from './repository';
import { CloudRepository } from './cloud/CloudRepository';
import { LOCAL_USER_ID } from '@/domain/settings';

const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** JWT fictif (signature factice) portant le rôle indiqué. */
const jwt = (role: string) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ iss: 'supabase', ref: 'projetfictif', role })}.c2lnbmF0dXJlLWZpY3RpdmU`;
const ANON = jwt('anon');
const URL_OK = 'https://projetfictif.supabase.co';
const cloud = (extra: BackendEnv = {}): BackendEnv => ({ VITE_DATA_BACKEND: 'supabase', VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: ANON, ...extra });

afterEach(() => vi.restoreAllMocks());

describe('V2.4 — backend par défaut', () => {
  it.each([{}, { VITE_DATA_BACKEND: undefined }, { VITE_DATA_BACKEND: '' }, { VITE_DATA_BACKEND: '   ' }, { VITE_DATA_BACKEND: 'local' }, { VITE_DATA_BACKEND: ' local ' }])(
    'variable absente, vide ou « local » → local, sans diagnostic (%o)',
    (env) => {
      const s = selectBackend(env);
      expect(s).toEqual({ requested: 'local', effective: 'local', supabase: { status: 'absent' }, notices: [] });
    },
  );

  it('mode local sans configuration Supabase : aucune exception, aucun diagnostic', () => {
    expect(() => selectBackend({ VITE_DATA_BACKEND: 'local' })).not.toThrow();
    expect(selectBackend({ VITE_DATA_BACKEND: 'local', VITE_SUPABASE_URL: 'n’importe quoi' }).notices).toEqual([]);
  });

  it('sélection réelle de l’application (import.meta.env) : lue sans exception, backend effectif local', () => {
    const s = getBackendSelection();
    expect(s.effective).toBe('local');
    expect(getBackendSelection()).toBe(s);
  });
});

describe('V2.4 — valeur de backend inconnue', () => {
  it.each(['cloud', 'Supabase', 'LOCAL', 'indexeddb', 42, {}, ['supabase']])('« %o » → refusée explicitement, mode local', (value) => {
    expect(parseDataBackend(value)).toBe('unknown');
    const s = selectBackend({ VITE_DATA_BACKEND: value });
    expect(s.requested).toBe('unknown');
    expect(s.effective).toBe('local');
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('valeur non reconnue');
    expect(s.notices[0]).toContain('mode local utilisé');
  });
});

describe('V2.4 — configuration Supabase', () => {
  it('configuration valide (JWT anon) : détectée, URL normalisée, données Cloud actives (V3.5)', () => {
    const s = selectBackend(cloud({ VITE_SUPABASE_URL: `${URL_OK}/` }));
    expect(s.requested).toBe('supabase');
    expect(s.effective).toBe('supabase');
    expect(s.supabase).toEqual({ status: 'ok', config: { url: URL_OK, anonKey: ANON } });
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('données Cloud chargées');
    expect(s.notices[0]).not.toContain(ANON);
  });

  it('clé « sb_publishable_ » et pile locale http://127.0.0.1 acceptées', () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: 'sb_publishable_cleFictive123' }).status).toBe('ok');
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: ANON })).toEqual({
      status: 'ok',
      config: { url: 'http://127.0.0.1:54321', anonKey: ANON },
    });
  });

  it('configuration absente : signalée, sans exception, mode local', () => {
    const s = selectBackend({ VITE_DATA_BACKEND: 'supabase' });
    expect(s.supabase).toEqual({ status: 'absent' });
    expect(s.effective).toBe('local');
    expect(s.notices[0]).toContain('sans configuration Cloud');
  });

  it.each([
    [{ VITE_SUPABASE_ANON_KEY: undefined }, ['VITE_SUPABASE_ANON_KEY']],
    [{ VITE_SUPABASE_URL: '' }, ['VITE_SUPABASE_URL']],
    [{ VITE_SUPABASE_URL: '  ', VITE_SUPABASE_ANON_KEY: ANON }, ['VITE_SUPABASE_URL']],
  ])('configuration incomplète %o : variables manquantes nommées, mode local', (extra, missing) => {
    const s = selectBackend(cloud(extra));
    expect(s.supabase).toEqual({ status: 'incomplete', missing });
    expect(s.effective).toBe('local');
    expect(s.notices[0]).toContain('incomplète');
  });

  it.each([
    ['pas une url', 'URL invalide'],
    ['http://projetfictif.supabase.co', 'https requis'],
    ['ftp://projetfictif.supabase.co', 'https requis'],
    ['https://utilisateur:motdepasse@projetfictif.supabase.co', 'identifiants interdits'],
    ['https://projetfictif.supabase.co/rest/v1', 'adresse racine'],
    ['https://projetfictif.supabase.co/?x=1', 'adresse racine'],
  ])('URL refusée : « %s »', (url, problem) => {
    const s = selectBackend(cloud({ VITE_SUPABASE_URL: url }));
    expect(s.supabase.status).toBe('invalid');
    expect(s.supabase.status === 'invalid' && s.supabase.problems.join(' ')).toContain(problem);
    expect(s.effective).toBe('local');
  });

  it.each([
    ['JWT de rôle service_role', jwt('service_role'), 'service_role'],
    ['clé sb_secret_', 'sb_secret_cleFictive123', 'clé secrète refusée'],
    ['JWT de rôle authenticated', jwt('authenticated'), 'autre que « anon »'],
    ['texte quelconque', 'cle-quelconque', 'format non reconnu'],
    ['JWT tronqué', 'aaa.bbb', 'format non reconnu'],
    ['clé avec espace', `${ANON} x`, 'espaces interdits'],
    ['clé publishable vide', 'sb_publishable_', 'clé publique vide'],
  ])('clé refusée : %s', (_label, key, problem) => {
    const s = selectBackend(cloud({ VITE_SUPABASE_ANON_KEY: key }));
    expect(s.supabase.status).toBe('invalid');
    expect(s.supabase.status === 'invalid' && s.supabase.problems.join(' ')).toContain(problem);
    expect(s.effective).toBe('local');
  });

  it('aucune exception, quelles que soient les valeurs fournies', () => {
    for (const v of [null, 0, true, {}, [], 'x'.repeat(10_000), '\u0000', 'https://', '.'.repeat(3)])
      expect(() => selectBackend({ VITE_DATA_BACKEND: v, VITE_SUPABASE_URL: v, VITE_SUPABASE_ANON_KEY: v })).not.toThrow();
  });

  it('aucun diagnostic ne contient de valeur de configuration (URL, clé, fragments de clé)', () => {
    const secretish = jwt('service_role');
    for (const env of [cloud(), cloud({ VITE_SUPABASE_ANON_KEY: secretish }), cloud({ VITE_SUPABASE_URL: 'http://projetfictif.supabase.co' }), cloud({ VITE_SUPABASE_ANON_KEY: 'sb_secret_cleFictive123' })]) {
      const text = selectBackend(env).notices.join('\n');
      for (const value of [URL_OK, 'projetfictif', ANON, secretish, ...ANON.split('.'), ...secretish.split('.'), 'cleFictive123']) expect(text).not.toContain(value);
    }
  });
});

describe('V2.4 — repository de l’application', () => {
  it('toujours LocalRepository sur la base « nexora » et l’utilisateur local, quel que soit le choix ; jamais CloudRepository', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const selections = [selectBackend(cloud()), selectBackend({}), selectBackend({ VITE_DATA_BACKEND: 'cloud' }), selectBackend(cloud({ VITE_SUPABASE_ANON_KEY: jwt('service_role') }))];
    for (const s of selections) {
      const repo = createRepository(s);
      expect(repo).toBeInstanceOf(LocalRepository);
      expect(repo).not.toBeInstanceOf(CloudRepository);
      expect((repo as LocalRepository).db.name).toBe('nexora');
      expect(repo.userId).toBe(LOCAL_USER_ID);
    }
    // Diagnostics signalés une seule fois (première sélection), sans valeur de configuration.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('[NEXORA]');
    expect(logged).not.toContain(ANON);
    expect(logged).not.toContain(URL_OK);
  });
});
