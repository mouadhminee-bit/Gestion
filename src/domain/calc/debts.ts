/**
 * Dettes et créances.
 *
 *  Montant restant = Principal − Σ principal remboursé (paiements datés ≤ date)
 *
 * Le remboursement du principal n'est PAS une dépense de consommation : il réduit
 * un passif (ou une créance). Seuls les intérêts sont comptés en dépense (dette)
 * ou en revenu (créance), voir ledger.flowOf.
 */
import type { ISODate } from '../dates';
import type { Debt, DebtPayment } from '../types';

export interface DebtStatusView {
  remaining: number;
  repaidPrincipal: number;
  paidInterest: number;
  progress: number | null;
  overdue: boolean;
  settled: boolean;
  paymentCount: number;
  lastPaymentDate: ISODate | null;
}

export function debtRemaining(debt: Debt, payments: DebtPayment[], asOf?: ISODate): number {
  if (asOf && debt.startDate > asOf) return 0;
  let repaid = 0;
  for (const p of payments) if (p.debtId === debt.id && (!asOf || p.date <= asOf)) repaid += p.principal;
  return Math.max(0, debt.principal - repaid);
}

export function computeDebtStatus(debt: Debt, payments: DebtPayment[], today: ISODate): DebtStatusView {
  const own = payments.filter((p) => p.debtId === debt.id);
  const repaidPrincipal = own.reduce((a, p) => a + p.principal, 0);
  const paidInterest = own.reduce((a, p) => a + p.interest, 0);
  const remaining = Math.max(0, debt.principal - repaidPrincipal);
  const settled = remaining === 0 || debt.status === 'settled';
  return {
    remaining,
    repaidPrincipal,
    paidInterest,
    progress: debt.principal > 0 ? Math.min(1, repaidPrincipal / debt.principal) : null,
    overdue: !settled && !!debt.dueDate && debt.dueDate < today,
    settled,
    paymentCount: own.length,
    lastPaymentDate: own.length ? own.map((p) => p.date).sort().at(-1)! : null,
  };
}

/** Validation d'un paiement : le principal ne peut pas dépasser le restant dû. */
export function validateDebtPayment(debt: Debt, payments: DebtPayment[], principal: number, interest: number): string | null {
  if (!Number.isInteger(principal) || !Number.isInteger(interest)) return 'Montant invalide.';
  if (principal < 0 || interest < 0) return 'Les montants doivent être positifs.';
  if (principal + interest === 0) return 'Le paiement doit être supérieur à zéro.';
  const remaining = debtRemaining(debt, payments);
  if (principal > remaining) return 'Le principal dépasse le montant restant dû.';
  return null;
}
