/**
 * Patrimoine net = Total des actifs − Total des passifs.
 *
 * Actifs :
 *  - chaque compte (solde comptable), compté UNE seule fois ;
 *    si un actif est lié à un compte (ex: portefeuille valorisé manuellement),
 *    sa dernière valorisation REMPLACE le solde comptable du compte ;
 *  - actifs non financiers (immobilier, véhicule...) : dernière valorisation manuelle ;
 *  - créances (sommes prêtées, remboursements attendus) : montant restant.
 * Passifs : dettes et crédits (montant restant).
 * Les objectifs d'épargne ne sont PAS des actifs (simple affectation).
 */
import type { MoneyBag } from '../money';
import { addToBag } from '../money';
import type { ISODate, MonthKey } from '../dates';
import { monthEnd, minDate } from '../dates';
import type { Account, Asset, AssetValuation, DataSnapshot, ID } from '../types';
import type { LedgerContext } from './ledger';
import { accountBalances } from './ledger';
import { debtRemaining } from './debts';

export type AssetClass = 'liquidity' | 'savings' | 'investment' | 'real_estate' | 'vehicle' | 'receivable' | 'other';

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  liquidity: 'Liquidités',
  savings: 'Épargne',
  investment: 'Investissements',
  real_estate: 'Immobilier',
  vehicle: 'Véhicules',
  receivable: 'Créances',
  other: 'Autres actifs',
};

export interface NetWorthLine {
  source: 'account' | 'asset' | 'debt';
  id: ID;
  name: string;
  cls: AssetClass | 'debt';
  value: number; // devise de base
  nativeValue: number;
  currency: string;
  /** Valeur saisie manuellement (estimation). */
  manual: boolean;
  valuationDate?: ISODate;
}

export interface NetWorth {
  asOf: ISODate;
  assets: NetWorthLine[];
  liabilities: NetWorthLine[];
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  byClass: Record<AssetClass, number>;
  unconverted: MoneyBag;
}

function accountClass(a: Account): AssetClass {
  switch (a.type) {
    case 'savings':
      return 'savings';
    case 'investment':
      return 'investment';
    case 'other':
      return 'other';
    default:
      return 'liquidity';
  }
}

function assetClass(a: Asset): AssetClass {
  switch (a.type) {
    case 'real_estate':
      return 'real_estate';
    case 'vehicle':
      return 'vehicle';
    case 'investment':
      return 'investment';
    default:
      return 'other';
  }
}

export function latestValuation(valuations: AssetValuation[], assetId: ID, asOf: ISODate): AssetValuation | null {
  let best: AssetValuation | null = null;
  for (const v of valuations) {
    if (v.assetId !== assetId || v.date > asOf) continue;
    if (!best || v.date > best.date || (v.date === best.date && v.createdAt > best.createdAt)) best = v;
  }
  return best;
}

export function computeNetWorth(ctx: LedgerContext, data: Pick<DataSnapshot, 'accounts' | 'transactions' | 'assets' | 'valuations' | 'debts' | 'debtPayments'>, asOf: ISODate): NetWorth {
  const res: NetWorth = {
    asOf,
    assets: [],
    liabilities: [],
    totalAssets: 0,
    totalLiabilities: 0,
    netWorth: 0,
    byClass: { liquidity: 0, savings: 0, investment: 0, real_estate: 0, vehicle: 0, receivable: 0, other: 0 },
    unconverted: {},
  };
  const balances = accountBalances(data.accounts, data.transactions, asOf);
  const assetByAccount = new Map<ID, Asset>();
  for (const a of data.assets) if (a.linkedAccountId && !a.archived) assetByAccount.set(a.linkedAccountId, a);

  const pushAsset = (line: NetWorthLine, cls: AssetClass) => {
    const v = ctx.convert(line.nativeValue, line.currency, asOf);
    if (v == null) {
      addToBag(res.unconverted, line.currency, line.nativeValue);
      return;
    }
    line.value = v;
    res.assets.push(line);
    res.totalAssets += v;
    res.byClass[cls] += v;
  };

  for (const acc of data.accounts) {
    if (acc.initialBalanceDate > asOf && !data.transactions.some((t) => t.accountId === acc.id && t.date <= asOf)) continue;
    let native = balances.get(acc.id) ?? 0;
    let manual = false;
    let valuationDate: ISODate | undefined;
    const linked = assetByAccount.get(acc.id);
    if (linked) {
      const val = latestValuation(data.valuations, linked.id, asOf);
      if (val) {
        native = val.value;
        manual = true;
        valuationDate = val.date;
      }
    }
    if (acc.archived && native === 0) continue;
    const cls = accountClass(acc);
    pushAsset({ source: 'account', id: acc.id, name: acc.name, cls, value: 0, nativeValue: native, currency: acc.currency, manual, valuationDate }, cls);
  }

  for (const asset of data.assets) {
    if (asset.archived || asset.linkedAccountId) continue;
    const val = latestValuation(data.valuations, asset.id, asOf);
    if (!val) continue;
    const cls = assetClass(asset);
    pushAsset({ source: 'asset', id: asset.id, name: asset.name, cls, value: 0, nativeValue: val.value, currency: asset.currency, manual: true, valuationDate: val.date }, cls);
  }

  for (const debt of data.debts) {
    if (debt.status === 'archived' || debt.startDate > asOf) continue;
    const remaining = debtRemaining(debt, data.debtPayments, asOf);
    if (remaining === 0) continue;
    if (debt.direction === 'receivable') {
      pushAsset({ source: 'debt', id: debt.id, name: debt.label, cls: 'receivable', value: 0, nativeValue: remaining, currency: debt.currency, manual: false }, 'receivable');
    } else {
      const v = ctx.convert(remaining, debt.currency, asOf);
      if (v == null) {
        addToBag(res.unconverted, debt.currency, -remaining);
        continue;
      }
      res.liabilities.push({ source: 'debt', id: debt.id, name: debt.label, cls: 'debt', value: v, nativeValue: remaining, currency: debt.currency, manual: false });
      res.totalLiabilities += v;
    }
  }
  res.netWorth = res.totalAssets - res.totalLiabilities;
  return res;
}

/**
 * Début du suivi : plus ancienne date d'ancrage de compte ou de transaction.
 * Avant cette date, le patrimoine n'est pas reconstituable (comptes inconnus) :
 * on ne l'affiche pas plutôt que de montrer un chiffre trompeur.
 */
export function trackingStart(data: Pick<DataSnapshot, 'accounts' | 'transactions'>): ISODate | null {
  let min: ISODate | null = null;
  for (const a of data.accounts) if (!min || a.initialBalanceDate < min) min = a.initialBalanceDate;
  for (const t of data.transactions) if (!min || t.date < min) min = t.date;
  return min;
}

/** Patrimoine net en fin de chaque mois (le mois en cours est arrêté à `today`). Les mois antérieurs au suivi sont exclus. */
export function netWorthHistory(
  ctx: LedgerContext,
  data: Pick<DataSnapshot, 'accounts' | 'transactions' | 'assets' | 'valuations' | 'debts' | 'debtPayments'>,
  months: MonthKey[],
  today: ISODate,
): { month: MonthKey; asOf: ISODate; netWorth: number; assets: number; liabilities: number }[] {
  const start = trackingStart(data);
  return months.filter((m) => start != null && monthEnd(m) >= start).map((m) => {
    const asOf = minDate(monthEnd(m), today);
    const nw = computeNetWorth(ctx, data, asOf);
    return { month: m, asOf, netWorth: nw.netWorth, assets: nw.totalAssets, liabilities: nw.totalLiabilities };
  });
}
