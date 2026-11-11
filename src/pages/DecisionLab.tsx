/**
 * Decision Lab — page d'accueil du module (étape E5.1) : « Mes simulations ».
 *
 * Lit les snapshots figés du store dédié (`features/decision/store`, sessionStorage) et les affiche
 * tels quels : aucune simulation n'est recalculée ici et aucune donnée financière réelle n'est lue
 * ni modifiée. Situation initiale (E5.2), décision (E5.3), simulation (E5.4) et comparateur
 * multi-variantes (E5.5) : rien n'est écrit dans les données financières.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, FlaskConical, Info, Trash2 } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState } from '@/components/ui/Misc';
import { useConfirm } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { DECISION_ENGINE_VERSION, type DecisionInput, type InitialSituation } from '@/domain/calc/decision';
import { buildInitialSituation, type InitialSituationDetails } from '@/domain/calc/decisionSituation';
import { gregorian } from '@/domain/dates';
import { deleteSimulation, loadSimulations, MAX_SIMULATIONS, type LoadResult } from '@/features/decision/store';
import type { DecisionSnapshot } from '@/features/decision/snapshot';
import { SituationCard } from '@/features/decision/SituationCard';
import { DecisionBuilder, type DecisionMode } from '@/features/decision/DecisionBuilder';
import { ComparisonBuilder, type ComparisonSetup } from '@/features/decision/ComparisonBuilder';
import { ComparisonPanel } from '@/features/decision/ComparisonPanel';
import { ComparisonResults } from '@/features/decision/ComparisonResults';
import { SimulationPanel } from '@/features/decision/SimulationPanel';
import { SimulationResults } from '@/features/decision/SimulationResults';
import { cn } from '@/lib/cn';
import { t, td } from '@/i18n/core';

function Notice({ tone, title, children, testId }: { tone: 'info' | 'warning' | 'negative'; title?: string; children: React.ReactNode; testId: string }) {
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <div
      role={tone === 'info' ? 'status' : 'alert'}
      data-testid={testId}
      className={cn(
        'flex gap-2.5 rounded-2xl border px-4 py-3 text-sm',
        tone === 'info' && 'border-cyan/30 bg-cyan/10',
        tone === 'warning' && 'border-warning/30 bg-warning/10',
        tone === 'negative' && 'border-negative/30 bg-negative/10',
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'info' ? 'text-cyan' : tone === 'warning' ? 'text-warning' : 'text-negative')} aria-hidden />
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        <p className={cn('text-xs text-muted', title && 'mt-0.5')}>{children}</p>
      </div>
    </div>
  );
}

/** Messages correspondant aux résultats réellement renvoyés par le store à la lecture. */
function StoreNotices({ state }: { state: LoadResult }) {
  const has = (...codes: string[]) => state.issues.some((i) => codes.includes(i.code));
  const ignored = state.issues.filter((i) => i.code === 'invalidSnapshot' || i.code === 'duplicateStoredId').length;
  const over = state.issues.find((i) => i.code === 'overLimit');
  return (
    <>
      {has('storageUnavailable') && <Notice tone="negative" testId="dl-storage-unavailable">{t('dl.err.storageUnavailable')}</Notice>}
      {has('unsupportedVersion') && <Notice tone="warning" testId="dl-unsupported-version">{t('dl.err.unsupportedVersion')}</Notice>}
      {has('corruptedJson', 'invalidEnvelope') && <Notice tone="warning" testId="dl-corrupted">{t('dl.err.corrupted')}</Notice>}
      {ignored > 0 && <Notice tone="warning" testId="dl-ignored">{t('dl.err.ignored', { count: ignored })}</Notice>}
      {over && <Notice tone="warning" testId="dl-over-limit">{t('dl.err.overLimit', { count: over.count ?? state.simulations.length, limit: over.limit ?? MAX_SIMULATIONS })}</Notice>}
      {!over && state.simulations.length >= MAX_SIMULATIONS && (
        <Notice tone="warning" testId="dl-limit-reached" title={t('dl.limit.title', { limit: MAX_SIMULATIONS })}>
          {t('dl.limit.text')}
        </Notice>
      )}
    </>
  );
}

function SimulationCard({ sim, open, onToggle, onDelete }: { sim: DecisionSnapshot; open: boolean; onToggle: () => void; onDelete: () => void }) {
  const { fmt, uiLocale } = useApp();
  const created = new Intl.DateTimeFormat(gregorian(uiLocale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sim.createdAt));
  const h = sim.hypotheses;
  const panelId = `dl-details-${sim.id}`;
  return (
    <li data-testid="dl-simulation" data-id={sim.id} className="rounded-2xl border border-line/10 bg-surface-2/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-words pt-1 text-sm font-semibold">
          <bdi>{sim.name}</bdi>
          {h.variants.length > 1 && (
            <Badge tone="violet" className="ms-2 align-middle">
              <span data-testid="dl-comparison-badge">{t('dl.cmp.badge')}</span>
            </Badge>
          )}
        </h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={panelId} onClick={onToggle} icon={<ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />}>
            {t('dl.details')}
          </Button>
          <Button variant="ghost" size="sm" aria-label={`${t('common.delete')} — ${sim.name}`} onClick={onDelete} icon={<Trash2 className="h-4 w-4" aria-hidden />} />
        </div>
      </div>
      {/* Sous le titre, sur toute la largeur : lisible sur mobile. */}
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted">{t('dl.field.created')}</dt>
          <dd>{created}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('dl.field.horizon')}</dt>
          <dd className="num">{h.horizonMonths}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('dl.field.start')}</dt>
          <dd>{h.startMonth ? fmt.month(h.startMonth) : '—'}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('dl.field.variants')}</dt>
          <dd className="num">{h.variants.length}</dd>
        </div>
      </dl>
      {sim.engineVersion !== DECISION_ENGINE_VERSION && (
        <Badge tone="warning" className="mt-2">
          {t('dl.engine.mismatch')}
        </Badge>
      )}

      {open && (
        <div id={panelId} data-testid="dl-details" className="mt-4 space-y-4 border-t border-line/10 pt-4 text-xs">
          <section>
            <h4 className="label mb-2">{t('dl.situation.title')}</h4>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <dt className="text-muted">{t('dl.situation.cash')}</dt>
                <dd className="num"><bdi>{fmt.money(h.situation.cash)}</bdi></dd>
              </div>
              <div>
                <dt className="text-muted">{t('dl.situation.netWorth')}</dt>
                <dd className="num"><bdi>{fmt.money(h.situation.netWorth)}</bdi></dd>
              </div>
              <div>
                <dt className="text-muted">{t('dl.situation.savings')}</dt>
                <dd className="num"><bdi>{fmt.money(h.situation.monthlySavings, undefined, { sign: true })}</bdi></dd>
              </div>
            </dl>
          </section>
          <section>
            <h4 className="label mb-2">{t('dl.field.variants')}</h4>
            <ul className="space-y-1.5">
              {h.variants.map((v) => (
                <li key={v.id} data-testid="dl-variant" className="flex flex-wrap items-center gap-2 font-semibold">
                  <bdi>{v.label ?? v.id}</bdi>
                  <Badge tone="cyan">{td(`dl.kind.${v.decision.kind}`)}</Badge>
                </li>
              ))}
            </ul>
          </section>
          {/* Résultats enregistrés, relus tels quels (aucun recalcul) : simulation simple ou comparaison. */}
          <div className="border-t border-line/10 pt-4 text-sm">
            {sim.results.variants.length === 1 ? <SimulationResults snapshot={sim} /> : <ComparisonResults snapshot={sim} />}
          </div>
        </div>
      )}
    </li>
  );
}

export default function DecisionLab() {
  const toast = useToast();
  const confirm = useConfirm();
  const { ctx, data, today } = useApp();
  const [state, setState] = useState<LoadResult>(() => loadSimulations());
  const [open, setOpen] = useState<string | null>(null);

  // Situation initiale : calculée en lecture seule à partir des données ; l'ajustement éventuel reste
  // dans l'état de cette page (temporaire) et n'est jamais écrit dans les données ni dans un stockage.
  const computed = useMemo<InitialSituationDetails | null>(() => {
    try {
      return buildInitialSituation(ctx, data, today);
    } catch {
      return null; // périmètre incohérent : saisie manuelle requise (message dans la carte)
    }
  }, [ctx, data, today]);
  const [override, setOverride] = useState<InitialSituation | null>(null);
  // Décision validée par le formulaire (E5.3), simulée par la carte « Simulation » (E5.4).
  const [decision, setDecision] = useState<DecisionInput | null>(null);
  // Comparaison prête (E5.5) : 2 à 4 variantes validées d'un même type, exécutées par la carte « Comparaison ».
  const [mode, setMode] = useState<DecisionMode>('single');
  const [comparison, setComparison] = useState<ComparisonSetup | null>(null);
  const situation: InitialSituation | null = override ?? (computed ? { cash: computed.cash, netWorth: computed.netWorth, monthlySavings: computed.monthlySavings } : null);

  async function remove(sim: DecisionSnapshot) {
    if (!(await confirm({ title: t('dl.delete.title'), message: t('dl.delete.message', { name: sim.name }), confirmLabel: t('common.delete') }))) return;
    const res = deleteSimulation(sim.id);
    // Le store ne lève jamais d'exception : succès ou échec, la liste reflète le stockage réel.
    setState(loadSimulations());
    if (res.ok) toast.success(t('dl.delete.done'));
    else toast.error(t('dl.err.deleteFailed'));
  }

  // Du plus récent au plus ancien (le store renvoie l'ordre chronologique).
  const simulations = [...state.simulations].reverse();
  const unreadable = state.issues.some((i) => ['storageUnavailable', 'unsupportedVersion', 'corruptedJson', 'invalidEnvelope'].includes(i.code));

  return (
    <div className="space-y-4">
      <PageHeader title={t('nav.decisionLab')} description={t('dl.description')} />

      <Notice tone="info" testId="dl-session-warning" title={t('dl.session.title')}>
        {t('dl.session.text')}
      </Notice>

      <SituationCard computed={computed} value={situation} onChange={setOverride} />

      <DecisionBuilder onValidated={setDecision} onModeChange={setMode} comparison={<ComparisonBuilder onChange={setComparison} />} />

      {mode === 'single' && decision && <SimulationPanel situation={situation} decision={decision} onSaved={() => setState(loadSimulations())} />}
      {mode === 'compare' && comparison && <ComparisonPanel situation={situation} setup={comparison} onSaved={() => setState(loadSimulations())} />}

      <StoreNotices state={state} />

      <Card
        title={t('dl.list.title')}
        actions={
          <Badge tone={state.simulations.length >= MAX_SIMULATIONS ? 'warning' : 'neutral'}>
            <span className="num" dir="ltr" data-testid="dl-count">
              {state.simulations.length} / {MAX_SIMULATIONS}
            </span>
          </Badge>
        }
      >
        {simulations.length === 0 ? (
          // Stockage illisible : le message d'erreur ci-dessus explique l'absence de liste.
          !unreadable && (
            <div data-testid="dl-empty">
              <EmptyState icon={<FlaskConical className="h-5 w-5" aria-hidden />} title={t('dl.empty.title')} description={t('dl.empty.text')} />
            </div>
          )
        ) : (
          <ul className="space-y-3">
            {simulations.map((sim) => (
              <SimulationCard key={sim.id} sim={sim} open={open === sim.id} onToggle={() => setOpen(open === sim.id ? null : sim.id)} onDelete={() => remove(sim)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
