/**
 * Base IndexedDB du cache cloud d'un utilisateur : `nexora-cache-<uid>` (Lot 4, étape 4.3).
 *
 * Mêmes tables métier que la base locale (`NexoraDB` v1, schéma inchangé) + une table
 * annexe `serverVersions` (version 2 de CETTE base uniquement) : dernière version serveur
 * connue de chaque clé. Les versions ne sont jamais ajoutées aux lignes métier : elles
 * n'apparaissent donc ni dans `snapshot()` ni dans `exportBackup()`.
 *
 * Une clé supprimée garde son enregistrement (`deleted: true`) : une écriture ultérieure
 * (réactivation) porte la version de la ligne supprimée, et une écriture obsolète est
 * détectée par le serveur.
 *
 * Protection : le constructeur exige l'utilisateur propriétaire et refuse tout nom autre
 * que `nexora-cache-<uid>` de CET utilisateur — en particulier `nexora`. Le contrôle a lieu
 * AVANT la construction de la base Dexie : la version 2 (table annexe) ne peut donc jamais
 * être déclarée sur la base locale réelle, ni la mettre à jour.
 */
import type { DexieOptions, Table } from 'dexie';
import { NexoraDB } from '../db';
import type { TableName } from '../tables';
import type { ID } from '@/domain/types';

export const CLOUD_CACHE_PREFIX = 'nexora-cache-';
/** Nom de la base IndexedDB réelle du mode local : ne doit JAMAIS être ouverte en mode cloud. */
export const LOCAL_DB_NAME = 'nexora';

/** Nom du cache d'un utilisateur : `nexora-cache-<uid>`. */
export function cloudCacheName(userId: ID): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error(`Identifiant utilisateur invalide pour le cache cloud : « ${userId} ».`);
  return `${CLOUD_CACHE_PREFIX}${userId}`;
}

/** Refuse toute base qui n'est pas exactement le cache de cet utilisateur. */
export function assertCloudCacheName(name: string, userId: ID): void {
  if (name === LOCAL_DB_NAME) throw new Error('Mode cloud : la base locale « nexora » ne doit jamais être ouverte.');
  if (!name.startsWith(CLOUD_CACHE_PREFIX)) throw new Error(`Mode cloud : cache « ${name} » refusé, préfixe « ${CLOUD_CACHE_PREFIX} » obligatoire.`);
  if (name !== cloudCacheName(userId)) throw new Error(`Mode cloud : cache « ${name} » refusé, attendu « ${cloudCacheName(userId)} ».`);
}

export interface CloudCacheOptions {
  /** Utilisateur propriétaire : le nom doit être exactement `nexora-cache-<userId>`. */
  userId: ID;
  /** Réservé aux tests (fabrique IndexedDB distincte = autre appareil simulé). */
  dexie?: DexieOptions;
}

/** Contrôle exécuté avant `super()` : aucune base Dexie n'est créée pour un nom refusé. */
function checkedName(name: string, userId: ID): string {
  assertCloudCacheName(name, userId);
  return name;
}

export interface ServerVersionRecord {
  table: TableName;
  /** Clé de la ligne, sous forme canonique (`keyString`). */
  key: string;
  /** Dernière version serveur confirmée. */
  version: number;
  /** Ligne supprimée logiquement côté serveur. */
  deleted: boolean;
}

export const SERVER_VERSIONS_TABLE = 'serverVersions';

export class CloudCacheDB extends NexoraDB {
  serverVersions!: Table<ServerVersionRecord, [string, string]>;

  readonly userId: ID;

  constructor(name: string, options: CloudCacheOptions) {
    super(checkedName(name, options?.userId), options.dexie);
    this.userId = options.userId;
    // Version 2 du CACHE : ajoute la table annexe ; les tables métier restent celles de la v1.
    this.version(2).stores({ [SERVER_VERSIONS_TABLE]: '[table+key]' });
  }
}
