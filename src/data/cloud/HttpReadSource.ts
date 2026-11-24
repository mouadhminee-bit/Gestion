/**
 * Source de lecture HTTP (Plan directeur V1, V3.4-a) : tables lues par supabase-js, avec le
 * jeton de la SESSION COURANTE (RLS : lignes de l'utilisateur seulement). Clé publique
 * uniquement, aucune clé `service_role`.
 *
 *  - page : `GET /rest/v1/<table>?select=*&<propriétaire>=eq.<uid>&order=<clé>.asc&offset=…&limit=…`
 *    avec `Prefer: count=exact` — AUCUN filtre `deleted_at` (lignes supprimées comprises) ;
 *  - contre-vérification : `HEAD` sur le même filtre, `Prefer: count=exact`, sans données ;
 *  - récupération des changements (V4.2) : `POST /rest/v1/rpc/pull_changes`
 *    `{ p_cursor, p_bound, p_after, p_limit }` (M9 ; refus de paramètre : 400 `PT400`).
 * Une seule tentative (`retry(false)` : postgrest-js relancerait sinon GET et HEAD sur 503 /
 * 520), chaque requête bornée par un délai (30 s par défaut).
 *
 * Erreurs → `CloudReadError` (jamais le corps de la réponse ni son message, qui pourraient
 * contenir des valeurs) :
 *  - réseau, délai, 5xx, 408, 429, SQLSTATE passager → `unavailable` ;
 *  - 401, 403, `42501`, `PGRST30x` → `unauthorized` ;
 *  - réponse 2xx illisible ou statut inattendu → `invalid_response` ;
 *  - autre 4xx → `rejected`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ID } from '@/domain/types';
import { CloudReadError, type CloudReadSource, type PullRequest, type ReadPage, type ReadQuery } from './CloudReader';
import type { CloudTableName } from './mapping';
import { HTTP_TIMEOUT_MS, isTransientSqlstate } from './HttpTransport';

/** Partie du client Supabase utilisée : la session (lue localement), les tables et `pull_changes`. */
export type ReadClient = Pick<SupabaseClient, 'from' | 'auth' | 'rpc'>;

interface PgError {
  message?: unknown;
  code?: unknown;
  hint?: unknown;
}

/** Erreur d'une requête de lecture → `CloudReadError` (statut et code seulement). */
export function classifyReadError(status: number, error: PgError, query: { readonly table: CloudTableName | null }, timeoutMs = HTTP_TIMEOUT_MS): CloudReadError {
  const table = query.table;
  const code = typeof error.code === 'string' ? error.code : '';
  const label = `HTTP ${status}${code ? ` ${code}` : ''}`;
  if (status === 0) {
    const text = `${typeof error.message === 'string' ? error.message : ''} ${typeof error.hint === 'string' ? error.hint : ''}`;
    const aborted = /abort|timeout/i.test(text);
    return new CloudReadError('unavailable', aborted ? `délai dépassé (${timeoutMs} ms)` : 'échec réseau', { table, status, reason: aborted ? 'timeout' : 'network' });
  }
  if (status >= 200 && status < 300) return new CloudReadError('invalid_response', `réponse illisible (HTTP ${status})`, { table, status });
  if (status >= 500 || status === 408 || status === 429 || isTransientSqlstate(code)) return new CloudReadError('unavailable', `serveur indisponible (${label})`, { table, status, reason: code || null });
  if (status === 401 || status === 403 || code === '42501' || /^PGRST30\d$/.test(code)) return new CloudReadError('unauthorized', `session refusée par le serveur (${label})`, { table, status, reason: code || null });
  return new CloudReadError('rejected', `lecture refusée par le serveur (${label})`, { table, status, reason: code || null });
}

export class HttpReadSource implements CloudReadSource {
  readonly kind = 'http';

  constructor(
    private readonly client: ReadClient,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? HTTP_TIMEOUT_MS;
  }

  async sessionUserId(): Promise<ID | null> {
    const { data } = await this.client.auth.getSession();
    return data.session?.access_token ? (data.session.user?.id ?? null) : null;
  }

  async page(query: ReadQuery, offset: number, limit: number): Promise<ReadPage> {
    let builder = this.client.from(query.sqlTable).select('*', { count: 'exact' }).eq(query.owner, query.userId);
    for (const column of query.order) builder = builder.order(column, { ascending: true });
    const res = await builder
      .range(offset, offset + limit - 1)
      .retry(false)
      .abortSignal(AbortSignal.timeout(this.timeoutMs));
    if (res.error) throw classifyReadError(res.status, res.error, query, this.timeoutMs);
    if (res.status < 200 || res.status >= 300) throw new CloudReadError('invalid_response', `statut HTTP ${res.status} inattendu`, { table: query.table, status: res.status });
    return { rows: res.data, total: res.count };
  }

  async pull(request: PullRequest): Promise<unknown> {
    const res = await this.client
      .rpc('pull_changes', { p_cursor: request.cursor, p_bound: request.bound, p_after: request.after, p_limit: request.limit })
      .retry(false)
      .abortSignal(AbortSignal.timeout(this.timeoutMs));
    if (res.error) throw classifyReadError(res.status, res.error, { table: null }, this.timeoutMs);
    if (res.status < 200 || res.status >= 300) throw new CloudReadError('invalid_response', `statut HTTP ${res.status} inattendu`, { status: res.status });
    return res.data;
  }

  async count(query: ReadQuery): Promise<unknown> {
    const res = await this.client
      .from(query.sqlTable)
      .select('*', { count: 'exact', head: true })
      .eq(query.owner, query.userId)
      .retry(false)
      .abortSignal(AbortSignal.timeout(this.timeoutMs));
    if (res.error) throw classifyReadError(res.status, res.error, query, this.timeoutMs);
    if (res.status < 200 || res.status >= 300) throw new CloudReadError('invalid_response', `statut HTTP ${res.status} inattendu`, { table: query.table, status: res.status });
    return res.count;
  }
}
