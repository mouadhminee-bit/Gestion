/**
 * Problèmes détectés lors de la validation d'une sauvegarde.
 *
 * `error` : restauration refusée (aucune donnée modifiée).
 * `warning` : restauration possible ; le problème est affiché dans l'aperçu.
 */
import { t } from '@/i18n/core';
import { ValidationError } from '@/domain/errors';

export type IssueCode =
  | 'notNexora'
  | 'badVersion'
  | 'newer'
  | 'badData'
  | 'missingTable'
  | 'unknownTable'
  | 'notArray'
  | 'badRow'
  | 'missingId'
  | 'duplicateId'
  | 'settingsCount'
  | 'badField'
  | 'orphan'
  | 'transferPair'
  | 'attachmentMissing';

export interface BackupIssue {
  severity: 'error' | 'warning';
  code: IssueCode;
  table?: string;
  /** Position de la ligne dans la table (à partir de 1). */
  row?: number;
  id?: string;
  field?: string;
  /** Identifiant référencé introuvable (relations). */
  ref?: string;
  /** Valeur lue (versions). */
  value?: string;
}

/** Libellé lisible (langue active) d'un problème. */
export function formatIssue(i: BackupIssue): string {
  const v = { table: i.table ?? '', row: i.row ?? 0, id: i.id ?? `#${i.row ?? '?'}`, field: i.field ?? '', ref: i.ref ?? '', version: i.value ?? '?' };
  switch (i.code) {
    case 'notNexora':
      return t('bk.notNexora');
    case 'badVersion':
      return t('bk.badVersion', v);
    case 'newer':
      return t('err.backupNewer');
    case 'badData':
      return t('err.backupInvalid');
    case 'missingTable':
      return t('bk.missingTable', v);
    case 'unknownTable':
      return t('bk.unknownTable', v);
    case 'notArray':
      return t('bk.notArray', v);
    case 'badRow':
      return t('bk.badRow', v);
    case 'missingId':
      return t('bk.missingId', v);
    case 'duplicateId':
      return t('bk.duplicateId', v);
    case 'settingsCount':
      return t('bk.settingsCount', { count: Number(i.value ?? 0) });
    case 'badField':
      return t('bk.badField', v);
    case 'orphan':
      return t('bk.orphan', v);
    case 'transferPair':
      return t('bk.transferPair', v);
    case 'attachmentMissing':
      return t('bk.attachmentMissing', v);
  }
}

/** Nombre maximal de problèmes détaillés dans un message. */
const SHOWN = 5;

/** Sauvegarde refusée : au moins un problème bloquant. Aucune donnée n'a été modifiée. */
export class BackupValidationError extends ValidationError {
  readonly issues: BackupIssue[];
  constructor(issues: BackupIssue[]) {
    const errors = issues.filter((i) => i.severity === 'error');
    const lines = errors.slice(0, SHOWN).map(formatIssue);
    if (errors.length > SHOWN) lines.push(t('bk.more', { count: errors.length - SHOWN }));
    super([t('bk.rejected', { count: errors.length }), ...lines].join('\n'));
    this.name = 'BackupValidationError';
    this.issues = issues;
  }
}

/** La sauvegarde de sécurité de l'état actuel n'a pas pu être produite ou relue. */
export class SafetyBackupError extends ValidationError {
  constructor(public readonly reason: string) {
    super(t('bk.safetyFailed'));
    this.name = 'SafetyBackupError';
  }
}

/** Le contrôle effectué après écriture a échoué : la transaction est annulée. */
export class RestoreVerificationError extends ValidationError {
  constructor(public readonly table: string, public readonly expected: number, public readonly actual: number) {
    super(t('bk.verifyFailed'));
    this.name = 'RestoreVerificationError';
  }
}
