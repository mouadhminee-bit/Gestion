/**
 * Decision Lab — situation initiale (référence sans décision), construite en LECTURE SEULE à partir
 * des fonctions existantes, sans les dupliquer ni les modifier.
 *
 * Périmètres (docs/DECISION_LAB.md § 4.1) :
 *  - TRÉSORERIE : comptes du périmètre Forecast (`accountsInScope` : non archivés ET inclus dans les
 *    totaux), soldes de `totalBalance` à la date du jour. C'est l'argent supposé payer les décisions.
 *  - PATRIMOINE : `computeNetWorth` (tous les comptes, actifs valorisés, créances, dettes). Les comptes
 *    exclus de la trésorerie y restent comptés : ils ne sont ni perdus ni comptés deux fois.
 *  - ÉPARGNE MENSUELLE DE RÉFÉRENCE : `computeBaseline` sur les SEULES opérations des comptes de
 *    trésorerie (un revenu perçu sur un compte exclu n'alimente pas la trésorerie de référence).
 *  - Les objectifs d'épargne sont des affectations, jamais des actifs : ils ne sont pas ajoutés.
 *
 * Garde-fous contre la double comptabilisation (vérifiés à chaque appel, erreur sinon) : chaque compte
 * figure une seule fois dans le patrimoine ; trésorerie et comptes exclus forment une partition des
 * comptes ; la décomposition du patrimoine retombe exactement sur `computeNetWorth` ; la somme des
 * soldes des comptes de trésorerie retombe exactement sur `totalBalance`.
 */
import type { ISODate } from '../dates';
import type { DataSnapshot, ID } from '../types';
import type { LedgerContext } from './ledger';
import { accountBalances, accountsInScope, totalBalance } from './ledger';
import { computeNetWorth } from './networth';
import { computeBaseline } from './scenario';
import type { InitialSituation } from './decision';

export interface CashAccountLine {
  id: ID;
  name: string;
  currency: string;
  /** Solde en devise de base (null : pas de taux de change, exclu des totaux). */
  balance: number | null;
  /** Valeur retenue pour ce compte dans le patrimoine (null : absent du patrimoine à cette date). */
  netWorthValue: number | null;
  /**
   * Pourquoi la valeur patrimoniale diffère du solde : `valuation` (compte lié à un actif valorisé
   * manuellement), `notYetOpened` (date d'ouverture postérieure, sans opération), null sinon.
   */
  difference: 'valuation' | 'notYetOpened' | null;
}

export interface ExcludedAccountLine {
  id: ID;
  name: string;
  currency: string;
  /** archived : compte archivé ; notInTotal : compte exclu des totaux par l'utilisateur. */
  reason: 'archived' | 'notInTotal';
  /** Valeur comptée dans le patrimoine (null : non comptée, ex. compte archivé à solde nul). */
  netWorthValue: number | null;
}

export interface NetWorthBreakdown {
  cashAccounts: number;
  excludedAccounts: number;
  standaloneAssets: number;
  receivables: number;
  liabilities: number;
  /** = cashAccounts + excludedAccounts + standaloneAssets + receivables − liabilities = patrimoine. */
  total: number;
}

export interface InitialSituationDetails extends InitialSituation {
  asOf: ISODate;
  baselineIncome: number;
  baselineExpenses: number;
  /** Mois complets disposant de données dans la base de référence (0 : épargne non calculable, 0 retenu). */
  baselineMonthsWithData: number;
  /** Information : épargne mensuelle calculée sur tous les comptes (non retenue pour la référence). */
  monthlySavingsAllAccounts: number;
  perimeter: {
    cashAccounts: CashAccountLine[];
    excludedAccounts: ExcludedAccountLine[];
    netWorth: NetWorthBreakdown;
    /** Σ valeurs patrimoniales des comptes de trésorerie − trésorerie (valorisations, comptes non ouverts). */
    cashValuationDifference: number;
  };
  /** Des montants n'ont pu être convertis faute de taux : ils sont absents des totaux. */
  unconverted: boolean;
}

export class SituationPerimeterError extends Error {
  constructor(message: string) {
    super(`Périmètre de la situation initiale incohérent : ${message}`);
    this.name = 'SituationPerimeterError';
  }
}

export function buildInitialSituation(ctx: LedgerContext, data: DataSnapshot, today: ISODate): InitialSituationDetails {
  const scope = accountsInScope(data.accounts);
  const scopeIds = new Set(scope.map((a) => a.id));
  const cash = totalBalance(ctx, scope, data.transactions, today);
  const nw = computeNetWorth(ctx, data, today);
  const cashTx = data.transactions.filter((t) => scopeIds.has(t.accountId));
  const baseline = computeBaseline(ctx, { transactions: cashTx }, today);
  const baselineAll = computeBaseline(ctx, data, today);

  // Valeur de chaque compte dans le patrimoine ; un compte ne doit y figurer qu'une fois.
  const nwByAccount = new Map<ID, number>();
  for (const line of nw.assets) {
    if (line.source !== 'account') continue;
    if (nwByAccount.has(line.id)) throw new SituationPerimeterError(`compte ${line.id} compté deux fois dans le patrimoine`);
    nwByAccount.set(line.id, line.value);
  }
  const linkedToAsset = new Set(data.assets.filter((a) => a.linkedAccountId && !a.archived).map((a) => a.linkedAccountId!));

  const balances = accountBalances(scope, data.transactions, today);
  let cashSum = 0;
  const cashAccounts: CashAccountLine[] = scope.map((a) => {
    const balance = ctx.convert(balances.get(a.id) ?? 0, a.currency, today);
    if (balance != null) cashSum += balance;
    const netWorthValue = nwByAccount.get(a.id) ?? null;
    let difference: CashAccountLine['difference'] = null;
    if (netWorthValue === null) difference = balance === null ? null : 'notYetOpened';
    else if (balance !== null && netWorthValue !== balance) difference = linkedToAsset.has(a.id) ? 'valuation' : null;
    return { id: a.id, name: a.name, currency: a.currency, balance, netWorthValue, difference };
  });
  if (cashSum !== cash.total) throw new SituationPerimeterError('la somme des comptes de trésorerie diffère du solde total');

  const excludedAccounts: ExcludedAccountLine[] = data.accounts
    .filter((a) => !scopeIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency, reason: a.archived ? 'archived' : 'notInTotal', netWorthValue: nwByAccount.get(a.id) ?? null }));
  if (cashAccounts.length + excludedAccounts.length !== data.accounts.length || excludedAccounts.some((a) => scopeIds.has(a.id))) {
    throw new SituationPerimeterError('trésorerie et comptes exclus ne forment pas une partition des comptes');
  }

  const sum = (xs: (number | null)[]) => xs.reduce<number>((acc, x) => acc + (x ?? 0), 0);
  const breakdown: NetWorthBreakdown = {
    cashAccounts: sum(cashAccounts.map((a) => a.netWorthValue)),
    excludedAccounts: sum(excludedAccounts.map((a) => a.netWorthValue)),
    standaloneAssets: sum(nw.assets.filter((l) => l.source === 'asset').map((l) => l.value)),
    receivables: sum(nw.assets.filter((l) => l.source === 'debt').map((l) => l.value)),
    liabilities: nw.totalLiabilities,
    total: nw.netWorth,
  };
  if (breakdown.cashAccounts + breakdown.excludedAccounts + breakdown.standaloneAssets + breakdown.receivables - breakdown.liabilities !== nw.netWorth) {
    throw new SituationPerimeterError('la décomposition du patrimoine ne retombe pas sur le patrimoine net');
  }

  return {
    asOf: today,
    cash: cash.total,
    netWorth: nw.netWorth,
    monthlySavings: baseline.income - baseline.expenses,
    baselineIncome: baseline.income,
    baselineExpenses: baseline.expenses,
    baselineMonthsWithData: baseline.monthsWithData,
    monthlySavingsAllAccounts: baselineAll.income - baselineAll.expenses,
    perimeter: {
      cashAccounts,
      excludedAccounts,
      netWorth: breakdown,
      cashValuationDifference: breakdown.cashAccounts - cash.total,
    },
    unconverted: Object.keys(cash.unconverted).length > 0 || Object.keys(nw.unconverted).length > 0,
  };
}
