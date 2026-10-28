import { useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import type { MonthKey } from '@/domain/dates';
import { addMonthsToKey, minDate, monthEnd, monthKey, monthPeriod } from '@/domain/dates';
import { accountBalances, accountsInScope, summarizePeriod, totalBalance } from '@/domain/calc/ledger';
import { monthBudgetOverview } from '@/domain/calc/budgets';
import { forecastMonth } from '@/domain/calc/forecast';
import type { ID } from '@/domain/types';

/** Indicateurs d'un mois — mêmes fonctions que budgets, rapports et assistant. */
export function useMonthData(month: MonthKey) {
  const { ctx, data, today, settings } = useApp();
  return useMemo(() => {
    const period = monthPeriod(month);
    const summary = summarizePeriod(ctx, data.transactions, period);
    const prevMonth = addMonthsToKey(month, -1);
    const prev = summarizePeriod(ctx, data.transactions, monthPeriod(prevMonth));
    const isCurrent = month === monthKey(today);
    const forecast = isCurrent ? forecastMonth(ctx, data, today) : null;
    const overview = monthBudgetOverview(data.budgets, month, summary, ctx.categories, today, settings.budgetAlertThresholds, forecast?.committedByCategory);
    const asOf = minDate(monthEnd(month), today);
    const balance = totalBalance(ctx, accountsInScope(data.accounts), data.transactions, asOf);
    return { period, summary, prev, prevMonth, isCurrent, forecast, overview, asOf, balance };
  }, [ctx, data, today, month, settings.budgetAlertThresholds]);
}

/** Soldes courants de tous les comptes (devise du compte). */
export function useBalances(): Map<ID, number> {
  const { data, today } = useApp();
  return useMemo(() => accountBalances(data.accounts, data.transactions, today), [data.accounts, data.transactions, today]);
}
