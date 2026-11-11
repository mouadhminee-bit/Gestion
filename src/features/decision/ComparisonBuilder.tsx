/**
 * Decision Lab — saisie d'une comparaison (étape E5.5) : un type de décision commun, puis 2 à 4
 * variantes, chacune avec son nom et ses propres hypothèses.
 *
 * Chaque variante est validée indépendamment par le moteur (`buildDecision`, comme une simulation
 * simple). Le type est choisi une fois pour toute la comparaison : toutes les variantes ont donc
 * le même type. Les brouillons sont conservés (changer de type ou modifier une variante ne perd
 * aucune saisie). Rien n'est écrit dans les données ni dans un stockage : la comparaison prête
 * (toutes les variantes validées, noms valides) est transmise à la page (`onChange`).
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, PenLine, Plus, Trash2 } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Misc';
import { Field, Input } from '@/components/ui/Field';
import { MAX_VARIANTS, MIN_VARIANTS, type DecisionInput } from '@/domain/calc/decision';
import { cn } from '@/lib/cn';
import { t, td } from '@/i18n/core';
import { buildDecision, DECISION_KINDS, emptyDraft, type DecisionDraft, type DecisionKind, type DraftErrors } from './decisionDraft';
import { DecisionForm, KIND_ICON, Recap } from './DecisionBuilder';
import { labelError, VARIANT_IDS } from './comparisonRun';
import { MAX_LABEL_LENGTH } from './snapshot';

/** Comparaison prête à être exécutée : un type, 2 à 4 variantes validées et nommées. */
export interface ComparisonSetup {
  kind: DecisionKind;
  variants: { label: string; decision: DecisionInput }[];
}

interface VariantState {
  /** Clé stable d'affichage (indépendante du rang). */
  key: number;
  label: string;
  drafts: Record<DecisionKind, DecisionDraft>;
  errors: DraftErrors;
  ready: DecisionInput | null;
}

const emptyDrafts = (): Record<DecisionKind, DecisionDraft> => ({
  purchase: emptyDraft('purchase'),
  recurring: emptyDraft('recurring'),
  goal: emptyDraft('goal'),
  investment: emptyDraft('investment'),
});

/**
 * Nom par défaut d'une nouvelle variante : « Variante X » avec la lettre de sa position si ce nom est
 * libre, sinon la première lettre dont le nom n'est pas déjà utilisé.
 */
function defaultLabel(existing: string[]): string {
  const used = (name: string) => existing.some((l) => l.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
  const letters = [VARIANT_IDS[existing.length], ...VARIANT_IDS].filter(Boolean);
  for (const letter of letters) {
    const name = t('dl.cmp.variantName', { letter });
    if (!used(name)) return name;
  }
  return t('dl.cmp.variantName', { letter: String(existing.length + 1) });
}

export function labelMessage(code: string): string {
  if (code === 'tooLong') return t('dl.run.err.nameTooLong', { max: MAX_LABEL_LENGTH });
  if (code === 'duplicate') return t('dl.cmp.err.duplicateLabel');
  return td('dl.err.required');
}

export function ComparisonBuilder({ onChange }: { onChange: (setup: ComparisonSetup | null) => void }) {
  const { settings, fmt } = useApp();
  const currency = settings.baseCurrency;
  const nextKey = useRef(2);
  const [kind, setKind] = useState<DecisionKind | null>(null);
  const [variants, setVariants] = useState<VariantState[]>(() => {
    const a = defaultLabel([]);
    const b = defaultLabel([a]);
    return [
      { key: 0, label: a, drafts: emptyDrafts(), errors: {}, ready: null },
      { key: 1, label: b, drafts: emptyDrafts(), errors: {}, ready: null },
    ];
  });

  const labels = variants.map((v) => v.label);
  const labelErrors = variants.map((_, k) => labelError(labels, k));
  const setup: ComparisonSetup | null =
    kind && variants.length >= MIN_VARIANTS && variants.every((v) => v.ready?.kind === kind) && labelErrors.every((e) => !e)
      ? { kind, variants: variants.map((v) => ({ label: v.label.trim(), decision: v.ready! })) }
      : null;
  const setupJson = JSON.stringify(setup);
  useEffect(() => {
    onChange(setup);
  }, [setupJson]);

  const patch = (key: number, fn: (v: VariantState) => VariantState) => setVariants((all) => all.map((v) => (v.key === key ? fn(v) : v)));

  function choose(k: DecisionKind | null) {
    setKind(k);
    // Le type est commun : en changer invalide toutes les variantes (leurs brouillons sont conservés).
    setVariants((all) => all.map((v) => ({ ...v, errors: {}, ready: null })));
  }

  function validate(key: number) {
    if (!kind) return;
    const v = variants.find((x) => x.key === key)!;
    const res = buildDecision(v.drafts[kind]);
    patch(key, (x) => (res.ok ? { ...x, errors: {}, ready: res.decision } : { ...x, errors: res.errors, ready: null }));
  }

  function add(copyFrom?: VariantState) {
    if (variants.length >= MAX_VARIANTS) return;
    const key = nextKey.current++;
    // Une copie reprend les saisies mais doit être validée à son tour (validation indépendante).
    const drafts = copyFrom ? (JSON.parse(JSON.stringify(copyFrom.drafts)) as Record<DecisionKind, DecisionDraft>) : emptyDrafts();
    setVariants((all) => [...all, { key, label: defaultLabel(all.map((v) => v.label)), drafts, errors: {}, ready: null }]);
  }

  function remove(key: number) {
    if (variants.length <= MIN_VARIANTS) return;
    setVariants((all) => all.filter((v) => v.key !== key));
  }

  if (!kind) {
    return (
      <div data-testid="dl-cmp-builder">
        <p className="mb-3 text-xs text-muted">{t('dl.cmp.choose')}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {DECISION_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`dl-cmp-kind-${k}`}
              onClick={() => choose(k)}
              className="flex items-start gap-3 rounded-2xl border border-line/10 bg-surface-2/40 p-3 text-start transition hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">{KIND_ICON[k]}</span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{td(`dl.kind.${k}`)}</span>
                <span className="mt-0.5 block text-xs text-muted">{td(`dl.form.desc.${k}`)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const readyCount = variants.filter((v) => v.ready).length;
  return (
    <div data-testid="dl-cmp-builder" data-kind={kind} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">{KIND_ICON[kind]}</span>
          {td(`dl.kind.${kind}`)}
        </div>
        <Button variant="ghost" size="sm" onClick={() => choose(null)} icon={<ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />}>
          {t('dl.form.changeType')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('dl.cmp.intro', { min: MIN_VARIANTS, max: MAX_VARIANTS })}</p>
      <p data-testid="dl-cmp-progress" className="text-xs font-medium">
        {t('dl.cmp.progress', { ready: readyCount, count: variants.length })}
      </p>

      <ol className="space-y-4">
        {variants.map((v, k) => {
          const letter = VARIANT_IDS[k];
          const labelId = `dl-cmp-label-${v.key}`;
          const lErr = labelErrors[k];
          return (
            <li key={v.key} data-testid="dl-cmp-variant" data-letter={letter} className={cn('rounded-2xl border p-4', v.ready ? 'border-positive/30' : 'border-line/10 bg-surface-2/30')}>
              <div className="mb-3 flex items-start gap-2 sm:gap-3">
                <span className="mt-[2.1rem] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary" aria-hidden>
                  {letter}
                </span>
                <div className="min-w-0 flex-1">
                  <Field label={t('dl.cmp.label', { letter })} htmlFor={labelId} required error={lErr ? labelMessage(lErr) : undefined}>
                    <Input
                      id={labelId}
                      value={v.label}
                      maxLength={MAX_LABEL_LENGTH + 1}
                      invalid={!!lErr}
                      aria-invalid={lErr ? true : undefined}
                      onChange={(e) => {
                        const label = e.target.value;
                        patch(v.key, (x) => ({ ...x, label }));
                      }}
                    />
                  </Field>
                </div>
                <div className="mt-[1.6rem] flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={variants.length >= MAX_VARIANTS}
                    aria-label={`${t('dl.cmp.duplicate')} — ${v.label}`}
                    title={t('dl.cmp.duplicate')}
                    onClick={() => add(v)}
                    icon={<Copy className="h-4 w-4" aria-hidden />}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={variants.length <= MIN_VARIANTS}
                    aria-label={`${t('dl.cmp.remove')} — ${v.label}`}
                    title={t('dl.cmp.remove')}
                    onClick={() => remove(v.key)}
                    icon={<Trash2 className="h-4 w-4" aria-hidden />}
                  />
                </div>
              </div>
              {k === 0 && (
                <p className="mb-3">
                  <Badge tone="cyan">{t('dl.cmp.base')}</Badge>
                </p>
              )}

              {v.ready ? (
                <div data-testid="dl-cmp-ready">
                  <div role="status" className="rounded-xl border border-positive/30 bg-positive/10 px-3 py-2 text-xs font-semibold">
                    {t('dl.cmp.variantReady')}
                  </div>
                  <Recap decision={v.ready} fmt={fmt} currency={currency} />
                  <div className="mt-3">
                    <Button variant="secondary" size="sm" onClick={() => patch(v.key, (x) => ({ ...x, ready: null }))} icon={<PenLine className="h-4 w-4" aria-hidden />}>
                      {t('common.edit')}
                    </Button>
                  </div>
                </div>
              ) : (
                <DecisionForm
                  kind={kind}
                  draft={v.drafts[kind]}
                  errors={v.errors}
                  currency={currency}
                  idPrefix={`dl-v${v.key}-f`}
                  testId={`dl-cmp-form-${letter}`}
                  onUpdate={(fn) => patch(v.key, (x) => ({ ...x, drafts: { ...x.drafts, [kind]: fn(x.drafts[kind]) } }))}
                  onErrors={(fn) => patch(v.key, (x) => ({ ...x, errors: fn(x.errors) }))}
                  onSubmit={() => validate(v.key)}
                  submitLabel={t('dl.cmp.validate')}
                />
              )}
            </li>
          );
        })}
      </ol>

      <Button variant="secondary" size="sm" disabled={variants.length >= MAX_VARIANTS} onClick={() => add()} icon={<Plus className="h-4 w-4" aria-hidden />}>
        {t('dl.cmp.add')}
      </Button>
      {variants.length >= MAX_VARIANTS && <p className="text-xs text-muted">{t('dl.cmp.maxReached', { max: MAX_VARIANTS })}</p>}
    </div>
  );
}
