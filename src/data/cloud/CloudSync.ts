/**
 * Synchronisation incrémentale du cache Cloud (Plan directeur V1, V4.2).
 *
 * Récupère les changements du serveur par `public.pull_changes` (M9) depuis le curseur du cache
 * (`syncState`, écrit par le chargement complet : borne prise AVANT la lecture, A2-b) et les
 * applique au cache `nexora-cache-<uid>` :
 *
 *  1. lecture du curseur ; absent → rien (aucun chargement complet avec curseur) ;
 *  2. récupération de TOUTES les pages de l'intervalle `[curseur, borne)`, HORS de la file des
 *     opérations (le réseau ne retarde pas les écritures de l'utilisateur) ; session vérifiée
 *     avant chaque requête ; une synchronisation devenue caduque n'envoie plus rien ;
 *  3. contrôles en mémoire, sans aucune écriture : forme des pages, borne constante, progression
 *     de la pagination, table connue, conversion stricte (`deserializeRow`), version ≥ 1,
 *     `curseur ≤ sync_txid < borne`, propriétaire = utilisateur, une seule ligne par clé ;
 *  4. DANS la file des opérations de `CloudRepository` (risque R3 : jamais au milieu d'une
 *     écriture) : dernière vérification (synchronisation d'actualité, cache non révoqué, session
 *     toujours celle de l'utilisateur), puis UNE transaction Dexie : chaque clé n'est écrite que
 *     si sa version est STRICTEMENT plus récente que celle du cache (règle de la version la plus
 *     haute, R1 ; jamais de fusion) — ligne active écrite, ligne supprimée retirée, version
 *     enregistrée (`deleted`) ; le curseur devient le maximum de lui-même et de la borne (deux
 *     onglets peuvent synchroniser le même cache : le curseur ne recule jamais).
 *
 * Toute erreur (réseau, refus, réponse non conforme, écriture) abandonne le cycle SANS rien
 * écrire ni avancer le curseur : le déclencheur suivant reprend depuis le même curseur
 * (réappliquer des changements déjà connus ne modifie rien). Aucune nouvelle tentative
 * rapprochée, aucune action sur la session, aucun rechargement (décision D3 de V4.2).
 *
 * Déclencheurs (D7) : retour au premier plan (`visibilitychange`), retour du réseau (`online`),
 * et toutes les 50 s (décision R1, P57 : la période la plus défavorable plus le traitement doit
 * rester ≤ 60 s, seuil du § 7 du plan directeur). Une seule synchronisation à la fois par instance : un déclenchement pendant
 * une synchronisation demande UNE relance à sa fin. `stop()` (fin de l'espace de travail :
 * déconnexion, changement de compte) retire les déclencheurs et rend caduque toute
 * synchronisation en cours : aucune écriture ne peut plus avoir lieu.
 *
 * Messages d'erreur : table, motif et nombres seulement — jamais de valeur métier ni de clé.
 */
import type { ID } from '@/domain/types';
import type { Key } from '../storage';
import { PRIMARY_KEYS, type TableName } from '../tables';
import { CloudCacheDB, PULL_STATE_ID, SERVER_VERSIONS_TABLE, SYNC_STATE_TABLE, XID8_TEXT, isNewerVersion } from './CloudCacheDB';
import { CloudReadError, type CloudReadSource } from './CloudReader';
import { MappingError, deserializeRow, tableOfSql, type CloudTableName } from './mapping';
import { keyString } from './transport';

/** Taille d'une page de récupération (maximum de `pull_changes`). */
export const PULL_PAGE_SIZE = 1000;
/**
 * Synchronisation périodique (D7). 50 s et non 60 s (décision R1, P57) : une création confirmée
 * juste après la borne d'une synchronisation n'apparaît qu'à la suivante, soit au plus la période
 * PLUS le traitement (requête, application, affichage). Avec 50 s, le seuil strict « ≤ 60 s » du
 * plan directeur (§ 7) est garanti tant que ce traitement ne dépasse pas 10 s.
 */
export const SYNC_INTERVAL_MS = 50_000;

/** File des opérations d'un dépôt Cloud : une seule opération à la fois (écritures, application des changements). */
export interface OperationQueue {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** File FIFO : chaque tâche attend la fin (réussie ou non) de la précédente. */
export function createOperationQueue(): OperationQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/** Échec de l'application au cache : transaction annulée, cache et curseur inchangés. */
export class CloudSyncWriteError extends Error {
  constructor(readonly reason: string) {
    super(`Synchronisation : écriture du cache annulée, aucune modification conservée (${reason})`);
    this.name = 'CloudSyncWriteError';
  }
}

/** Un changement récupéré, vérifié et converti. */
export interface PulledChange {
  readonly table: CloudTableName;
  readonly key: Key;
  /** Ligne convertie (contenu ignoré si la ligne est supprimée). */
  readonly row: Record<string, unknown>;
  readonly version: number;
  readonly deleted: boolean;
}

/** Résultat vérifié d'une récupération : changements de l'intervalle `[cursor, bound)`. */
export interface PulledChanges {
  readonly userId: ID;
  readonly cursor: string;
  readonly bound: string;
  readonly changes: readonly PulledChange[];
  readonly pages: number;
}

/** Une synchronisation est-elle toujours d'actualité ? (consulté avant chaque requête et avant l'écriture) */
export interface SyncContext {
  isCurrent(): boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (detail: string, table: CloudTableName | null = null, reason: string | null = null) => new CloudReadError('invalid_response', detail, { table, reason });
const stale = () => new CloudReadError('unauthorized', 'synchronisation interrompue (session terminée ou remplacée) : aucune requête envoyée', { reason: 'stale' });

function rowKey(table: CloudTableName, row: Record<string, unknown>): Key | null {
  const pk = PRIMARY_KEYS[table];
  const parts = (typeof pk === 'string' ? [pk] : pk).map((f) => row[f]);
  if (!parts.every((p) => typeof p === 'string' && p.length > 0)) return null;
  return typeof pk === 'string' ? (parts[0] as string) : (parts as string[]);
}

/** Session de la source = utilisateur attendu, et synchronisation d'actualité ; sinon refus sans envoi. */
async function ensureCurrent(source: CloudReadSource, userId: ID, ctx: SyncContext): Promise<void> {
  if (!ctx.isCurrent()) throw stale();
  let uid: ID | null;
  try {
    uid = await source.sessionUserId();
  } catch {
    uid = null;
  }
  if (uid !== userId || !ctx.isCurrent()) throw stale();
}

/**
 * Récupère et vérifie tous les changements de `userId` depuis `cursor` (aucune écriture).
 * `CloudReadError` en cas de refus, d'indisponibilité ou de réponse non conforme.
 */
export async function pullChanges(source: CloudReadSource, userId: ID, cursor: string, ctx: SyncContext, pageSize = PULL_PAGE_SIZE): Promise<PulledChanges> {
  if (typeof userId !== 'string' || !userId) throw new CloudReadError('unauthorized', 'utilisateur non précisé (aucune requête envoyée)');
  if (typeof cursor !== 'string' || !XID8_TEXT.test(cursor)) throw invalid('curseur de récupération invalide', null, 'cursor');
  const start = BigInt(cursor);
  const changes: PulledChange[] = [];
  const seen = new Set<string>();
  let bound: string | null = null;
  let after: unknown = null;
  let pages = 0;
  for (;;) {
    await ensureCurrent(source, userId, ctx);
    let page: unknown;
    try {
      page = await source.pull({ cursor, bound, after, limit: pageSize });
    } catch (e) {
      if (e instanceof CloudReadError) throw e;
      throw new CloudReadError('unavailable', `échec de la source (${e instanceof Error ? e.name : 'erreur'})`, { reason: 'pull' });
    }
    pages++;
    if (!isObject(page) || typeof page.bound !== 'string' || !XID8_TEXT.test(page.bound) || !Array.isArray(page.rows)) throw invalid('page de récupération illisible', null, 'shape');
    if (bound !== null && page.bound !== bound) throw invalid('borne modifiée pendant la pagination', null, 'bound_changed');
    bound = page.bound;
    const end = BigInt(bound);
    if (end < start) throw invalid('borne antérieure au curseur', null, 'bound_before_cursor');
    if (page.rows.length > pageSize) throw invalid(`page de ${page.rows.length} lignes pour ${pageSize} demandées`, null, 'page_overflow');
    for (const item of page.rows as unknown[]) {
      if (!isObject(item) || typeof item.table !== 'string') throw invalid('changement illisible', null, 'item');
      let table: CloudTableName;
      try {
        table = tableOfSql(item.table);
      } catch {
        throw invalid('changement d’une table inconnue', null, 'unknown_table');
      }
      let row: Record<string, unknown>;
      let meta: ReturnType<typeof deserializeRow>['meta'];
      try {
        const d = deserializeRow(table, item.row);
        row = d.row as unknown as Record<string, unknown>;
        meta = d.meta;
      } catch (e) {
        if (e instanceof MappingError) throw new CloudReadError('invalid_row', `ligne non conforme (colonne ${e.field ?? '—'}, ${e.code})`, { table, reason: e.code });
        throw new CloudReadError('invalid_row', 'ligne illisible', { table });
      }
      // Isolation d'abord : une ligne d'un autre utilisateur est signalée comme telle.
      if ((table === 'users' ? row.id : row.userId) !== userId) throw new CloudReadError('foreign_row', 'ligne d’un autre utilisateur', { table });
      if (meta.version < 1) throw new CloudReadError('invalid_row', 'version serveur invalide (< 1)', { table, reason: 'invalid_version' });
      const txid = BigInt(meta.syncTxid);
      if (txid < start || txid >= end) throw invalid('changement hors de l’intervalle demandé', table, 'out_of_range');
      const key = rowKey(table, row);
      if (key === null) throw new CloudReadError('invalid_row', 'clé primaire absente ou invalide', { table, reason: 'invalid_key' });
      const id = `${table}\u0000${keyString(key)}`;
      if (seen.has(id)) throw new CloudReadError('incomplete', 'clé reçue deux fois dans un même intervalle', { table, reason: 'duplicate_key' });
      seen.add(id);
      changes.push({ table, key, row, version: meta.version, deleted: meta.deletedAt !== null });
    }
    if (page.next === null) break;
    if (!isObject(page.next) || page.rows.length === 0) throw invalid('position de reprise illisible', null, 'next');
    if (after !== null && JSON.stringify(page.next) === JSON.stringify(after)) throw invalid('pagination sans progression', null, 'no_progress');
    after = page.next;
  }
  return { userId, cursor, bound: bound!, changes, pages };
}

/** Résumé d'une application au cache. */
export interface SyncApplySummary {
  /** Curseur enregistré après l'application. */
  readonly cursor: string;
  /** Changements reçus. */
  readonly received: number;
  /** Clés écrites (strictement plus récentes que le cache). */
  readonly applied: number;
}

/**
 * Applique des changements vérifiés au cache, en UNE transaction (tout ou rien) : règle de la
 * version la plus haute, curseur porté au maximum de lui-même et de la borne. `null` : aucun
 * curseur dans le cache (rien n'est écrit).
 */
export async function applyPulledChanges(cache: CloudCacheDB, pulled: PulledChanges): Promise<SyncApplySummary | null> {
  if (cache.userId !== pulled.userId) throw new CloudReadError('foreign_row', 'changements destinés à un autre utilisateur');
  const touched = [...new Set(pulled.changes.map((c) => c.table as TableName))];
  try {
    return await cache.transaction('rw', [...touched.map((t) => cache.table(t)), cache.table(SERVER_VERSIONS_TABLE), cache.table(SYNC_STATE_TABLE)], async () => {
      const state = await cache.syncState.get(PULL_STATE_ID);
      if (!state) return null;
      let applied = 0;
      for (const c of pulled.changes) {
        const key = keyString(c.key);
        const known = await cache.serverVersions.get([c.table, key]);
        if (!isNewerVersion(c.version, known)) continue;
        const table = cache.table(c.table);
        if (c.deleted) await table.delete(c.key as never);
        else await table.put(c.row);
        await cache.serverVersions.put({ table: c.table, key, version: c.version, deleted: c.deleted });
        applied++;
      }
      const cursor = BigInt(state.cursor) >= BigInt(pulled.bound) ? state.cursor : pulled.bound;
      if (cursor !== state.cursor) await cache.syncState.put({ id: PULL_STATE_ID, cursor });
      return { cursor, received: pulled.changes.length, applied };
    });
  } catch (e) {
    if (e instanceof CloudReadError) throw e;
    const inner = (e as { inner?: { name?: unknown } })?.inner?.name;
    throw new CloudSyncWriteError(typeof inner === 'string' ? inner : e instanceof Error ? e.name : 'Error');
  }
}

/** Issue d'un cycle de synchronisation. */
export type SyncOutcome =
  | { readonly status: 'applied'; readonly summary: SyncApplySummary; readonly pages: number }
  | { readonly status: 'skipped'; readonly reason: 'no_cursor' | 'stopped' | 'stale' }
  | { readonly status: 'failed'; readonly error: Error };

export interface CloudSyncOptions {
  readonly userId: ID;
  readonly cache: CloudCacheDB;
  /** Source liée à la session courante (`HttpReadSource` en production). */
  readonly source: CloudReadSource;
  /** File des opérations du dépôt (`CloudRepository`) : l'application y attend son tour. */
  readonly queue: OperationQueue;
  readonly pageSize?: number;
}

/** Environnement des déclencheurs (navigateur par défaut ; injectable pour les tests). */
export interface SyncTriggerEnvironment {
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

function browserEnvironment(): SyncTriggerEnvironment | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return {
    target: window,
    document,
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
  };
}

/**
 * Synchronisation d'un espace de travail Cloud (un utilisateur, un cache). Une instance par
 * espace ; `stop()` est définitif.
 */
export class CloudSync {
  private stopped = false;
  private running: Promise<SyncOutcome> | null = null;
  private again = false;
  private detach: (() => void) | null = null;
  /** Dernière issue (diagnostic et tests). */
  lastOutcome: SyncOutcome | null = null;

  constructor(private readonly options: CloudSyncOptions) {
    if (options.cache.userId !== options.userId) throw new Error('Synchronisation : cache d’un autre utilisateur.');
  }

  get userId(): ID {
    return this.options.userId;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private readonly ctx: SyncContext = { isCurrent: () => !this.stopped && !this.options.cache.revoked };

  /**
   * Demande une synchronisation. Pendant une synchronisation en cours : UNE relance à sa fin
   * (les demandes suivantes sont regroupées). Renvoie l'issue du dernier cycle exécuté.
   */
  request(): Promise<SyncOutcome> {
    if (this.stopped) return Promise.resolve({ status: 'skipped', reason: 'stopped' });
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = this.loop();
    this.running = run;
    return run;
  }

  private async loop(): Promise<SyncOutcome> {
    let outcome: SyncOutcome;
    try {
      do {
        this.again = false;
        outcome = await this.once();
        this.lastOutcome = outcome;
      } while (this.again && !this.stopped);
    } finally {
      this.running = null;
    }
    return outcome;
  }

  private async once(): Promise<SyncOutcome> {
    const { cache, source, userId, queue } = this.options;
    if (!this.ctx.isCurrent()) return { status: 'skipped', reason: 'stopped' };
    try {
      const state = await cache.syncState.get(PULL_STATE_ID);
      if (!state) return { status: 'skipped', reason: 'no_cursor' };
      const pulled = await pullChanges(source, userId, state.cursor, this.ctx, this.options.pageSize);
      return await queue.run(async () => {
        // Dernière vérification, immédiatement avant l'écriture (dans la file : aucune écriture en cours).
        try {
          await ensureCurrent(source, userId, this.ctx);
        } catch {
          return { status: 'skipped', reason: this.ctx.isCurrent() ? 'stale' : 'stopped' } as const;
        }
        const summary = await applyPulledChanges(cache, pulled);
        if (!summary) return { status: 'skipped', reason: 'no_cursor' } as const;
        return { status: 'applied', summary, pages: pulled.pages } as const;
      });
    } catch (e) {
      if (!this.ctx.isCurrent()) return { status: 'skipped', reason: 'stopped' };
      if (e instanceof CloudReadError && e.reason === 'stale') return { status: 'skipped', reason: 'stale' };
      return { status: 'failed', error: e instanceof Error ? e : new Error('échec de la synchronisation') };
    }
  }

  /**
   * Branche les déclencheurs (D7) : retour au premier plan, retour du réseau, toutes les 50 s (R1).
   * Sans environnement navigateur (et sans environnement injecté) : aucun déclencheur.
   */
  start(env: SyncTriggerEnvironment | null = browserEnvironment(), intervalMs = SYNC_INTERVAL_MS): void {
    if (this.stopped || this.detach || !env) return;
    const trigger = () => {
      void this.request();
    };
    const onVisibility = () => {
      if (env.document.visibilityState === 'visible') trigger();
    };
    env.target.addEventListener('online', trigger);
    env.document.addEventListener('visibilitychange', onVisibility);
    const timer = env.setInterval(trigger, intervalMs);
    this.detach = () => {
      env.target.removeEventListener('online', trigger);
      env.document.removeEventListener('visibilitychange', onVisibility);
      env.clearInterval(timer);
    };
  }

  /** Arrêt définitif : déclencheurs retirés, synchronisation en cours rendue caduque (aucune écriture). */
  stop(): void {
    this.stopped = true;
    this.detach?.();
    this.detach = null;
  }
}
