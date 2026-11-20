/**
 * Chargement Cloud lié à la session (Plan directeur V1, V3.4-c) — protocole du rapport de
 * cadrage V3.4, § 5, sans `CloudRepository` (branchement en V3.5).
 *
 * `runCloudLoad(deps, uid, ctx)` enchaîne, pour l'utilisateur authentifié `uid` :
 *  1. ouverture du cache `nexora-cache-<uid>` AVANT toute vérification de session : la
 *     connexion reste ouverte jusqu'à la fin, de sorte qu'une suppression par un autre onglet
 *     la révoque (`CloudCacheDB.revoked`) au lieu d'être suivie d'une recréation ;
 *  2. vérification : chargement toujours d'actualité (`ctx.isCurrent`), cache non révoqué,
 *     session (stockage partagé entre onglets) toujours celle de `uid` ;
 *  3. purge des caches des AUTRES utilisateurs (P-3) ;
 *  4. lecture complète (`readCloudData`) — la session est revérifiée avant CHAQUE requête,
 *     et un chargement invalidé n'envoie plus aucune requête ;
 *  5. préparation (`prepareCloudLoad`) ;
 *  6. dernière vérification, immédiatement avant l'écriture ;
 *  7. écriture atomique (`writeCloudLoad`) ;
 *  8. revérification après validation : session perdue entre-temps → suppression du cache.
 *
 * Invalidation : tout chargement devenu caduc (déconnexion, changement de compte, nouvel
 * essai, démontage) est ABANDONNÉ sans écriture ; si la session n'appartient plus à `uid`,
 * le cache est supprimé — y compris une base vide recréée par l'ouverture (résidu P-6 : aucune
 * requête, aucune donnée, suppression immédiate). Une panne réseau ne supprime rien : elle
 * remonte en erreur (`CloudReadError`), le cache reste tel quel.
 */
import type { DexieOptions } from 'dexie';
import type { ID } from '@/domain/types';
import { CloudCacheDB, cloudCacheName } from './CloudCacheDB';
import { prepareCloudLoad, writeCloudLoad, type CloudLoadSummary } from './CloudLoader';
import { readCloudData, type CloudReadSource } from './CloudReader';
import { deleteCloudCache, purgeOtherCloudCaches, type CacheDeps, type DeleteOutcome, type PurgeOutcome } from './cloudCaches';

/** Un chargement est-il toujours d'actualité ? (consulté avant chaque étape et chaque requête) */
export interface CloudLoadContext {
  isCurrent(): boolean;
}

/** Motif d'abandon : remplacé (nouvel essai, autre utilisateur…), cache supprimé ailleurs, session perdue. */
export type CloudLoadCancelReason = 'superseded' | 'cache_revoked' | 'session_lost';

export type CloudLoadOutcome =
  | { readonly status: 'loaded'; readonly summary: CloudLoadSummary; readonly purge: PurgeOutcome }
  | { readonly status: 'cancelled'; readonly reason: CloudLoadCancelReason; readonly cacheDeleted: boolean };

export interface CloudLoadDeps extends CacheDeps {
  /** Source de lecture liée à la session courante (`HttpReadSource` en production). */
  readonly source: CloudReadSource;
  /** Constructeur `IDBKeyRange` associé à `indexedDB` (tests : fabrique distincte). */
  readonly IDBKeyRange?: typeof IDBKeyRange;
}

const dexieOptions = (deps: CloudLoadDeps): DexieOptions | undefined => (deps.indexedDB ? { indexedDB: deps.indexedDB, IDBKeyRange: deps.IDBKeyRange ?? globalThis.IDBKeyRange } : undefined);

export async function runCloudLoad(deps: CloudLoadDeps, userId: ID, ctx: CloudLoadContext): Promise<CloudLoadOutcome> {
  const cache = new CloudCacheDB(cloudCacheName(userId), { userId, dexie: dexieOptions(deps) });

  const sessionIsUser = async () => {
    try {
      return (await deps.source.sessionUserId()) === userId;
    } catch {
      return false;
    }
  };
  /** Motif d'abandon, ou `null` si le chargement peut continuer. */
  const stale = async (): Promise<CloudLoadCancelReason | null> => {
    if (!ctx.isCurrent()) return 'superseded';
    if (cache.revoked) return 'cache_revoked';
    if (!(await sessionIsUser())) return 'session_lost';
    return ctx.isCurrent() ? null : 'superseded';
  };
  /** Abandon sans écriture ; cache supprimé si la session n'appartient plus à `userId`. */
  const cancel = async (reason: CloudLoadCancelReason): Promise<CloudLoadOutcome> => {
    cache.close();
    let cacheDeleted = false;
    if (!(await sessionIsUser())) {
      const outcome: DeleteOutcome | 'failed' = await deleteCloudCache(userId, deps).catch(() => 'failed' as const);
      cacheDeleted = outcome === 'deleted';
    }
    return { status: 'cancelled', reason, cacheDeleted };
  };
  // Source protégée : un chargement caduc ou un cache révoqué n'envoie plus aucune requête
  // (`readCloudData` vérifie la session avant chaque requête et refuse sans rien envoyer).
  const guarded: CloudReadSource = {
    kind: deps.source.kind,
    sessionUserId: async () => (ctx.isCurrent() && !cache.revoked ? deps.source.sessionUserId() : null),
    page: (q, offset, limit) => deps.source.page(q, offset, limit),
    count: (q) => deps.source.count(q),
  };

  try {
    await cache.open(); // 1
    let reason = await stale(); // 2
    if (reason) return await cancel(reason);
    const purge = await purgeOtherCloudCaches(userId, deps); // 3
    reason = await stale();
    if (reason) return await cancel(reason);
    let result;
    try {
      result = await readCloudData(guarded, userId); // 4
    } catch (e) {
      reason = await stale();
      if (reason) return await cancel(reason);
      throw e;
    }
    const prepared = prepareCloudLoad(result, userId); // 5
    reason = await stale(); // 6
    if (reason) return await cancel(reason);
    let summary: CloudLoadSummary;
    try {
      summary = await writeCloudLoad(cache, prepared); // 7
    } catch (e) {
      reason = await stale();
      if (reason) return await cancel(reason);
      throw e;
    }
    reason = await stale(); // 8
    if (reason) return await cancel(reason);
    return { status: 'loaded', summary, purge };
  } finally {
    cache.close();
  }
}

/** Accès aux données Cloud pour le cycle de session : chargement et suppression du cache (D6). */
export interface CloudDataPort {
  load(userId: ID, ctx: CloudLoadContext): Promise<CloudLoadOutcome>;
  deleteCache(userId: ID): Promise<DeleteOutcome>;
}

export function createCloudDataPort(deps: CloudLoadDeps): CloudDataPort {
  return {
    load: (userId, ctx) => runCloudLoad(deps, userId, ctx),
    deleteCache: (userId) => deleteCloudCache(userId, deps),
  };
}
