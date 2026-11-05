/**
 * Règle d'affichage du statut de projection, par surface.
 *
 * Le statut calculé par le moteur (`complete` / `minimum` / `no-data`) n'est jamais modifié ici :
 * cette règle décide seulement s'il faut l'expliquer à l'écran, et comment.
 *  - Dashboard : jamais. C'est une synthèse financière, sans avertissement sur la qualité
 *    du moteur de projection, même quand la projection n'est qu'un minimum.
 *  - Budgets : jamais. L'onglet reste centré sur le suivi budgétaire (prévu, réalisé, reste,
 *    dépassements, écarts) ; la projection n'y est affichée que lorsqu'elle est complète.
 *  - Projection, Simulation : 'minimum' → avertissement sur les limites ;
 *    'no-data' → état neutre (pas encore assez de données) ; 'complete' → rien.
 *    La simulation n'appelle cette règle que lorsque ses résultats sont affichés : ils dépendent
 *    alors toujours de la projection (solde fin de mois = projection actuelle + scénario).
 */
import type { ProjectionStatus } from '@/domain/calc/forecast';

export type ProjectionSurface = 'dashboard' | 'projection' | 'simulation' | 'budgets';
export type ProjectionNoticeKind = Exclude<ProjectionStatus, 'complete'>;

export function projectionNotice(surface: ProjectionSurface, status: ProjectionStatus | null | undefined): ProjectionNoticeKind | null {
  if (surface === 'dashboard' || surface === 'budgets' || status == null || status === 'complete') return null;
  return status;
}
