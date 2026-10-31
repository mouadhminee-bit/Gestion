import type { OccurrenceView } from '@/domain/calc/recurring';
import { t } from '@/i18n/core';

export type OccurrenceTone = 'positive' | 'warning' | 'neutral' | 'cyan' | 'negative';

const TONE: Record<OccurrenceView['status'], OccurrenceTone> = {
  paid: 'positive',
  partial: 'warning',
  matched: 'cyan',
  skipped: 'neutral',
  upcoming: 'neutral',
  overdue: 'negative',
};

/**
 * Libellé et ton d'une échéance. « Détecté, à confirmer » (matched) n'est jamais présenté
 * comme réglé ; « Soldée » distingue un reliquat abandonné d'un paiement complet.
 */
export function occurrenceBadge(o: OccurrenceView): { label: string; tone: OccurrenceTone } {
  if (o.status === 'paid' && o.settled) return { label: t('rec.status.settled'), tone: 'positive' };
  return { label: t(`rec.status.${o.status}`), tone: TONE[o.status] };
}
