/**
 * Format des fichiers de sauvegarde NEXORA (JSON).
 *
 * Deux numéros distincts :
 *  - `formatVersion` : version du FORMAT DE FICHIER (enveloppe, tables présentes,
 *    encodage des pièces jointes). Absent dans les fichiers v1.
 *  - `schemaVersion` : version du schéma de données (IndexedDB, `db.ts`).
 *
 * Historique :
 *  - v1 (`{ app, schemaVersion: 1, exportedAt, data }`, sans `formatVersion`) :
 *    16 tables utilisateur, pièces jointes NON incluses.
 *  - v2 (`formatVersion: 2`) : les 16 tables + `attachments` (fichiers encodés en
 *    base64). Paramètres complets.
 *
 * Voir `docs/BACKUP_RESTORE.md`.
 */
import { SCHEMA_VERSION, USER_TABLES } from '../tables';

export const BACKUP_APP = 'nexora';
/** Version du format de fichier produite par `exportBackup()`. */
export const BACKUP_FORMAT_VERSION = 2;
/** Version de schéma de données acceptée (et produite). */
export const BACKUP_SCHEMA_VERSION = SCHEMA_VERSION;

/** Tables d'un fichier v2, dans l'ordre d'écriture. */
export const BACKUP_TABLES = [...USER_TABLES, 'attachments'] as const;
export type BackupTableName = (typeof BACKUP_TABLES)[number];

/** Taille maximale d'une pièce jointe (identique à `addAttachment`). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Taille maximale d'un fichier de sauvegarde accepté par l'interface. */
export const MAX_BACKUP_FILE_BYTES = 100 * 1024 * 1024;

/** Pièce jointe telle qu'elle figure dans un fichier v2. */
export interface SerializedAttachment {
  id: string;
  userId?: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  /** Contenu du fichier en base64 ; `null` si le fichier n'était pas disponible à l'export. */
  data: string | null;
}

export interface BackupFile {
  app: 'nexora';
  /** Absent (= 1) dans les anciens fichiers. */
  formatVersion?: number;
  schemaVersion: number;
  exportedAt: string;
  data: Record<string, unknown[]>;
}

/** Fichier normalisé au format courant, prêt à être appliqué. */
export interface BackupFileV2 extends BackupFile {
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  data: Record<BackupTableName, Record<string, unknown>[]>;
}
