/**
 * Serveur PostgREST SIMULÉ — RÉSERVÉ AUX TESTS (V3.3).
 *
 * Reproduit, au format filaire RÉEL, les deux fonctions de la migration 8 :
 *  - `POST /rest/v1/rpc/apply_changeset`   `{ p_changeset }`    (noms, clés et lignes SQL) ;
 *  - `POST /rest/v1/rpc/resolve_changeset` `{ p_changeset_id }` ;
 *  - erreurs `{ code, message, details, hint }` avec les statuts du § 7.7 de
 *    docs/LOT4_PLAN.md (`PT403`, `PT409`, `PT400`, `PT413`), refus d'authentification de
 *    PostgREST (`42501`, `PGRST301`, `PGRST303`).
 * La logique du serveur est celle de `MemoryTransport` ALIGNÉ (P15) : le transport HTTP et
 * le transport en mémoire passent ainsi la même suite de contrat. Identité : `sub` du jeton
 * de la requête (JWT fictif, signature non vérifiée sauf jeton marqué « invalide »).
 * Aucune requête réelle : `fetch` est fourni au client Supabase des tests.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MemoryTransport, REGISTERED_AT } from '@/data/cloud/MemoryTransport';
import { MAPPING, deserializeRow, fromSqlKey, sqlColumnsOf, sqlTableOf, tableOfSql, toSqlKey, type CloudTableName, type ColumnSpec } from '@/data/cloud/mapping';
import { CloudConflictError, CloudProtocolError, CloudTransportError, type ChangeSet, type CommitResult, type ResolveResult } from '@/data/cloud/transport';

export const SIM_URL = 'https://projetfictif.supabase.co';
const REF = 'projetfictif';
const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = (claims: Record<string, unknown>, signature = 'c2lnbmF0dXJlLWZpY3RpdmU') => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.${signature}`;

/** Clé publique fictive (rôle anon). */
export const SIM_ANON_KEY = fakeJwt({ iss: 'supabase', ref: REF, role: 'anon' });

/** Jeton d'accès fictif d'un utilisateur ; `invalid` : signature refusée ; `expired` : expiré. */
export function userToken(uid: string, opts: { invalid?: boolean; expired?: boolean } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return fakeJwt({ iss: `${SIM_URL}/auth/v1`, sub: uid, aud: 'authenticated', role: 'authenticated', exp: opts.expired ? now - 60 : now + 3600 }, opts.invalid ? 'invalide' : undefined);
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Réponse imposée à la prochaine requête (réseau, délai, réponse brute). */
export type Override = { network: true } | { hang: true } | { status: number; body: string; contentType?: string };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const pgError = (status: number, code: string | null, message: string, details: unknown = null) =>
  json(status, { code, message, details: details === null ? null : JSON.stringify(details), hint: null });

const PROTOCOL_STATUS: Readonly<Record<string, number>> = {
  unauthorized: 403,
  changeset_too_large: 413,
  duplicate_key: 409,
  changeset_id_reused: 409,
  changeset_abandoned: 409,
};

/** Colonnes qu'un client doit écrire (clé + colonnes modifiables), comme la liste blanche SQL. */
function writeCols(table: CloudTableName): string[] {
  const spec = MAPPING[table] as unknown as { sqlKey: readonly string[]; fields: Record<string, ColumnSpec | { kind: string }> };
  return (Object.values(spec.fields).filter((f) => f.kind === 'column') as ColumnSpec[]).filter((c) => c.writable || spec.sqlKey.includes(c.column)).map((c) => c.column);
}

export function postgrestSimulator(server: MemoryTransport = new MemoryTransport()) {
  if (server.legacy) throw new Error('simulateur : MemoryTransport aligné requis');
  const requests: RecordedRequest[] = [];
  const overrides: Override[] = [];

  /** Ligne SQL reçue → ligne TS ; `null` si elle ne correspond pas exactement aux colonnes écrites. */
  function rowFromWire(table: CloudTableName, uid: string, values: unknown): Record<string, unknown> | null {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
    const cols = writeCols(table);
    const got = Object.keys(values);
    if (got.length !== cols.length || !cols.every((c) => got.includes(c))) return null; // « colonnes attendues »
    const full: Record<string, unknown> = { version: 1, sync_txid: '1', server_updated_at: REGISTERED_AT, deleted_at: null };
    for (const c of sqlColumnsOf(table)) full[c] = c in (values as object) ? (values as Record<string, unknown>)[c] : null;
    if (table === 'users') full.created_at = server.entry(uid, 'users', uid)?.row.createdAt ?? REGISTERED_AT;
    try {
      return deserializeRow(table, full).row as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Lot filaire → lot TS. Une partie illisible devient une valeur que le serveur refuse au même stade. */
  function changesetFromWire(w: unknown, uid: string): ChangeSet {
    if (!w || typeof w !== 'object' || Array.isArray(w) || !Array.isArray((w as { ops?: unknown }).ops)) return w as ChangeSet;
    const ops = ((w as { ops: unknown[] }).ops).map((op) => {
      if (!op || typeof op !== 'object' || Array.isArray(op)) return op;
      const o = { ...(op as Record<string, unknown>) };
      let table: CloudTableName | null = null;
      try {
        table = tableOfSql(String(o.table));
        o.table = table;
      } catch {
        o.table = '__table_inconnue__';
      }
      if (table) {
        try {
          o.key = fromSqlKey(table, o.key as Record<string, unknown>);
        } catch {
          o.key = '__cle_invalide__';
        }
        if ('row' in o && o.type === 'put') o.row = rowFromWire(table, uid, o.row);
      }
      return o;
    });
    return { ...(w as object), ops } as ChangeSet;
  }

  const resultToWire = (r: CommitResult | ResolveResult) =>
    'versions' in r ? { ...r, versions: r.versions.map((v) => ({ ...v, table: sqlTableOf(v.table), key: toSqlKey(v.table, v.key) })) } : r;

  function errorToResponse(e: unknown): Response {
    if (e instanceof CloudConflictError) {
      return pgError(409, 'PT409', 'version_conflict', {
        conflicts: e.conflicts.map((c) => ({ table: sqlTableOf(c.table), key: toSqlKey(c.table, c.key), expectedVersion: c.expectedVersion, actualVersion: c.actualVersion, actualDeleted: c.actualDeleted })),
      });
    }
    if (e instanceof CloudProtocolError) {
      const status = PROTOCOL_STATUS[e.code] ?? 400;
      return pgError(status, `PT${status}`, e.code, { reason: e.message });
    }
    if (e instanceof CloudTransportError && /changeset_pending/.test(e.message)) return pgError(409, 'PT409', 'changeset_pending', { reason: 'lot en cours' });
    return pgError(500, 'XX000', 'erreur interne simulée');
  }

  async function handle(method: string, url: URL, headers: Headers, rawBody: string | null): Promise<Response> {
    const fn = url.pathname.replace(/^\/rest\/v1\/rpc\//, '');
    if (method !== 'POST' || !['apply_changeset', 'resolve_changeset'].includes(fn) || !url.pathname.startsWith('/rest/v1/rpc/')) {
      return pgError(404, 'PGRST202', `Could not find the function public.${fn}`);
    }
    if (headers.get('apikey') !== SIM_ANON_KEY) return json(401, { message: 'Invalid API key' });
    const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    if (token === SIM_ANON_KEY) return pgError(401, '42501', `permission denied for function ${fn}`);
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return pgError(401, 'PGRST301', 'JWSError JWSInvalidSignature');
    }
    if (token.endsWith('.invalide')) return pgError(401, 'PGRST301', 'JWSError JWSInvalidSignature');
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return pgError(401, 'PGRST303', 'JWT expired');
    if (claims.role !== 'authenticated' || typeof claims.sub !== 'string') return pgError(401, '42501', `permission denied for function ${fn}`);
    const uid = claims.sub;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody ?? '');
    } catch {
      return pgError(400, 'PGRST102', 'Empty or invalid json');
    }
    try {
      const session = server.as(uid);
      if (fn === 'apply_changeset') return json(200, resultToWire(await session.commit(changesetFromWire(body.p_changeset, uid))));
      return json(200, resultToWire(await session.resolve(String(body.p_changeset_id), uid)));
    } catch (e) {
      return errorToResponse(e);
    }
  }

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init.headers);
    const rawBody = typeof init.body === 'string' ? init.body : null;
    let parsed: unknown = rawBody;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      /* corps non JSON conservé tel quel */
    }
    requests.push({ method: init.method ?? 'GET', path: url.pathname, headers: Object.fromEntries(headers.entries()), body: parsed });
    const o = overrides.shift();
    if (o && 'network' in o) throw new TypeError('fetch failed');
    if (o && 'hang' in o) {
      return new Promise<Response>((_, reject) => {
        const signal = init.signal;
        const abort = () => reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (o) return new Response(o.body, { status: o.status, headers: { 'Content-Type': o.contentType ?? 'application/json' } });
    return handle(init.method ?? 'GET', url, headers, rawBody);
  };

  return {
    server,
    requests,
    fetch: fetchImpl as typeof fetch,
    /** Impose la réponse de la prochaine requête. */
    respondNext(o: Override) {
      overrides.push(o);
    },
  };
}

/**
 * Client Supabase de test relié au simulateur, avec la session de `uid` (ou sans session).
 * Session lue dans un stockage en mémoire : aucune requête d'authentification.
 */
export function simClient(fetchImpl: typeof fetch, session: { uid: string; token?: string } | null): SupabaseClient {
  const store = new Map<string, string>();
  if (session) {
    const now = Math.floor(Date.now() / 1000);
    store.set(
      `sb-${REF}-auth-token`,
      JSON.stringify({
        access_token: session.token ?? userToken(session.uid),
        refresh_token: 'rafraichissement-fictif',
        expires_in: 3600,
        expires_at: now + 3600,
        token_type: 'bearer',
        user: { id: session.uid, aud: 'authenticated', role: 'authenticated', email: 'test@exemple.invalid', app_metadata: {}, user_metadata: {}, created_at: REGISTERED_AT },
      }),
    );
  }
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  return createClient(SIM_URL, SIM_ANON_KEY, {
    auth: { storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  });
}
