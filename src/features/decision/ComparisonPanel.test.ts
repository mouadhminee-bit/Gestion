// @vitest-environment jsdom
/**
 * Decision Lab — étape E5.5 : comparateur multi-variantes dans la page (React, jsdom, données
 * fictives). Choix du mode → type commun → 2 à 4 variantes validées une à une → horizon commun →
 * comparaison → résultats → modification et relance → enregistrement → historique.
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
import { comparisonRows } from './comparisonRun';
import { activateMessages } from '@/i18n/core';
import ar from '@/i18n/locales/ar';
import he from '@/i18n/locales/he';
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
  repo = new LocalRepository(new NexoraDB(`dl-cmp-${++seq}`), UID);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(h(MemoryRouter, null, h(TooltipProvider, null, h(ToastProvider, null, h(ConfirmProvider, null, h(AppProvider, { repo, data, children: h(DecisionLab) })))))));
  return { data, before };
}

const $ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => [...scope.querySelectorAll<T>(sel)];
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s/g, ' ').replace(/[⁦-⁩]/g, '');
const buttonIn = (scope: Element, label: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const type = (sel: string, value: string) =>
  act(async () => {
    const el = $<HTMLInputElement>(sel)!;
    if (!el) throw new Error(`champ absent : ${sel}`);
    setValue.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const decision = () => $('[data-testid="dl-decision"]')!;
const builder = () => $('[data-testid="dl-cmp-builder"]')!;
const variants = () => $$('[data-testid="dl-cmp-variant"]');
const variant = (letter: string) => $(`[data-testid="dl-cmp-variant"][data-letter="${letter}"]`)!;
const panel = () => $('[data-testid="dl-cmp-run"]');
const results = () => $('[data-testid="dl-cmp-results"]', panel() ?? document.createElement('div'));
const indicator = (key: string, scope: ParentNode = results()!) => $(`[data-indicator="${key}"]`, scope)!;
const cell = (key: string, letter: string, what: 'value' | 'diff', scope?: ParentNode) => text($(`tr[data-variant="${letter}"] [data-testid="dl-cmp-${what}"]`, indicator(key, scope)));

async function compareMode() {
  await click(buttonIn(decision(), 'Comparaison (2 à 4 variantes)'));
}
/** Saisit un placement dans la variante de clé `key` (champs `dl-v{key}-f-…`). */
async function fillInvestment(key: number, initial: string, monthly: string, rate: string) {
  await type(`#dl-v${key}-f-initialCapital`, initial);
  await type(`#dl-v${key}-f-monthlyContribution`, monthly);
  await type(`#dl-v${key}-f-effectiveRateBps`, rate);
}
async function validate(letter: string) {
  await click(buttonIn(variant(letter), 'Valider la variante'));
}
/** Deux placements : A = 20 000 + 1 500/mois à 6 % ; B = 10 000 + 2 000/mois à 4 %. */
async function twoInvestments() {
  await compareMode();
  await click($('[data-testid="dl-cmp-kind-investment"]'));
  await fillInvestment(0, '20000', '1500', '6');
  await validate('A');
  await fillInvestment(1, '10000', '2000', '4');
  await validate('B');
}
async function launch(horizon: string) {
  await type('#dl-cmp-horizon', horizon);
  await click(buttonIn(panel()!, 'Lancer la comparaison') ?? buttonIn(panel()!, 'Relancer la comparaison'));
}

describe('choix du mode et saisie des variantes', () => {
  it('« Simulation simple / Comparaison » dans la carte Nouvelle décision ; les saisies de chaque mode sont conservées', async () => {
    await render();
    const modes = $$('[role="radio"]', decision()).map((b) => b.textContent);
    expect(modes).toEqual(['Simulation simple', 'Comparaison (2 à 4 variantes)']);
    expect(decision().dataset.mode).toBe('single');
    // Saisie en mode simple, puis passage en comparaison et retour : rien n'est perdu.
    await click($('[data-testid="dl-kind-recurring"]'));
    await type('#dl-f-monthlyAmount', '500');
    await compareMode();
    expect(decision().dataset.mode).toBe('compare');
    expect($('[data-testid="dl-single"]')!.hidden).toBe(true);
    expect(text(builder())).toContain('Choisissez le type de décision commun à toutes les variantes.');
    await click($('[data-testid="dl-cmp-kind-investment"]'));
    await type('#dl-v0-f-initialCapital', '1234');
    await click(buttonIn(decision(), 'Simulation simple'));
    expect($<HTMLInputElement>('#dl-f-monthlyAmount')!.value).toBe('500');
    await compareMode();
    expect($<HTMLInputElement>('#dl-v0-f-initialCapital')!.value).toBe('1234');
  });

  it('2 variantes au départ, noms modifiables, ajout jusqu\'à 4, retrait jusqu\'à 2, duplication', async () => {
    await render();
    await compareMode();
    await click($('[data-testid="dl-cmp-kind-recurring"]'));
    expect(variants().map((v) => v.dataset.letter)).toEqual(['A', 'B']);
    expect(variants().map((v) => $<HTMLInputElement>('input', v)!.value)).toEqual(['Variante A', 'Variante B']);
    expect(text(variant('A'))).toContain('Variante A : base des écarts');
    // Retrait impossible sous 2 variantes.
    expect(buttonIn(variant('A'), 'Retirer la variante — Variante A')!.disabled).toBe(true);
    const add = buttonIn(builder(), 'Ajouter une variante')!;
    await click(add);
    await click(add);
    expect(variants()).toHaveLength(4);
    expect(variants().map((v) => $<HTMLInputElement>('input', v)!.value)).toEqual(['Variante A', 'Variante B', 'Variante C', 'Variante D']);
    expect(add.disabled).toBe(true);
    expect(text(builder())).toContain('4 variantes au maximum.');
    // Nom par défaut : lettre de la position quand ce nom est libre.
    await click(buttonIn(variant('D'), 'Retirer la variante — Variante D'));
    await type('#dl-cmp-label-1', 'Loyer bas');
    await click(add);
    expect(variants().map((v) => $<HTMLInputElement>('input', v)!.value)).toEqual(['Variante A', 'Loyer bas', 'Variante C', 'Variante D']);
    await type('#dl-cmp-label-1', 'Variante B');
    await click(add); // sans effet
    expect(variants()).toHaveLength(4);
    // Retrait de B : C et D prennent les rangs B et C, leurs noms sont conservés.
    await click(buttonIn(variant('B'), 'Retirer la variante — Variante B'));
    expect(variants().map((v) => [v.dataset.letter, $<HTMLInputElement>('input', v)!.value])).toEqual([
      ['A', 'Variante A'],
      ['B', 'Variante C'],
      ['C', 'Variante D'],
    ]);
    // Renommer, puis dupliquer : la copie reprend les saisies, sans être validée.
    await type('#dl-cmp-label-0', 'Loyer actuel');
    await type('#dl-v0-f-monthlyAmount', '4500');
    await click(buttonIn(variant('A'), 'Dupliquer la variante — Loyer actuel'));
    expect(variants()).toHaveLength(4);
    const copy = variants()[3];
    expect($<HTMLInputElement>('input', copy)!.value).toBe('Variante A'); // « Variante D » est déjà pris : premier nom libre
    expect($<HTMLInputElement>('input[name="monthlyAmount"]', copy)!.value).toContain('4');
    expect($('[data-testid="dl-cmp-ready"]', copy)).toBeNull();
  });

  it('validation indépendante de chaque variante ; carte Comparaison seulement quand toutes sont validées', async () => {
    await render();
    await compareMode();
    await click($('[data-testid="dl-cmp-kind-investment"]'));
    await fillInvestment(0, '20000', '1500', '6');
    await validate('A');
    expect($('[data-testid="dl-cmp-ready"]', variant('A'))).not.toBeNull();
    expect(text($('[data-testid="dl-cmp-progress"]'))).toBe('Variantes validées : 1 / 2');
    // B vide : ses erreurs s'affichent dans B uniquement, A reste validée.
    await validate('B');
    expect(text(variant('B'))).toContain('Ce champ est obligatoire.');
    expect(text(variant('A'))).not.toContain('Ce champ est obligatoire.');
    expect($('[data-testid="dl-cmp-ready"]', variant('A'))).not.toBeNull();
    expect(panel()).toBeNull();
    await fillInvestment(1, '10000', '2000', '4');
    await validate('B');
    expect(text($('[data-testid="dl-cmp-progress"]'))).toBe('Variantes validées : 2 / 2');
    expect(panel()).not.toBeNull();
    expect($$('[data-testid="dl-cmp-run-variants"] li', panel()!).map((li) => text(li))).toEqual(['A · Variante A', 'B · Variante B']);
    // Une variante ajoutée non validée retire la carte (toutes doivent être validées).
    await click(buttonIn(builder(), 'Ajouter une variante'));
    expect(panel()).toBeNull();
    await click(buttonIn(variant('C'), 'Retirer la variante — Variante C'));
    expect(panel()).not.toBeNull();
    // Taux hors bornes du moteur : erreur sous le champ de la variante concernée.
    await click(buttonIn(variant('B'), 'Modifier'));
    await type('#dl-v1-f-effectiveRateBps', '45');
    await validate('B');
    expect(text(variant('B'))).toContain('Le taux doit être compris entre 0 et 30 %');
    expect(panel()).toBeNull();
  });

  it('noms des variantes : obligatoires et distincts (sinon la comparaison ne peut pas être lancée)', async () => {
    await render();
    await twoInvestments();
    expect(panel()).not.toBeNull();
    await type('#dl-cmp-label-1', ' variante a ');
    expect(text(variant('A'))).toContain('Ce nom est déjà utilisé par une autre variante.');
    expect(text(variant('B'))).toContain('Ce nom est déjà utilisé par une autre variante.');
    expect(panel()).toBeNull();
    await type('#dl-cmp-label-1', '');
    expect(text(variant('B'))).toContain('Ce champ est obligatoire.');
    expect(panel()).toBeNull();
    await type('#dl-cmp-label-1', 'Prudent');
    expect(panel()).not.toBeNull();
    expect(text($('[data-testid="dl-cmp-run-variants"]'))).toContain('Prudent');
  });

  it('changer de type invalide toutes les variantes (un seul type par comparaison) ; les saisies sont conservées', async () => {
    await render();
    await twoInvestments();
    await click(buttonIn(builder(), 'Changer de type'));
    await click($('[data-testid="dl-cmp-kind-recurring"]'));
    expect(builder().dataset.kind).toBe('recurring');
    expect($$('[data-testid="dl-cmp-ready"]')).toHaveLength(0);
    expect(panel()).toBeNull();
    await click(buttonIn(builder(), 'Changer de type'));
    await click($('[data-testid="dl-cmp-kind-investment"]'));
    expect($<HTMLInputElement>('#dl-v1-f-effectiveRateBps')!.value).toBe('4');
  });

  it('objectif d\'épargne : méthodes différentes d\'une variante à l\'autre', async () => {
    await render();
    await compareMode();
    await click($('[data-testid="dl-cmp-kind-goal"]'));
    await type('#dl-v0-f-target', '60000');
    await type('#dl-v0-f-effectiveRateBps', '3');
    await type('#dl-v0-f-months', '24');
    await validate('A');
    await click(buttonIn(variant('B'), 'Versement fixé'));
    await type('#dl-v1-f-target', '60000');
    await type('#dl-v1-f-effectiveRateBps', '3');
    await type('#dl-v1-f-monthlyContribution', '3000');
    await validate('B');
    await launch('36');
    const r = results()!;
    expect(cell('goalContribution', 'A', 'value')).toBe('2.429,83 DH'); // référentiel E2
    expect(cell('goalContribution', 'B', 'value')).toBe('3.000,00 DH');
    expect(cell('goalContribution', 'B', 'diff')).toBe('+570,17 DH');
    expect(text($('[data-testid="dl-cmp-mixed-modes"]', r))).toContain('Les variantes n\'utilisent pas toutes la même méthode');
  });
});

describe('comparaison : exécution, résultats, écarts', () => {
  it('horizon commun obligatoire et borné ; erreurs bloquantes, aucun résultat', async () => {
    await render();
    await twoInvestments();
    expect($<HTMLInputElement>('#dl-cmp-name')!.value).toBe('Comparaison · Placement');
    await click(buttonIn(panel()!, 'Lancer la comparaison'));
    expect(text($('#dl-cmp-horizon')!.closest('.flex-col'))).toContain('Ce champ est obligatoire.');
    await launch('481');
    expect(text($('#dl-cmp-horizon')!.closest('.flex-col'))).toContain('L\'horizon doit être compris entre 1 et 480 mois.');
    await type('#dl-cmp-name', '');
    await launch('12');
    expect(text($('#dl-cmp-name')!.closest('.flex-col'))).toContain('Ce champ est obligatoire.');
    expect(results()).toBeNull();
  });

  it('résultats : synthèse par variante, indicateurs, écarts « variante − A », trajectoires et valeurs exactes', async () => {
    await render();
    await twoInvestments();
    await launch('120');
    const r = results()!;
    expect(text(r)).toContain('Comparaison sur 120 mois');
    expect(text(r)).toContain('Placement · même situation initiale, même horizon');
    expect($('[data-testid="dl-cmp-run-status"]')!.textContent).toBe('Comparaison en cours, non enregistrée');
    expect($$('[data-testid="dl-cmp-summary"]', r).map((s) => s.dataset.variant)).toEqual(['A', 'B']);
    // A : valeur finale du moteur (référentiel E2 : 279 527,12 DH) ; écart de patrimoine +79 527,12 DH.
    expect(cell('invFinal', 'A', 'value')).toBe('279.527,12 DH');
    expect(text($('[data-testid="dl-cmp-summary"][data-variant="A"]', r))).toContain('Patrimoine net après 120 mois : +79.527,12 DH');
    // Trésorerie en fin d'horizon : A = 50 000 − 20 000 − 120 × 1 500 ; B = 50 000 − 10 000 − 120 × 2 000.
    expect(cell('endCash', 'A', 'value')).toBe('-150.000,00 DH');
    expect(cell('endCash', 'B', 'value')).toBe('-200.000,00 DH');
    expect(cell('endCash', 'B', 'diff')).toBe('-50.000,00 DH'); // B − A
    expect(cell('invContributions', 'B', 'diff')).toBe('+50.000,00 DH'); // 250 000 − 200 000
    expect(text($('tr[data-variant="A"]', indicator('endCash')))).toContain('base');
    expect(text($('[data-testid="dl-cmp-sign-rule"]', r))).toBe(
      'Écart = valeur de la variante − valeur de la variante de base (A · Variante A). Un écart positif indique une valeur plus élevée, un écart négatif une valeur plus faible ; il ne dit pas si la variante est préférable.',
    );
    // Premier mois négatif : A au mois 21 (référentiel E5.4), B : 40 000 − 2 000 × m < 0 au mois 21.
    expect(cell('firstNegativeCashMonth', 'A', 'value')).toBe('21');
    expect(cell('firstNegativeCashMonth', 'B', 'value')).toBe('21');
    expect(cell('firstNegativeCashMonth', 'B', 'diff')).toBe('0');
    // Avertissements propres à chaque variante.
    expect($('[data-testid="dl-cmp-summary"][data-variant="A"] [data-notice="negativeCash"]', r)!.getAttribute('role')).toBe('alert');
    // Aucun qualificatif : ni « meilleure » ni « rentable ».
    expect(text(r)).not.toMatch(/meilleur|rentable|recommand/i);
    // Graphiques : trésorerie, patrimoine, solde du compte dédié (détail du moteur), une série par variante.
    for (const id of ['dl-cmp-chart-cash', 'dl-cmp-chart-networth', 'dl-cmp-chart-extra']) expect($(`[data-testid="${id}"]`, r), id).not.toBeNull();
    expect(text($('[data-testid="dl-cmp-chart-cash"]', r))).toContain('Sans la décision');
    expect(text($('[data-testid="dl-cmp-chart-cash"]', r))).toContain('B · Variante B');
    expect($('[data-testid="dl-cmp-chart-cash"] [role="img"]', r)!.getAttribute('dir')).toBe('ltr');
    // Valeurs exactes : 121 lignes, colonnes référence + A + B ; changement de série.
    await click(buttonIn(r, 'Voir les valeurs mois par mois'));
    const table = () => $('[data-testid="dl-cmp-table"]', r)!;
    expect(table().dataset.series).toBe('cash');
    const rows = $$('tbody tr', table());
    expect(rows).toHaveLength(121);
    expect(text(rows[0])).toContain('0 · nov');
    expect(text(rows[120])).toContain('-150.000,00 DH');
    expect(text(rows[120])).toContain('-200.000,00 DH');
    expect($$('thead th', table()).map((th) => text(th))).toEqual(['Mois', 'Sans la décision', 'A · Variante A', 'B · Variante B']);
    await click(buttonIn(r, 'Solde du compte dédié'));
    expect(table().dataset.series).toBe('extra');
    expect(text($$('tbody tr', table())[120])).toContain('279.527,12 DH');
    expect(text($('[data-testid="dl-cmp-limits"]', r))).toContain('ne tiennent compte d\'aucun critère personnel');
  });

  it('modifier une variante efface le résultat ; relancer donne le nouveau résultat', async () => {
    await render();
    await twoInvestments();
    await launch('12');
    expect(results()).not.toBeNull();
    await click(buttonIn(variant('B'), 'Modifier'));
    expect(panel()).toBeNull(); // variante B non validée : plus de comparaison affichée
    await type('#dl-v1-f-monthlyContribution', '1000');
    await validate('B');
    expect(results()).toBeNull();
    await launch('12');
    expect(cell('invContributions', 'B', 'value')).toBe('22.000,00 DH'); // 10 000 + 12 × 1 000
    // Renommer une variante efface aussi le résultat (le nom fait partie des hypothèses enregistrées).
    await type('#dl-cmp-label-0', 'Dynamique');
    expect(results()).toBeNull();
    // Ajuster la situation initiale efface le résultat affiché.
    await launch('12');
    const situation = $('[data-testid="dl-situation"]')!;
    await click(buttonIn(situation, 'Modifier'));
    await type('#dl-situation-cash', '100000');
    await click(buttonIn(situation, 'Valider la situation'));
    expect(results()).toBeNull();
    await launch('12');
    expect(cell('endCash', 'A', 'value')).toBe('62.000,00 DH'); // 100 000 − 20 000 − 12 × 1 500
  });

  it('achat : comptant contre crédit, indicateurs du crédit et capital restant dû', async () => {
    await render();
    await compareMode();
    await click($('[data-testid="dl-cmp-kind-purchase"]'));
    for (const key of [0, 1]) {
      await type(`#dl-v${key}-f-price`, '180000');
      await type(`#dl-v${key}-f-fees`, '1500');
    }
    await type('#dl-v0-f-downPayment', '30000');
    await click($('#dl-v0-f-financed'));
    await type('#dl-v0-f-loan-nominalRateBps', '7');
    await type('#dl-v0-f-loan-months', '48');
    await validate('A');
    await type('#dl-v1-f-downPayment', '180000');
    await validate('B');
    await launch('60');
    expect(cell('loanInstallment', 'A', 'value')).toBe('3.591,94 DH'); // référentiel E2
    expect(cell('loanInterest', 'A', 'value')).toBe('22.412,96 DH');
    expect(cell('loanInstallment', 'B', 'value')).toBe('Sans crédit');
    expect(cell('loanInstallment', 'B', 'diff')).toBe('—');
    expect(text($('[data-testid="dl-cmp-chart-extra"]', results()!))).toContain('Capital restant dû');
    expect($('[data-testid="dl-cmp-summary"][data-variant="B"] [data-notice="negativeCash"]', results()!)).not.toBeNull();
    expect(text($('[data-testid="dl-cmp-limits"]', results()!))).toContain('aucune dépréciation');
  });

  it('dépense récurrente : 4 variantes, seulement les indicateurs fournis par le moteur', async () => {
    await render();
    await compareMode();
    await click($('[data-testid="dl-cmp-kind-recurring"]'));
    await click(buttonIn(builder(), 'Ajouter une variante'));
    await click(buttonIn(builder(), 'Ajouter une variante'));
    for (const [key, amount] of [[0, '500'], [1, '700'], [2, '300'], [3, '1000']] as const) {
      await type(`#dl-v${key}-f-monthlyAmount`, amount);
      await validate('ABCD'[key]);
    }
    await launch('12');
    const r = results()!;
    expect($$('[data-testid="dl-cmp-summary"]', r)).toHaveLength(4);
    expect($$('[data-testid="dl-cmp-indicator"]', r).map((i) => i.dataset.indicator)).toEqual(['endCash', 'endCashDelta', 'endNetWorth', 'endNetWorthDelta', 'lowestCash', 'lowestCashMonth', 'firstNegativeCashMonth']);
    expect(cell('endCashDelta', 'D', 'value')).toBe('-12.000,00 DH');
    expect(cell('endCashDelta', 'D', 'diff')).toBe('-6.000,00 DH'); // D − A = −12 000 − (−6 000)
    expect(cell('endCashDelta', 'C', 'diff')).toBe('+2.400,00 DH');
    expect($('[data-testid="dl-cmp-chart-extra"]', r)).toBeNull();
  });
});

describe('enregistrement et historique', () => {
  it('snapshot identique à l\'affichage, ajouté à l\'historique, relu sans recalcul, jamais en double', async () => {
    const { data, before } = await render();
    await twoInvestments();
    await launch('60');
    const shown = text(indicator('invFinal'));
    const save = buttonIn(panel()!, 'Enregistrer dans mes simulations')!;
    await click(save);
    expect($('[data-testid="dl-cmp-run-status"]')!.textContent).toBe('Comparaison enregistrée');
    expect(save.disabled).toBe(true);
    await click(save);
    const stored = loadSimulations().simulations;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      name: 'Comparaison · Placement',
      hypotheses: { horizonMonths: 60, startMonth: '2026-11', situation: { cash: 5_000_000 }, variants: [{ id: 'A', label: 'Variante A' }, { id: 'B', label: 'Variante B' }] },
    });
    // Historique : badge « Comparaison », résultats relus du snapshot, identiques à ceux affichés.
    const item = $('[data-testid="dl-simulation"]')!;
    expect(text($('[data-testid="dl-comparison-badge"]', item))).toBe('Comparaison');
    await click(buttonIn(item, 'Détails'));
    const hist = $('[data-testid="dl-details"] [data-testid="dl-cmp-results"]')!;
    expect(text(indicator('invFinal', hist))).toBe(shown);
    expect($('[data-testid="dl-cmp-chart-extra"]', hist)).toBeNull(); // détail mensuel non stocké
    expect(text($('[data-testid="dl-cmp-limits"]', hist))).toContain('Comparaison enregistrée : seules les séries de trésorerie et de patrimoine sont conservées');
    // Valeurs exactes de l'historique : celles du snapshot enregistré.
    await click(buttonIn(hist, 'Voir les valeurs mois par mois'));
    const rows = $$('[data-testid="dl-cmp-table"] tbody tr', hist);
    const expected = comparisonRows(stored[0]);
    expect(rows).toHaveLength(61);
    expect(text(rows[60])).toContain(`${(expected[60].cash[1] / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')} DH`);
    // Relancer crée une nouvelle comparaison, sans toucher à la première.
    await launch('24');
    await click(buttonIn(panel()!, 'Enregistrer dans mes simulations'));
    expect(loadSimulations().simulations.map((s) => s.hypotheses.horizonMonths).sort()).toEqual([24, 60]);
    expect(loadSimulations().simulations.find((s) => s.hypotheses.horizonMonths === 60)).toEqual(stored[0]);
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
    await twoInvestments();
    await launch('12');
    await click(buttonIn(panel()!, 'Enregistrer dans mes simulations'));
    expect($('[data-testid="dl-cmp-save-error"]')!.textContent).toContain('Limite de 50 simulations atteinte');
    expect(sessionStorage.getItem(DECISION_STORE_KEY)).toBe(raw);
  });

  it('stockage indisponible : erreur explicite, résultat conservé à l\'écran', async () => {
    await render();
    await twoInvestments();
    await launch('12');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await click(buttonIn(panel()!, 'Enregistrer dans mes simulations'));
    expect($('[data-testid="dl-cmp-save-error"]')!.textContent).toContain("n'a pas pu être enregistrée");
    expect(results()).not.toBeNull();
    expect(loadSimulations().simulations).toHaveLength(0);
  });

  it('simulation simple inchangée à côté du comparateur', async () => {
    await render();
    await click($('[data-testid="dl-kind-recurring"]'));
    await type('#dl-f-monthlyAmount', '500');
    await click(buttonIn(decision(), 'Valider les hypothèses'));
    expect($('[data-testid="dl-run"]')).not.toBeNull();
    // En mode comparaison, la carte de simulation simple n'est pas affichée (et revient ensuite).
    await compareMode();
    expect($('[data-testid="dl-run"]')).toBeNull();
    await click(buttonIn(decision(), 'Simulation simple'));
    expect($('[data-testid="dl-run"]')).not.toBeNull();
    expect($('[data-testid="dl-cmp-run"]')).toBeNull();
  });
});

describe('langues RTL', () => {
  for (const [lang, msgs] of [
    ['ar', ar],
    ['he', he],
  ] as const) {
    it(`${lang} : libellés, résultats et montants isolés`, async () => {
      activateMessages(lang, msgs);
      await render();
      const m = msgs as Record<string, string>;
      await click(buttonIn(decision(), m['dl.mode.compare'].replace('{min}', '2').replace('{max}', '4')));
      await click($('[data-testid="dl-cmp-kind-recurring"]'));
      expect($<HTMLInputElement>('#dl-cmp-label-0')!.value).toBe(m['dl.cmp.variantName'].replace('{letter}', 'A'));
      await type('#dl-v0-f-monthlyAmount', '500');
      await click(buttonIn(variant('A'), m['dl.cmp.validate']));
      await type('#dl-v1-f-monthlyAmount', '800');
      await click(buttonIn(variant('B'), m['dl.cmp.validate']));
      await click(buttonIn(panel()!, m['dl.cmp.run.start']));
      expect(text($('#dl-cmp-horizon')!.closest('.flex-col'))).toContain(m['dl.err.required']);
      await type('#dl-cmp-horizon', '12');
      await click(buttonIn(panel()!, m['dl.cmp.run.start']));
      const r = results()!;
      expect(text(r)).toContain(m['dl.cmp.res.title'].replace('{months}', '12'));
      expect(text(r)).toContain(m['dl.cmp.ind.title']);
      expect(r.querySelectorAll('bdi').length).toBeGreaterThan(20);
      // Montants insérés dans les phrases : isolés (ordre correct en RTL).
      expect($('[data-testid="dl-cmp-summary"] p', r)!.textContent).toMatch(/⁨.+⁩/);
      expect($('[data-testid="dl-cmp-chart-cash"] [role="img"]', r)!.getAttribute('dir')).toBe('ltr');
    });
  }
});
