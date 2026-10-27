import type { BudgetCategory, BudgetTransaction } from './domain.js';
import { isIsoDate, validatePeriod } from './date-range.js';
import { normalizeTransactions } from './ledger.js';
import { stableMedian } from './recurring.js';

export type PlanningFrequency = 'once' | 'monthly' | 'quarterly' | 'yearly';
export type PlanningDirection = 'expense' | 'income';
export type PlanningStatus = 'active' | 'paused';

export interface PlanningCommitment {
  readonly id: string;
  readonly title: string;
  /** Positive integer in minor currency units. Direction supplies the cash-flow sign. */
  readonly amountMinor: number;
  readonly date: string;
  readonly direction: PlanningDirection;
  readonly frequency: PlanningFrequency;
  readonly currency: string;
  readonly status: PlanningStatus;
  /** Transient source metadata for agenda display; it is never stored in Actual. */
  readonly source?: 'manual' | 'actual_transaction' | 'recurring_candidate';
}

export interface PlanningMonthlyCashFlow {
  readonly month: string;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly savingsMinor: number;
  readonly transactionCount: number;
}

export interface PlanningHistoryEstimate {
  readonly currency: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly monthsWithData: number;
  readonly transactionCount: number;
  readonly emptyMonths: number;
  readonly monthlyIncomeMinor: number;
  readonly monthlyExpenseMinor: number;
  readonly monthlySavingsMinor: number;
  readonly monthlyHistory: readonly PlanningMonthlyCashFlow[];
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
}

export interface SavingsGoalInput {
  readonly asOfDate: string;
  readonly targetDate: string;
  readonly targetAmountMinor: number;
  readonly initialAmountMinor: number;
  readonly monthlyContributionMinor: number;
  readonly currency: string;
  readonly monthlyIncomeMinor: number;
  readonly monthlyExpenseMinor: number;
  readonly commitments: readonly PlanningCommitment[];
}

export interface SavingsGoalMonthlyRow {
  readonly month: string;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly commitmentIncomeMinor: number;
  readonly commitmentExpenseMinor: number;
  readonly availableCashMinor: number;
  readonly plannedContributionMinor: number;
  readonly actualContributionMinor: number;
  readonly projectedBalanceMinor: number;
}

export interface SavingsGoalProjection {
  readonly isEstimate: true;
  readonly currency: string;
  readonly asOfDate: string;
  readonly targetDate: string;
  readonly targetAmountMinor: number;
  readonly initialAmountMinor: number;
  readonly monthlyContributionMinor: number;
  readonly requiredMonthlyContributionMinor: number | null;
  readonly progressPercent: number;
  readonly projectedBalanceMinor: number;
  readonly projectedProgressPercent: number;
  readonly maximumAchievableBalanceMinor: number;
  readonly achievableUnderCashFlow: boolean;
  readonly goalReachedInitially: boolean;
  readonly estimatedCompletionDate: string | null;
  readonly months: number;
  readonly monthlyProjection: readonly SavingsGoalMonthlyRow[];
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
}

function safeMinor(value: number, label: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new RangeError(label + ' must be a safe integer in minor currency units.');
  }
}

function monthNumber(month: string): number {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(number) || number < 1 || number > 12) {
    throw new RangeError('month must use YYYY-MM.');
  }
  return year * 12 + number - 1;
}

function monthKeyFromNumber(value: number): string {
  const year = Math.floor(value / 12);
  const month = value % 12 + 1;
  if (year < 1900 || year > 9999) throw new RangeError('Planning horizon is outside supported calendar years.');
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0');
}

function monthStart(month: string): string {
  return month + '-01';
}

function monthEnd(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  return dateInMonth(month, lastDayOfMonth(year, monthIndex));
}

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function dateInMonth(month: string, dayOfMonth: number): string {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const day = Math.min(dayOfMonth, lastDayOfMonth(year, monthIndex));
  return month + '-' + String(day).padStart(2, '0');
}

function monthsBetweenInclusive(startDate: string, endDate: string): string[] {
  const start = monthNumber(startDate.slice(0, 7));
  const end = monthNumber(endDate.slice(0, 7));
  if (end < start) throw new RangeError('startDate must be on or before endDate.');
  if (end - start > 1200) throw new RangeError('Planning history cannot exceed 100 years.');
  const months: string[] = [];
  for (let value = start; value <= end; value += 1) months.push(monthKeyFromNumber(value));
  return months;
}

function validateCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('currency must be a three-letter uppercase code.');
}

/**
 * Summarizes a complete calendar-month window. Missing months are represented
 * explicitly as zeroes; internal transfers and split parents are excluded by
 * the shared ledger normalizer.
 */
export function estimatePlanningCashFlow(
  transactions: readonly BudgetTransaction[],
  categories: readonly BudgetCategory[],
  options: { readonly currency: string; readonly startDate: string; readonly endDate: string },
): PlanningHistoryEstimate {
  validatePeriod(options);
  validateCurrency(options.currency);
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const entries = normalizeTransactions(transactions).filter((entry) =>
    entry.date >= options.startDate && entry.date <= options.endDate,
  );
  const months = monthsBetweenInclusive(options.startDate, options.endDate);
  const values = new Map(months.map((month) => [month, { income: 0, expense: 0, count: 0 }]));
  for (const entry of entries) {
    if (entry.isTransfer) continue;
    const month = entry.date.slice(0, 7);
    const aggregate = values.get(month);
    if (!aggregate) continue;
    const category = entry.categoryId ? categoriesById.get(entry.categoryId) : undefined;
    if (category?.isIncome && entry.amountMinor > 0) aggregate.income += entry.amountMinor;
    else if (entry.amountMinor < 0) aggregate.expense += -entry.amountMinor;
    aggregate.count += 1;
  }
  for (const aggregate of values.values()) {
    safeMinor(aggregate.income, 'monthly income');
    safeMinor(aggregate.expense, 'monthly expense');
  }
  const monthlyHistory = months.map((month) => {
    const row = values.get(month)!;
    return {
      month,
      incomeMinor: row.income,
      expenseMinor: row.expense,
      savingsMinor: row.income - row.expense,
      transactionCount: row.count,
    };
  });
  const monthlyIncomeMinor = stableMedian(monthlyHistory.map((row) => row.incomeMinor)) ?? 0;
  const monthlyExpenseMinor = stableMedian(monthlyHistory.map((row) => row.expenseMinor)) ?? 0;
  const emptyMonths = monthlyHistory.filter((row) => row.transactionCount === 0).length;
  const warnings: string[] = [];
  if (monthlyHistory.length < 3) {
    warnings.push('El historial cubre menos de tres meses naturales; la mediana puede no representar el comportamiento habitual.');
  }
  if (emptyMonths > 0) {
    warnings.push('Se incluyen ' + emptyMonths + ' mes(es) sin movimientos como cero para no inflar la mediana.');
  }
  if (monthlyIncomeMinor <= 0) {
    warnings.push('Los ingresos mensuales observados son cero o negativos; no se puede asumir capacidad de ahorro positiva.');
  }
  if (entries.length === 0) warnings.push('No hay movimientos en el periodo; los importes observados se tratan como cero, no como datos confirmados de ingresos o gastos.');
  return {
    currency: options.currency,
    startDate: options.startDate,
    endDate: options.endDate,
    monthsWithData: monthlyHistory.filter((row) => row.transactionCount > 0).length,
    transactionCount: entries.filter((entry) => !entry.isTransfer).length,
    emptyMonths,
    monthlyIncomeMinor,
    monthlyExpenseMinor,
    monthlySavingsMinor: monthlyIncomeMinor - monthlyExpenseMinor,
    monthlyHistory,
    assumptions: [
      'La ventana contiene todos los meses naturales entre las fechas, incluidos los meses sin movimientos.',
      'Los traspasos internos se excluyen y los desgloses se normalizan para no contar el padre junto a sus partes.',
      'La mediana mensual de ingresos y gastos es una referencia estadística, no una garantía de ingresos disponibles.',
      'Solo se incluyen importes que finance-core ha recibido en la divisa de análisis; el adaptador debe excluir y advertir las conversiones no disponibles.',
    ],
    warnings,
  };
}

function occurrenceDateForMonth(commitment: PlanningCommitment, month: string): string {
  return dateInMonth(month, Number(commitment.date.slice(8, 10)));
}

/** Expands one-off, monthly, quarterly and annual manual commitments in a bounded date window. */
export function expandCommitmentOccurrences(
  commitments: readonly PlanningCommitment[],
  startDate: string,
  endDate: string,
): readonly (PlanningCommitment & { readonly occurrenceDate: string })[] {
  validatePeriod({ startDate, endDate });
  const firstMonth = monthNumber(startDate.slice(0, 7));
  const lastMonth = monthNumber(endDate.slice(0, 7));
  if (lastMonth - firstMonth > 1200) throw new RangeError('Commitment expansion cannot exceed 100 years.');
  const occurrences: (PlanningCommitment & { occurrenceDate: string })[] = [];
  for (const commitment of commitments) {
    if (commitment.status !== 'active') continue;
    if (!isIsoDate(commitment.date)) throw new RangeError('Commitment date must be a valid ISO calendar date.');
    if (!/^[A-Z]{3}$/.test(commitment.currency)) throw new RangeError('Commitment currency must be a three-letter uppercase code.');
    safeMinor(commitment.amountMinor, 'commitment amount');
    if (commitment.amountMinor <= 0) throw new RangeError('Commitment amount must be greater than zero.');
    if (!['once', 'monthly', 'quarterly', 'yearly'].includes(commitment.frequency)) {
      throw new RangeError('Unsupported commitment frequency.');
    }
    if (commitment.frequency === 'once') {
      if (commitment.date >= startDate && commitment.date <= endDate) occurrences.push({ ...commitment, occurrenceDate: commitment.date });
      continue;
    }
    const baseMonth = monthNumber(commitment.date.slice(0, 7));
    const interval = commitment.frequency === 'monthly' ? 1 : commitment.frequency === 'quarterly' ? 3 : 12;
    const from = Math.max(firstMonth, baseMonth);
    for (let current = from; current <= lastMonth; current += 1) {
      if (current < baseMonth || (current - baseMonth) % interval !== 0) continue;
      const month = monthKeyFromNumber(current);
      const occurrenceDate = occurrenceDateForMonth(commitment, month);
      if (occurrenceDate >= startDate && occurrenceDate <= endDate) occurrences.push({ ...commitment, occurrenceDate });
    }
  }
  return occurrences.sort((left, right) =>
    left.occurrenceDate.localeCompare(right.occurrenceDate) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id),
  );
}

/**
 * Projects a savings goal using deterministic monthly cash flow, explicit
 * manual commitments and no assumed interest. Contributions are capped at the
 * non-negative cash available in each month.
 */
export function projectSavingsGoal(input: SavingsGoalInput): SavingsGoalProjection {
  if (!isIsoDate(input.asOfDate) || !isIsoDate(input.targetDate)) {
    throw new RangeError('Goal dates must be valid ISO calendar dates.');
  }
  if (input.targetDate <= input.asOfDate) throw new RangeError('targetDate must be after asOfDate.');
  validateCurrency(input.currency);
  safeMinor(input.targetAmountMinor, 'target amount');
  safeMinor(input.initialAmountMinor, 'initial amount');
  safeMinor(input.monthlyContributionMinor, 'monthly contribution');
  safeMinor(input.monthlyIncomeMinor, 'monthly income', true);
  safeMinor(input.monthlyExpenseMinor, 'monthly expense');
  if (input.targetAmountMinor <= 0) throw new RangeError('target amount must be greater than zero.');
  if (input.targetDate.slice(0, 4) > String(Number(input.asOfDate.slice(0, 4)) + 10)) {
    throw new RangeError('Savings goal horizon cannot exceed ten years.');
  }
  const initialBalance = input.initialAmountMinor;
  const goalReachedInitially = initialBalance >= input.targetAmountMinor;
  const currentMonthNumber = monthNumber(input.asOfDate.slice(0, 7));
  const targetMonthNumber = monthNumber(input.targetDate.slice(0, 7));
  const targetMonthEnd = monthEnd(input.targetDate.slice(0, 7));
  // Only count a target-month contribution when the deadline allows the full calendar month.
  const months = Math.max(0, targetMonthNumber - currentMonthNumber - (input.targetDate === targetMonthEnd ? 0 : 1));
  if (months > 120) throw new RangeError('Savings goal horizon cannot exceed 120 months.');
  const projectedMonths = Array.from({ length: months }, (_item, index) => monthKeyFromNumber(currentMonthNumber + index + 1));
  const windowStart = projectedMonths.length ? monthStart(projectedMonths[0]!) : input.targetDate;
  const commitments = input.commitments.filter((commitment) => commitment.status === 'active');
  const mismatchedCurrencies = commitments.filter((commitment) => commitment.currency !== input.currency);
  const sameCurrencyCommitments = commitments.filter((commitment) => commitment.currency === input.currency);
  const occurrences = expandCommitmentOccurrences(sameCurrencyCommitments, windowStart, input.targetDate);
  const byMonth = new Map<string, { income: number; expense: number }>();
  for (const occurrence of occurrences) {
    const month = occurrence.occurrenceDate.slice(0, 7);
    const aggregate = byMonth.get(month) ?? { income: 0, expense: 0 };
    if (occurrence.direction === 'income') aggregate.income += occurrence.amountMinor;
    else aggregate.expense += occurrence.amountMinor;
    safeMinor(aggregate.income, 'commitment income');
    safeMinor(aggregate.expense, 'commitment expense');
    byMonth.set(month, aggregate);
  }
  let balance = initialBalance;
  let maximumBalance = initialBalance;
  let projectedCompletionDate: string | null = goalReachedInitially ? input.asOfDate : null;
  const monthlyProjection: SavingsGoalMonthlyRow[] = [];
  for (const month of projectedMonths) {
    const commitment = byMonth.get(month) ?? { income: 0, expense: 0 };
    const availableCashMinor = input.monthlyIncomeMinor - input.monthlyExpenseMinor + commitment.income - commitment.expense;
    const contribution = Math.min(input.monthlyContributionMinor, Math.max(0, availableCashMinor));
    balance += contribution;
    maximumBalance += Math.max(0, availableCashMinor);
    safeMinor(balance, 'projected balance');
    safeMinor(maximumBalance, 'maximum achievable balance');
    if (!projectedCompletionDate && balance >= input.targetAmountMinor) {
      projectedCompletionDate = monthEnd(month);
    }
    monthlyProjection.push({
      month,
      incomeMinor: input.monthlyIncomeMinor,
      expenseMinor: input.monthlyExpenseMinor,
      commitmentIncomeMinor: commitment.income,
      commitmentExpenseMinor: commitment.expense,
      availableCashMinor,
      plannedContributionMinor: input.monthlyContributionMinor,
      actualContributionMinor: contribution,
      projectedBalanceMinor: balance,
    });
  }
  const gap = Math.max(0, input.targetAmountMinor - initialBalance);
  const requiredMonthlyContributionMinor = months > 0 ? Math.ceil(gap / months) : (gap === 0 ? 0 : null);
  const achievableUnderCashFlow = maximumBalance >= input.targetAmountMinor;
  const warnings: string[] = [];
  if (months === 0 && !goalReachedInitially) warnings.push('La fecha objetivo cae en el mes actual: no hay meses completos para nuevas aportaciones periódicas.');
  if (input.monthlyIncomeMinor <= 0) warnings.push('Los ingresos supuestos son cero o negativos; la proyección no atribuye capacidad de ahorro a ingresos no demostrados.');
  if (input.monthlyIncomeMinor - input.monthlyExpenseMinor <= 0) warnings.push('El flujo mensual base es cero o negativo antes de compromisos; las aportaciones quedan limitadas al efectivo positivo disponible.');
  if (monthlyProjection.some((row) => row.actualContributionMinor < row.plannedContributionMinor)) {
    warnings.push('En uno o más meses la aportación se limita al efectivo estimado disponible después de compromisos; no se supone financiación adicional.');
  }
  if (mismatchedCurrencies.length > 0) {
    warnings.push('Se han excluido ' + mismatchedCurrencies.length + ' compromiso(s) cuya divisa no coincide con la divisa objetivo.');
  }
  if (!achievableUnderCashFlow && !goalReachedInitially) {
    warnings.push('El objetivo no es alcanzable dentro del horizonte con el flujo de caja y los compromisos activos actuales.');
  }
  if (balance < input.targetAmountMinor && achievableUnderCashFlow) {
    warnings.push('La aportación configurada no alcanza el objetivo, aunque el flujo máximo estimado podría permitirlo; aumenta la aportación o revisa los supuestos.');
  }
  const assumptions = [
    'La divisa de análisis es ' + input.currency + '; solo se suman compromisos con esa misma divisa.',
    'Las aportaciones empiezan el próximo mes natural y no se aplica interés, revalorización ni inflación.',
    'Los ingresos y gastos base permanecen constantes cada mes; los compromisos se aplican según su fecha y frecuencia declaradas.',
    'Las aportaciones se limitan al mínimo entre el importe mensual supuesto y el efectivo no negativo estimado después de compromisos.',
    'Los compromisos futuros son hipótesis manuales, no movimientos reales; no modifican Actual Budget.',
  ];
  if (windowStart <= input.targetDate && projectedMonths.length > 0) {
    assumptions.push('El horizonte comprende meses completos desde ' + windowStart + ' hasta el mes de la fecha objetivo ' + input.targetDate + '.');
  }
  return {
    isEstimate: true,
    currency: input.currency,
    asOfDate: input.asOfDate,
    targetDate: input.targetDate,
    targetAmountMinor: input.targetAmountMinor,
    initialAmountMinor: initialBalance,
    monthlyContributionMinor: input.monthlyContributionMinor,
    requiredMonthlyContributionMinor,
    progressPercent: Math.min(100, initialBalance / input.targetAmountMinor * 100),
    projectedBalanceMinor: balance,
    projectedProgressPercent: Math.min(100, balance / input.targetAmountMinor * 100),
    maximumAchievableBalanceMinor: maximumBalance,
    achievableUnderCashFlow,
    goalReachedInitially,
    estimatedCompletionDate: projectedCompletionDate,
    months,
    monthlyProjection,
    assumptions,
    warnings,
  };
}
