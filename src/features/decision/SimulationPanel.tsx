/**
 * Decision Lab — carte « Simulation » (étape E5.4) : horizon, exécution, résultats, enregistrement.
 *
 * Exécute le moteur sur la situation initiale et la décision validées, avec l'horizon saisi
 * (`runSimulation`). Le snapshot affiché est enregistré tel quel par le store E4 (`saveSimulation`) :
 * aucun recalcul entre l'écran et le stockage, un nouvel identifiant à chaque exécution (un
 * snapshot existant n'est jamais remplacé). Toute modification de la situation ou de la décision
 * efface le résultat affiché : il faut relancer la simulation.
 */
import { useEffect, useState } from 'react';
import { Play, Save } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Misc';
import { Field, Input } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { MAX_HORIZON_MONTHS, type DecisionInput, type InitialSituation } from '@/domain/calc/decision';
import { monthKey } from '@/domain/dates';
import { t, td } from '@/i18n/core';
import { errorMessage } from './DecisionBuilder';
import { MAX_NAME_LENGTH } from './snapshot';
import { saveSimulation, MAX_SIMULATIONS } from './store';
import { runSimulation, type RunErrors, type SimulationRun } from './simulationRun';
import { SimulationResults } from './SimulationResults';

function runErrorMessage(field: keyof RunErrors, code: string): string {
  if (field === 'situation') return t('dl.run.err.situation');
  if (field === 'name' && code === 'tooLong') return t('dl.run.err.nameTooLong', { max: MAX_NAME_LENGTH });
  if (field === 'horizon' && (code === 'notPositive' || code === 'tooLarge')) return t('dl.run.err.horizonRange', { max: MAX_HORIZON_MONTHS });
  return errorMessage(field, code);
}

export function SimulationPanel({ situation, decision, onSaved }: { situation: InitialSituation | null; decision: DecisionInput; onSaved: () => void }) {
  const { today } = useApp();
  const toast = useToast();
  const [name, setName] = useState(() => td(`dl.kind.${decision.kind}`));
  const [horizonText, setHorizonText] = useState('');
  const [errors, setErrors] = useState<RunErrors>({});
  const [run, setRun] = useState<SimulationRun | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Hypothèses modifiées : le résultat affiché ne leur correspond plus.
  const hypotheses = JSON.stringify([situation, decision]);
  useEffect(() => {
    setRun(null);
    setSaved(false);
    setSaveError(null);
  }, [hypotheses]);

  function start(e: React.FormEvent) {
    e.preventDefault();
    const res = runSimulation({ name, horizonText, situation, decision, startMonth: monthKey(today) });
    setSaved(false);
    setSaveError(null);
    if (!res.ok) {
      setErrors(res.errors);
      setRun(null);
      return;
    }
    setErrors({});
    setRun({ snapshot: res.snapshot, live: res.live });
  }

  function save() {
    if (!run || saved) return;
    const res = saveSimulation(run.snapshot);
    if (res.ok) {
      setSaved(true);
      toast.success(t('dl.run.saved'));
      onSaved();
      return;
    }
    setSaveError(res.issue.code === 'limitReached' ? t('dl.run.save.limit', { limit: MAX_SIMULATIONS }) : t('dl.run.save.failed'));
  }

  return (
    <Card data-testid="dl-run" title={t('dl.run.title')}>
      <form onSubmit={start} noValidate className="space-y-4">
        <p className="text-xs text-muted">{t('dl.run.intro')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('dl.run.name')} htmlFor="dl-run-name" required error={errors.name ? runErrorMessage('name', errors.name) : undefined}>
            <Input
              id="dl-run-name"
              value={name}
              maxLength={MAX_NAME_LENGTH + 1}
              invalid={!!errors.name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setErrors(({ name: _n, ...rest }) => rest);
              }}
            />
          </Field>
          <Field label={t('dl.run.horizon')} htmlFor="dl-run-horizon" required hint={t('dl.run.horizon.hint', { max: MAX_HORIZON_MONTHS })} error={errors.horizon ? runErrorMessage('horizon', errors.horizon) : undefined}>
            <Input
              id="dl-run-horizon"
              inputMode="numeric"
              autoComplete="off"
              className="num"
              value={horizonText}
              invalid={!!errors.horizon}
              aria-invalid={errors.horizon ? true : undefined}
              onChange={(e) => {
                setHorizonText(e.target.value);
                setErrors(({ horizon: _h, form: _f, ...rest }) => rest);
              }}
            />
          </Field>
        </div>
        {(errors.situation || errors.form) && (
          <p role="alert" data-testid="dl-run-error" className="rounded-lg bg-negative/10 p-2 text-xs text-negative">
            {errors.situation ? runErrorMessage('situation', errors.situation) : runErrorMessage('form', errors.form!)}
          </p>
        )}
        <Button type="submit" variant="primary" icon={<Play className="h-4 w-4 rtl:rotate-180" aria-hidden />}>
          {run ? t('dl.run.rerun') : t('dl.run.start')}
        </Button>
      </form>

      {run && (
        <div className="mt-6 space-y-4 border-t border-line/10 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge tone={saved ? 'positive' : 'violet'}>
              <span data-testid="dl-run-status">{saved ? t('dl.run.saved') : t('dl.run.current')}</span>
            </Badge>
            <Button variant="secondary" size="sm" disabled={saved} onClick={save} icon={<Save className="h-4 w-4" aria-hidden />}>
              {t('dl.run.save')}
            </Button>
          </div>
          {saveError && (
            <p role="alert" data-testid="dl-run-save-error" className="rounded-lg bg-warning/10 p-2 text-xs text-warning">
              {saveError}
            </p>
          )}
          <SimulationResults snapshot={run.snapshot} live={run.live} />
        </div>
      )}
    </Card>
  );
}
