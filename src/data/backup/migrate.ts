/**
 * Migration des fichiers de sauvegarde vers le format courant.
 *
 * Règles :
 *  - la version est identifiée explicitement (`formatVersion`, sinon fichier v1 si
 *    `schemaVersion === 1`) ; une version inconnue ou future est refusée ;
 *  - seules les étapes nécessaires sont appliquées, dans l'ordre (v1 → v2 → …) ;
 *  - les données métier ne sont jamais modifiées : seule l'enveloppe évolue, et les
 *    PARAMÈTRES absents sont complétés par des valeurs par défaut (liste tracée) ;
 *  - le fichier d'entrée n'est pas modifié (copie superficielle des niveaux touchés).
 */
import { isLang, languageInfo } from '@/i18n/languages';
import { defaultSettings } from '@/domain/settings';
import { BACKUP_APP, BACKUP_FORMAT_VERSION, BACKUP_SCHEMA_VERSION, type BackupFile } from './format';
import { BackupValidationError, type BackupIssue } from './issues';

export interface MigrationReport {
  /** Version du format du fichier d'origine. */
  fromVersion: number;
  /** Version du format après migration (= format courant). */
  toVersion: number;
  /** Étapes appliquées (ex. `v1→v2 : table attachments ajoutée (vide : non exportée en v1)`). */
  steps: string[];
  /** Paramètres absents du fichier, complétés par défaut. */
  filledSettings: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function reject(issue: Omit<BackupIssue, 'severity'>): never {
  throw new BackupValidationError([{ severity: 'error', ...issue }]);
}

/** Identifie la version de format d'un fichier brut (ou le refuse). */
export function detectFormatVersion(raw: unknown): number {
  if (!isObject(raw) || raw.app !== BACKUP_APP) reject({ code: 'notNexora' });
  const { formatVersion, schemaVersion } = raw;
  if (formatVersion !== undefined) {
    if (!Number.isInteger(formatVersion) || (formatVersion as number) < 1) reject({ code: 'badVersion', value: String(formatVersion) });
    if ((formatVersion as number) > BACKUP_FORMAT_VERSION) reject({ code: 'newer', value: String(formatVersion) });
  }
  if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 1) reject({ code: 'badVersion', value: String(schemaVersion) });
  if ((schemaVersion as number) > BACKUP_SCHEMA_VERSION) reject({ code: 'newer', value: String(schemaVersion) });
  return formatVersion === undefined ? 1 : (formatVersion as number);
}

type Step = (file: BackupFile, report: MigrationReport) => BackupFile;

/** v1 → v2 : les pièces jointes n'étaient pas exportées ; la table est déclarée vide. */
const v1ToV2: Step = (file, report) => {
  if (!isObject(file.data)) return { ...file, formatVersion: 2 };
  if ('attachments' in file.data) reject({ code: 'unknownTable', table: 'attachments' });
  report.steps.push('v1→v2: attachments = [] (not exported by format v1)');
  return { ...file, formatVersion: 2, data: { ...file.data, attachments: [] } };
};

/** `STEPS[n]` migre un fichier de la version n vers n + 1. */
const STEPS: Record<number, Step> = { 1: v1ToV2 };

/**
 * Complète les paramètres absents (valeur `undefined`). Une valeur présente mais invalide
 * n'est PAS corrigée : elle sera refusée par la validation.
 */
function completeSettings(file: BackupFile, report: MigrationReport): BackupFile {
  const rows = isObject(file.data) ? file.data.settings : undefined;
  if (!Array.isArray(rows) || rows.length !== 1 || !isObject(rows[0])) return file;
  const row = rows[0];
  const lang = isLang(row.language) ? row.language : undefined;
  const defaults: Record<string, unknown> = {
    ...defaultSettings('', lang ? { language: lang, locale: lang === 'fr' ? 'fr-MA' : languageInfo(lang).locale } : {}),
    // Une sauvegarde provient d'un espace déjà configuré : pas de retour à l'accueil.
    onboarded: true,
  };
  const filled: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(defaults)) {
    if (key === 'id' || key === 'userId' || key === 'updatedAt') continue;
    if (filled[key] === undefined) {
      filled[key] = Array.isArray(value) ? [...value] : value;
      report.filledSettings.push(key);
    }
  }
  if (!report.filledSettings.length) return file;
  return { ...file, data: { ...file.data, settings: [filled] } };
}

/**
 * Convertit un fichier brut au format courant.
 * @throws BackupValidationError si l'application ou la version n'est pas reconnue.
 */
export function migrateBackup(raw: unknown): { file: BackupFile; report: MigrationReport } {
  const fromVersion = detectFormatVersion(raw);
  const report: MigrationReport = { fromVersion, toVersion: BACKUP_FORMAT_VERSION, steps: [], filledSettings: [] };
  let file = raw as BackupFile;
  for (let v = fromVersion; v < BACKUP_FORMAT_VERSION; v++) {
    const step = STEPS[v];
    if (!step) reject({ code: 'badVersion', value: String(v) });
    file = step(file, report);
  }
  file = completeSettings(file, report);
  return { file, report };
}
