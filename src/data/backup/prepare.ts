/**
 * Phases A et B de la restauration (sans aucune écriture).
 *
 *  A. `prepareBackup(raw)` : migration vers le format courant puis validation complète.
 *     Lève `BackupValidationError` au premier problème bloquant — avant toute écriture.
 *  B. `planRestore(repo, raw)` : A + sauvegarde de sécurité de l'état actuel, vérifiée
 *     par relecture, + aperçu des volumes (actuel / fichier) par table.
 *
 * La phase C (application atomique) est `RepositoryCore.restoreBackup`, qui rejoue A
 * (le fichier n'est jamais appliqué sans validation, quel que soit l'appelant).
 */
import type { NexoraRepository } from '../contracts';
import { BACKUP_TABLES, type BackupFile, type BackupFileV2, type BackupTableName } from './format';
import { BackupValidationError, SafetyBackupError, type BackupIssue } from './issues';
import { migrateBackup, type MigrationReport } from './migrate';
import { hasBlockingIssues, validateBackup } from './validate';

export interface PreparedBackup {
  file: BackupFileV2;
  report: MigrationReport;
  /** Problèmes non bloquants (affichés dans l'aperçu). */
  warnings: BackupIssue[];
  /** Nombre de lignes par table dans le fichier. */
  counts: Record<BackupTableName, number>;
}

export function countRows(file: BackupFile): Record<BackupTableName, number> {
  return Object.fromEntries(BACKUP_TABLES.map((t) => [t, Array.isArray(file.data?.[t]) ? file.data[t].length : 0])) as Record<BackupTableName, number>;
}

/** Migre puis valide intégralement. Aucune écriture. */
export function prepareBackup(raw: unknown): PreparedBackup {
  const { file, report } = migrateBackup(raw);
  const issues = validateBackup(file, 'full');
  if (hasBlockingIssues(issues)) throw new BackupValidationError(issues);
  return { file: file as BackupFileV2, report, warnings: issues, counts: countRows(file) };
}

export interface TableDiff {
  table: BackupTableName;
  current: number;
  incoming: number;
}

export interface RestorePlan {
  prepared: PreparedBackup;
  /** Volumes actuels et du fichier, par table. */
  diff: TableDiff[];
  /** Sauvegarde de sécurité de l'état actuel (JSON vérifié par relecture). */
  safety: {
    json: string;
    exportedAt: string;
    counts: Record<BackupTableName, number>;
    /**
     * L'état actuel passe aussi la validation COMPLÈTE : il pourra être rétabli par
     * l'annulation immédiate (`undo.ts`). Sinon, seul le fichier téléchargé le permet.
     */
    undoable: boolean;
  };
}

/**
 * Produit la sauvegarde de sécurité de l'état actuel et vérifie qu'elle est exploitable :
 * relue depuis son JSON, elle doit être reconnue (format, version), structurellement
 * valide (tables, identifiants) et contenir exactement le même nombre de lignes.
 * La validation est volontairement structurelle : un état actuel imparfait doit rester
 * sauvegardable, sinon il deviendrait impossible de le remplacer.
 */
export async function createSafetyBackup(repo: Pick<NexoraRepository, 'exportBackup'>): Promise<RestorePlan['safety']> {
  let json: string;
  let source: BackupFile;
  try {
    source = await repo.exportBackup();
    json = JSON.stringify(source);
  } catch (e) {
    throw new SafetyBackupError(`export: ${String(e)}`);
  }
  let reread: BackupFile;
  try {
    reread = migrateBackup(JSON.parse(json)).file;
  } catch (e) {
    throw new SafetyBackupError(`relecture: ${String(e)}`);
  }
  const issues = validateBackup(reread, 'structure');
  if (hasBlockingIssues(issues)) throw new SafetyBackupError(`structure: ${issues.map((i) => `${i.code}:${i.table ?? ''}`).join(', ')}`);
  const expected = countRows(source);
  const actual = countRows(reread);
  for (const t of BACKUP_TABLES) if (expected[t] !== actual[t]) throw new SafetyBackupError(`volume ${t}: ${actual[t]} ≠ ${expected[t]}`);
  const undoable = !hasBlockingIssues(validateBackup(reread, 'full'));
  return { json, exportedAt: source.exportedAt, counts: expected, undoable };
}

/** Phases A + B : validation, sauvegarde de sécurité vérifiée, aperçu. Aucune écriture. */
export async function planRestore(repo: Pick<NexoraRepository, 'exportBackup'>, raw: unknown): Promise<RestorePlan> {
  const prepared = prepareBackup(raw);
  const safety = await createSafetyBackup(repo);
  const diff = BACKUP_TABLES.map((table) => ({ table, current: safety.counts[table], incoming: prepared.counts[table] }));
  return { prepared, diff, safety };
}
