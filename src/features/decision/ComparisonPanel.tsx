/**
 * Decision Lab — carte « Comparaison » (étape E5.5) : nom, horizon commun, exécution, résultats,
 * enregistrement.
 *
 * Exécute le moteur sur la situation initiale commune et les variantes validées, avec l'horizon
 * commun saisi (`runComparison`). Le snapshot affiché est enregistré tel quel par le store E4 :
 * aucun recalcul entre l'écran et le stockage, un nouvel identifiant à chaque exécution (un
 * snapshot existant n'est jamais remplacé). Toute modification de la situation ou d'une variante
 * efface le résultat affiché : il faut relancer la comparaison.
 */
import { useEffect, useState } from 'react';
import { Play, Save } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Misc';
import { Field, Input } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { MAX_HORIZON_MONTHS, MAX_VARIANTS, MIN_VARIANTS, type InitialSituation } from '@/domain/calc/decision';
import { monthKey } from '@/domain/dates';
import { t, td } from '@/i18n/core';
import { errorMessage } from './DecisionBuilder';
import { labelMessage, type ComparisonSetup } from './ComparisonBuilder';
import { MAX_NAME_LENGTH } from './snapshot';
import { saveSimulation, MAX_SIMULATIONS } from './store';
import { runComparison, VARIANT_IDS, type ComparisonErrors, type ComparisonRun } from './comparisonRun';
import { ComparisonResults } from './ComparisonResults';

function commonMessage(field: 'name' | 'horizon' | 'situation' | 'form', code: string): string {
  if (field === 'situation') return t('dl.run.err.situation');
  if (field === 'name' && code === 'tooLong') return t('dl.run.err.nameTooLong', { max: MAX_NAME_LENGTH });
  if (field === 'horizon' && (code === 'notPositive' || code === 'tooLarge')) return t('dl.run.err.horizonRange', { max: MAX_HORIZON_MONTHS });
  if (code === 'variantCount') return t('dl.cmp.err.variantCount', { min: MIN_VARIANTS, max: MAX_VARIANTS });
  if (code === 'mixedKinds') return t('dl.cmp.err.mixedKinds');
  return errorMessage(field, code);
}

function variantMessage(field: 'label' | 'decision', code: string): string {
  if (field === 'label') return labelMessage(code);
  if (code === 'notValidated') return t('dl.cmp.err.notValidated');
  return errorMessage('form', code);
}

export function ComparisonPanel({ situation, setup, onSaved }: { situation: InitialSituation | null; setup: ComparisonSetup; onSaved: () => void }) {
  const { today } = useApp();
  const toast = useToast();
  const [name, setName] = useState(() => t('dl.cmp.defaultName', { kind: td(`dl.kind.${setup.kind}`) }));
  const [horizonText, setHorizonText] = useState('');
  const [errors, setErrors] = useState<ComparisonErrors>({});
  const [run, setRun] = useState<ComparisonRun | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Hypothèses modifiées (situation, type, variantes, noms) : le résultat affiché ne leur correspond plus.
  const hypotheses = JSON.stringify([situation, setup]);
  useEffect(() => {
    setRun(null);
    setSaved(false);
    setSaveError(null);
    setErrors((e) => ({ name: e.name, horizon: e.horizon }));
  }, [hypotheses]);

  function start(e: React.FormEvent) {
    e.preventDefault();
    const res = runComparison({ name, horizonText, situation, variants: setup.variants, startMonth: monthKey(today) });
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
      toast.success(t('dl.cmp.saved'));
      onSaved();
      return;
    }
    setSaveError(res.issue.code === 'limitReached' ? t('dl.run.save.limit', { limit: MAX_SIMULATIONS }) : t('dl.run.save.failed'));
  }

  const variantErrors = Object.entries(errors.variants ?? {}).flatMap(([k, ve]) =>
    (['label', 'decision'] as const).filter((f) => ve[f]).map((f) => ({ k: Number(k), f, code: ve[f]! })),
  );
  const blocking = [errors.situation && commonMessage('situation', errors.situation), errors.form && commonMessage('form', errors.form)].filter(Boolean) as string[];

  return (
    <Card data-testid="dl-cmp-run" title={t('dl.cmp.run.title')}>
      <form onSubmit={start} noValidate className="space-y-4">
        <p className="text-xs text-muted">{t('dl.cmp.run.intro')}</p>
        <ul className="flex flex-wrap gap-2" data-testid="dl-cmp-run-variants">
          {setup.variants.map((v, k) => (
            <li key={k}>
              <Badge tone={k === 0 ? 'cyan' : 'neutral'}>
                <span className="font-bold">{VARIANT_IDS[k]}</span>
                <span aria-hidden> · </span>
                <bdi>{v.label}</bdi>
              </Badge>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('dl.cmp.run.name')} htmlFor="dl-cmp-name" required error={errors.name ? commonMessage('name', errors.name) : undefined}>
            <Input
              id="dl-cmp-name"
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
          <Field label={t('dl.cmp.run.horizon')} htmlFor="dl-cmp-horizon" required hint={t('dl.run.horizon.hint', { max: MAX_HORIZON_MONTHS })} error={errors.horizon ? commonMessage('horizon', errors.horizon) : undefined}>
            <Input
              id="dl-cmp-horizon"
              inputMode="numeric"
              autoComplete="off"
              className="num"
              value={horizonText}
              invalid={!!errors.horizon}
              aria-invalid={errors.horizon ? true : undefined}
              onChange={(e) => {
                setHorizonText(e.target.value);
                setErrors(({ horizon: _h, form: _f, variants: _v, ...rest }) => rest);
              }}
            />
          </Field>
        </div>
        {(blocking.length > 0 || variantErrors.length > 0) && (
          <div role="alert" data-testid="dl-cmp-run-error" className="space-y-1 rounded-lg bg-negative/10 p-2 text-xs text-negative">
            {blocking.map((m) => (
              <p key={m}>{m}</p>
            ))}
            {variantErrors.map(({ k, f, code }) => (
              <p key={`${k}-${f}`} data-variant={VARIANT_IDS[k]}>
                <span className="font-semibold">
                  {VARIANT_IDS[k]} · <bdi>{setup.variants[k]?.label}</bdi>
                </span>{' '}
                : {variantMessage(f, code)}
              </p>
            ))}
          </div>
        )}
        <Button type="submit" variant="primary" icon={<Play className="h-4 w-4 rtl:rotate-180" aria-hidden />}>
          {run ? t('dl.cmp.run.rerun') : t('dl.cmp.run.start')}
        </Button>
      </form>

      {run && (
        <div className="mt-6 space-y-4 border-t border-line/10 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge tone={saved ? 'positive' : 'violet'}>
              <span data-testid="dl-cmp-run-status">{saved ? t('dl.cmp.saved') : t('dl.cmp.current')}</span>
            </Badge>
            <Button variant="secondary" size="sm" disabled={saved} onClick={save} icon={<Save className="h-4 w-4" aria-hidden />}>
              {t('dl.run.save')}
            </Button>
          </div>
          {saveError && (
            <p role="alert" data-testid="dl-cmp-save-error" className="rounded-lg bg-warning/10 p-2 text-xs text-warning">
              {saveError}
            </p>
          )}
          <ComparisonResults snapshot={run.snapshot} live={run.live} />
        </div>
      )}
    </Card>
  );
}
