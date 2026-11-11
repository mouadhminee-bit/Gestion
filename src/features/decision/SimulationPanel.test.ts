// @vitest-environment jsdom
/**
 * Decision Lab — étape E5.4 : parcours complet dans la page (React, jsdom, données fictives).
 * Situation → décision validée → horizon → simulation → résultats → enregistrement → historique.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '@/app/AppContext';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Dialog';
import { NexoraDB } from '@/data/db';
import { LocalRepository } from '@/data/repository';
import { createSnapshot } from './snapshot';
import { DECISION_STORE_KEY, loadSimulations, MAX_SIMULATIONS, saveSimulation } from './store';
import { activateMessages } from '@/i18n/core';
import ar from '@/i18n/locales/ar';
import fr from '@/i18n/locales/fr';
import DecisionLab from '@/pages/DecisionLab';
import { account, emptySnapshot, UID } from '@/test/fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
Element.prototype.scrollIntoView ??= () => {};

const TODAY = '2026-11-15';
let seq = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let repo: LocalRepository;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  activateMessages('fr', fr);
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Trésorerie de départ 50 000 DH (compte courant), aucune épargne de référence. */
async function render() {
  const data = emptySnapshot({ accounts: [account({ id: 'bank', initialBalance: 5_000_000 })] });
  const before = JSON.stringify(data);
  repo = new LocalRepository(new NexoraDB(`dl-run-${++seq}`), UID);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(h(MemoryRouter, null, h(TooltipProvider, null, h(ToastProvider, null, h(ConfirmProvider, null, h(AppProvider, { repo, data, children: h(DecisionLab) })))))));
  return { data, before };
}

const $ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector<T>(sel);
const run = () => $('[data-testid="dl-run"]');
const results = () => $('[data-testid="dl-results"]', run()!);
/** Texte visible : espaces normalisées, marqueurs d'isolation bidirectionnelle retirés. */
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s/g, ' ').replace(/[\u2066-\u2069]/g, '');
const buttonIn = (scope: Element, label: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const type = (sel: string, value: string) =>
  act(async () => {
    const el = $<HTMLInputElement>(sel)!;
    setValue.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const decision = () => $('[data-testid="dl-decision"]')!;

/** Valide un placement : 20 000 DH + 1 500 DH par mois à 6 %. */
async function validateInvestment() {
  await click($('[data-testid="dl-kind-investment"]'));
  await type('#dl-f-initialCapital', '20000');
  await type('#dl-f-monthlyContribution', '1500');
  await type('#dl-f-effectiveRateBps', '6');
  await click(buttonIn(decision(), 'Valider les hypothèses'));
}
async function simulate(horizon: string) {
  await type('#dl-run-horizon', horizon);
  await click(buttonIn(run()!, 'Lancer la simulation') ?? buttonIn(run()!, 'Relancer la simulation'));
}

describe('parcours : décision validée → horizon → résultats', () => {
  it('la carte Simulation n\'apparaît qu\'après la validation des hypothèses', async () => {
    await render();
    expect(run()).toBeNull();
    await validateInvestment();
    expect(run()).not.toBeNull();
    expect($<HTMLInputElement>('#dl-run-name')!.value).toBe('Placement');
    expect($<HTMLInputElement>('#dl-run-horizon')!.value).toBe(''); // aucun horizon imposé
    expect(text(run())).toContain('De 1 à 480 mois.');
    expect(text(run())).toContain('Le mois 0 est le mois en cours.');
  });

  it('horizon obligatoire et borné : erreurs bloquantes, aucun résultat', async () => {
    await render();
    await validateInvestment();
    await click(buttonIn(run()!, 'Lancer la simulation'));
    expect(text($('#dl-run-horizon')!.closest('.flex-col'))).toContain('Ce champ est obligatoire.');
    await simulate('481');
    expect(text($('#dl-run-horizon')!.closest('.flex-col'))).toContain('L\'horizon doit être compris entre 1 et 480 mois.');
    await simulate('0');
    expect(text($('#dl-run-horizon')!.closest('.flex-col'))).toContain('L\'horizon doit être compris entre 1 et 480 mois.');
    expect(results()).toBeNull();
  });

  it('résultats sur l\'horizon réel : indicateurs, trajectoires et valeurs mois par mois du snapshot', async () => {
    await render();
    await validateInvestment();
    await simulate('120');
    const r = results()!;
    expect(text(r)).toContain('Résultats sur 120 mois');
    expect($('[data-testid="dl-run-status"]')!.textContent).toBe('Simulation en cours, non enregistrée');
    // Trésorerie : départ 50 000, sortie 20 000 au mois 0 puis 1 500 par mois pendant 120 mois.
    const cash = text($('[data-testid="dl-res-cash"]', r));
    // « Au départ » : situation initiale, avant le versement du capital au mois 0.
    expect(text($('[data-testid="dl-res-cash"] dd', r))).toBe('50.000,00 DH');
    expect(cash).toContain('50.000,00 DH');
    expect(cash).toContain('-150.000,00 DH'); // 50 000 − 20 000 − 120 × 1 500
    expect(text($('[data-testid="dl-res-cash-delta"]', r))).toContain('-200.000,00 DH');
    // Placement : valeur finale du moteur (référentiel E2 : 279 527,12 DH).
    expect(text($('[data-testid="dl-res-investment"]', r))).toContain('279.527,12 DH');
    expect(text($('[data-testid="dl-res-netWorth-delta"]', r))).toContain('+79.527,12 DH');
    expect(text($('[data-testid="dl-res-summary"]', r))).toContain('Patrimoine net après 120 mois : +79.527,12 DH par rapport à la situation sans décision.');
    // 30 000 après le capital, −1 500 par mois : 0 au mois 20, négative au mois 21 (avertissement non bloquant).
    expect($('[data-notice="negativeCash"]', r)!.getAttribute('role')).toBe('alert');
    expect(text($('[data-notice="negativeCash"]', r))).toContain('à partir du mois 21');
    expect(text($('[data-testid="dl-res-first-negative"]', r))).toContain('21');
    // Graphiques : trésorerie, patrimoine et solde du placement (détail du moteur).
    for (const id of ['dl-chart-cash', 'dl-chart-networth', 'dl-chart-extra']) expect($(`[data-testid="${id}"]`, r), id).not.toBeNull();
    expect(text($('[data-testid="dl-chart-extra"]', r))).toContain('Solde du compte dédié');
    // Valeurs exactes : 121 lignes (mois 0 à 120), sans interpolation.
    await click(buttonIn(r, 'Voir les valeurs mois par mois'));
    const rows = r.querySelectorAll('[data-testid="dl-res-table"] tbody tr');
    expect(rows).toHaveLength(121);
    expect(text(rows[0])).toContain('0 · nov'); // mois 0 = mois en cours (novembre 2026)
    expect(text(rows[120])).toContain('-150.000,00 DH');
    expect(text($('[data-testid="dl-res-limits"]', r))).toContain('sans inflation, fiscalité ni frais de gestion');
  });

  it('enregistrement : snapshot identique à l\'affichage, ajouté à l\'historique, jamais en double', async () => {
    const { data, before } = await render();
    await validateInvestment();
    await simulate('60');
    const shown = text($('[data-testid="dl-res-investment"]', results()!));
    const save = buttonIn(run()!, 'Enregistrer dans mes simulations')!;
    await click(save);
    expect($('[data-testid="dl-run-status"]')!.textContent).toBe('Simulation enregistrée');
    expect(save.disabled).toBe(true);
    await click(save);
    const stored = loadSimulations().simulations;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'Placement', hypotheses: { horizonMonths: 60, startMonth: '2026-11', situation: { cash: 5_000_000 } } });
    expect(document.querySelectorAll('[data-testid="dl-simulation"]')).toHaveLength(1);
    // Historique : résultats relus du snapshot, identiques à ceux affichés.
    await click(buttonIn($('[data-testid="dl-simulation"]')!, 'Détails'));
    const hist = $('[data-testid="dl-details"] [data-testid="dl-results"]')!;
    expect(text($('[data-testid="dl-res-investment"]', hist))).toBe(shown);
    expect($('[data-testid="dl-chart-extra"]', hist)).toBeNull(); // détail mensuel non stocké
    // Relancer crée une nouvelle simulation, sans toucher à la première.
    await simulate('24');
    await click(buttonIn(run()!, 'Enregistrer dans mes simulations'));
    expect(loadSimulations().simulations.map((s) => s.hypotheses.horizonMonths).sort()).toEqual([24, 60]);
    // Données financières réelles intactes ; seule la clé dédiée est écrite.
    expect(JSON.stringify(data)).toBe(before);
    expect(await repo.snapshot()).toBeNull();
    expect(Object.keys(sessionStorage).filter((k) => k !== 'nexora.month')).toEqual([DECISION_STORE_KEY]);
  });

  it('limite de 50 atteinte : enregistrement refusé avec explication, rien n\'est supprimé', async () => {
    for (let k = 1; k <= MAX_SIMULATIONS; k++) {
      saveSimulation(createSnapshot({ name: `S${k}`, situation: { cash: 1, netWorth: 1, monthlySavings: 0 }, horizonMonths: 1, variants: [{ id: 'v', decision: { kind: 'recurring', monthlyAmount: 1 } }], id: `s-${k}` }));
    }
    const raw = sessionStorage.getItem(DECISION_STORE_KEY);
    await render();
    await validateInvestment();
    await simulate('12');
    await click(buttonIn(run()!, 'Enregistrer dans mes simulations'));
    expect($('[data-testid="dl-run-save-error"]')!.textContent).toContain('Limite de 50 simulations atteinte');
    expect(sessionStorage.getItem(DECISION_STORE_KEY)).toBe(raw);
  });

  it('modifier les hypothèses efface le résultat ; relancer donne le nouveau résultat', async () => {
    await render();
    await validateInvestment();
    await simulate('12');
    expect(results()).not.toBeNull();
    await click(buttonIn(decision(), 'Modifier'));
    expect(run()).toBeNull(); // décision retirée : plus de simulation affichée
    await type('#dl-f-monthlyContribution', '1000');
    await click(buttonIn(decision(), 'Valider les hypothèses'));
    expect(results()).toBeNull();
    await simulate('12');
    expect(text($('[data-testid="dl-res-investment"]', results()!))).toContain('32.000,00 DH'); // 20 000 + 12 × 1 000 (versements)
  });

  it('ajuster la situation initiale efface le résultat affiché', async () => {
    await render();
    await validateInvestment();
    await simulate('12');
    const situation = $('[data-testid="dl-situation"]')!;
    await click(buttonIn(situation, 'Modifier'));
    await type('#dl-situation-cash', '100000');
    await click(buttonIn(situation, 'Valider la situation'));
    expect(results()).toBeNull();
    await simulate('12');
    expect(text($('[data-testid="dl-res-cash"]', results()!))).toContain('100.000,00 DH');
  });
});

describe('types de décision : indicateurs propres', () => {
  it('achat financé : crédit (mensualité, intérêts) et dette restante au-delà de l\'horizon', async () => {
    await render();
    await click($('[data-testid="dl-kind-purchase"]'));
    await type('#dl-f-price', '180000');
    await type('#dl-f-downPayment', '30000');
    await type('#dl-f-fees', '1500');
    await click($('#dl-financed'));
    await type('#dl-f-loan-nominalRateBps', '7');
    await type('#dl-f-loan-months', '48');
    await click(buttonIn(decision(), 'Valider les hypothèses'));
    await simulate('12');
    const loan = text($('[data-testid="dl-res-loan"]', results()!));
    expect(loan).toContain('3.591,94 DH'); // mensualité (référentiel E2)
    expect(loan).toContain('22.412,96 DH'); // intérêts totaux
    expect($('[data-notice="loanBeyondHorizon"]', results()!)!.getAttribute('role')).toBe('status');
    expect(text($('[data-testid="dl-chart-extra"]', results()!))).toContain('Capital restant dû');
    expect(text($('[data-testid="dl-res-limits"]', results()!))).toContain('aucune dépréciation');
  });

  it('objectif : atteint au mois 24 ; dépense récurrente : aucun indicateur inventé', async () => {
    await render();
    await click($('[data-testid="dl-kind-goal"]'));
    await type('#dl-f-target', '60000');
    await type('#dl-f-effectiveRateBps', '3');
    await type('#dl-f-months', '24');
    await click(buttonIn(decision(), 'Valider les hypothèses'));
    await simulate('24');
    const goal = text($('[data-testid="dl-res-goal"]', results()!));
    expect(goal).toContain('2.429,83 DH'); // effort mensuel (référentiel E2)
    expect(text($('[data-testid="dl-res-goal-reached"]', results()!))).toContain('24');
    // Cible atteinte dans l'horizon : aucun avertissement d'objectif. 24 × 2 429,83 DH dépassent
    // la trésorerie de départ (50 000 DH) : seul l'avertissement de trésorerie négative est attendu.
    expect([...results()!.querySelectorAll('[data-notice]')].map((n) => n.getAttribute('data-notice'))).toEqual(['negativeCash']);

    await click(buttonIn(decision(), 'Changer de type'));
    await click($('[data-testid="dl-kind-recurring"]'));
    await type('#dl-f-monthlyAmount', '500');
    await click(buttonIn(decision(), 'Valider les hypothèses'));
    await simulate('12');
    const r = results()!;
    for (const id of ['dl-res-loan', 'dl-res-goal', 'dl-res-investment', 'dl-chart-extra']) expect($(`[data-testid="${id}"]`, r), id).toBeNull();
    expect(text($('[data-testid="dl-res-cash-delta"]', r))).toContain('-6.000,00 DH');
  });
});

describe('objectif d\'épargne : totaux sur l\'horizon simulé (A2)', () => {
  async function goalContribution(monthly: string, horizon: string) {
    await click($('[data-testid="dl-kind-goal"]'));
    await click([...decision().querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Versement fixé'));
    await type('#dl-f-target', '60000');
    await type('#dl-f-effectiveRateBps', '0');
    await type('#dl-f-monthlyContribution', monthly);
    await click(buttonIn(decision(), 'Valider les hypothèses'));
    await simulate(horizon);
    return results()!;
  }

  it('cible non atteinte : versé sur les 60 mois = 6 000 DH (jamais le total sur 480 mois), aucune atteinte affichée', async () => {
    await render();
    const r = await goalContribution('100', '60');
    const goal = $('[data-testid="dl-res-goal"]', r)!;
    expect(text($('[data-testid="dl-res-goal-contributed"]', goal))).toBe('Versé sur les 60 mois simulés6.000,00 DH');
    expect(text($('[data-testid="dl-res-goal-interest"]', goal))).toContain('0,00 DH');
    expect(text($('[data-testid="dl-res-goal-final"]', goal))).toContain('6.000,00 DH');
    expect(text($('[data-testid="dl-res-goal-reached"]', goal))).toContain('Non atteinte en 480 mois');
    expect($('[data-testid="dl-res-goal-to-reach"]', goal)).toBeNull();
    expect(text(goal)).not.toContain('48.000,00');
    // Même période que la trésorerie : écart de trésorerie = −versé sur l'horizon.
    expect(text($('[data-testid="dl-res-cash-delta"]', r))).toContain('-6.000,00 DH');
  });

  it('cible atteinte après l\'horizon : mois d\'atteinte signalé, versements nécessaires distincts du versé sur l\'horizon', async () => {
    await render();
    const r = await goalContribution('2000', '24'); // atteinte au mois 30
    const goal = $('[data-testid="dl-res-goal"]', r)!;
    expect(text($('[data-testid="dl-res-goal-reached"]', goal))).toContain('Mois 30 (après l\'horizon)');
    expect(text($('[data-testid="dl-res-goal-to-reach"]', goal))).toBe('Versements nécessaires pour atteindre la cible (jusqu\'au mois 30)60.000,00 DH');
    expect(text($('[data-testid="dl-res-goal-contributed"]', goal))).toBe('Versé sur les 24 mois simulés48.000,00 DH');
  });
});

describe('valeurs extrêmes (A3)', () => {
  it('patrimoine initial extrême et placement : message explicite, aucun résultat, aucune exception', async () => {
    const thrown: unknown[] = [];
    const onError = (e: ErrorEvent) => thrown.push(e.error);
    window.addEventListener('error', onError);
    try {
      await render();
      const situation = $('[data-testid="dl-situation"]')!;
      await click(buttonIn(situation, 'Modifier'));
      await type('#dl-situation-netWorth', '90071992547409');
      await click(buttonIn(situation, 'Valider la situation'));
      await click($('[data-testid="dl-kind-investment"]'));
      await type('#dl-f-initialCapital', '100000');
      await type('#dl-f-monthlyContribution', '0');
      await type('#dl-f-effectiveRateBps', '10');
      await click(buttonIn(decision(), 'Valider les hypothèses'));
      await simulate('120');
      expect(text($('[data-testid="dl-run-error"]'))).toBe('Ces montants sont trop élevés pour être simulés.');
      expect(results()).toBeNull();
      // Situation corrigée (patrimoine représentable) : la même décision aboutit.
      await click(buttonIn(situation, 'Modifier'));
      await type('#dl-situation-netWorth', '300000');
      await click(buttonIn(situation, 'Valider la situation'));
      await simulate('120');
      expect(results()).not.toBeNull();
      expect($('[data-testid="dl-run-error"]')).toBeNull();
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(thrown).toEqual([]);
  });
});

describe('décision sans effet dans l\'horizon (A4)', () => {
  it('dépense commençant au mois 24, horizon 12 : avertissement contextualisé, aucun résultat présenté comme un avantage', async () => {
    await render();
    await click($('[data-testid="dl-kind-recurring"]'));
    await type('#dl-f-monthlyAmount', '500');
    await type('#dl-f-startMonth', '24');
    await click(buttonIn(decision(), 'Valider les hypothèses'));
    await simulate('12');
    const notice = $('[data-notice="noEffectAfterHorizon"]', results()!)!;
    expect(notice.getAttribute('role')).toBe('alert');
    expect(text(notice)).toBe('La dépense commence au mois 24, après la fin de l\'horizon (12 mois) : aucun effet n\'est simulé. Allongez l\'horizon pour en mesurer l\'impact.');
    // Horizon allongé jusqu'au premier mois de la dépense : effet réel, plus d'avertissement.
    await simulate('24');
    expect($('[data-notice="noEffectAfterHorizon"]', results()!)).toBeNull();
    expect(text($('[data-testid="dl-res-cash-delta"]', results()!))).toContain('-500,00 DH');
  });
});

describe('langue RTL', () => {
  it('arabe : libellés, résultats et erreurs traduits', async () => {
    activateMessages('ar', ar);
    await render();
    await click($('[data-testid="dl-kind-recurring"]'));
    await type('#dl-f-monthlyAmount', '500');
    await click(buttonIn(decision(), ar['dl.form.validate'] as string));
    await click(buttonIn(run()!, ar['dl.run.start'] as string));
    expect(text($('#dl-run-horizon')!.closest('.flex-col'))).toContain(ar['dl.err.required'] as string);
    await type('#dl-run-horizon', '12');
    await click(buttonIn(run()!, ar['dl.run.start'] as string));
    expect(text(results())).toContain((ar['dl.res.title'] as string).replace('{months}', '12'));
    expect(text(results())).toContain(ar['dl.res.series.with'] as string);
    expect(results()!.querySelectorAll('bdi').length).toBeGreaterThan(5);
  });
});
