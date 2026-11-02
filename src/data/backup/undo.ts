/**
 * Annulation immédiate d'une restauration (atténuation de P18).
 *
 * Après une restauration réussie, la sauvegarde de sécurité (JSON déjà vérifié, phase B)
 * est conservée EN MÉMOIRE dans un emplacement unique. Tant qu'il existe, l'utilisateur
 * peut revenir à l'état précédent, même si le navigateur a ignoré le téléchargement du
 * fichier de sécurité.
 *
 * Garanties :
 *  - le retour arrière passe par `restoreBackup` : validation complète, transaction
 *    unique, contrôle des volumes ; en cas d'échec (quota, panne), les données restaurées
 *    sont inchangées et l'emplacement est CONSERVÉ (nouvelle tentative possible) ;
 *  - après succès, l'empreinte des données est comparée à celle de la sauvegarde de
 *    sécurité (`verified`) ;
 *  - une modification faite depuis la restauration est détectée (empreinte) et signalée
 *    avant confirmation : elle serait perdue.
 *
 * Limites (voir docs/BACKUP_RESTORE.md § 6.1) : mémoire de l'onglet uniquement (perdue au
 * rechargement, à la fermeture, en cas de plantage de l'onglet) ; une seule restauration
 * (la dernière) ; indisponible si l'état précédent ne passe pas la validation complète ;
 * effacée par toute autre opération de remplacement (démo, espace vierge, suppression).
 */
import type { NexoraRepository } from '../contracts';
import type { BackupFile } from './format';

export interface UndoSlot {
  /** Sauvegarde de sécurité (JSON vérifié) de l'état qui précédait la restauration. */
  safetyJson: string;
  /** Nom du fichier de sécurité proposé au téléchargement. */
  safetyName: string;
  /** Empreinte des données juste après la restauration (détection des modifications). */
  restoredFingerprint: string;
  restoredAt: string;
}

/** Empreinte rapide (cyrb53) d'une chaîne — détection d'écart, pas de sécurité. */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + str.length;
}

/** Empreinte du CONTENU d'une sauvegarde (hors date d'export et enveloppe). */
export function fingerprintData(file: Pick<BackupFile, 'data'>): string {
  return cyrb53(JSON.stringify(file.data));
}

// --- Emplacement unique en mémoire (observable) ---------------------------------------

let slot: UndoSlot | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const undoStore = {
  get: (): UndoSlot | null => slot,
  set(next: UndoSlot) {
    slot = next;
    emit();
  },
  /** Libère la mémoire ; l'annulation n'est plus possible. */
  clear() {
    if (!slot) return;
    slot = null;
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Les données ont-elles changé depuis la restauration ? */
export async function changedSinceRestore(repo: Pick<NexoraRepository, 'exportBackup'>, s: UndoSlot): Promise<boolean> {
  return fingerprintData(await repo.exportBackup()) !== s.restoredFingerprint;
}

export interface UndoResult {
  /** Données rétablies identiques (empreinte) à la sauvegarde de sécurité. */
  verified: boolean;
  /** Opérations de l'état rétabli (repositionnement du mois affiché). */
  transactions: { date: string }[];
}

/**
 * Rétablit l'état qui précédait la restauration. En cas d'échec, l'erreur est propagée,
 * les données restaurées restent inchangées (transaction annulée) et l'emplacement est
 * conservé. En cas de succès, l'emplacement est libéré.
 */
export async function undoRestore(repo: Pick<NexoraRepository, 'restoreBackup' | 'exportBackup'>, s: UndoSlot = undoStore.get()!): Promise<UndoResult> {
  if (!s) throw new Error('no-undo-slot');
  const safety = JSON.parse(s.safetyJson) as BackupFile;
  await repo.restoreBackup(safety);
  const verified = fingerprintData(await repo.exportBackup()) === fingerprintData(safety);
  if (undoStore.get() === s) undoStore.clear();
  return { verified, transactions: (safety.data.transactions ?? []) as { date: string }[] };
}
