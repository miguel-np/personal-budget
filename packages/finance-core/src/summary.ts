import type { BudgetCategory, CategoryTotal, FinancialSummary, LedgerEntry, Period } from './domain.js';
import { validatePeriod } from './date-range.js';

export interface SummaryOptions extends Period {
  readonly currency: string;
}

interface MutableCategoryTotal {
  categoryId: string | null;
  categoryName: string;
  amountMinor: number;
  transactionCount: number;
}

function ensureSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(label + ' exceeds the safe integer range.');
  return value;
}

function addTotal(
  totals: Map<string, MutableCategoryTotal>,
  categoryId: string | null,
  categoryName: string,
  amountMinor: number,
): void {
  const key = categoryId ?? '__uncategorized__';
  const current = totals.get(key) ?? { categoryId, categoryName, amountMinor: 0, transactionCount: 0 };
  current.amountMinor = ensureSafeInteger(current.amountMinor + amountMinor, 'Category total');
  current.transactionCount += 1;
  totals.set(key, current);
}

function sortTotals(totals: Map<string, MutableCategoryTotal>): readonly CategoryTotal[] {
  return [...totals.values()]
    .sort((left, right) => Math.abs(right.amountMinor) - Math.abs(left.amountMinor))
    .map((item) => ({ ...item }));
}

/** Calculate amounts deterministically, preserving Actual's integer minor-unit representation. */
export function calculateSummary(
  entries: readonly LedgerEntry[],
  categories: readonly BudgetCategory[],
  options: SummaryOptions,
): FinancialSummary {
  validatePeriod(options);
  if (!/^[A-Z]{3}$/.test(options.currency)) throw new RangeError('currency must be a three-letter uppercase code.');

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const expensesByCategory = new Map<string, MutableCategoryTotal>();
  const incomeByCategory = new Map<string, MutableCategoryTotal>();
  let incomeMinor = 0;
  let expenseMinor = 0;
  let uncategorizedOutflowMinor = 0;
  let unclassifiedInflowMinor = 0;
  let excludedTransferCount = 0;
  let transactionCount = 0;

  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountMinor)) throw new RangeError('Transaction amount must be a safe integer in minor units.');
    if (entry.date < options.startDate || entry.date > options.endDate) continue;
    if (entry.isTransfer || entry.transferId) {
      excludedTransferCount += 1;
      continue;
    }

    transactionCount += 1;
    const category = entry.categoryId ? categoryById.get(entry.categoryId) : undefined;
    const categoryName = category?.name ?? 'Sin categoría';

    if (category?.isIncome) {
      incomeMinor = ensureSafeInteger(incomeMinor + entry.amountMinor, 'Income total');
      addTotal(incomeByCategory, category.id, category.name, entry.amountMinor);
      continue;
    }

    if (entry.amountMinor > 0 && entry.categoryId === null) {
      unclassifiedInflowMinor = ensureSafeInteger(unclassifiedInflowMinor + entry.amountMinor, 'Unclassified inflow total');
      continue;
    }

    const netOutflow = -entry.amountMinor;
    expenseMinor = ensureSafeInteger(expenseMinor + netOutflow, 'Expense total');
    addTotal(expensesByCategory, entry.categoryId, categoryName, netOutflow);
    if (entry.categoryId === null && entry.amountMinor < 0) {
      uncategorizedOutflowMinor = ensureSafeInteger(uncategorizedOutflowMinor + netOutflow, 'Uncategorized outflow total');
    }
  }

  const savingsMinor = ensureSafeInteger(incomeMinor - expenseMinor, 'Savings total');
  const savingsRatePercent = incomeMinor > 0 ? (savingsMinor / incomeMinor) * 100 : null;
  const warnings: string[] = [];
  if (unclassifiedInflowMinor !== 0) warnings.push('Hay entradas positivas sin categoría; no se contabilizan como ingresos hasta clasificarlas.');
  if (uncategorizedOutflowMinor !== 0) warnings.push('Hay gastos sin categoría que conviene revisar.');
  if (incomeMinor <= 0) warnings.push('La tasa de ahorro no se calcula porque los ingresos del periodo no son positivos.');

  return {
    currency: options.currency,
    startDate: options.startDate,
    endDate: options.endDate,
    incomeMinor,
    expenseMinor,
    savingsMinor,
    savingsRatePercent,
    uncategorizedOutflowMinor,
    unclassifiedInflowMinor,
    excludedTransferCount,
    transactionCount,
    expensesByCategory: sortTotals(expensesByCategory),
    incomeByCategory: sortTotals(incomeByCategory),
    warnings,
  };
}
