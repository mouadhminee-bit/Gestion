/**
 * Decision Lab — carte « Situation initiale » (étape E5.2).
 *
 * Affiche les trois montants de départ d'une simulation, calculés en lecture seule à partir des
 * données de l'utilisateur (`buildInitialSituation`), et permet de les ajuster avant de construire
 * une décision. L'ajustement reste dans l'état de la page : rien n'est écrit dans les comptes, les
 * opérations, les budgets ou les objectifs, ni dans aucun stockage.
 */
import { useState } from 'react';
import { PenLine, RotateCcw } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, DemoBadge } from '@/components/ui/Misc';
import { Field, MoneyInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import type { InitialSituation } from '@/domain/calc/decision';
import type { InitialSituationDetails } from '@/domain/calc/decisionSituation';
import { t, td } from '@/i18n/core';
import { draftFromSituation, sameSituation, SITUATION_FIELDS, validateSituationDraft, type SituationDraft, type SituationField, type SituationIssueCode } from './situationDraft';

const LABEL: Record<SituationField, 'dl.situation.cash' | 'dl.situation.netWorth' | 'dl.situation.savings'> = {
  cash: 'dl.situation.cash',
  netWorth: 'dl.situation.netWorth',
  monthlySavings: 'dl.situation.savings',
};

export interface SituationCardProps {
  /** Situation calculée à partir des données (null : calcul impossible, saisie manuelle requise). */
  computed: InitialSituationDetails | null;
  /** Situation retenue pour les simulations (null : aucune tant que la saisie n'est pas validée). */
  value: InitialSituation | null;
  /** Nouvelle situation validée, ou null pour revenir aux valeurs calculées. */
  onChange: (value: InitialSituation | null) => void;
}

export function SituationCard({ computed, value, onChange }: SituationCardProps) {
  const { fmt, settings } = useApp();
  const toast = useToast();
  const currency = settings.baseCurrency;
  const edited = value !== null && (computed === null || !sameSituation(value, computed));
  const [editing, setEditing] = useState(value === null);
  const [draft, setDraft] = useState<SituationDraft>(() => (value ? draftFromSituation(value) : { cash: null, netWorth: null, monthlySavings: null }));
  const [hasText, setHasText] = useState<Partial<Record<SituationField, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<SituationField, SituationIssueCode>>>({});

  function startEditing() {
    setDraft(value ? draftFromSituation(value) : { cash: null, netWorth: null, monthlySavings: null });
    setHasText({});
    setErrors({});
    setEditing(true);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = validateSituationDraft(draft, hasText);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    // Identique aux valeurs calculées : ce n'est pas une modification.
    onChange(computed && sameSituation(res.value, computed) ? null : res.value);
    setErrors({});
    setEditing(false);
    toast.success(t('dl.situation.saved'));
  }

  const hint = (f: SituationField) => td(`dl.situation.${f === 'monthlySavings' ? 'savings' : f}.hint`, { currency });

  return (
    <Card
      data-testid="dl-situation"
      title={t('dl.situation.title')}
      actions={
        <>
          {settings.demoMode && !edited && <DemoBadge />}
          {value !== null && (
            <Badge tone={edited ? 'violet' : 'neutral'}>
              <span data-testid="dl-situation-source">{edited ? t('dl.situation.source.edited') : t('dl.situation.source.computed')}</span>
            </Badge>
          )}
        </>
      }
    >
      {/* Dans le corps de la carte : pleine largeur sur mobile (l'en-tête partage sa ligne avec les badges). */}
      <p className="mb-4 text-xs text-muted">{t('dl.situation.intro')}</p>

      {computed === null && (
        <p role="alert" data-testid="dl-situation-unavailable" className="mb-3 rounded-lg bg-warning/10 p-2 text-xs text-warning">
          {t('dl.situation.note.unavailable')}
        </p>
      )}

      {editing ? (
        <form onSubmit={submit} noValidate data-testid="dl-situation-form" className="space-y-4">
          <p className="text-xs text-muted">{t('dl.situation.required')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {SITUATION_FIELDS.map((f) => {
              const id = `dl-situation-${f}`;
              return (
                <Field key={f} label={t(LABEL[f])} htmlFor={id} required hint={hint(f)} error={errors[f] ? td(`dl.situation.err.${errors[f]}`) : undefined}>
                  <MoneyInput
                    id={id}
                    name={f}
                    currency={currency}
                    allowNegative
                    keepInvalidText
                    required
                    invalid={!!errors[f]}
                    value={draft[f]}
                    onChange={(v) => {
                      setDraft((d) => ({ ...d, [f]: v }));
                      // L'erreur affichée ne concerne plus la nouvelle saisie.
                      setErrors(({ [f]: _fixed, ...rest }) => rest);
                    }}
                    // Une saisie non interprétable n'est jamais effacée ni corrigée (`keepInvalidText`) :
                    // elle reste visible et l'erreur s'affiche dès la sortie du champ.
                    onBlur={() => {
                      if (draft[f] === null && hasText[f]) setErrors((e) => ({ ...e, [f]: 'invalid' }));
                    }}
                    // Distingue un champ vide (obligatoire) d'une saisie non interprétable (invalide).
                    onInput={(e) => {
                      const filled = e.currentTarget.value.trim() !== '';
                      setHasText((h) => ({ ...h, [f]: filled }));
                    }}
                  />
                </Field>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary">
              {t('dl.situation.validate')}
            </Button>
            {value !== null && (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
            )}
          </div>
        </form>
      ) : (
        value !== null && (
          <>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {SITUATION_FIELDS.map((f) => (
                <div key={f} data-testid={`dl-situation-value-${f}`}>
                  <dt className="text-xs font-medium text-muted">{t(LABEL[f])}</dt>
                  <dd className="num mt-0.5 text-lg font-semibold">
                    <bdi>{fmt.money(value[f], currency, { sign: f === 'monthlySavings' })}</bdi>
                  </dd>
                  <dd className="mt-0.5 text-xs text-muted/80">{hint(f)}</dd>
                </div>
              ))}
            </dl>

            {!edited && computed && (
              <ul data-testid="dl-situation-notes" className="mt-4 space-y-1 text-xs text-muted">
                {computed.baselineMonthsWithData === 0 ? (
                  <li className="text-warning">{t('dl.situation.note.noBaseline')}</li>
                ) : (
                  <li>{t('dl.situation.note.baseline', { count: computed.baselineMonthsWithData })}</li>
                )}
                {computed.perimeter.excludedAccounts.length > 0 && (
                  <li>
                    {t('dl.situation.note.excluded')} <bdi>{computed.perimeter.excludedAccounts.map((a) => a.name).join(' · ')}</bdi>
                  </li>
                )}
                {computed.unconverted && <li className="text-warning">{t('dl.situation.note.unconverted')}</li>}
              </ul>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={startEditing} icon={<PenLine className="h-4 w-4" aria-hidden />}>
                {t('common.edit')}
              </Button>
              {edited && computed && (
                <Button variant="ghost" size="sm" onClick={() => onChange(null)} icon={<RotateCcw className="h-4 w-4" aria-hidden />}>
                  {t('dl.situation.reset')}
                </Button>
              )}
            </div>
          </>
        )
      )}
    </Card>
  );
}
