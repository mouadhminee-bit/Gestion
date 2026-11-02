/**
 * Validation stricte d'une sauvegarde AU FORMAT COURANT (après `migrateBackup`).
 *
 * Fonction pure, sans aucune écriture : elle est exécutée intégralement avant toute
 * suppression. Deux niveaux :
 *  - `structure` : enveloppe, tables (présentes, connues, tableaux), lignes (objets),
 *    identifiants (présents, uniques), une seule ligne de paramètres ;
 *  - `full` : `structure` + types des champs essentiels + relations + transferts +
 *    pièces jointes.
 */
import { isValidISODate } from '@/domain/dates';
import { isLang } from '@/i18n/languages';
import { BACKUP_TABLES, MAX_ATTACHMENT_BYTES, type BackupFile, type BackupTableName } from './format';
import type { BackupIssue } from './issues';
import { RELATIONS, SETTINGS_FIELDS, TABLE_FIELDS, type FieldSpec, type FieldType } from './schema';
import { base64DecodedSize } from './attachments';

/** Au-delà, la validation s'arrête (fichier manifestement inexploitable). */
const MAX_ISSUES = 500;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function checkType(type: FieldType, v: unknown): boolean {
  if (typeof type === 'object') return type.enum.includes(v as string | number);
  switch (type) {
    case 'id':
      return typeof v === 'string' && v.trim() !== '';
    case 'string':
      return typeof v === 'string';
    case 'money':
    case 'int':
      return Number.isSafeInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'bool':
      return typeof v === 'boolean';
    case 'date':
      return isValidISODate(v);
    case 'month':
      return typeof v === 'string' && MONTH_RE.test(v);
    case 'currency':
      return typeof v === 'string' && CURRENCY_RE.test(v);
    case 'timestamp':
      return typeof v === 'string' && !Number.isNaN(Date.parse(v));
    case 'stringArray':
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'numberArray':
      return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  }
}

function checkField(spec: FieldSpec, v: unknown): boolean {
  if (v === undefined) return spec.presence === 'optional' || spec.presence === 'optionalNullable';
  if (v === null) return spec.presence === 'nullable' || spec.presence === 'optionalNullable';
  return checkType(spec.type, v);
}

class Collector {
  readonly issues: BackupIssue[] = [];
  errors = 0;
  add(issue: BackupIssue) {
    if (issue.severity === 'error') this.errors++;
    if (this.issues.length < MAX_ISSUES) this.issues.push(issue);
  }
  get full() {
    return this.issues.length >= MAX_ISSUES;
  }
}

export function validateBackup(file: BackupFile, mode: 'structure' | 'full' = 'full'): BackupIssue[] {
  const c = new Collector();
  const err = (i: Omit<BackupIssue, 'severity'>) => c.add({ severity: 'error', ...i });
  const warn = (i: Omit<BackupIssue, 'severity'>) => c.add({ severity: 'warning', ...i });

  if (!isObject(file.data)) {
    err({ code: 'badData' });
    return c.issues;
  }
  const data = file.data;
  for (const key of Object.keys(data)) if (!(BACKUP_TABLES as readonly string[]).includes(key)) err({ code: 'unknownTable', table: key });

  // --- Structure : tables, lignes, identifiants -----------------------------------------
  const rows = {} as Record<BackupTableName, Record<string, unknown>[]>;
  const ids = {} as Record<BackupTableName, Set<string>>;
  for (const table of BACKUP_TABLES) {
    ids[table] = new Set();
    rows[table] = [];
    if (!(table in data)) {
      err({ code: 'missingTable', table });
      continue;
    }
    const list = data[table];
    if (!Array.isArray(list)) {
      err({ code: 'notArray', table });
      continue;
    }
    list.forEach((r, index) => {
      const row = index + 1;
      if (!isObject(r)) return err({ code: 'badRow', table, row });
      rows[table].push(r);
      if (table === 'settings') return; // identifiant réécrit (= utilisateur courant)
      if (typeof r.id !== 'string' || r.id.trim() === '') return err({ code: 'missingId', table, row });
      if (ids[table].has(r.id)) err({ code: 'duplicateId', table, row, id: r.id });
      ids[table].add(r.id);
    });
  }
  if (Array.isArray(data.settings) && data.settings.length !== 1) err({ code: 'settingsCount', table: 'settings', value: String(data.settings.length) });
  if (mode === 'structure' || c.full) return c.issues;

  // --- Champs essentiels -----------------------------------------------------------------
  for (const table of BACKUP_TABLES) {
    const specs = table === 'settings' ? SETTINGS_FIELDS : TABLE_FIELDS[table];
    rows[table].forEach((r, index) => {
      for (const [field, spec] of Object.entries(specs)) {
        if (!checkField(spec, r[field])) err({ code: 'badField', table, row: index + 1, id: r.id as string | undefined, field });
      }
    });
    if (c.full) return c.issues;
  }
  const settings = rows.settings[0];
  if (settings && typeof settings.language === 'string' && !isLang(settings.language)) err({ code: 'badField', table: 'settings', field: 'language' });
  if (settings && typeof settings.locale === 'string' && !settings.locale.trim()) err({ code: 'badField', table: 'settings', field: 'locale' });

  // Échéances : identifiant déterministe `<ruleId>:<dueDate>` (clé serveur rule_id + due_date).
  rows.occurrences.forEach((o, index) => {
    if (typeof o.ruleId === 'string' && typeof o.dueDate === 'string' && o.id !== `${o.ruleId}:${o.dueDate}`) err({ code: 'badField', table: 'occurrences', row: index + 1, id: o.id as string, field: 'id' });
  });

  // Taux : strictement positif.
  rows.rates.forEach((r, index) => {
    if (typeof r.rate === 'number' && !(r.rate > 0)) err({ code: 'badField', table: 'rates', row: index + 1, id: r.id as string, field: 'rate' });
  });

  // Pièces jointes : contenu base64 cohérent avec la taille déclarée.
  const unavailable = new Set<string>();
  rows.attachments.forEach((a, index) => {
    const at = { table: 'attachments', row: index + 1, id: a.id as string };
    if (Number.isSafeInteger(a.size) && ((a.size as number) < 0 || (a.size as number) > MAX_ATTACHMENT_BYTES)) err({ ...at, code: 'badField', field: 'size' });
    if (a.data === null) {
      unavailable.add(a.id as string);
      warn({ ...at, code: 'attachmentMissing' });
    } else if (typeof a.data === 'string') {
      const decoded = base64DecodedSize(a.data);
      if (decoded === null || decoded !== a.size) err({ ...at, code: 'badField', field: 'data' });
    }
  });

  // --- Transferts : deux jambes, comptes renseignés --------------------------------------
  const legs = new Map<string, number>();
  rows.transactions.forEach((t, index) => {
    if (t.type !== 'transfer') return;
    const at = { table: 'transactions', row: index + 1, id: t.id as string };
    if (typeof t.transferId !== 'string') return err({ ...at, code: 'badField', field: 'transferId' });
    if (typeof t.counterpartAccountId !== 'string') err({ ...at, code: 'badField', field: 'counterpartAccountId' });
    legs.set(t.transferId, (legs.get(t.transferId) ?? 0) + 1);
  });
  for (const [transferId, n] of legs) if (n !== 2) err({ code: 'transferPair', table: 'transactions', id: transferId, value: String(n) });

  // --- Relations -------------------------------------------------------------------------
  for (const r of RELATIONS) {
    rows[r.table].forEach((row, index) => {
      const ref = row[r.field];
      if (ref === undefined || ref === null || typeof ref !== 'string') return;
      // Pièce jointe déclarée mais sans contenu : déjà signalée (attachmentMissing).
      if (ids[r.target].has(ref)) return;
      c.add({ severity: r.severity, code: 'orphan', table: r.table, row: index + 1, id: row.id as string | undefined, field: r.field, ref });
    });
    if (c.full) break;
  }
  return c.issues;
}

export const hasBlockingIssues = (issues: BackupIssue[]) => issues.some((i) => i.severity === 'error');
