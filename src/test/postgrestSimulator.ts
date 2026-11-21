/**
 * Serveur PostgREST SIMULÉ — RÉSERVÉ AUX TESTS (V3.3, lecture V3.4-a, Auth V3.4-c).
 *
 * Reproduit, au format filaire RÉEL, les deux fonctions de la migration 8 :
 *  - `POST /rest/v1/rpc/apply_changeset`   `{ p_changeset }`    (noms, clés et lignes SQL) ;
 *  - `POST /rest/v1/rpc/resolve_changeset` `{ p_changeset_id }` ;
 *  - erreurs `{ code, message, details, hint }` avec les statuts du § 7.7 de
 *    docs/LOT4_PLAN.md (`PT403`, `PT409`, `PT400`, `PT413`), refus d'authentification de
 *    PostgREST (`42501`, `PGRST301`, `PGRST303`).
 * Et la lecture des tables (V3.4-a) :
 *  - `GET` / `HEAD /rest/v1/<table>?select=*` : RLS (lignes de l'utilisateur du jeton,
 *    actives ET supprimées, comme la politique de lecture de la migration 6), filtres
 *    `col=eq.v`, `col=is.null`, `col=not.is.null`, tri `order=a.asc,b.desc`, pages
 *    `offset` / `limit` plafonnées à `maxRows` (1 000 par défaut, comme Supabase),
 *    `Prefer: count=exact` → `Content-Range: début-fin/total` ; 206 pour une page partielle,
 *    416 (`PGRST103`) au-delà du total ; table inconnue → 404 `PGRST205`.
 * La logique du serveur est celle de `MemoryTransport` ALIGNÉ (P15) : le transport HTTP et
 * le transport en mémoire passent ainsi la même suite de contrat. Identité : `sub` du jeton
 * de la requête (JWT fictif, signature non vérifiée sauf jeton marqué « invalide »).
 * Aucune requête réelle : `fetch` est fourni au client Supabase des tests. `onRequest`
 * s'exécute avant chaque requête (modifications concurrentes simulées).
 * Apport V3.4-c (tests multi-onglets avec le vrai SDK, écart accepté le 19/11/2026) :
 * `GET /auth/v1/user`, `POST /auth/v1/logout` et sessions révocables (`revokedSessions`) —
 * voir `handleAuth`. Réservé aux tests, comme le reste de ce fichier.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MemoryTransport, REGISTERED_AT, REGISTERED_AT_SQL, orderSqlRows } from '@/data/cloud/MemoryTransport';
import {
  MAPPING,
  SERVER_METADATA_COLUMNS,
  deserializeRow,
  fromSqlKey,
  sqlColumnsOf,
  sqlTableOf,
  tableOfSql,
  toSqlKey,
  type CloudTableName,
  type ColumnSpec,
} from '@/data/cloud/mapping';
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
  /** Paramètres de l'URL (`?…`, vide sans paramètre). */
  query: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Réponse imposée à la prochaine requête (réseau, délai, réponse brute avec en-têtes). */
export type Override = { network: true } | { hang: true } | { status: number; body: string | null; contentType?: string; headers?: Record<string, string> };

export interface SimulatorOptions {
  /** Nombre maximal de lignes par réponse de lecture (réglage « Max rows » ; 1 000 par défaut). */
  maxRows?: number;
}

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

export function postgrestSimulator(server: MemoryTransport = new MemoryTransport(), options: SimulatorOptions = {}) {
  const requests: RecordedRequest[] = [];
  const overrides: Override[] = [];
  const maxRows = options.maxRows ?? 1000;

  /** Ligne SQL reçue → ligne TS ; `null` si elle ne correspond pas exactement aux colonnes écrites. */
  function rowFromWire(table: CloudTableName, _uid: string, values: unknown): Record<string, unknown> | null {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
    const cols = writeCols(table);
    const got = Object.keys(values);
    if (got.length !== cols.length || !cols.every((c) => got.includes(c))) return null; // « colonnes attendues »
    const full: Record<string, unknown> = { version: 1, sync_txid: '1', server_updated_at: REGISTERED_AT_SQL, deleted_at: null };
    for (const c of sqlColumnsOf(table)) full[c] = c in (values as object) ? (values as Record<string, unknown>)[c] : null;
    if (table === 'users') full.created_at = REGISTERED_AT_SQL; // fixée par le serveur, à la microseconde
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

  /** Identité de la requête (`sub` du jeton) ou refus d'authentification de PostgREST. */
  function authenticate(headers: Headers, denied: string): string | Response {
    if (headers.get('apikey') !== SIM_ANON_KEY) return json(401, { message: 'Invalid API key' });
    const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    if (token === SIM_ANON_KEY) return pgError(401, '42501', denied);
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return pgError(401, 'PGRST301', 'JWSError JWSInvalidSignature');
    }
    if (token.endsWith('.invalide')) return pgError(401, 'PGRST301', 'JWSError JWSInvalidSignature');
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return pgError(401, 'PGRST303', 'JWT expired');
    if (claims.role !== 'authenticated' || typeof claims.sub !== 'string') return pgError(401, '42501', denied);
    return claims.sub;
  }

  /** Lecture d'une table (`GET` / `HEAD`) avec la RLS de l'utilisateur du jeton. */
  function handleRead(method: string, url: URL, headers: Headers): Response {
    const sqlTable = url.pathname.slice('/rest/v1/'.length);
    const uid = authenticate(headers, `permission denied for table ${sqlTable}`);
    if (typeof uid !== 'string') return uid;
    let table: CloudTableName;
    try {
      table = tableOfSql(sqlTable);
    } catch {
      return pgError(404, 'PGRST205', `Could not find the table 'public.${sqlTable}' in the schema cache`);
    }
    const params = url.searchParams;
    if (params.get('select') !== '*') return pgError(400, 'PGRST100', 'simulateur : select=* attendu');
    const columns = new Set<string>([...sqlColumnsOf(table), ...SERVER_METADATA_COLUMNS]);
    let rows = server.sqlRows(uid, table); // RLS : lignes de l'utilisateur, actives et supprimées
    for (const [name, value] of params) {
      if (['select', 'order', 'offset', 'limit'].includes(name)) continue;
      if (!columns.has(name)) return pgError(400, '42703', `column ${sqlTable}.${name} does not exist`);
      if (value.startsWith('eq.')) rows = rows.filter((r) => r[name] !== null && String(r[name]) === value.slice(3));
      else if (value === 'is.null') rows = rows.filter((r) => r[name] === null);
      else if (value === 'not.is.null') rows = rows.filter((r) => r[name] !== null);
      else return pgError(400, 'PGRST100', `simulateur : opérateur non pris en charge (${name})`);
    }
    const order = params.get('order');
    if (order) {
      const spec = order.split(',').map((part) => {
        const [column, direction] = part.split('.');
        return { column, ascending: direction !== 'desc', valid: columns.has(column) && (direction === 'asc' || direction === 'desc') };
      });
      if (spec.some((s) => !s.valid)) return pgError(400, 'PGRST100', 'simulateur : tri invalide');
      rows = orderSqlRows(rows, spec);
    }
    const offset = params.has('offset') ? Number(params.get('offset')) : 0;
    const limit = params.has('limit') ? Number(params.get('limit')) : Infinity;
    if (!Number.isSafeInteger(offset) || offset < 0 || !(limit === Infinity || (Number.isSafeInteger(limit) && limit >= 0))) return pgError(400, 'PGRST103', 'simulateur : offset / limit invalides');
    const counted = /count=exact/.test(headers.get('prefer') ?? '');
    const total = rows.length;
    const totalText = counted ? String(total) : '*';
    if (offset > 0 && offset >= total) {
      return new Response(JSON.stringify({ code: 'PGRST103', message: 'Requested range not satisfiable', details: null, hint: null }), {
        status: 416,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Range': `*/${totalText}` },
      });
    }
    const page = rows.slice(offset, offset + Math.min(limit, maxRows));
    const range = page.length ? `${offset}-${offset + page.length - 1}` : '*';
    return new Response(method === 'HEAD' ? null : JSON.stringify(page), {
      status: counted && page.length < total ? 206 : 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Range': `${range}/${totalText}` },
    });
  }

  /**
   * Auth (V3.4-c, tests multi-onglets avec le vrai SDK) : vérification de session
   * `GET /auth/v1/user` et révocation `POST /auth/v1/logout`, au format d'erreur de GoTrue.
   * Une session révoquée (`revokedSessions`) répond `session_not_found`, comme sur NEXORA-DEV.
   */
  function handleAuth(method: string, url: URL, headers: Headers): Response | null {
    const gotrue = (status: number, errorCode: string, msg: string) => json(status, { code: status, error_code: errorCode, msg });
    if (url.pathname === '/auth/v1/logout' && method === 'POST') return new Response(null, { status: 204 });
    if (url.pathname !== '/auth/v1/user' || method !== 'GET') return null;
    if (headers.get('apikey') !== SIM_ANON_KEY) return json(401, { message: 'Invalid API key' });
    const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return gotrue(403, 'bad_jwt', 'invalid JWT: unable to parse or verify signature');
    }
    if (token.endsWith('.invalide') || (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) || typeof claims.sub !== 'string') {
      return gotrue(403, 'bad_jwt', 'invalid JWT: unable to parse or verify signature, token is expired');
    }
    if (sim.revokedSessions.has(claims.sub)) return gotrue(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
    return json(200, { id: claims.sub, aud: 'authenticated', role: 'authenticated', email: `${claims.sub.slice(0, 8)}@exemple.invalid`, app_metadata: {}, user_metadata: {}, created_at: REGISTERED_AT });
  }

  async function handle(method: string, url: URL, headers: Headers, rawBody: string | null): Promise<Response> {
    const auth = handleAuth(method, url, headers);
    if (auth) return auth;
    if ((method === 'GET' || method === 'HEAD') && /^\/rest\/v1\/[a-z_]+$/.test(url.pathname)) return handleRead(method, url, headers);
    const fn = url.pathname.replace(/^\/rest\/v1\/rpc\//, '');
    if (method !== 'POST' || !['apply_changeset', 'resolve_changeset'].includes(fn) || !url.pathname.startsWith('/rest/v1/rpc/')) {
      return pgError(404, 'PGRST202', `Could not find the function public.${fn}`);
    }
    const uid = authenticate(headers, `permission denied for function ${fn}`);
    if (typeof uid !== 'string') return uid;
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
    const recorded: RecordedRequest = { method: init.method ?? 'GET', path: url.pathname, query: url.search, headers: Object.fromEntries(headers.entries()), body: parsed };
    requests.push(recorded);
    await sim.onRequest?.(recorded, requests.length - 1);
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
    if (o) return new Response(o.body, { status: o.status, headers: { 'Content-Type': o.contentType ?? 'application/json', ...o.headers } });
    return handle(init.method ?? 'GET', url, headers, rawBody);
  };

  const sim = {
    server,
    requests,
    fetch: fetchImpl as typeof fetch,
    /** Impose la réponse de la prochaine requête. */
    respondNext(o: Override) {
      overrides.push(o);
    },
    /** Exécuté avant chaque requête (après son enregistrement) : modifications concurrentes. */
    onRequest: null as ((request: RecordedRequest, index: number) => void | Promise<void>) | null,
    /** V3.4-c — utilisateurs dont la session est révoquée côté Auth (`GET /auth/v1/user` → `session_not_found`). */
    revokedSessions: new Set<string>(),
  };
  return sim;
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
