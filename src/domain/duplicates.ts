/**
 * Détection de doublons potentiels.
 * Une paire est suspecte si : même compte, même sens, même montant, dates à ±2 jours,
 * et libellés similaires (ou même date exacte). Rien n'est supprimé automatiquement :
 * l'utilisateur confirme toujours.
 */
import type { ISODate } from './dates';
import { diffDays } from './dates';
import type { Direction, ID } from './types';

export interface DuplicateCandidate {
  accountId: ID;
  direction: Direction;
  amount: number;
  date: ISODate;
  label: string;
}

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // accents et signes diacritiques (toutes écritures)
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\b\d{4,}\b/g, ' ') // références numériques
    .replace(/\s+/g, ' ')
    .trim();
}

export function labelSimilarity(a: string, b: string): number {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function isPotentialDuplicate(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (a.accountId !== b.accountId || a.direction !== b.direction || a.amount !== b.amount) return false;
  const gap = Math.abs(diffDays(a.date, b.date));
  if (gap > 2) return false;
  if (gap === 0 && labelSimilarity(a.label, b.label) >= 0.3) return true;
  return labelSimilarity(a.label, b.label) >= 0.5;
}

/** Pour chaque candidat, l'élément existant le plus probable (ou undefined). */
export function findDuplicates<T extends DuplicateCandidate>(candidates: DuplicateCandidate[], existing: T[]): (T | undefined)[] {
  const byAmount = new Map<number, T[]>();
  for (const e of existing) {
    const list = byAmount.get(e.amount);
    if (list) list.push(e);
    else byAmount.set(e.amount, [e]);
  }
  return candidates.map((c) => (byAmount.get(c.amount) ?? []).find((e) => isPotentialDuplicate(c, e)));
}
