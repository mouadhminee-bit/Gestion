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
 * Version 3 (V4.2) : table annexe `syncState`, curseur de la récupération des changements
 * (`pull_changes`, M9). Écrit par le chargement complet (borne prise AVANT la lecture, A2-b)
 * dans la même transaction que les données, puis avancé par chaque récupération appliquée. Son
 * absence signifie qu'aucun chargement complet avec curseur n'a eu lieu : aucune récupération
 * incrémentale n'est alors possible. Le cache reste jetable (reconstruit par le chargement).
 *
 * Protection : le constructeur exige l'utilisateur propriétaire et refuse tout nom autre
 * que `nexora-cache-<uid>` de CET utilisateur — en particulier `nexora`. Le contrôle a lieu
 * AVANT la construction de la base Dexie : les versions 2 et 3 (tables annexes) ne peuvent donc
 * jamais être déclarées sur la base locale réelle, ni la mettre à jour.
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

/** Table annexe du curseur de récupération des changements (version 3 du cache, V4.2). */
export const SYNC_STATE_TABLE = 'syncState';
/** Identifiant de l'unique enregistrement de `syncState`. */
export const PULL_STATE_ID = 'pull';

/** Curseur de récupération : borne (`xid8` en texte décimal) jusqu'à laquelle le cache est à jour. */
export interface SyncStateRecord {
  id: typeof PULL_STATE_ID;
  cursor: string;
}

/** Curseur `xid8` en texte décimal (format de `pull_changes`). */
export const XID8_TEXT = /^[0-9]{1,20}$/;

/**
 * Règle de la version la plus haute (V4.2) : une version reçue du serveur (lot confirmé,
 * changement récupéré) ne remplace la clé du cache que si elle est STRICTEMENT plus récente que
 * celle déjà connue (ou si la clé est inconnue). Partagée par `CloudStorage.applyConfirmed` et
 * l'application des changements récupérés (`CloudSync`).
 */
export function isNewerVersion(version: number, known: Pick<ServerVersionRecord, 'version'> | undefined | null): boolean {
  return !known || version > known.version;
}

export class CloudCacheDB extends NexoraDB {
  serverVersions!: Table<ServerVersionRecord, [string, string]>;
  syncState!: Table<SyncStateRecord, string>;

  readonly userId: ID;
  private revokedFlag = false;

  constructor(name: string, options: CloudCacheOptions) {
    super(checkedName(name, options?.userId), options.dexie);
    this.userId = options.userId;
    // Version 2 du CACHE : ajoute la table annexe ; les tables métier restent celles de la v1.
    this.version(2).stores({ [SERVER_VERSIONS_TABLE]: '[table+key]' });
    // Version 3 du CACHE (V4.2) : curseur de récupération des changements.
    this.version(3).stores({ [SYNC_STATE_TABLE]: 'id' });
    // Suppression de la base par une autre connexion (déconnexion dans un autre onglet, purge) :
    // cette instance est RÉVOQUÉE — fermée sans réouverture automatique, toute opération
    // ultérieure échoue (`DatabaseClosedError`) au lieu de recréer la base (V3.4-c, T41).
    // Dexie appelle les gestionnaires dans l'ordre INVERSE de leur ajout : celui-ci passe avant
    // le gestionnaire par défaut de Dexie (fermeture AVEC réouverture automatique) et l'écarte
    // en renvoyant `false`. Une mise à niveau de schéma (nouvelle version > 0) garde le
    // comportement par défaut de Dexie.
    this.on('versionchange', (event: IDBVersionChangeEvent) => {
      if (event.newVersion) return undefined;
      this.revokedFlag = true;
      this.close({ disableAutoOpen: true });
      return false;
    });
  }

  /** La base a été supprimée par une autre connexion : cette instance ne peut plus servir. */
  get revoked(): boolean {
    return this.revokedFlag;
  }
}
