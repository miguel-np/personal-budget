import type { BudgetCategory, BudgetTransaction } from './domain.js';
import { validatePeriod } from './date-range.js';
import { normalizeTransactions } from './ledger.js';
import { detectRecurringCandidates, stableMedian } from './recurring.js';

export type ForecastScenario =
  | { readonly type: 'category_reduction'; readonly categoryId: string; readonly percent: number }
  | { readonly type: 'income_change'; readonly percent: number };

export interface ForecastOptions {
  readonly currency: string;
  readonly horizonMonths: number;
  readonly startDate: string;
  readonly endDate: string;
}

export interface ForecastMonthlyRow {
  readonly month: string;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly savingsMinor: number;
}

export interface ForecastResult {
  readonly isEstimate: true;
  readonly currency: string;
  readonly horizonMonths: number;
  readonly history: {
    readonly startDate: string;
    readonly endDate: string;
    readonly monthsWithData: number;
    readonly transactionCount: number;
  };
  readonly baselineMonthlyIncomeMinor: number;
  readonly recurringExpenseMonthlyMinor: number;
  readonly extraordinaryExpenseMonthlyMinor: number;
  readonly projectedMonthlyIncomeMinor: number;
  readonly projectedMonthlyExpenseMinor: number;
  readonly projectedMonthlySavingsMinor: number;
  readonly projectedSavingsMinor: number;
  readonly monthlyProjection: readonly ForecastMonthlyRow[];
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
}

interface MonthAggregate {
  income: number;
  expense: number;
  recurringExpense: number;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function nextMonths(startMonth: string, count: number): readonly string[] {
  const [year, month] = startMonth.split('-').map(Number);
  const months: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const date = new Date(Date.UTC(year!, month! - 1 + index, 1));
    months.push(String(date.getUTCFullYear()).padStart(4, '0') + '-' + String(date.getUTCMonth() + 1).padStart(2, '0'));
  }
  return months;
}

function sumRows(rows: readonly ForecastMonthlyRow[]): number {
  return rows.reduce((total, row) => total + row.savingsMinor, 0);
}

/**
 * Projects savings for a scenario from local history with deterministic
 * medians. The output is an estimate with explicit assumptions and warnings;
 * finance-core computes every figure and no real transaction is touched.
 */
export function projectSavings(
  transactions: readonly BudgetTransaction[],
  categories: readonly BudgetCategory[],
  scenario: ForecastScenario,
  options: ForecastOptions,
): ForecastResult {
  validatePeriod(options);
  if (!/^[A-Z]{3}$/.test(options.currency)) throw new RangeError('currency must be a three-letter uppercase code.');
  if (!Number.isInteger(options.horizonMonths) || options.horizonMonths < 1 || options.horizonMonths > 60) {
    throw new RangeError('horizonMonths must be an integer from 1 to 60.');
  }
  if (scenario.type === 'category_reduction') {
    const category = categories.find((item) => item.id === scenario.categoryId && !item.isIncome);
    if (!category) throw new RangeError('scenario category must be an existing expense category.');
    if (!Number.isFinite(scenario.percent) || scenario.percent < 0 || scenario.percent > 100) {
      throw new RangeError('category_reduction percent must be from 0 to 100.');
    }
  } else if (!Number.isFinite(scenario.percent) || scenario.percent < -100 || scenario.percent > 1_000) {
    throw new RangeError('income_change percent must be from -100 to 1000.');
  }

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const entries = normalizeTransactions(transactions);
  const historyEntries = entries.filter((entry) => entry.date >= options.startDate && entry.date <= options.endDate);

  const byMonth = new Map<string, MonthAggregate>();
  for (const entry of historyEntries) {
    if (entry.isTransfer) continue;
    const month = monthKey(entry.date);
    const aggregate = byMonth.get(month) ?? { income: 0, expense: 0, recurringExpense: 0 };
    const category = entry.categoryId ? categoryById.get(entry.categoryId) : undefined;
    if (category?.isIncome) aggregate.income += entry.amountMinor;
    else if (entry.amountMinor < 0) aggregate.expense += -entry.amountMinor;
    byMonth.set(month, aggregate);
  }

  const recurring = detectRecurringCandidates(transactions, options);
  const recurringPayees = new Set(recurring.map((candidate) => candidate.payee));
  for (const entry of historyEntries) {
    if (entry.isTransfer || entry.amountMinor >= 0 || !entry.payeeLabel) continue;
    if (!recurringPayees.has(entry.payeeLabel)) continue;
    const aggregate = byMonth.get(monthKey(entry.date));
    if (aggregate) aggregate.recurringExpense += -entry.amountMinor;
  }

  const monthlyIncome = [...byMonth.values()].map((item) => item.income);
  const monthlyExpense = [...byMonth.values()].map((item) => item.expense);
  const monthlyRecurring = [...byMonth.values()].map((item) => item.recurringExpense);

  const baselineMonthlyIncomeMinor = stableMedian(monthlyIncome) ?? 0;
  const totalMonthlyExpenseMinor = stableMedian(monthlyExpense) ?? 0;
  const recurringExpenseMonthlyMinor = stableMedian(monthlyRecurring) ?? 0;
  const extraordinaryExpenseMonthlyMinor = Math.max(0, totalMonthlyExpenseMinor - recurringExpenseMonthlyMinor);

  const categoryMonthTotals = new Map<string, number[]>();
  for (const entry of historyEntries) {
    if (entry.isTransfer || entry.amountMinor >= 0 || !entry.categoryId) continue;
    const list = categoryMonthTotals.get(entry.categoryId) ?? [];
    list.push(-entry.amountMinor);
    categoryMonthTotals.set(entry.categoryId, list);
  }

  let projectedMonthlyIncomeMinor = baselineMonthlyIncomeMinor;
  let projectedMonthlyExpenseMinor = totalMonthlyExpenseMinor;
  const assumptions: string[] = [];
  if (scenario.type === 'income_change') {
    projectedMonthlyIncomeMinor = Math.round(baselineMonthlyIncomeMinor * (1 + scenario.percent / 100));
    assumptions.push(`Cambio de ingreso mensual del ${scenario.percent} % sobre la mediana histórica (${baselineMonthlyIncomeMinor} unidades monetarias menores).`);
  } else {
    const category = categoryById.get(scenario.categoryId)!;
    const categoryMedian = stableMedian(categoryMonthTotals.get(scenario.categoryId) ?? []) ?? 0;
    const reduction = Math.round(categoryMedian * scenario.percent / 100);
    projectedMonthlyExpenseMinor = Math.max(0, totalMonthlyExpenseMinor - reduction);
    assumptions.push(`Reducción del ${scenario.percent} % en la categoría ${category.name}; mediana mensual histórica de la categoría ${categoryMedian} y reducción estimada de ${reduction} unidades monetarias menores.`);
  }
  assumptions.push('La proyección asume ingresos y gastos constantes por mes durante el horizonte; las cifras proceden de medianas mensuales del historial local.');
  assumptions.push('El gasto recurrente estimado corresponde a candidatos recurrentes detectados; el resto se trata como gasto extraordinario o variable.');

  const warnings: string[] = [];
  if (byMonth.size < 3) {
    warnings.push(`El historial contiene ${byMonth.size} mes(es) con datos; la estimación es poco fiable con menos de tres meses.`);
  }
  if (baselineMonthlyIncomeMinor <= 0) {
    warnings.push('Los ingresos del historial son cero o irregulares; la tasa de ahorro proyectada no es fiable.');
  }
  if (recurringExpenseMonthlyMinor === 0) {
    warnings.push('No se detectaron candidatos recurrentes en el historial; el gasto se proyecta como una única cifra mediana.');
  }
  const monthExpenses = [...byMonth.values()].map((item) => item.expense);
  const maxExpense = monthExpenses.length > 0 ? Math.max(...monthExpenses) : 0;
  if (maxExpense > totalMonthlyExpenseMinor * 1.5 && totalMonthlyExpenseMinor > 0) {
    warnings.push('El historial incluye meses con gasto extraordinario puntual; la mediana suaviza esos picos y puede subestimar el gasto esperado.');
  }
  warnings.push('El horizonte proyectado va más allá del último mes con datos; la proyección asume comportamiento constante.');

  const projectedMonthlySavingsMinor = projectedMonthlyIncomeMinor - projectedMonthlyExpenseMinor;
  const projectedMonths = nextMonths(options.endDate.slice(0, 7), options.horizonMonths);
  const monthlyProjection: ForecastMonthlyRow[] = projectedMonths.map((month) => ({
    month,
    incomeMinor: projectedMonthlyIncomeMinor,
    expenseMinor: projectedMonthlyExpenseMinor,
    savingsMinor: projectedMonthlySavingsMinor,
  }));

  return {
    isEstimate: true,
    currency: options.currency,
    horizonMonths: options.horizonMonths,
    history: {
      startDate: options.startDate,
      endDate: options.endDate,
      monthsWithData: byMonth.size,
      transactionCount: historyEntries.filter((entry) => !entry.isTransfer).length,
    },
    baselineMonthlyIncomeMinor,
    recurringExpenseMonthlyMinor,
    extraordinaryExpenseMonthlyMinor,
    projectedMonthlyIncomeMinor,
    projectedMonthlyExpenseMinor,
    projectedMonthlySavingsMinor,
    projectedSavingsMinor: sumRows(monthlyProjection),
    monthlyProjection,
    assumptions,
    warnings,
  };
}
