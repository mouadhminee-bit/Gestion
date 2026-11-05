import { cn } from '@/lib/cn';
import type { ProjectionNoticeKind } from './projectionNotice';

/**
 * Note de statut de projection : 'minimum' = avertissement (limites de la projection) ;
 * 'no-data' = état neutre, sans couleur d'alerte. Rien si `kind` est null.
 */
export function ProjectionNote({ kind, minimum, noData, className }: { kind: ProjectionNoticeKind | null; minimum: string; noData: string; className?: string }) {
  if (!kind) return null;
  return (
    <p
      data-projection-notice={kind}
      className={cn('rounded-lg p-2 text-xs', kind === 'minimum' ? 'bg-warning/10 text-warning' : 'bg-surface-2/60 text-muted', className)}
    >
      {kind === 'minimum' ? minimum : noData}
    </p>
  );
}
