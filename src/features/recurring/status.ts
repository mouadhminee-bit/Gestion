import type { OccurrenceView } from '@/domain/calc/recurring';
import { isLate } from '@/domain/calc/recurring';
import type { ISODate } from '@/domain/dates';
import { t } from '@/i18n/core';

export type OccurrenceTone = 'positive' | 'warning' | 'neutral' | 'cyan' | 'negative' | 'violet';

/**
 * Libellé et ton d'une échéance, avec le vocabulaire du sens (« Payée » pour une dépense,
 * « Reçue » pour un revenu). Trois issues distinctes pour un paiement : intégral, partiel
 * (reliquat dû, rouge s'il est en retard) et clôturé (reliquat abandonné ou ancienne
 * échéance marquée payée). « Détecté, à confirmer » n'est jamais présenté comme réglé.
 */
export function occurrenceBadge(o: OccurrenceView, today: ISODate): { label: string; tone: OccurrenceTone } {
  const income = o.rule.kind === 'income';
  switch (o.status) {
    case 'paid':
      if (o.closure) return { label: t('rec.status.settled'), tone: 'violet' };
      return { label: t(income ? 'rec.status.received' : 'rec.status.paid'), tone: 'positive' };
    case 'partial':
      return { label: t(income ? 'rec.status.partialReceived' : 'rec.status.partial'), tone: isLate(o, today) ? 'negative' : 'warning' };
    case 'matched':
      return { label: t('rec.status.matched'), tone: 'cyan' };
    case 'overdue':
      return { label: t('rec.status.overdue'), tone: 'negative' };
    default:
      return { label: t(`rec.status.${o.status}`), tone: 'neutral' };
  }
}
