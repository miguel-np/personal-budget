import { describe, expect, it } from 'vitest';
import type { BudgetCategory, BudgetTransaction } from '../src/domain.js';
import { projectSavings } from '../src/forecast.js';

const categories: readonly BudgetCategory[] = [
  { id: 'salary', name: 'Salario', groupId: 'income', isIncome: true },
  { id: 'food', name: 'Alimentación', groupId: 'spend', isIncome: false },
  { id: 'rent', name: 'Alquiler', groupId: 'spend', isIncome: false },
];

function expense(id: string, date: string, amount: number, payee: string, category: string | null = null, overrides: Partial<BudgetTransaction> = {}): BudgetTransaction {
  return { id, account: 'account-1', date, amount, payee_name: payee, category, transfer_id: null, ...overrides };
}

function salary(id: string, date: string, amount: number): BudgetTransaction {
  return { id, account: 'account-1', date, amount, payee_name: 'Empresa', category: 'salary', transfer_id: null };
}

const historyPeriod = { startDate: '2026-01-01', endDate: '2026-06-30' };

function stableHistory(): BudgetTransaction[] {
  const transactions: BudgetTransaction[] = [];
  for (let month = 1; month <= 6; month += 1) {
    const monthLabel = String(month).padStart(2, '0');
    transactions.push(salary('salary-' + month, '2026-' + monthLabel + '-01', 200_000));
    transactions.push(expense('rent-' + month, '2026-' + monthLabel + '-02', -80_000, 'Casero', 'rent'));
    transactions.push(expense('food-' + month, '2026-' + monthLabel + '-03', -30_000, 'Supermercado', 'food'));
  }
  return transactions;
}

describe('projectSavings', () => {
  it('is deterministic and marks the result as an estimate', () => {
    const transactions = stableHistory();
    const scenario = { type: 'income_change', percent: 0 } as const;
    const options = { currency: 'EUR', horizonMonths: 6, ...historyPeriod };
    const first = projectSavings(transactions, categories, scenario, options);
    const second = projectSavings(transactions, categories, scenario, options);
    expect(first).toEqual(second);
    expect(first.isEstimate).toBe(true);
    expect(first.baselineMonthlyIncomeMinor).toBe(200_000);
    expect(first.recurringExpenseMonthlyMinor).toBe(110_000);
    expect(first.projectedMonthlySavingsMinor).toBe(90_000);
    expect(first.projectedSavingsMinor).toBe(540_000);
    expect(first.monthlyProjection).toHaveLength(6);
    expect(first.monthlyProjection[0]!.month).toBe('2026-07');
    expect(first.assumptions.some((assumption) => assumption.includes('constante'))).toBe(true);
  });

  it('applies a category reduction using that category monthly median', () => {
    const transactions = stableHistory();
    const result = projectSavings(transactions, categories, { type: 'category_reduction', categoryId: 'food', percent: 10 }, {
      currency: 'EUR', horizonMonths: 3, ...historyPeriod,
    });
    expect(result.projectedMonthlyExpenseMinor).toBe(110_000 - 3_000);
    expect(result.projectedMonthlySavingsMinor).toBe(93_000);
    expect(result.assumptions.some((assumption) => assumption.includes('Alimentación'))).toBe(true);
  });

  it('reduces the monthly category total, not the median individual transaction', () => {
    const transactions = stableHistory();
    for (let month = 1; month <= 6; month += 1) {
      const monthLabel = String(month).padStart(2, '0');
      transactions.push(expense('food-extra-' + month, '2026-' + monthLabel + '-04', -20_000, 'Mercado adicional', 'food'));
    }
    const result = projectSavings(transactions, categories, { type: 'category_reduction', categoryId: 'food', percent: 10 }, {
      currency: 'EUR', horizonMonths: 3, ...historyPeriod,
    });
    // Food is 50,000 minor units per month (30,000 + 20,000), so a 10%
    // reduction lowers monthly spending by 5,000, not 3,000 or 2,000.
    expect(result.projectedMonthlyExpenseMinor).toBe(130_000 - 5_000);
    expect(result.projectedMonthlySavingsMinor).toBe(75_000);
  });

  it('includes zero-spend months in the category monthly median', () => {
    const transactions = stableHistory().filter((transaction) =>
      transaction.category !== 'food' || transaction.date.startsWith('2026-01') || transaction.date.startsWith('2026-02'));
    transactions.push(expense('food-extra-01', '2026-01-04', -20_000, 'Mercado adicional', 'food'));
    transactions.push(expense('food-extra-02', '2026-02-04', -20_000, 'Mercado adicional', 'food'));
    const result = projectSavings(transactions, categories, { type: 'category_reduction', categoryId: 'food', percent: 10 }, {
      currency: 'EUR', horizonMonths: 3, ...historyPeriod,
    });
    // The category has no spend in four of six months; the median monthly
    // category spend is therefore zero and should not create artificial savings.
    expect(result.projectedMonthlyExpenseMinor).toBe(80_000);
    expect(result.projectedMonthlySavingsMinor).toBe(120_000);
  });

  it('applies an income change on the historical median', () => {
    const result = projectSavings(stableHistory(), categories, { type: 'income_change', percent: 10 }, {
      currency: 'EUR', horizonMonths: 2, ...historyPeriod,
    });
    expect(result.projectedMonthlyIncomeMinor).toBe(220_000);
    expect(result.projectedMonthlyExpenseMinor).toBe(110_000);
    expect(result.projectedSavingsMinor).toBe(220_000);
  });

  it('warns about insufficient or zero-income history instead of faking precision', () => {
    const sparse = stableHistory().slice(0, 3);
    const result = projectSavings(sparse, categories, { type: 'income_change', percent: 0 }, {
      currency: 'EUR', horizonMonths: 1, ...historyPeriod,
    });
    expect(result.warnings.some((warning) => warning.includes('menos de tres meses'))).toBe(true);

    const zeroIncome = stableHistory().map((transaction) => transaction.category === 'salary'
      ? { ...transaction, amount: 0 } : transaction);
    const zeroResult = projectSavings(zeroIncome, categories, { type: 'income_change', percent: 0 }, {
      currency: 'EUR', horizonMonths: 1, ...historyPeriod,
    });
    expect(zeroResult.baselineMonthlyIncomeMinor).toBe(0);
    expect(zeroResult.projectedMonthlySavingsMinor).toBe(-110_000);
    expect(zeroResult.warnings.some((warning) => warning.includes('ingresos'))).toBe(true);
  });

  it('separates recurring estimates from extraordinary spikes with a warning', () => {
    const transactions = [
      ...stableHistory().slice(0, 9),
      expense('xmas-gift', '2026-04-20', -150_000, 'Regalo', 'food'),
      expense('xmas-trip', '2026-04-21', -200_000, 'Viaje', null),
    ];
    const result = projectSavings(transactions, categories, { type: 'income_change', percent: 0 }, {
      currency: 'EUR', horizonMonths: 1, ...historyPeriod,
    });
    expect(result.recurringExpenseMonthlyMinor).toBe(110_000);
    expect(result.warnings.some((warning) => warning.includes('extraordinario'))).toBe(true);
  });

  it('warns when no recurring candidates are detected', () => {
    const oneOffs = [
      salary('salary-1', '2026-01-01', 200_000),
      expense('a', '2026-01-02', -5000, 'Tienda A'),
      expense('b', '2026-02-03', -6000, 'Tienda B'),
      expense('c', '2026-03-04', -7000, 'Tienda C'),
      salary('salary-2', '2026-02-01', 200_000),
      salary('salary-3', '2026-03-01', 200_000),
    ];
    const result = projectSavings(oneOffs, categories, { type: 'income_change', percent: 0 }, {
      currency: 'EUR', horizonMonths: 1, ...historyPeriod,
    });
    expect(result.recurringExpenseMonthlyMinor).toBe(0);
    expect(result.warnings.some((warning) => warning.includes('recurrentes'))).toBe(true);
  });

  it('always warns that the horizon extends beyond data', () => {
    const result = projectSavings(stableHistory(), categories, { type: 'income_change', percent: 0 }, {
      currency: 'EUR', horizonMonths: 12, ...historyPeriod,
    });
    expect(result.warnings.some((warning) => warning.includes('horizonte'))).toBe(true);
    expect(result.monthlyProjection).toHaveLength(12);
    expect(result.monthlyProjection.at(-1)!.month).toBe('2027-06');
  });

  it('rejects invalid scenarios, horizons and currencies without touching data', () => {
    const options = { currency: 'EUR', horizonMonths: 1, ...historyPeriod };
    expect(() => projectSavings(stableHistory(), categories, { type: 'category_reduction', categoryId: 'missing', percent: 10 }, options)).toThrow(/expense category/);
    expect(() => projectSavings(stableHistory(), categories, { type: 'category_reduction', categoryId: 'food', percent: 101 }, options)).toThrow(/percent/);
    expect(() => projectSavings(stableHistory(), categories, { type: 'income_change', percent: -101 }, options)).toThrow(/percent/);
    expect(() => projectSavings(stableHistory(), categories, { type: 'income_change', percent: 0 }, { ...options, horizonMonths: 0 })).toThrow(/horizonMonths/);
    expect(() => projectSavings(stableHistory(), categories, { type: 'income_change', percent: 0 }, { ...options, horizonMonths: 61 })).toThrow(/horizonMonths/);
    expect(() => projectSavings(stableHistory(), categories, { type: 'income_change', percent: 0 }, { ...options, currency: 'eur' })).toThrow(/currency/);
    expect(() => projectSavings(stableHistory(), categories, { type: 'income_change', percent: 0 }, { ...options, startDate: '2026-06-30', endDate: '2026-01-01' })).toThrow(/startDate/);
  });
});
