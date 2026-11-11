/**
 * Decision Lab — moteur de simulation pur et déterministe (V1).
 *
 * Simule l'IMPACT INCRÉMENTAL d'une décision hypothétique par rapport à une situation de
 * référence sans décision, mois par mois (mois 0 = aujourd'hui, mois m = fin du m-ième mois).
 * Le moteur ne lit ni n'écrit aucune donnée : il reçoit des nombres et renvoie de nouveaux
 * objets (aucune entrée n'est modifiée). Conventions et limites : docs/DECISION_LAB.md.
 *
 * Conventions validées (oracle indépendant : references/decision-lab/) :
 *  - montants en centimes entiers (devise de base uniquement), taux en points de base ;
 *  - taux annuel EFFECTIF (placement, objectif) → i = (1 + R)^(1/12) − 1 (H1) ;
 *  - taux NOMINAL du crédit → i = taux / 12 (H5) ;
 *  - intérêts de chaque mois arrondis au centime, demi vers l'extérieur (H4) ;
 *  - mensualité arrondie au centime, dernière échéance ajustée pour solder (H6) ;
 *  - effort d'épargne arrondi au centime supérieur (H7), dernier versement plafonné (H14) ;
 *  - après l'atteinte d'un objectif : versements arrêtés, capital conservé et rémunéré (H15) ;
 *  - versements en fin de mois (H2), capital initial au mois 0 (H3) ;
 *  - achat : apport et frais au mois 0, crédit versé au vendeur, bien à l'actif au mois 0 (H11) ;
 *  - référence : trésorerie non dépensée non rémunérée (H12) ;
 *  - horizon ≤ 480 mois (H10), taux ≤ 30 % ; pas d'inflation, de fiscalité ni de frais de gestion.
 *
 * Arithmétique : les arrondis sont faits sur des rationnels EXACTS (BigInt). `roundHalfAwayFromZero`
 * (money.ts) opère sur des flottants et ne peut pas garantir l'arrondi exact de b × 7/1200 ou d'une
 * mensualité ; le taux effectif mensuel (irrationnel) est calculé en virgule fixe à 10^-50.
 */
import type { MonthKey } from '../dates';
import { addMonthsToKey } from '../dates';
import { ValidationError } from '../errors';

export const DECISION_ENGINE_VERSION = 1;
export const MAX_HORIZON_MONTHS = 480;
export const MAX_RATE_BPS = 3000;
export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 4;

// ------------------------------------------------------------------ entrées

export interface PurchaseDecision {
  kind: 'purchase';
  /** Prix du bien. */
  price: number;
  /** Apport (mois 0). Achat comptant : apport = prix, sans crédit. */
  downPayment: number;
  /** Frais initiaux (mois 0), perdus pour le patrimoine. */
  fees: number;
  /** Valeur inscrite à l'actif (par défaut : prix). Aucune dépréciation en V1. */
  assetValue?: number;
  /** Crédit de (prix − apport), versé directement au vendeur. Obligatoire si prix > apport. */
  loan?: { nominalRateBps: number; months: number } | null;
  /** Assurance mensuelle (fin de mois), pendant `insuranceMonths` (par défaut : durée du crédit). */
  insuranceMonthly?: number;
  insuranceMonths?: number | null;
}

export interface RecurringExpenseDecision {
  kind: 'recurring';
  monthlyAmount: number;
  /** Premier mois de dépense (1 par défaut). */
  startMonth?: number;
  /** Nombre de mois ; null / absent : jusqu'à l'horizon. */
  months?: number | null;
}

export type SavingsGoalDecision =
  | { kind: 'goal'; mode: 'effort'; target: number; effectiveRateBps: number; months: number }
  | { kind: 'goal'; mode: 'contribution'; target: number; effectiveRateBps: number; monthlyContribution: number; deadlineMonths?: number | null };

export interface InvestmentDecision {
  kind: 'investment';
  initialCapital: number;
  monthlyContribution: number;
  /** Nombre de versements ; null / absent : jusqu'à l'horizon. */
  contributionMonths?: number | null;
  effectiveRateBps: number;
}

export type DecisionInput = PurchaseDecision | RecurringExpenseDecision | SavingsGoalDecision | InvestmentDecision;

export interface SimulationOptions {
  horizonMonths: number;
  /** Mois calendaire du mois 0 (facultatif) : renseigne `monthKey` sur chaque ligne. */
  startMonth?: MonthKey;
}

/** Situation de référence, en devise de base (voir decisionSituation.ts). */
export interface InitialSituation {
  cash: number;
  netWorth: number;
  /** Épargne mensuelle de référence (revenus − dépenses), constante, non rémunérée (H12). */
  monthlySavings: number;
}

// ------------------------------------------------------------------ sorties

/** Flux de trésorerie du mois (négatif = décaissement). */
export interface DecisionFlows {
  initial: number;
  fees: number;
  installment: number;
  /** Composantes de l'échéance (somme = installment). */
  loanInterest: number;
  loanPrincipal: number;
  insurance: number;
  expense: number;
  contribution: number;
}

export interface DecisionMonth {
  month: number;
  monthKey?: MonthKey;
  flows: DecisionFlows;
  cashFlow: number;
  /** Écart de trésorerie cumulé depuis le mois 0. */
  cumulativeCash: number;
  /** Actif créé par la décision (bien, placement, épargne affectée). */
  assets: number;
  /** Dette restante créée par la décision. */
  liabilities: number;
  /** Impact sur le patrimoine net = actif − dette + écart de trésorerie cumulé. */
  netWorthImpact: number;
  netWorthChange: number;
}

export interface LoanRow {
  month: number;
  openingBalance: number;
  installment: number;
  interest: number;
  principal: number;
  closingBalance: number;
}

export interface LoanSchedule {
  amount: number;
  nominalRateBps: number;
  /** Durée contractuelle (base du calcul de la mensualité). */
  months: number;
  /** Nombre d'échéances réellement payées (< months si l'arrondi solde le crédit avant terme). */
  actualMonths: number;
  /** Mois du remboursement anticipé dû à l'arrondi de la mensualité (null : échéancier complet). */
  earlyPayoffMonth: number | null;
  installment: number;
  lastInstallment: number;
  totalInterest: number;
  totalPaid: number;
  rows: LoanRow[];
}

export interface SavingsRow {
  month: number;
  openingBalance: number;
  interest: number;
  contribution: number;
  closingBalance: number;
  /** Capital initial inclus. */
  cumulativeContributions: number;
  cumulativeInterest: number;
}

export interface GoalOutcome {
  mode: 'effort' | 'contribution';
  monthlyContribution: number;
  /** Mois d'atteinte (null : non atteint en 480 mois). */
  reachedMonth: number | null;
  lastContribution: number;
  /**
   * Versements et intérêts de l'ÉCHÉANCIER, du mois 1 au mois d'atteinte (ou jusqu'à 480 mois si la
   * cible n'est pas atteinte) : période propre à l'objectif, différente de l'horizon simulé.
   */
  totalContributed: number;
  totalInterest: number;
  /** Total des versements nécessaires pour atteindre la cible (null : cible non atteinte en 480 mois). */
  contributionsToReach: number | null;
  /** Versements réellement effectués du mois 1 à la fin de l'horizon simulé. */
  contributedToHorizon: number;
  /** Intérêts acquis du mois 1 à la fin de l'horizon (rendement après atteinte compris, H15). */
  interestToHorizon: number;
  /** Solde du compte dédié au mois d'atteinte (null : non atteint). */
  balanceAtReach: number | null;
  deadlineMonths: number | null;
  reachedByDeadline: boolean | null;
  /** Solde réel du compte dédié à l'échéance (rendement après atteinte compris). */
  balanceAtDeadline: number | null;
  /** Montant manquant à l'échéance (0 si la cible est atteinte). */
  shortfallAtDeadline: number | null;
  /** Solde du compte dédié à l'horizon de simulation. */
  finalBalance: number;
  /** Intérêts acquis après l'atteinte, jusqu'à l'horizon. */
  interestAfterReach: number;
  /** Échéancier jusqu'à l'atteinte (ou 480 mois). */
  schedule: SavingsRow[];
}

export interface DecisionSummary {
  finalCumulativeCash: number;
  finalNetWorthImpact: number;
  finalAssets: number;
  finalLiabilities: number;
  lowestCumulativeCash: number;
  lowestCumulativeCashMonth: number;
}

export interface DecisionResult {
  engineVersion: number;
  kind: DecisionInput['kind'];
  horizonMonths: number;
  months: DecisionMonth[];
  summary: DecisionSummary;
  loan?: LoanSchedule;
  savings?: SavingsRow[];
  goal?: GoalOutcome;
}

// ------------------------------------------------------------------ validation

export interface DecisionIssue {
  field: string;
  code: string;
}

/** Entrée invalide : `issues` liste chaque champ fautif (codes stables, traduits par l'interface). */
export class DecisionInputError extends ValidationError {
  constructor(public readonly issues: DecisionIssue[]) {
    super('decision.invalid', Object.fromEntries(issues.map((i) => [i.field, i.code])));
    this.name = 'DecisionInputError';
  }
}

function intIssue(issues: DecisionIssue[], field: string, v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    issues.push({ field, code: 'notInteger' });
    return false;
  }
  if (v < min) {
    issues.push({ field, code: min > 0 ? 'notPositive' : 'negative' });
    return false;
  }
  if (v > max) {
    issues.push({ field, code: 'tooLarge' });
    return false;
  }
  return true;
}

const optional = (v: unknown) => v === undefined || v === null;

export function validateDecision(d: DecisionInput, options: SimulationOptions): DecisionIssue[] {
  const issues: DecisionIssue[] = [];
  intIssue(issues, 'horizonMonths', options.horizonMonths, 1, MAX_HORIZON_MONTHS);
  if (options.startMonth !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(options.startMonth)) issues.push({ field: 'startMonth', code: 'invalidMonth' });
  const rate = (field: string, v: unknown) => {
    const before = issues.length;
    intIssue(issues, field, v, 0, MAX_RATE_BPS);
    if (issues.length > before && issues[before].code === 'tooLarge') issues[before].code = 'rateOutOfRange';
  };
  switch (d?.kind) {
    case 'purchase': {
      const okPrice = intIssue(issues, 'price', d.price, 0);
      const okDown = intIssue(issues, 'downPayment', d.downPayment, 0);
      intIssue(issues, 'fees', d.fees, 0);
      if (!optional(d.assetValue)) intIssue(issues, 'assetValue', d.assetValue, 0);
      if (okPrice && okDown) {
        if (d.downPayment > d.price) issues.push({ field: 'downPayment', code: 'exceedsPrice' });
        else if (d.price > d.downPayment && !d.loan) issues.push({ field: 'loan', code: 'loanRequired' });
        else if (d.price === d.downPayment && d.loan) issues.push({ field: 'loan', code: 'loanNotAllowed' });
      }
      if (d.loan) {
        rate('loan.nominalRateBps', d.loan.nominalRateBps);
        intIssue(issues, 'loan.months', d.loan.months, 1, MAX_HORIZON_MONTHS);
      }
      const ins = d.insuranceMonthly ?? 0;
      if (intIssue(issues, 'insuranceMonthly', ins, 0) && ins > 0) {
        if (!optional(d.insuranceMonths)) intIssue(issues, 'insuranceMonths', d.insuranceMonths, 1, MAX_HORIZON_MONTHS);
        else if (!d.loan) issues.push({ field: 'insuranceMonths', code: 'required' });
      }
      break;
    }
    case 'recurring':
      intIssue(issues, 'monthlyAmount', d.monthlyAmount, 1);
      if (!optional(d.startMonth)) intIssue(issues, 'startMonth', d.startMonth, 1, MAX_HORIZON_MONTHS);
      if (!optional(d.months)) intIssue(issues, 'months', d.months, 1, MAX_HORIZON_MONTHS);
      break;
    case 'goal':
      intIssue(issues, 'target', d.target, 1);
      rate('effectiveRateBps', d.effectiveRateBps);
      if (d.mode === 'effort') intIssue(issues, 'months', d.months, 1, MAX_HORIZON_MONTHS);
      else if (d.mode === 'contribution') {
        intIssue(issues, 'monthlyContribution', d.monthlyContribution, 1);
        if (!optional(d.deadlineMonths)) intIssue(issues, 'deadlineMonths', d.deadlineMonths, 1, MAX_HORIZON_MONTHS);
      } else issues.push({ field: 'mode', code: 'unknownMode' });
      break;
    case 'investment':
      intIssue(issues, 'initialCapital', d.initialCapital, 0);
      intIssue(issues, 'monthlyContribution', d.monthlyContribution, 0);
      if (!optional(d.contributionMonths)) intIssue(issues, 'contributionMonths', d.contributionMonths, 0, MAX_HORIZON_MONTHS);
      rate('effectiveRateBps', d.effectiveRateBps);
      if (d.initialCapital === 0 && d.monthlyContribution === 0) issues.push({ field: 'initialCapital', code: 'emptyInvestment' });
      break;
    default:
      issues.push({ field: 'kind', code: 'unknownKind' });
  }
  return issues;
}

// ------------------------------------------------------------------ arithmétique exacte

const RATE_SCALE = 10n ** 50n;
const NOMINAL_DEN = 120000n; // bps / 10 000 / 12

/** n / d arrondi au plus proche, demi vers l'extérieur (d > 0). */
function divRoundHalfAway(n: bigint, d: bigint): bigint {
  const neg = n < 0n;
  const q = (2n * (neg ? -n : n) + d) / (2n * d);
  return neg ? -q : q;
}

/** ⌈n / d⌉ pour n ≥ 0, d > 0. */
function divCeil(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}

function toSafe(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new DecisionInputError([{ field: 'result', code: 'resultOutOfRange' }]);
  return n;
}

const rateCache = new Map<number, bigint>();

/**
 * Taux mensuel équivalent à un taux annuel effectif (H1), en virgule fixe : i × 10^50.
 * Newton sur y^12 = 1 + R depuis y0 = 1 + R/12 (au-dessus de la racine : convergence monotone).
 */
export function effectiveMonthlyRateScaled(bps: number): bigint {
  if (bps === 0) return 0n;
  const cached = rateCache.get(bps);
  if (cached !== undefined) return cached;
  const target = ((10000n + BigInt(bps)) * RATE_SCALE) / 10000n;
  let y = RATE_SCALE + (BigInt(bps) * RATE_SCALE) / NOMINAL_DEN;
  for (let k = 0; k < 200; k++) {
    let p11 = RATE_SCALE;
    for (let j = 0; j < 11; j++) p11 = (p11 * y) / RATE_SCALE;
    const p12 = (p11 * y) / RATE_SCALE;
    const next = y - ((p12 - target) * RATE_SCALE) / (12n * p11);
    const diff = next > y ? next - y : y - next;
    y = next;
    if (diff <= 1n) break;
  }
  const r = y - RATE_SCALE;
  rateCache.set(bps, r);
  return r;
}

/** Taux mensuel effectif arrondi à `digits` décimales (affichage, documentation). */
export function formatEffectiveMonthlyRate(bps: number, digits = 30): string {
  const scaled = divRoundHalfAway(effectiveMonthlyRateScaled(bps), 10n ** BigInt(50 - digits));
  const s = scaled.toString().padStart(digits + 1, '0');
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

const effectiveInterest = (balance: bigint, r: bigint) => (r === 0n ? 0n : divRoundHalfAway(balance * r, RATE_SCALE));
const nominalInterest = (balance: bigint, bps: number) => divRoundHalfAway(balance * BigInt(bps), NOMINAL_DEN);

// ------------------------------------------------------------------ briques financières

/** Tableau d'amortissement à échéances constantes (H5, H6, H4). */
export function amortizationSchedule(amount: number, nominalRateBps: number, months: number): LoanSchedule {
  const L = BigInt(amount);
  const n = BigInt(months);
  let inst: bigint;
  if (nominalRateBps === 0) inst = divRoundHalfAway(L, n);
  else {
    const a = NOMINAL_DEN + BigInt(nominalRateBps);
    const an = a ** n;
    const bn = NOMINAL_DEN ** n;
    inst = divRoundHalfAway(L * BigInt(nominalRateBps) * an, NOMINAL_DEN * (an - bn));
  }
  const rows: LoanRow[] = [];
  let b = L;
  let totalInterest = 0n;
  let totalPaid = 0n;
  let earlyPayoffMonth: number | null = null;
  for (let m = 1; m <= months && b > 0n; m++) {
    const interest = nominalInterest(b, nominalRateBps);
    const due = b + interest;
    // Une mensualité qui ne couvre pas les intérêts du mois n'amortit rien : crédit non amortissable.
    if (m < months && inst <= interest) throw new DecisionInputError([{ field: 'loan', code: 'notAmortizable' }]);
    // H6 : dernière échéance ajustée au montant réellement dû. Si l'arrondi de la mensualité, capitalisé,
    // solde le crédit avant terme, cette échéance ajustée arrive plus tôt et l'échéancier s'arrête.
    const last = m === months || inst >= due;
    const pay = last ? due : inst;
    if (last && m < months) earlyPayoffMonth = m;
    const principal = pay - interest;
    const opening = b;
    b -= principal;
    totalInterest += interest;
    totalPaid += pay;
    rows.push({ month: m, openingBalance: toSafe(opening), installment: toSafe(pay), interest: toSafe(interest), principal: toSafe(principal), closingBalance: toSafe(b) });
  }
  if (b !== 0n || rows.some((r) => r.installment < 0 || r.principal < 0)) throw new Error('échéancier incohérent');
  return {
    amount,
    nominalRateBps,
    months,
    actualMonths: rows.length,
    earlyPayoffMonth,
    installment: toSafe(inst),
    lastInstallment: rows[rows.length - 1].installment,
    totalInterest: toSafe(totalInterest),
    totalPaid: toSafe(totalPaid),
    rows,
  };
}

/** Placement : capital au mois 0 (H3), intérêts arrondis (H4), versements en fin de mois (H2). */
export function savingsSchedule(initial: number, monthly: number, contributionMonths: number, effectiveRateBps: number, horizon: number): SavingsRow[] {
  const r = effectiveMonthlyRateScaled(effectiveRateBps);
  let b = BigInt(initial);
  let cumC = b;
  let cumI = 0n;
  const rows: SavingsRow[] = [];
  for (let m = 1; m <= horizon; m++) {
    const opening = b;
    const interest = effectiveInterest(b, r);
    const contribution = m <= contributionMonths ? BigInt(monthly) : 0n;
    b += interest + contribution;
    cumC += contribution;
    cumI += interest;
    rows.push({ month: m, openingBalance: toSafe(opening), interest: toSafe(interest), contribution: toSafe(contribution), closingBalance: toSafe(b), cumulativeContributions: toSafe(cumC), cumulativeInterest: toSafe(cumI) });
  }
  return rows;
}

/** Effort mensuel constant pour atteindre `target` en `months` mois (H7 : centime supérieur). */
export function requiredMonthlyEffort(target: number, effectiveRateBps: number, months: number): number {
  const T = BigInt(target);
  const n = BigInt(months);
  const r = effectiveMonthlyRateScaled(effectiveRateBps);
  if (r === 0n) return toSafe(divCeil(T, n));
  // P = T·i / ((1+i)^n − 1), avec i = r / S : P = T·r·S^(n−1) / ((S+r)^n − S^n)
  const sn1 = RATE_SCALE ** (n - 1n);
  return toSafe(divCeil(T * r * sn1, (RATE_SCALE + r) ** n - sn1 * RATE_SCALE));
}

/** Versements de fin de mois jusqu'à la cible, dernier versement plafonné (H14). */
function goalSchedule(target: number, monthly: number, r: bigint): { rows: SavingsRow[]; reachedMonth: number | null } {
  const T = BigInt(target);
  const P = BigInt(monthly);
  let b = 0n;
  let cumC = 0n;
  let cumI = 0n;
  const rows: SavingsRow[] = [];
  for (let m = 1; m <= MAX_HORIZON_MONTHS; m++) {
    const opening = b;
    const interest = effectiveInterest(b, r);
    const need = T - (b + interest);
    const pay = need > 0n ? (P < need ? P : need) : 0n;
    b += interest + pay;
    cumC += pay;
    cumI += interest;
    rows.push({ month: m, openingBalance: toSafe(opening), interest: toSafe(interest), contribution: toSafe(pay), closingBalance: toSafe(b), cumulativeContributions: toSafe(cumC), cumulativeInterest: toSafe(cumI) });
    if (b >= T) return { rows, reachedMonth: m };
  }
  return { rows, reachedMonth: null };
}

// ------------------------------------------------------------------ simulation

/** Opposé sans −0 (les flux sont comparés strictement). */
const neg = (x: number) => (x === 0 ? 0 : -x);

const ZERO_FLOWS: DecisionFlows = { initial: 0, fees: 0, installment: 0, loanInterest: 0, loanPrincipal: 0, insurance: 0, expense: 0, contribution: 0 };

/** Somme exacte d'entiers (BigInt) : hors des entiers exacts, `resultOutOfRange` (jamais d'arrondi caché). */
const exactSum = (...values: number[]): number => toSafe(values.reduce((acc, v) => acc + BigInt(v), 0n));

function buildMonths(horizon: number, startMonth: MonthKey | undefined, at: (m: number) => { flows: Partial<DecisionFlows>; assets: number; liabilities: number }): DecisionMonth[] {
  const out: DecisionMonth[] = [];
  let cumulativeCash = 0;
  let prevImpact = 0;
  for (let m = 0; m <= horizon; m++) {
    const { flows: partial, assets, liabilities } = at(m);
    const flows: DecisionFlows = { ...ZERO_FLOWS, ...partial };
    // Chaque cumul et chaque différence est calculé exactement puis contrôlé (A3).
    const cashFlow = exactSum(flows.initial, flows.fees, flows.installment, flows.insurance, flows.expense, flows.contribution);
    cumulativeCash = exactSum(cumulativeCash, cashFlow);
    const netWorthImpact = exactSum(assets, -liabilities, cumulativeCash);
    const row: DecisionMonth = { month: m, flows, cashFlow, cumulativeCash, assets, liabilities, netWorthImpact, netWorthChange: exactSum(netWorthImpact, -prevImpact) };
    if (startMonth) row.monthKey = addMonthsToKey(startMonth, m);
    out.push(row);
    prevImpact = netWorthImpact;
  }
  return out;
}

function summarize(months: DecisionMonth[]): DecisionSummary {
  const last = months[months.length - 1];
  let low = months[0];
  for (const m of months) if (m.cumulativeCash < low.cumulativeCash) low = m;
  return {
    finalCumulativeCash: last.cumulativeCash,
    finalNetWorthImpact: last.netWorthImpact,
    finalAssets: last.assets,
    finalLiabilities: last.liabilities,
    lowestCumulativeCash: low.cumulativeCash,
    lowestCumulativeCashMonth: low.month,
  };
}

function simulatePurchase(d: PurchaseDecision, o: SimulationOptions): DecisionResult {
  const credit = d.price - d.downPayment;
  const loan = d.loan ? amortizationSchedule(credit, d.loan.nominalRateBps, d.loan.months) : undefined;
  const asset = d.assetValue ?? d.price;
  const ins = d.insuranceMonthly ?? 0;
  const insMonths = ins > 0 ? (d.insuranceMonths ?? loan?.actualMonths ?? 0) : 0;
  const months = buildMonths(o.horizonMonths, o.startMonth, (m) => {
    if (m === 0) return { flows: { initial: neg(d.downPayment), fees: neg(d.fees) }, assets: asset, liabilities: credit };
    const row = loan?.rows[m - 1];
    return {
      flows: row ? { installment: neg(row.installment), loanInterest: neg(row.interest), loanPrincipal: neg(row.principal), insurance: m <= insMonths ? neg(ins) : 0 } : { insurance: m <= insMonths ? neg(ins) : 0 },
      assets: asset,
      liabilities: row ? row.closingBalance : 0,
    };
  });
  return { engineVersion: DECISION_ENGINE_VERSION, kind: 'purchase', horizonMonths: o.horizonMonths, months, summary: summarize(months), loan };
}

function simulateRecurring(d: RecurringExpenseDecision, o: SimulationOptions): DecisionResult {
  const start = d.startMonth ?? 1;
  const end = d.months == null ? Infinity : start + d.months - 1;
  const months = buildMonths(o.horizonMonths, o.startMonth, (m) => ({
    flows: { expense: m >= start && m <= end ? neg(d.monthlyAmount) : 0 },
    assets: 0,
    liabilities: 0,
  }));
  return { engineVersion: DECISION_ENGINE_VERSION, kind: 'recurring', horizonMonths: o.horizonMonths, months, summary: summarize(months) };
}

function simulateInvestment(d: InvestmentDecision, o: SimulationOptions): DecisionResult {
  const count = d.contributionMonths ?? o.horizonMonths;
  const savings = savingsSchedule(d.initialCapital, d.monthlyContribution, count, d.effectiveRateBps, o.horizonMonths);
  const months = buildMonths(o.horizonMonths, o.startMonth, (m) =>
    m === 0
      ? { flows: { initial: neg(d.initialCapital) }, assets: d.initialCapital, liabilities: 0 }
      : { flows: { contribution: neg(savings[m - 1].contribution) }, assets: savings[m - 1].closingBalance, liabilities: 0 },
  );
  return { engineVersion: DECISION_ENGINE_VERSION, kind: 'investment', horizonMonths: o.horizonMonths, months, summary: summarize(months), savings };
}

function simulateGoal(d: SavingsGoalDecision, o: SimulationOptions): DecisionResult {
  const r = effectiveMonthlyRateScaled(d.effectiveRateBps);
  let monthly: number;
  let deadline: number | null;
  let plan: ReturnType<typeof goalSchedule>;
  if (d.mode === 'effort') {
    deadline = d.months;
    monthly = requiredMonthlyEffort(d.target, d.effectiveRateBps, d.months);
    plan = goalSchedule(d.target, monthly, r);
    // Garde-fou : l'arrondi mensuel des intérêts ne doit pas empêcher d'atteindre la cible à l'échéance.
    while (plan.reachedMonth === null || plan.reachedMonth > d.months) {
      monthly += 1;
      plan = goalSchedule(d.target, monthly, r);
    }
  } else {
    deadline = d.deadlineMonths ?? null;
    monthly = d.monthlyContribution;
    plan = goalSchedule(d.target, monthly, r);
  }
  const rows = plan.rows;
  const last = rows[rows.length - 1];
  // Après l'atteinte : plus aucun versement ; le capital reste sur le compte dédié et continue de
  // produire le rendement prévu (intérêts arrondis, H4). Solde du compte au mois m (m ≥ 1) :
  const span = Math.max(o.horizonMonths, deadline ?? 0);
  const after: number[] = [];
  let balance = BigInt(last.closingBalance);
  for (let m = rows.length + 1; m <= span; m++) {
    balance += effectiveInterest(balance, r);
    after.push(toSafe(balance));
  }
  const balanceAt = (m: number) => (m <= rows.length ? rows[m - 1].closingBalance : after[m - rows.length - 1]);
  const reachedByDeadline = deadline == null ? null : plan.reachedMonth !== null && plan.reachedMonth <= deadline;
  const balanceAtDeadline = deadline == null ? null : balanceAt(deadline);
  const finalBalance = balanceAt(o.horizonMonths);
  const balanceAtReach = plan.reachedMonth === null ? null : last.closingBalance;
  // Totaux de la période simulée (mois 1 à l'horizon), additionnés mois par mois : versements de
  // l'échéancier jusqu'à l'horizon, intérêts de l'échéancier puis intérêts après l'atteinte (H15).
  let contributedToHorizon = 0n;
  let interestToHorizon = 0n;
  for (let m = 1; m <= o.horizonMonths; m++) {
    if (m <= rows.length) {
      contributedToHorizon += BigInt(rows[m - 1].contribution);
      interestToHorizon += BigInt(rows[m - 1].interest);
    } else interestToHorizon += BigInt(balanceAt(m)) - BigInt(balanceAt(m - 1));
  }
  const months = buildMonths(o.horizonMonths, o.startMonth, (m) => {
    if (m === 0) return { flows: {}, assets: 0, liabilities: 0 };
    const row = rows[m - 1];
    return { flows: { contribution: row ? neg(row.contribution) : 0 }, assets: balanceAt(m), liabilities: 0 };
  });
  const goal: GoalOutcome = {
    mode: d.mode,
    monthlyContribution: monthly,
    reachedMonth: plan.reachedMonth,
    lastContribution: last.contribution,
    totalContributed: last.cumulativeContributions,
    totalInterest: last.cumulativeInterest,
    contributionsToReach: plan.reachedMonth === null ? null : last.cumulativeContributions,
    contributedToHorizon: toSafe(contributedToHorizon),
    interestToHorizon: toSafe(interestToHorizon),
    balanceAtReach,
    deadlineMonths: deadline,
    reachedByDeadline,
    balanceAtDeadline,
    shortfallAtDeadline: balanceAtDeadline == null ? null : reachedByDeadline ? 0 : d.target - balanceAtDeadline,
    finalBalance,
    interestAfterReach: balanceAtReach !== null && plan.reachedMonth! < o.horizonMonths ? finalBalance - balanceAtReach : 0,
    schedule: rows,
  };
  return { engineVersion: DECISION_ENGINE_VERSION, kind: 'goal', horizonMonths: o.horizonMonths, months, summary: summarize(months), goal };
}

/**
 * Totaux d'un objectif sur l'horizon, déduits de son impact à l'horizon : le seul flux de trésorerie
 * d'un objectif est le versement, et son seul actif est le compte dédié (versements + intérêts). D'où
 * versé = −écart de trésorerie cumulé et intérêts = impact sur le patrimoine. Sert à relire les
 * simulations enregistrées avant que `simulateGoal` ne fournisse ces totaux (identité vérifiée par
 * les tests sur des simulations complètes).
 */
export function goalHorizonTotalsFromImpact(cumulativeCash: number, netWorthImpact: number): { contributedToHorizon: number; interestToHorizon: number } {
  return { contributedToHorizon: cumulativeCash === 0 ? 0 : -cumulativeCash, interestToHorizon: netWorthImpact };
}

/** Simule une décision. Lève `DecisionInputError` si l'entrée est invalide. */
export function simulateDecision(d: DecisionInput, options: SimulationOptions): DecisionResult {
  const issues = validateDecision(d, options);
  if (issues.length) throw new DecisionInputError(issues);
  switch (d.kind) {
    case 'purchase':
      return simulatePurchase(d, options);
    case 'recurring':
      return simulateRecurring(d, options);
    case 'goal':
      return simulateGoal(d, options);
    case 'investment':
      return simulateInvestment(d, options);
  }
}

// ------------------------------------------------------------------ référence et comparaison

export interface ReferencePoint {
  month: number;
  monthKey?: MonthKey;
  cash: number;
  netWorth: number;
}

export interface TrajectoryPoint {
  month: number;
  monthKey?: MonthKey;
  reference: { cash: number; netWorth: number };
  withDecision: { cash: number; netWorth: number };
  delta: { cash: number; netWorth: number };
}

function validateSituation(s: InitialSituation, prefix = 'situation'): DecisionIssue[] {
  const issues: DecisionIssue[] = [];
  for (const k of ['cash', 'netWorth', 'monthlySavings'] as const) {
    if (typeof s?.[k] !== 'number' || !Number.isSafeInteger(s[k])) issues.push({ field: `${prefix}.${k}`, code: 'notInteger' });
  }
  return issues;
}

/** Référence sans décision : épargne mensuelle constante, non rémunérée (H12). */
export function referenceTrajectory(s: InitialSituation, options: SimulationOptions): ReferencePoint[] {
  const issues = [...validateSituation(s)];
  if (!Number.isSafeInteger(options.horizonMonths) || options.horizonMonths < 1 || options.horizonMonths > MAX_HORIZON_MONTHS) issues.push({ field: 'horizonMonths', code: 'tooLarge' });
  if (issues.length) throw new DecisionInputError(issues);
  // Multiplication et additions exactes (BigInt) : un produit m × épargne au-delà de 2^53 ne doit
  // jamais être arrondi puis compensé par une trésorerie de signe opposé (A3).
  const savings = BigInt(s.monthlySavings);
  return Array.from({ length: options.horizonMonths + 1 }, (_, m) => {
    const p: ReferencePoint = { month: m, cash: toSafe(BigInt(s.cash) + BigInt(m) * savings), netWorth: toSafe(BigInt(s.netWorth) + BigInt(m) * savings) };
    if (options.startMonth) p.monthKey = addMonthsToKey(options.startMonth, m);
    return p;
  });
}

/**
 * Superpose l'impact d'une décision à la référence : avec décision = référence + écart, calculé
 * exactement. Lève `DecisionInputError` (`resultOutOfRange`) si la somme sort des entiers exacts
 * (ex. patrimoine initial très élevé et placement) : aucun résultat n'est tronqué ni arrondi (A3).
 */
export function projectDecision(reference: ReferencePoint[], result: DecisionResult): TrajectoryPoint[] {
  if (reference.length !== result.months.length) throw new Error('horizons différents');
  return reference.map((ref, m) => {
    const imp = result.months[m];
    const p: TrajectoryPoint = {
      month: m,
      reference: { cash: ref.cash, netWorth: ref.netWorth },
      withDecision: { cash: exactSum(ref.cash, imp.cumulativeCash), netWorth: exactSum(ref.netWorth, imp.netWorthImpact) },
      delta: { cash: imp.cumulativeCash, netWorth: imp.netWorthImpact },
    };
    if (ref.monthKey) p.monthKey = ref.monthKey;
    return p;
  });
}

export interface DecisionVariant {
  id: string;
  label?: string;
  decision: DecisionInput;
}

export interface VariantOutcome {
  id: string;
  label?: string;
  result: DecisionResult;
  trajectory: TrajectoryPoint[];
  endOfHorizon: { cash: number; netWorth: number; cashDelta: number; netWorthDelta: number };
  lowestCash: { month: number; value: number };
  /** Premier mois où la trésorerie avec décision devient négative (null : jamais). */
  firstNegativeCashMonth: number | null;
}

export interface DecisionComparison {
  engineVersion: number;
  horizonMonths: number;
  situation: InitialSituation;
  reference: ReferencePoint[];
  variants: VariantOutcome[];
}

/** Compare 2 à 4 variantes contre une référence IDENTIQUE, sur le même horizon. */
export function compareDecisions(situation: InitialSituation, variants: DecisionVariant[], options: SimulationOptions): DecisionComparison {
  const issues = validateSituation(situation);
  if (!Array.isArray(variants) || variants.length < MIN_VARIANTS || variants.length > MAX_VARIANTS) issues.push({ field: 'variants', code: 'variantCount' });
  else {
    const ids = new Set<string>();
    variants.forEach((v, k) => {
      if (typeof v.id !== 'string' || !v.id) issues.push({ field: `variants[${k}].id`, code: 'required' });
      else if (ids.has(v.id)) issues.push({ field: `variants[${k}].id`, code: 'duplicate' });
      else ids.add(v.id);
      for (const i of validateDecision(v.decision, options)) issues.push({ field: `variants[${k}].${i.field}`, code: i.code });
    });
  }
  if (issues.length) throw new DecisionInputError(issues);
  const reference = referenceTrajectory(situation, options);
  return {
    engineVersion: DECISION_ENGINE_VERSION,
    horizonMonths: options.horizonMonths,
    situation: { ...situation },
    reference,
    variants: variants.map((v) => {
      const result = simulateDecision(v.decision, options);
      const trajectory = projectDecision(reference, result);
      const end = trajectory[trajectory.length - 1];
      let low = trajectory[0];
      for (const p of trajectory) if (p.withDecision.cash < low.withDecision.cash) low = p;
      const neg = trajectory.find((p) => p.withDecision.cash < 0);
      return {
        id: v.id,
        ...(v.label !== undefined ? { label: v.label } : {}),
        result,
        trajectory,
        endOfHorizon: { cash: end.withDecision.cash, netWorth: end.withDecision.netWorth, cashDelta: end.delta.cash, netWorthDelta: end.delta.netWorth },
        lowestCash: { month: low.month, value: low.withDecision.cash },
        firstNegativeCashMonth: neg ? neg.month : null,
      };
    }),
  };
}
