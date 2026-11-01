/**
 * Correspondance TypeScript ↔ PostgreSQL (Lot 4, étape 4.2).
 *
 * Source unique de la conversion entre les lignes du domaine (tables Dexie, camelCase) et
 * les lignes du schéma Supabase (`supabase/migrations/`, snake_case). Aucune règle métier,
 * aucun calcul : seulement des noms, des types de représentation et des clés.
 *
 * Indépendant de React, de Dexie et de Supabase ; aucune dépendance externe.
 *
 * Principes :
 *  - liste blanche stricte : toute table, tout champ ou toute colonne non décrits ici sont
 *    REFUSÉS (`MappingError`) — y compris un champ dont la valeur est `undefined` ;
 *  - les métadonnées serveur (`version`, `sync_txid`, `server_updated_at`, `deleted_at`)
 *    ne sont jamais écrites par le client : leur présence dans une ligne à écrire est
 *    refusée ; à la lecture, elles sont séparées de la ligne métier (`ServerMetadata`) ;
 *  - les valeurs ne sont jamais arrondies ni converties en chaînes : un montant `bigint`
 *    reste un entier sûr JavaScript, un taux `double precision` reste le même nombre ;
 *  - `meta` (version du schéma local) n'existe pas côté serveur : table exclue ;
 *  - les fichiers joints (`attachments.blob`) ne quittent jamais l'appareil.
 *
 * Les contraintes métier (CHECK : énumérations, montants > 0…) restent de la
 * responsabilité de `RepositoryCore` et du schéma ; le mapping ne contrôle que ce que le
 * type SQL de la colonne impose (format d'un UUID, d'une date, entier sûr, nombre fini…).
 */
import type { Key } from '../storage';
import type { TableName, TableRows } from '../tables';
import { isValidISODate } from '@/domain/dates';

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

export type MappingErrorCode =
  | 'unknown_table' // table absente du mapping
  | 'excluded_table' // table locale sans équivalent serveur (`meta`)
  | 'unknown_column' // champ TS ou colonne SQL non décrits
  | 'forbidden_column' // métadonnée serveur fournie par le client
  | 'missing_column' // champ obligatoire absent / colonne absente de la réponse
  | 'invalid_value' // valeur incompatible avec le type de la colonne
  | 'key_mismatch' // clé dérivée incohérente (paramètres, échéances)
  | 'owner_mismatch'; // ligne attribuée à un autre utilisateur

export class MappingError extends Error {
  constructor(
    public readonly code: MappingErrorCode,
    public readonly table: string,
    public readonly field: string | null,
    detail: string,
  ) {
    super(`Mapping ${table}${field ? `.${field}` : ''} : ${detail}`);
    this.name = 'MappingError';
  }
}

// ---------------------------------------------------------------------------
// Description des colonnes
// ---------------------------------------------------------------------------

/** Type SQL de la colonne (tel que déclaré dans les migrations). */
export type SqlType =
  | 'uuid'
  | 'text'
  | 'boolean'
  | 'bigint' // montants : entier sûr JavaScript (|x| ≤ 2^53 − 1)
  | 'integer'
  | 'smallint'
  | 'double precision' // taux : nombre JavaScript fini, transmis tel quel
  | 'double precision[]'
  | 'text[]'
  | 'date' // AAAA-MM-JJ
  | 'char(7)' // mois AAAA-MM
  | 'timestamptz';

/**
 * Présence du champ côté TypeScript, et représentation d'un `NULL` SQL à la lecture :
 *  - `required`         : `T`             — colonne `NOT NULL`
 *  - `nullable`         : `T | null`      — `NULL` ↔ `null`
 *  - `optional`         : `T?`            — `NULL` ↔ champ absent
 *  - `optionalNullable` : `T? | null`     — `NULL` ↔ `null` (à la lecture)
 * À l'écriture, `null` et `undefined` sont acceptés pour les trois dernières (même sens).
 */
export type Presence = 'required' | 'nullable' | 'optional' | 'optionalNullable';

export interface ColumnSpec {
  readonly kind: 'column';
  readonly column: string;
  readonly type: SqlType;
  readonly presence: Presence;
  /** `false` : colonne lue mais jamais écrite par le client (ex. `profiles.created_at`). */
  readonly writable: boolean;
}

/** Champ propre à l'appareil, jamais transmis ni reçu (ex. fichier joint). */
export interface LocalFieldSpec {
  readonly kind: 'local';
  readonly reason: string;
}

/** Champ recalculé à partir d'autres champs (clé dérivée) ; vérifié à l'écriture. */
export interface DerivedFieldSpec {
  readonly kind: 'derived';
  readonly reason: string;
}

export type FieldSpec = ColumnSpec | LocalFieldSpec | DerivedFieldSpec;

/** Tables synchronisées : toutes sauf `meta`. */
export type CloudTableName = Exclude<TableName, 'meta'>;

/** Champs locaux retirés des lignes cloud. */
interface LocalFields {
  users: 'email';
  attachments: 'blob';
}
type LocalFieldOf<N> = N extends keyof LocalFields ? LocalFields[N] : never;

/** Ligne métier telle qu'elle existe côté serveur (sans les champs locaux). */
export type CloudRow<N extends CloudTableName> = Omit<TableRows[N], LocalFieldOf<N>>;

export interface TableSpec<N extends CloudTableName> {
  readonly sqlTable: string;
  /** Colonnes de la clé primaire SQL. */
  readonly sqlKey: readonly string[];
  /**
   * `upsert` : insertion ou mise à jour ; `update-only` : la ligne est créée par le serveur
   * (déclencheur d'inscription) et le client ne peut modifier que les colonnes `writable`.
   */
  readonly write: 'upsert' | 'update-only';
  /** Un descripteur pour CHAQUE champ du type TS (vérifié à la compilation). */
  readonly fields: { readonly [K in keyof TableRows[N]]-?: FieldSpec };
}

const col = (column: string, type: SqlType, presence: Presence = 'required', writable = true): ColumnSpec => ({ kind: 'column', column, type, presence, writable });
const local = (reason: string): LocalFieldSpec => ({ kind: 'local', reason });
const derived = (reason: string): DerivedFieldSpec => ({ kind: 'derived', reason });

const id = col('id', 'uuid');
const userId = col('user_id', 'uuid');
const createdAt = col('created_at', 'timestamptz');
const updatedAt = col('updated_at', 'timestamptz');
const entity = { id, userId, createdAt, updatedAt } as const;

/** Métadonnées gérées exclusivement par PostgreSQL (déclencheur `tg_sync_metadata`). */
export const SERVER_METADATA_COLUMNS = ['version', 'sync_txid', 'server_updated_at', 'deleted_at'] as const;
/** Mêmes métadonnées sous leur forme camelCase : refusées aussi dans une ligne TS. */
const SERVER_METADATA_FIELDS = ['version', 'syncTxid', 'serverUpdatedAt', 'deletedAt'] as const;

// ---------------------------------------------------------------------------
// Matrice des 18 tables
// ---------------------------------------------------------------------------

export const MAPPING: { readonly [N in CloudTableName]: TableSpec<N> } = {
  users: {
    sqlTable: 'profiles',
    sqlKey: ['id'],
    write: 'update-only', // créée par `handle_new_user` ; `authenticated` : UPDATE (display_name) seulement
    fields: {
      id,
      displayName: col('display_name', 'text'),
      email: local('non stocké dans profiles : l’adresse fait foi dans auth.users (Supabase Auth)'),
      createdAt: col('created_at', 'timestamptz', 'required', false), // date d'inscription, fixée par le serveur
    },
  },
  settings: {
    sqlTable: 'user_settings',
    sqlKey: ['user_id'],
    write: 'upsert',
    fields: {
      id: derived('= userId (une ligne de paramètres par utilisateur, clé user_id)'),
      userId,
      displayName: col('display_name', 'text'),
      baseCurrency: col('base_currency', 'text'),
      language: col('language', 'text'),
      locale: col('locale', 'text'),
      timeZone: col('time_zone', 'text'),
      dateFormat: col('date_format', 'text'),
      weekStartsOn: col('week_starts_on', 'smallint'),
      theme: col('theme', 'text'),
      currencyDisplay: col('currency_display', 'text'),
      privacyMode: col('privacy_mode', 'boolean'),
      budgetAlertThresholds: col('budget_alert_thresholds', 'double precision[]'),
      notifyBudgets: col('notify_budgets', 'boolean'),
      notifyBills: col('notify_bills', 'boolean'),
      notifyDebts: col('notify_debts', 'boolean'),
      billReminderDays: col('bill_reminder_days', 'double precision'),
      onboarded: col('onboarded', 'boolean'),
      demoMode: col('demo_mode', 'boolean'),
      updatedAt,
    },
  },
  accounts: {
    sqlTable: 'accounts',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      ...entity,
      name: col('name', 'text'),
      type: col('type', 'text'),
      currency: col('currency', 'text'),
      initialBalance: col('initial_balance', 'bigint'),
      initialBalanceDate: col('initial_balance_date', 'date'),
      archived: col('archived', 'boolean'),
      includeInTotal: col('include_in_total', 'boolean'),
      color: col('color', 'text'),
      description: col('description', 'text', 'optional'),
      order: col('sort_order', 'integer'), // `order` : mot réservé SQL
    },
  },
  categories: {
    sqlTable: 'categories',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      ...entity,
      name: col('name', 'text'),
      kind: col('kind', 'text'),
      nature: col('nature', 'text', 'optional'),
      parentId: col('parent_id', 'uuid', 'nullable'),
      icon: col('icon', 'text'),
      color: col('color', 'text'),
      archived: col('archived', 'boolean'),
      order: col('sort_order', 'integer'),
      key: col('key', 'text', 'optional'),
    },
  },
  transactions: {
    sqlTable: 'transactions',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      ...entity,
      type: col('type', 'text'),
      direction: col('direction', 'text'),
      amount: col('amount', 'bigint'),
      currency: col('currency', 'text'),
      label: col('label', 'text'),
      date: col('date', 'date'),
      categoryId: col('category_id', 'uuid', 'nullable'),
      subcategoryId: col('subcategory_id', 'uuid', 'nullable'),
      accountId: col('account_id', 'uuid'),
      paymentMethod: col('payment_method', 'text', 'optional'),
      payee: col('payee', 'text', 'optional'),
      notes: col('notes', 'text', 'optional'),
      tags: col('tags', 'text[]'),
      attachmentId: col('attachment_id', 'uuid', 'optional'),
      status: col('status', 'text'),
      transferId: col('transfer_id', 'uuid', 'optional'),
      counterpartAccountId: col('counterpart_account_id', 'uuid', 'optional'),
      refundOfId: col('refund_of_id', 'uuid', 'optional'),
      debtId: col('debt_id', 'uuid', 'optional'),
      debtPaymentId: col('debt_payment_id', 'uuid', 'optional'),
      interestAmount: col('interest_amount', 'bigint', 'optional'),
      recurringRuleId: col('recurring_rule_id', 'uuid', 'optional'),
      recurringDueDate: col('recurring_due_date', 'date', 'optional'),
      importBatchId: col('import_batch_id', 'uuid', 'optional'),
    },
  },
  attachments: {
    sqlTable: 'attachments',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      id,
      userId,
      name: col('name', 'text'),
      mimeType: col('mime_type', 'text'),
      size: col('size', 'integer'),
      blob: local('fichier binaire : jamais transmis dans un ChangeSet (Storage : Lot 7)'),
      createdAt,
    },
  },
  importBatches: {
    sqlTable: 'import_batches',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      id,
      userId,
      fileName: col('file_name', 'text'),
      createdAt,
      rowCount: col('row_count', 'integer'),
      importedCount: col('imported_count', 'integer'),
      skippedCount: col('skipped_count', 'integer'),
      accountId: col('account_id', 'uuid'),
    },
  },
  budgets: {
    sqlTable: 'budgets',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      ...entity,
      month: col('month', 'char(7)'),
      categoryId: col('category_id', 'uuid', 'nullable'),
      amount: col('amount', 'bigint'),
      currency: col('currency', 'text'),
      alertThresholds: col('alert_thresholds', 'double precision[]', 'optional'),
    },
  },
  goals: {
    sqlTable: 'savings_goals',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      ...entity,
      name: col('name', 'text'),
      description: col('description', 'text', 'optional'),
      targetAmount: col('target_amount', 'bigint'),
      currency: col('currency', 'text'),
      savedAmount: col('saved_amount', 'bigint'),
      targetDate: col('target_date', 'date', 'optional'),
      priority: col('priority', 'text'),
      linkedAccountId: col('linked_account_id', 'uuid', 'optional'),
      trackLinkedAccount: col('track_linked_account', 'boolean'),
      monthlyContribution: col('monthly_contribution', 'bigint', 'optional'),
      status: col('status', 'text'),
      icon: col('icon', 'text'),
      color: col('color', 'text'),
    },
  },
  goalContributions: {
    sqlTable: 'goal_contributions',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      id,
      userId,
      goalId: col('goal_id', 'uuid'),
      date: col('date', 'date'),
      amount: col('amount', 'bigint'),
      note: col('note', 'text', 'optional'),
      createdAt,
    },
  },
  recurringRules: {
    sqlTable: 'recurring_rules',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      ...entity,
      kind: col('kind', 'text'),
      label: col('label', 'text'),
      amount: col('amount', 'bigint'),
      currency: col('currency', 'text'),
      accountId: col('account_id', 'uuid'),
      categoryId: col('category_id', 'uuid', 'nullable'),
      subcategoryId: col('subcategory_id', 'uuid', 'optionalNullable'),
      payee: col('payee', 'text', 'optional'),
      frequency: col('frequency', 'text'),
      customInterval: col('custom_interval', 'double precision', 'optional'),
      customUnit: col('custom_unit', 'text', 'optional'),
      startDate: col('start_date', 'date'),
      endDate: col('end_date', 'date', 'optional'),
      active: col('active', 'boolean'),
      notes: col('notes', 'text', 'optional'),
    },
  },
  occurrences: {
    sqlTable: 'recurring_occurrences',
    sqlKey: ['rule_id', 'due_date'],
    write: 'upsert',
    fields: {
      id: derived('= "<ruleId>:<dueDate>" (clé primaire SQL : rule_id, due_date)'),
      userId,
      ruleId: col('rule_id', 'uuid'),
      dueDate: col('due_date', 'date'),
      status: col('status', 'text'),
      transactionId: col('transaction_id', 'uuid', 'optional'),
      closure: col('closure', 'text', 'optional'),
      updatedAt,
    },
  },
  debts: {
    sqlTable: 'debts',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      ...entity,
      label: col('label', 'text'),
      type: col('type', 'text'),
      direction: col('direction', 'text'),
      principal: col('principal', 'bigint'),
      currency: col('currency', 'text'),
      startDate: col('start_date', 'date'),
      dueDate: col('due_date', 'date', 'optional'),
      counterparty: col('counterparty', 'text', 'optional'),
      interestRate: col('interest_rate', 'double precision', 'optional'),
      installmentAmount: col('installment_amount', 'bigint', 'optional'),
      installmentFrequency: col('installment_frequency', 'text', 'optional'),
      status: col('status', 'text'),
      notes: col('notes', 'text', 'optional'),
      originTransactionId: col('origin_transaction_id', 'uuid', 'optional'),
    },
  },
  debtPayments: {
    sqlTable: 'debt_payments',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      id,
      userId,
      debtId: col('debt_id', 'uuid'),
      date: col('date', 'date'),
      principal: col('principal', 'bigint'),
      interest: col('interest', 'bigint'),
      accountId: col('account_id', 'uuid', 'optional'),
      transactionId: col('transaction_id', 'uuid', 'optional'),
      note: col('note', 'text', 'optional'),
      createdAt,
    },
  },
  assets: {
    sqlTable: 'assets',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      ...entity,
      name: col('name', 'text'),
      type: col('type', 'text'),
      currency: col('currency', 'text'),
      linkedAccountId: col('linked_account_id', 'uuid', 'optional'),
      archived: col('archived', 'boolean'),
      notes: col('notes', 'text', 'optional'),
    },
  },
  valuations: {
    sqlTable: 'asset_valuations',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      id,
      userId,
      assetId: col('asset_id', 'uuid'),
      date: col('date', 'date'),
      value: col('value', 'bigint'),
      source: col('source', 'text'),
      note: col('note', 'text', 'optional'),
      createdAt,
    },
  },
  rates: {
    sqlTable: 'exchange_rates',
    sqlKey: ['id'],
    write: 'upsert',
    fields: {
      id,
      userId,
      base: col('base', 'text'),
      quote: col('quote', 'text'),
      rate: col('rate', 'double precision'),
      date: col('date', 'date'),
      source: col('source', 'text'),
      createdAt,
    },
  },
  notificationStates: {
    sqlTable: 'notification_states',
    sqlKey: ['user_id', 'id'],
    write: 'upsert',
    fields: {
      id: col('id', 'text'), // clé textuelle déterministe (ex. budget:<catId>:2026-10:90)
      userId,
      read: col('read', 'boolean'),
      dismissed: col('dismissed', 'boolean'),
      updatedAt,
    },
  },
};

export const CLOUD_TABLES = Object.keys(MAPPING) as CloudTableName[];
/** Tables locales sans équivalent serveur, et pourquoi. */
export const EXCLUDED_TABLES: Readonly<Partial<Record<TableName, string>>> = {
  meta: 'version du schéma IndexedDB local ; le schéma serveur est versionné par les migrations',
};

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Refuse toute table non synchronisée (`meta`) ou inconnue. */
export function assertCloudTable(table: string): asserts table is CloudTableName {
  if (Object.prototype.hasOwnProperty.call(EXCLUDED_TABLES, table)) throw new MappingError('excluded_table', table, null, `table locale sans équivalent serveur (${EXCLUDED_TABLES[table as TableName]})`);
  if (!Object.prototype.hasOwnProperty.call(MAPPING, table)) throw new MappingError('unknown_table', table, null, 'table inconnue du mapping');
}

/** Nom de la table PostgreSQL d'une table TS synchronisée. */
export function sqlTableOf(table: string): string {
  assertCloudTable(table);
  return MAPPING[table].sqlTable;
}

/** Table TS correspondant à une table PostgreSQL. */
export function tableOfSql(sqlTable: string): CloudTableName {
  const found = CLOUD_TABLES.find((t) => MAPPING[t].sqlTable === sqlTable);
  if (!found) throw new MappingError('unknown_table', sqlTable, null, 'table PostgreSQL inconnue du mapping');
  return found;
}

type AnySpec = { sqlTable: string; sqlKey: readonly string[]; write: 'upsert' | 'update-only'; fields: Record<string, FieldSpec> };
const specOf = (table: CloudTableName) => MAPPING[table] as unknown as AnySpec;
const columnsOf = (table: CloudTableName) => Object.entries(specOf(table).fields).filter((e): e is [string, ColumnSpec] => e[1].kind === 'column');

/** Colonnes SQL métier d'une table (hors métadonnées serveur), dans l'ordre du mapping. */
export function sqlColumnsOf(table: CloudTableName): string[] {
  return columnsOf(table).map(([, c]) => c.column);
}

// ---------------------------------------------------------------------------
// Valeurs
// ---------------------------------------------------------------------------

/** Valeur transmissible (JSON) vers ou depuis PostgreSQL. */
export type SqlValue = string | number | boolean | null | readonly string[] | readonly number[];
export type SqlRow = Record<string, SqlValue>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH_RE = /^\d{4}-\d{2}$/; // identique au CHECK de budgets.month
/** Horodatage ISO 8601 avec fuseau EXPLICITE (Z, ±HH, ±HHMM, ±HH:MM) ; séparateur T ou espace. */
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;
const INT32 = 2 ** 31;
const INT16 = 2 ** 15;

function fail(code: MappingErrorCode, table: string, field: string | null, detail: string): never {
  throw new MappingError(code, table, field, detail);
}

const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'tableau' : typeof v === 'object' ? (v as object).constructor?.name ?? 'objet' : `${typeof v} ${String(v).slice(0, 40)}`);

/**
 * Horodatage → forme canonique `toISOString()` (UTC, `Z`, millisecondes).
 * Même instant ; refusé si l'heure n'a pas de fuseau (ambigu) ou si des chiffres au-delà
 * de la milliseconde seraient perdus (le client n'en produit jamais).
 */
function canonicalTimestamp(v: unknown, table: string, field: string): string {
  if (typeof v !== 'string') fail('invalid_value', table, field, `horodatage attendu, reçu ${describe(v)}`);
  const m = TIMESTAMP_RE.exec(v);
  if (!m || !isValidISODate(m[1])) fail('invalid_value', table, field, `horodatage ISO 8601 avec fuseau attendu, reçu « ${v} »`);
  const fraction = m[3] ?? '';
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) fail('invalid_value', table, field, `précision inférieure à la milliseconde non représentable : « ${v} »`);
  let offset = m[4];
  if (offset !== 'Z' && offset.length === 3) offset += ':00'; // ±HH → ±HH:00
  else if (offset !== 'Z' && !offset.includes(':')) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
  const ms = new Date(`${m[1]}T${time}.${(fraction + '000').slice(0, 3)}${offset}`).getTime();
  if (!Number.isFinite(ms)) fail('invalid_value', table, field, `horodatage invalide : « ${v} »`);
  const iso = new Date(ms).toISOString();
  if (!/^\d{4}-/.test(iso)) fail('invalid_value', table, field, `année hors plage : « ${v} »`);
  return iso;
}

/** Entier sûr ; accepte, à la lecture seulement, une chaîne décimale (bigint transmis en texte). */
function integerValue(v: unknown, table: string, field: string, bound: number | null, allowString: boolean): number {
  let n = v;
  if (allowString && typeof v === 'string' && /^-?\d+$/.test(v)) n = Number(v);
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) fail('invalid_value', table, field, `entier sûr attendu (|x| ≤ 2^53 − 1), reçu ${describe(v)}`);
  if (bound !== null && (n < -bound || n >= bound)) fail('invalid_value', table, field, `entier hors plage [${-bound}, ${bound - 1}] : ${n}`);
  if (allowString && typeof v === 'string' && String(n) !== v.replace(/^(-?)0+(?=\d)/, '$1')) fail('invalid_value', table, field, `entier non représentable exactement : ${v}`);
  return n as number;
}

function textValue(v: unknown, table: string, field: string): string {
  if (typeof v !== 'string') fail('invalid_value', table, field, `texte attendu, reçu ${describe(v)}`);
  if (v.includes('\u0000')) fail('invalid_value', table, field, 'caractère NUL refusé par PostgreSQL');
  return v;
}

function doubleValue(v: unknown, table: string, field: string): number {
  // NaN / ±Infinity : non transmissibles en JSON (deviendraient `null` sans erreur).
  if (typeof v !== 'number' || !Number.isFinite(v)) fail('invalid_value', table, field, `nombre fini attendu, reçu ${describe(v)}`);
  return v;
}

/** Convertit une valeur non nulle selon le type SQL ; `read` = sens PostgreSQL → TS. */
function convert(type: SqlType, v: unknown, table: string, field: string, read: boolean): SqlValue {
  switch (type) {
    case 'uuid':
      if (typeof v !== 'string' || !UUID_RE.test(v)) fail('invalid_value', table, field, `UUID canonique (minuscules) attendu, reçu ${describe(v)}`);
      return v;
    case 'text':
      return textValue(v, table, field);
    case 'boolean':
      if (typeof v !== 'boolean') fail('invalid_value', table, field, `booléen attendu, reçu ${describe(v)}`);
      return v;
    case 'bigint':
      return integerValue(v, table, field, null, read);
    case 'integer':
      return integerValue(v, table, field, INT32, read);
    case 'smallint':
      return integerValue(v, table, field, INT16, read);
    case 'double precision':
      return doubleValue(v, table, field);
    case 'double precision[]':
      if (!Array.isArray(v)) fail('invalid_value', table, field, `tableau de nombres attendu, reçu ${describe(v)}`);
      return v.map((x, i) => doubleValue(x, table, `${field}[${i}]`));
    case 'text[]':
      if (!Array.isArray(v)) fail('invalid_value', table, field, `tableau de textes attendu, reçu ${describe(v)}`);
      return v.map((x, i) => textValue(x, table, `${field}[${i}]`));
    case 'date':
      if (!isValidISODate(v)) fail('invalid_value', table, field, `date AAAA-MM-JJ attendue, reçu ${describe(v)}`);
      return v;
    case 'char(7)':
      if (typeof v !== 'string' || !MONTH_RE.test(v)) fail('invalid_value', table, field, `mois AAAA-MM attendu, reçu ${describe(v)}`);
      return v;
    case 'timestamptz':
      return canonicalTimestamp(v, table, field);
  }
}

// ---------------------------------------------------------------------------
// Clés particulières
// ---------------------------------------------------------------------------

/** Identifiant TS d'une échéance : `<ruleId>:<dueDate>` (même format que `occurrenceId`). */
export function occurrenceKey(ruleId: string, dueDate: string): string {
  return `${ruleId}:${dueDate}`;
}

/** Décompose `<ruleId>:<dueDate>` ; sans ambiguïté (un UUID ne contient pas « : »). */
export function parseOccurrenceKey(key: unknown): { ruleId: string; dueDate: string } {
  const parts = typeof key === 'string' ? key.split(':') : [];
  if (parts.length !== 2 || !UUID_RE.test(parts[0]) || !isValidISODate(parts[1])) fail('key_mismatch', 'occurrences', 'id', `clé « <ruleId>:<AAAA-MM-JJ> » attendue, reçu ${describe(key)}`);
  return { ruleId: parts[0], dueDate: parts[1] };
}

/** Valeurs des champs dérivés, calculées depuis la ligne TS. */
const DERIVED: { readonly [table: string]: { readonly [field: string]: (row: Record<string, unknown>) => unknown } } = {
  settings: { id: (r) => r.userId },
  occurrences: { id: (r) => occurrenceKey(r.ruleId as string, r.dueDate as string) },
};

/** Clé TS (`PRIMARY_KEYS`) → colonnes de la clé primaire SQL. */
export function toSqlKey(table: string, key: Key): SqlRow {
  assertCloudTable(table);
  switch (table) {
    case 'settings':
      return { user_id: convert('uuid', key, table, 'id', false) };
    case 'occurrences': {
      const { ruleId, dueDate } = parseOccurrenceKey(key);
      return { rule_id: ruleId, due_date: dueDate };
    }
    case 'notificationStates': {
      if (!Array.isArray(key) || key.length !== 2) fail('key_mismatch', table, null, `clé [userId, id] attendue, reçu ${describe(key)}`);
      return { user_id: convert('uuid', key[0], table, 'userId', false), id: convert('text', key[1], table, 'id', false) };
    }
    default:
      return { id: convert('uuid', key, table, 'id', false) };
  }
}

/** Colonnes de la clé primaire SQL → clé TS (`PRIMARY_KEYS`). */
export function fromSqlKey(table: string, sqlKey: Readonly<Record<string, unknown>>): Key {
  assertCloudTable(table);
  const expected = specOf(table).sqlKey;
  const keys = Object.keys(sqlKey);
  if (keys.length !== expected.length || !expected.every((k) => keys.includes(k))) fail('key_mismatch', table, null, `clé SQL (${expected.join(', ')}) attendue, reçu (${keys.join(', ')})`);
  switch (table) {
    case 'settings':
      return convert('uuid', sqlKey.user_id, table, 'user_id', true) as string;
    case 'occurrences':
      return occurrenceKey(convert('uuid', sqlKey.rule_id, table, 'rule_id', true) as string, convert('date', sqlKey.due_date, table, 'due_date', true) as string);
    case 'notificationStates':
      return [convert('uuid', sqlKey.user_id, table, 'user_id', true) as string, convert('text', sqlKey.id, table, 'id', true) as string];
    default:
      return convert('uuid', sqlKey.id, table, 'id', true) as string;
  }
}

// ---------------------------------------------------------------------------
// Validation des champs
// ---------------------------------------------------------------------------

/** Refuse toute métadonnée serveur (snake_case ou camelCase) dans une ligne à écrire. */
export function assertNoServerMetadata(table: string, row: Readonly<Record<string, unknown>>): void {
  for (const k of Object.keys(row)) {
    if ((SERVER_METADATA_COLUMNS as readonly string[]).includes(k) || (SERVER_METADATA_FIELDS as readonly string[]).includes(k)) fail('forbidden_column', table, k, 'métadonnée gérée exclusivement par le serveur');
  }
}

/** Refuse tout champ TS non décrit pour la table (y compris de valeur `undefined`). */
export function assertKnownFields(table: CloudTableName, row: Readonly<Record<string, unknown>>): void {
  assertNoServerMetadata(table, row);
  const fields = specOf(table).fields;
  for (const k of Object.keys(row)) if (!Object.prototype.hasOwnProperty.call(fields, k)) fail('unknown_column', table, k, 'champ inconnu du mapping');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// TypeScript → PostgreSQL
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  /** Si fourni : la ligne doit appartenir à cet utilisateur (sinon `owner_mismatch`). */
  userId?: string;
}

export interface SerializedRow {
  readonly sqlTable: string;
  readonly write: 'upsert' | 'update-only';
  /** Colonnes de la clé primaire SQL. */
  readonly key: SqlRow;
  /**
   * Clé + colonnes écrites par le client. Toutes les colonnes `writable` y figurent
   * (valeur `null` pour un champ absent) : la ligne représente l'état final complet.
   */
  readonly values: SqlRow;
}

/** Propriétaire déclaré d'une ligne TS. */
function ownerOf(table: CloudTableName, row: Record<string, unknown>): unknown {
  return table === 'users' ? row.id : row.userId;
}

/**
 * Valide et convertit une ligne TS en ligne PostgreSQL. Les champs locaux (`blob`, `email`)
 * sont retirés ; les métadonnées serveur et les champs inconnus sont refusés ; les champs
 * dérivés doivent être cohérents.
 */
export function serializeRow(table: string, row: unknown, options: SerializeOptions = {}): SerializedRow {
  assertCloudTable(table);
  if (!isObject(row)) fail('invalid_value', table, null, `ligne attendue, reçu ${describe(row)}`);
  assertKnownFields(table, row);
  const spec = specOf(table);
  const values: Record<string, SqlValue> = {};
  for (const [field, f] of Object.entries(spec.fields)) {
    if (f.kind !== 'column') continue;
    const v = row[field];
    let out: SqlValue;
    if (v === undefined || v === null) {
      if (f.presence === 'required') fail('missing_column', table, field, v === null ? 'valeur obligatoire (null refusé)' : 'champ obligatoire absent');
      out = null;
    } else out = convert(f.type, v, table, field, false);
    if (f.writable || spec.sqlKey.includes(f.column)) values[f.column] = out;
  }
  for (const [field, compute] of Object.entries(DERIVED[table] ?? {})) {
    if (row[field] !== compute(row)) fail('key_mismatch', table, field, `valeur dérivée attendue « ${String(compute(row))} », reçu ${describe(row[field])}`);
  }
  if (options.userId !== undefined && ownerOf(table, row) !== options.userId) fail('owner_mismatch', table, table === 'users' ? 'id' : 'userId', 'ligne attribuée à un autre utilisateur');
  const key: Record<string, SqlValue> = {};
  for (const k of spec.sqlKey) key[k] = values[k];
  return { sqlTable: spec.sqlTable, write: spec.write, key, values };
}

// ---------------------------------------------------------------------------
// PostgreSQL → TypeScript
// ---------------------------------------------------------------------------

/** Métadonnées serveur d'une ligne lue (jamais intégrées à la ligne métier). */
export interface ServerMetadata {
  /** Version de la ligne (+1 à chaque mise à jour, par déclencheur). */
  readonly version: number;
  /** Identifiant de transaction `xid8` (entier 64 bits) : conservé en texte, sans perte. */
  readonly syncTxid: string;
  /** Horodatage serveur, tel que renvoyé (opaque pour le client). */
  readonly serverUpdatedAt: string;
  /** Suppression logique (`null` = ligne active), telle que renvoyée. */
  readonly deletedAt: string | null;
}

export interface DeserializedRow<N extends CloudTableName> {
  readonly row: CloudRow<N>;
  readonly meta: ServerMetadata;
}

function rawTimestamp(v: unknown, table: string, field: string): string {
  canonicalTimestamp(String(v).replace(/(\.\d{3})\d+/, '$1'), table, field); // validation seulement
  return v as string;
}

/**
 * Valide et convertit une ligne PostgreSQL (toutes ses colonnes, métadonnées comprises)
 * en ligne TS. Toute colonne inconnue ou absente est refusée (dérive de schéma).
 */
export function deserializeRow<N extends CloudTableName>(table: N, sqlRow: unknown): DeserializedRow<N> {
  assertCloudTable(table);
  if (!isObject(sqlRow)) fail('invalid_value', table, null, `ligne attendue, reçu ${describe(sqlRow)}`);
  const spec = specOf(table);
  const known = new Set<string>([...SERVER_METADATA_COLUMNS, ...columnsOf(table).map(([, c]) => c.column)]);
  for (const k of Object.keys(sqlRow)) if (!known.has(k)) fail('unknown_column', table, k, 'colonne inconnue du mapping');
  for (const k of known) if (!Object.prototype.hasOwnProperty.call(sqlRow, k)) fail('missing_column', table, k, 'colonne absente de la ligne lue');

  const row: Record<string, unknown> = {};
  for (const [field, f] of columnsOf(table)) {
    const v = sqlRow[f.column];
    if (v === null) {
      if (f.presence === 'required') fail('invalid_value', table, f.column, 'NULL dans une colonne obligatoire');
      if (f.presence !== 'optional') row[field] = null;
      continue;
    }
    row[field] = convert(f.type, v, table, f.column, true);
  }
  for (const [field, compute] of Object.entries(DERIVED[table] ?? {})) row[field] = compute(row);
  // Ordre des champs : celui du mapping (stable, indépendant de la réponse).
  const ordered: Record<string, unknown> = {};
  for (const field of Object.keys(spec.fields)) if (field in row) ordered[field] = row[field];

  const deleted = sqlRow.deleted_at;
  const meta: ServerMetadata = {
    version: integerValue(sqlRow.version, table, 'version', null, true),
    syncTxid: (() => {
      const t = sqlRow.sync_txid;
      if (!((typeof t === 'string' && /^\d+$/.test(t)) || (typeof t === 'number' && Number.isSafeInteger(t) && t >= 0))) fail('invalid_value', table, 'sync_txid', `xid8 attendu, reçu ${describe(t)}`);
      return String(t);
    })(),
    serverUpdatedAt: rawTimestamp(sqlRow.server_updated_at, table, 'server_updated_at'),
    deletedAt: deleted === null ? null : rawTimestamp(deleted, table, 'deleted_at'),
  };
  return { row: ordered as CloudRow<N>, meta };
}

/** Retire les champs locaux d'une ligne TS (forme comparable à une ligne relue). */
export function toCloudRow<N extends CloudTableName>(table: N, row: TableRows[N]): CloudRow<N> {
  assertCloudTable(table);
  const out = { ...(row as unknown as Record<string, unknown>) };
  for (const [field, f] of Object.entries(specOf(table).fields)) if (f.kind === 'local') delete out[field];
  return out as CloudRow<N>;
}
