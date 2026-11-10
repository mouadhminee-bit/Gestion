/**
 * Decision Lab — stockage des simulations dans `sessionStorage` (durée de vie : l'onglet).
 *
 * Indépendance : une seule clé dédiée (`nexora.decisionLab`, plus une clé de quarantaine) ; ce module
 * n'importe ni la couche de données (`@/data`, Dexie) ni le repository et ne lit aucune autre clé :
 * il ne peut modifier ni transactions, ni budgets, ni objectifs, ni aucune donnée financière réelle.
 *
 * Format versionné : `{ formatVersion, simulations: DecisionSnapshot[] }`.
 *  - version inconnue plus récente : lecture vide, écriture REFUSÉE (ne jamais détruire les données
 *    d'une version plus récente de l'application) ;
 *  - version plus ancienne : migrée par `MIGRATIONS` (aucune en version 1).
 *
 * Fiabilité : aucune fonction ne lève d'exception. Stockage indisponible, quota dépassé, JSON
 * corrompu, entrées invalides : tout est renvoyé sous forme de résultat explicite (`issues`).
 * Les entrées invalides sont ignorées à la lecture ; avant la première réécriture qui les ferait
 * disparaître, le contenu brut est copié dans la clé de quarantaine.
 *
 * Snapshots immuables : pas d'API de mise à jour ; un identifiant déjà présent est refusé.
 * Limite : au plus `MAX_SIMULATIONS` (50). Lorsque la limite est atteinte, le NOUVEL enregistrement
 * est refusé (`limitReached`, avec la limite et le nombre actuel) : aucune simulation existante n'est
 * jamais supprimée automatiquement ; l'utilisateur doit en supprimer une explicitement. Liste triée
 * par date de création croissante, puis par identifiant.
 *
 * Durée de vie : celle de l'onglet (`sessionStorage`). Les simulations disparaissent à la fermeture
 * de l'onglet ; elles ne sont ni partagées entre onglets ni incluses dans les sauvegardes JSON.
 */
import { validateSnapshot, type DecisionSnapshot } from './snapshot';

export const DECISION_STORE_KEY = 'nexora.decisionLab';
export const DECISION_QUARANTINE_KEY = 'nexora.decisionLab.quarantine';
export const DECISION_STORE_FORMAT = 1;
export const MAX_SIMULATIONS = 50;

/** Sous-ensemble de `Storage` utilisé (injectable pour les tests). */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type StoreIssueCode =
  | 'storageUnavailable'
  | 'corruptedJson'
  | 'invalidEnvelope'
  | 'unsupportedVersion'
  | 'invalidSnapshot'
  | 'duplicateStoredId'
  | 'quotaExceeded'
  | 'writeFailed'
  | 'duplicateId'
  | 'notFound'
  /** Enregistrement refusé : la limite de simulations est atteinte (en supprimer une). */
  | 'limitReached'
  /** Lecture : le stockage contient plus de simulations que la limite (stockage altéré) ; toutes sont conservées. */
  | 'overLimit';

export interface StoreIssue {
  code: StoreIssueCode;
  /** Position de l'entrée fautive dans le stockage. */
  index?: number;
  id?: string;
  details?: string[];
  /** `limitReached` / `overLimit` : limite applicable et nombre de simulations enregistrées. */
  limit?: number;
  count?: number;
}

export interface LoadResult {
  /** Snapshots valides, gelés, du plus ancien au plus récent. */
  simulations: DecisionSnapshot[];
  issues: StoreIssue[];
  /** false : stockage indisponible ou version non prise en charge — toute écriture sera refusée. */
  writable: boolean;
}

export type SaveResult =
  | { ok: true; snapshot: DecisionSnapshot; count: number; issues: StoreIssue[] }
  | { ok: false; issue: StoreIssue };

export type RemoveResult = { ok: true; count: number } | { ok: false; issue: StoreIssue };

/** Migrations de format : clé = version source, valeur = transformation vers la version suivante. */
const MIGRATIONS: Record<number, (envelope: Record<string, unknown>) => Record<string, unknown>> = {};

function defaultStorage(): StorageLike | null {
  try {
    const s = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return s ?? null;
  } catch {
    return null; // accès refusé (navigation privée, politique de sécurité…)
  }
}

const byAge = (a: DecisionSnapshot, b: DecisionSnapshot) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface ReadState extends LoadResult {
  storage: StorageLike | null;
  raw: string | null;
}

function read(storage: StorageLike | null | undefined): ReadState {
  const st = storage === undefined ? defaultStorage() : storage;
  const empty = (issues: StoreIssue[], writable: boolean, raw: string | null = null): ReadState => ({ storage: st, raw, simulations: [], issues, writable });
  if (!st) return empty([{ code: 'storageUnavailable' }], false);
  let raw: string | null;
  try {
    raw = st.getItem(DECISION_STORE_KEY);
  } catch {
    return empty([{ code: 'storageUnavailable' }], false);
  }
  if (raw === null) return empty([], true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty([{ code: 'corruptedJson' }], true, raw);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty([{ code: 'invalidEnvelope' }], true, raw);
  let envelope = parsed as Record<string, unknown>;
  let version = envelope.formatVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return empty([{ code: 'invalidEnvelope' }], true, raw);
  if (version > DECISION_STORE_FORMAT) return empty([{ code: 'unsupportedVersion', details: [`formatVersion ${version}`] }], false, raw);
  try {
    while ((version as number) < DECISION_STORE_FORMAT) {
      const migrate = MIGRATIONS[version as number];
      if (!migrate) return empty([{ code: 'unsupportedVersion', details: [`formatVersion ${version}`] }], false, raw);
      envelope = migrate(envelope);
      version = envelope.formatVersion;
    }
  } catch {
    return empty([{ code: 'invalidEnvelope' }], true, raw);
  }
  if (!Array.isArray(envelope.simulations) || Object.keys(envelope).some((k) => k !== 'formatVersion' && k !== 'simulations')) return empty([{ code: 'invalidEnvelope' }], true, raw);

  const issues: StoreIssue[] = [];
  const simulations: DecisionSnapshot[] = [];
  const ids = new Set<string>();
  envelope.simulations.forEach((entry: unknown, index: number) => {
    const v = validateSnapshot(entry);
    if (!v.ok) issues.push({ code: 'invalidSnapshot', index, details: v.errors });
    else if (ids.has(v.value.id)) issues.push({ code: 'duplicateStoredId', index, id: v.value.id });
    else {
      ids.add(v.value.id);
      simulations.push(v.value);
    }
  });
  simulations.sort(byAge);
  // Au-delà de la limite (stockage altéré) : rien n'est ignoré ni supprimé ; le dépassement est signalé
  // et tout nouvel enregistrement sera refusé jusqu'au retour sous la limite.
  if (simulations.length > MAX_SIMULATIONS) issues.push({ code: 'overLimit', limit: MAX_SIMULATIONS, count: simulations.length });
  return { storage: st, raw, simulations, issues, writable: true };
}

function write(state: ReadState, simulations: DecisionSnapshot[]): StoreIssue | null {
  const st = state.storage!;
  // Le contenu actuel contient des données illisibles ou ignorées : copie brute avant de l'écraser.
  if (state.raw !== null && state.issues.some((i) => i.code !== 'overLimit')) {
    try {
      st.setItem(DECISION_QUARANTINE_KEY, state.raw);
    } catch {
      /* au mieux : la quarantaine ne doit pas empêcher l'écriture */
    }
  }
  const text = JSON.stringify({ formatVersion: DECISION_STORE_FORMAT, simulations });
  try {
    st.setItem(DECISION_STORE_KEY, text);
    if (st.getItem(DECISION_STORE_KEY) !== text) return { code: 'writeFailed' };
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    return { code: /quota/i.test(name) || (e as { code?: number })?.code === 22 ? 'quotaExceeded' : 'writeFailed' };
  }
  return null;
}

/** Lit toutes les simulations valides. Ne modifie jamais le stockage. */
export function loadSimulations(storage?: StorageLike | null): LoadResult {
  const { simulations, issues, writable } = read(storage);
  return { simulations, issues, writable };
}

export function getSimulation(id: string, storage?: StorageLike | null): DecisionSnapshot | null {
  return read(storage).simulations.find((s) => s.id === id) ?? null;
}

/**
 * Ajoute un snapshot (validé strictement). Refuse un identifiant déjà présent (un snapshot existant
 * n'est jamais écrasé) et refuse l'ajout lorsque la limite est atteinte (`limitReached`) : aucune
 * simulation existante n'est supprimée. En cas d'échec d'écriture, le stockage précédent est rétabli.
 */
export function saveSimulation(snapshot: unknown, storage?: StorageLike | null): SaveResult {
  const check = validateSnapshot(snapshot);
  if (!check.ok) return { ok: false, issue: { code: 'invalidSnapshot', details: check.errors } };
  const state = read(storage);
  if (!state.writable) return { ok: false, issue: state.issues[0] };
  if (state.simulations.some((s) => s.id === check.value.id)) return { ok: false, issue: { code: 'duplicateId', id: check.value.id } };
  if (state.simulations.length >= MAX_SIMULATIONS) return { ok: false, issue: { code: 'limitReached', limit: MAX_SIMULATIONS, count: state.simulations.length } };
  const next = [...state.simulations, check.value].sort(byAge);
  const failure = write(state, next);
  if (failure) {
    restore(state);
    return { ok: false, issue: failure };
  }
  return { ok: true, snapshot: check.value, count: next.length, issues: state.issues };
}

/** Supprime une simulation (action explicite de l'utilisateur). */
export function deleteSimulation(id: string, storage?: StorageLike | null): RemoveResult {
  const state = read(storage);
  if (!state.writable) return { ok: false, issue: state.issues[0] };
  if (!state.simulations.some((s) => s.id === id)) return { ok: false, issue: { code: 'notFound', id } };
  const next = state.simulations.filter((s) => s.id !== id);
  const failure = write(state, next);
  if (failure) {
    restore(state);
    return { ok: false, issue: failure };
  }
  return { ok: true, count: next.length };
}

/** Supprime toutes les simulations (clé dédiée uniquement ; la quarantaine est conservée). */
export function clearSimulations(storage?: StorageLike | null): RemoveResult {
  const state = read(storage);
  // Version plus récente non prise en charge : on ne détruit pas ses données.
  if (!state.storage || !state.writable) return { ok: false, issue: state.issues[0] ?? { code: 'storageUnavailable' } };
  try {
    state.storage.removeItem(DECISION_STORE_KEY);
  } catch {
    return { ok: false, issue: { code: 'writeFailed' } };
  }
  return { ok: true, count: 0 };
}

/** Rétablit le contenu lu avant une écriture échouée (au mieux). */
function restore(state: ReadState): void {
  try {
    if (state.raw === null) state.storage!.removeItem(DECISION_STORE_KEY);
    else state.storage!.setItem(DECISION_STORE_KEY, state.raw);
  } catch {
    /* le stockage refuse aussi la restauration : rien de plus à faire */
  }
}
