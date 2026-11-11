/**
 * Decision Lab — carte « Nouvelle décision » (étape E5.3) : choix du type, formulaire, récapitulatif.
 *
 * Produit une entrée du moteur (`DecisionInput`) validée par le moteur lui-même (`buildDecision`).
 * Les brouillons des quatre types sont conservés pendant le parcours : changer de type ou revenir à
 * la modification ne perd aucune saisie. Rien n'est écrit dans les données ni dans un stockage :
 * l'entrée validée est transmise à la page (`onValidated`), qui la simulera à l'étape suivante.
 */
import { useState, type ReactNode } from 'react';
import { ArrowLeft, CalendarClock, PenLine, PiggyBank, ShoppingBag, TrendingUp } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Misc';
import { Field, Input, MoneyInput, Segmented, Switch } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { MAX_HORIZON_MONTHS, MAX_RATE_BPS, MAX_VARIANTS, MIN_VARIANTS, type DecisionInput } from '@/domain/calc/decision';
import { cn } from '@/lib/cn';
import { t, td } from '@/i18n/core';
import {
  buildDecision,
  DECISION_KINDS,
  draftFromDecision,
  emptyDraft,
  fieldsOf,
  flattenDecision,
  FORM_LEVEL,
  type DecisionDraft,
  type DecisionKind,
  type DraftErrors,
  type FieldSpec,
  type GoalMode,
} from './decisionDraft';

export const KIND_ICON: Record<DecisionKind, ReactNode> = {
  purchase: <ShoppingBag className="h-5 w-5" aria-hidden />,
  recurring: <CalendarClock className="h-5 w-5" aria-hidden />,
  goal: <PiggyBank className="h-5 w-5" aria-hidden />,
  investment: <TrendingUp className="h-5 w-5" aria-hidden />,
};

/** Libellé (et aide éventuelle) d'un champ : `months` désigne une durée différente selon le type. */
const LABEL: Record<string, string> = {
  price: 'dl.f.price',
  downPayment: 'dl.f.downPayment',
  fees: 'dl.f.fees',
  assetValue: 'dl.f.assetValue',
  'loan.nominalRateBps': 'dl.f.loanRate',
  'loan.months': 'dl.f.loanMonths',
  insuranceMonthly: 'dl.f.insurance',
  insuranceMonths: 'dl.f.insuranceMonths',
  monthlyAmount: 'dl.f.monthlyAmount',
  startMonth: 'dl.f.startMonth',
  target: 'dl.f.target',
  effectiveRateBps: 'dl.f.effectiveRate',
  monthlyContribution: 'dl.f.monthlyContribution',
  deadlineMonths: 'dl.f.deadline',
  initialCapital: 'dl.f.initialCapital',
  contributionMonths: 'dl.f.contributionMonths',
};
const HINTED = new Set(['downPayment', 'fees', 'assetValue', 'insuranceMonths', 'startMonth', 'effectiveRateBps', 'deadlineMonths', 'contributionMonths']);

const labelKey = (kind: DecisionKind, key: string) => (key === 'months' ? (kind === 'goal' ? 'dl.f.goalMonths' : 'dl.f.months') : LABEL[key]);
const hintKey = (kind: DecisionKind, key: string) => (key === 'months' ? (kind === 'recurring' ? 'dl.f.months.hint' : null) : HINTED.has(key) ? `${LABEL[key]}.hint` : null);

/** Message d'erreur traduit ; le code est celui de l'interface ou du moteur. */
export function errorMessage(field: string, code: string): string {
  if (code === 'required' && field === 'insuranceMonths') return t('dl.err.insuranceMonths');
  if (code === 'tooLarge') return t('dl.err.tooLarge', { max: MAX_HORIZON_MONTHS });
  if (code === 'rateOutOfRange') return t('dl.err.rateOutOfRange', { max: MAX_RATE_BPS / 100 });
  const known = ['required', 'negative', 'notPositive', 'exceedsPrice', 'loanRequired', 'loanNotAllowed', 'notAmortizable', 'emptyInvestment', 'resultOutOfRange'];
  return known.includes(code) ? td(`dl.err.${code}`) : t('dl.err.invalid');
}

export type DecisionMode = 'single' | 'compare';

/**
 * `comparison` : contenu du mode « Comparaison » (E5.5), fourni par la page. Sans lui, la carte ne
 * propose que la simulation simple. Les deux modes restent montés : passer de l'un à l'autre ne perd
 * aucune saisie.
 */
export function DecisionBuilder({
  onValidated,
  onModeChange,
  comparison,
}: {
  onValidated?: (decision: DecisionInput | null) => void;
  onModeChange?: (mode: DecisionMode) => void;
  comparison?: ReactNode;
}) {
  const [mode, setMode] = useState<DecisionMode>('single');
  const { fmt, settings } = useApp();
  const toast = useToast();
  const currency = settings.baseCurrency;
  const [kind, setKind] = useState<DecisionKind | null>(null);
  const [drafts, setDrafts] = useState<Record<DecisionKind, DecisionDraft>>(() => ({
    purchase: emptyDraft('purchase'),
    recurring: emptyDraft('recurring'),
    goal: emptyDraft('goal'),
    investment: emptyDraft('investment'),
  }));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [ready, setReady] = useState<DecisionInput | null>(null);

  const draft = kind ? drafts[kind] : null;
  const update = (fn: (d: DecisionDraft) => DecisionDraft) => kind && setDrafts((all) => ({ ...all, [kind]: fn(all[kind]) }));
  function invalidate() {
    if (ready) {
      setReady(null);
      onValidated?.(null);
    }
  }

  function choose(k: DecisionKind | null) {
    setKind(k);
    setErrors({});
    invalidate();
  }

  function submit() {
    if (!draft) return;
    const res = buildDecision(draft);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    setReady(res.decision);
    onValidated?.(res.decision);
    toast.success(t('dl.form.ready.title'));
  }

  /** Retour au formulaire : le brouillon de ce type a été conservé tel quel. */
  function edit() {
    invalidate();
  }

  const header = kind && (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">{KIND_ICON[kind]}</span>
        {td(`dl.kind.${kind}`)}
      </div>
      <Button variant="ghost" size="sm" onClick={() => choose(null)} icon={<ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />}>
        {t('dl.form.changeType')}
      </Button>
    </div>
  );

  return (
    <Card data-testid="dl-decision" data-mode={mode} title={t('dl.form.title')}>
      {comparison && (
        <div className="mb-4">
          <Segmented<DecisionMode>
            className="w-full sm:w-auto"
            value={mode}
            onChange={(m) => {
              setMode(m);
              onModeChange?.(m);
            }}
            options={[
              { value: 'single', label: t('dl.mode.single') },
              { value: 'compare', label: t('dl.mode.compare', { min: MIN_VARIANTS, max: MAX_VARIANTS }) },
            ]}
          />
        </div>
      )}
      {comparison && <div hidden={mode !== 'compare'}>{comparison}</div>}
      <div hidden={mode !== 'single'} data-testid="dl-single">
      {!kind && (
        <>
          <p className="mb-3 text-xs text-muted">{t('dl.form.choose')}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {DECISION_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                data-testid={`dl-kind-${k}`}
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
        </>
      )}

      {kind && draft && ready && (
        <div data-testid="dl-decision-ready">
          {header}
          <div role="status" className="rounded-2xl border border-positive/30 bg-positive/10 px-4 py-3 text-sm">
            <div className="font-semibold">{t('dl.form.ready.title')}</div>
            <p className="mt-0.5 text-xs text-muted">{t('dl.form.ready.text')}</p>
          </div>
          <Recap decision={ready} fmt={fmt} currency={currency} />
          <div className="mt-4">
            <Button variant="secondary" size="sm" onClick={edit} icon={<PenLine className="h-4 w-4" aria-hidden />}>
              {t('common.edit')}
            </Button>
          </div>
        </div>
      )}

      {kind && draft && !ready && (
        <DecisionForm
          kind={kind}
          draft={draft}
          errors={errors}
          currency={currency}
          onUpdate={update}
          onErrors={setErrors}
          onSubmit={submit}
          header={header}
          submitLabel={t('dl.form.validate')}
        />
      )}
      </div>
    </Card>
  );
}

/**
 * Formulaire d'une décision (saisie et erreurs) : utilisé par la simulation simple et par chaque
 * variante du comparateur (`idPrefix` distinct par variante). Le brouillon et les erreurs restent
 * dans l'état du composant parent ; la validation est faite par le parent (`buildDecision`).
 */
export function DecisionForm({
  kind,
  draft,
  errors,
  currency,
  onUpdate,
  onErrors,
  onSubmit,
  header,
  submitLabel,
  idPrefix = 'dl-f',
  testId,
}: {
  kind: DecisionKind;
  draft: DecisionDraft;
  errors: DraftErrors;
  currency: string;
  onUpdate: (fn: (d: DecisionDraft) => DecisionDraft) => void;
  onErrors: (fn: (e: DraftErrors) => DraftErrors) => void;
  onSubmit: () => void;
  header?: ReactNode;
  submitLabel: string;
  idPrefix?: string;
  testId?: string;
}) {
  const update = onUpdate;
  const setErrors = (next: DraftErrors | ((e: DraftErrors) => DraftErrors)) => onErrors(typeof next === 'function' ? next : () => next);
  const clearError = (...keys: string[]) =>
    setErrors((e) => {
      const next = { ...e };
      for (const k of [...keys, FORM_LEVEL]) delete next[k];
      return next;
    });
  return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          noValidate
          data-testid={testId ?? `dl-form-${kind}`}
          className="space-y-4"
        >
          {header}
          <p className="text-xs text-muted">{t('dl.form.legend', { currency })}</p>

          {kind === 'goal' && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted">{t('dl.form.goalMode')}</div>
              <Segmented<GoalMode>
                className="w-full"
                size="sm"
                value={draft.goalMode}
                onChange={(m) => {
                  update((d) => ({ ...d, goalMode: m }));
                  setErrors({});
                }}
                options={[
                  { value: 'effort', label: t('dl.form.mode.effort') },
                  { value: 'contribution', label: t('dl.form.mode.contribution') },
                ]}
              />
              <p className="text-xs text-muted/80">{t(draft.goalMode === 'effort' ? 'dl.form.mode.effort.hint' : 'dl.form.mode.contribution.hint')}</p>
            </div>
          )}

          {(() => {
            const fields = fieldsOf(draft);
            // Achat : l'interrupteur de financement précède les champs du crédit qu'il fait apparaître.
            const split = kind === 'purchase' ? fields.findIndex((f) => f.key === 'assetValue') + 1 : fields.length;
            const renderFields = (list: FieldSpec[]) => (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {list.map((f) => (
                  <DraftField
                    key={f.key}
                    spec={f}
                    kind={kind}
                    draft={draft}
                    currency={currency}
                    idPrefix={idPrefix}
                    error={errors[f.key]}
                    onMoney={(v) => {
                      update((d) => ({ ...d, money: { ...d.money, [f.key]: v } }));
                      clearError(f.key);
                    }}
                    onMoneyText={(hasText) => update((d) => ({ ...d, moneyText: { ...d.moneyText, [f.key]: hasText } }))}
                    onText={(v) => {
                      update((d) => ({ ...d, text: { ...d.text, [f.key]: v } }));
                      clearError(f.key);
                    }}
                    onInvalidBlur={() => setErrors((e) => ({ ...e, [f.key]: 'invalid' }))}
                  />
                ))}
              </div>
            );
            return (
              <>
                {renderFields(fields.slice(0, split))}
                {kind === 'purchase' && (
                  <div data-testid="dl-field-loan">
                    <Switch
                      id={idPrefix === 'dl-f' ? 'dl-financed' : `${idPrefix}-financed`}
                      checked={draft.financed}
                      onChange={(v) => {
                        update((d) => ({ ...d, financed: v }));
                        clearError('loan', 'loan.nominalRateBps', 'loan.months');
                      }}
                      label={t('dl.f.financed')}
                      description={t('dl.f.financed.hint')}
                    />
                    {errors.loan && (
                      <p role="alert" className="text-xs text-negative">
                        {errorMessage('loan', errors.loan)}
                      </p>
                    )}
                  </div>
                )}
                {split < fields.length && renderFields(fields.slice(split))}
              </>
            );
          })()}

          {errors[FORM_LEVEL] && (
            <p role="alert" data-testid="dl-form-error" className="rounded-lg bg-negative/10 p-2 text-xs text-negative">
              {errorMessage(FORM_LEVEL, errors[FORM_LEVEL])}
            </p>
          )}

          <Button type="submit" variant="primary">
            {submitLabel}
          </Button>
        </form>
  );
}

function DraftField({
  spec,
  kind,
  draft,
  currency,
  idPrefix,
  error,
  onMoney,
  onMoneyText,
  onText,
  onInvalidBlur,
}: {
  spec: FieldSpec;
  kind: DecisionKind;
  draft: DecisionDraft;
  currency: string;
  idPrefix: string;
  error?: string;
  onMoney: (v: number | null) => void;
  /** Présence d'un texte dans le champ monétaire (indépendante de la valeur interprétée). */
  onMoneyText: (hasText: boolean) => void;
  onText: (v: string) => void;
  onInvalidBlur: () => void;
}) {
  const id = `${idPrefix}-${spec.key.replace('.', '-')}`;
  const hk = hintKey(kind, spec.key);
  return (
    <div data-testid={`dl-field-${spec.key}`}>
      <Field label={td(labelKey(kind, spec.key))} htmlFor={id} required={spec.required} hint={hk ? td(hk) : undefined} error={error ? errorMessage(spec.key, error) : undefined}>
        {spec.type === 'money' ? (
          <MoneyInput
            id={id}
            name={spec.key}
            currency={currency}
            allowNegative
            keepInvalidText
            required={spec.required}
            invalid={!!error}
            value={draft.money[spec.key] ?? null}
            onChange={onMoney}
            onInput={(e) => onMoneyText(e.currentTarget.value.trim() !== '')}
            onBlur={() => {
              if ((draft.money[spec.key] ?? null) === null && draft.moneyText[spec.key]) onInvalidBlur();
            }}
          />
        ) : (
          <div className="relative">
            <Input
              id={id}
              name={spec.key}
              inputMode={spec.type === 'rate' ? 'decimal' : 'numeric'}
              autoComplete="off"
              required={spec.required}
              invalid={!!error}
              aria-invalid={error ? true : undefined}
              className={cn('num', spec.type === 'rate' && 'pe-10')}
              value={draft.text[spec.key] ?? ''}
              onChange={(e) => onText(e.target.value)}
            />
            {spec.type === 'rate' && <span className="pointer-events-none absolute end-3.5 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">%</span>}
          </div>
        )}
      </Field>
    </div>
  );
}

/** Récapitulatif de l'entrée validée : les hypothèses saisies, aucun résultat. */
export function Recap({ decision, fmt, currency }: { decision: DecisionInput; fmt: ReturnType<typeof useApp>['fmt']; currency: string }) {
  const values = flattenDecision(decision);
  const rows = fieldsOf(draftFromDecision(decision)).filter((f) => values[f.key] !== undefined);
  return (
    <dl data-testid="dl-decision-recap" className="mt-4 grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
      {decision.kind === 'goal' && (
        <div>
          <dt className="text-muted">{t('dl.form.goalMode')}</dt>
          <dd className="font-medium">{t(decision.mode === 'effort' ? 'dl.form.mode.effort' : 'dl.form.mode.contribution')}</dd>
        </div>
      )}
      {rows.map((f) => (
        <div key={f.key}>
          <dt className="text-muted">{td(labelKey(decision.kind, f.key))}</dt>
          <dd className="num font-medium">
            <bdi>
              {f.type === 'money'
                ? fmt.money(values[f.key], currency)
                : f.type === 'rate'
                  ? fmt.percent(values[f.key] / 10_000, 2) // affichage uniquement (points de base → ratio)
                  : values[f.key]}
            </bdi>
          </dd>
        </div>
      ))}
      <div className="sm:col-span-2">
        <Badge tone="cyan">{td(`dl.kind.${decision.kind}`)}</Badge>
      </div>
    </dl>
  );
}
