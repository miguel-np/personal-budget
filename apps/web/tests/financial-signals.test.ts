import { describe, expect, it } from 'vitest';
import { assessNetWorth, comparePeriodValues, getBudgetAlerts, type BudgetSignalCategory } from '../src/financial-signals.js';

function budgetCategory(overrides: Partial<BudgetSignalCategory> = {}): BudgetSignalCategory {
  return {
    categoryId: 'food',
    categoryName: 'Alimentación',
    isIncome: false,
    hidden: false,
    budgetedMinor: 10_000,
    spentMinor: 8_500,
    availableMinor: 1_500,
    percentUsed: 85,
    ...overrides,
  };
}

describe('financial dashboard signals', () => {
  it('calculates absolute comparison and only gives percentage for a positive baseline', () => {
    expect(comparePeriodValues(12_000, 10_000)).toEqual({ absoluteMinor: 2_000, percentageChange: 20 });
    expect(comparePeriodValues(7_000, 0)).toEqual({ absoluteMinor: 7_000, percentageChange: null });
    expect(comparePeriodValues(100, -50)).toEqual({ absoluteMinor: 150, percentageChange: null });
    expect(() => comparePeriodValues(Number.MAX_SAFE_INTEGER, -1)).toThrow(RangeError);
  });

  it('ranks overspent categories above near-limit categories and uses known budget values only', () => {
    const alerts = getBudgetAlerts([
      budgetCategory({ categoryId: 'near', categoryName: 'Cerca del límite', percentUsed: 85 }),
      budgetCategory({ categoryId: 'over-small', categoryName: 'Exceso pequeño', availableMinor: -500, percentUsed: 105 }),
      budgetCategory({ categoryId: 'over-large', categoryName: 'Exceso grande', availableMinor: -2_000, percentUsed: 120 }),
      budgetCategory({ categoryId: 'unknown', budgetedMinor: null, percentUsed: null }),
      budgetCategory({ categoryId: 'unknown-spend', spentMinor: null, availableMinor: null }),
      budgetCategory({ categoryId: 'unbudgeted', budgetedMinor: 0, percentUsed: null }),
      budgetCategory({ categoryId: 'income', isIncome: true }),
      budgetCategory({ categoryId: 'hidden', hidden: true }),
      budgetCategory({ categoryId: 'under-limit', percentUsed: 50 }),
    ]);
    expect(alerts.map((alert) => alert.categoryId)).toEqual(['over-large', 'over-small', 'near']);
    expect(alerts[0]?.kind).toBe('over-budget');
    expect(alerts[0]?.overByMinor).toBe(2_000);
  });

  it('does not turn unknown spend into zero and supports a configurable threshold', () => {
    expect(getBudgetAlerts([budgetCategory({ spentMinor: null, availableMinor: null })])).toEqual([]);
    expect(getBudgetAlerts([budgetCategory({ percentUsed: 79 })])).toEqual([]);
    expect(getBudgetAlerts([budgetCategory({ percentUsed: 80 })])[0]?.kind).toBe('near-limit');
    expect(() => getBudgetAlerts([], 0)).toThrow(RangeError);
  });
});

describe('net worth eligibility', () => {
  it('does not infer a liability from a negative balance when classification is missing', () => {
    const result = assessNetWorth([
      { id: 'negative', closed: false, offBudget: false, displayBalanceMinor: -50_000, displayCurrency: 'EUR' },
    ], 'EUR');
    expect(result.status).toBe('unavailable');
    expect(result.amountMinor).toBeNull();
    expect(result.reasons.join(' ')).toContain('no permiten deducirla');
  });

  it('requires every selected balance to be converted to the reporting currency', () => {
    const result = assessNetWorth([
      { id: 'cash', closed: false, offBudget: false, classification: 'asset', displayBalanceMinor: 100_000, displayCurrency: 'EUR' },
      { id: 'foreign', closed: false, offBudget: false, classification: 'asset', displayBalanceMinor: null, displayCurrency: 'EUR' },
    ], 'EUR');
    expect(result.status).toBe('incomplete');
    expect(result.amountMinor).toBeNull();
  });

  it('uses explicit classifications and makes off-budget inclusion auditable', () => {
    const accounts = [
      { id: 'cash', closed: false, offBudget: false, classification: 'asset' as const, displayBalanceMinor: 100_000, displayCurrency: 'EUR' },
      { id: 'loan', closed: false, offBudget: true, classification: 'liability' as const, displayBalanceMinor: -30_000, displayCurrency: 'EUR' },
      { id: 'closed', closed: true, offBudget: false, classification: 'asset' as const, displayBalanceMinor: 5_000, displayCurrency: 'EUR' },
    ];
    const included = assessNetWorth(accounts, 'EUR');
    expect(included.status).toBe('available');
    expect(included.amountMinor).toBe(70_000);
    expect(included.includedAccountIds).toEqual(['cash', 'loan']);
    expect(included.excludedAccountIds).toEqual(['closed']);

    const excluded = assessNetWorth(accounts, 'EUR', undefined, false);
    expect(excluded.amountMinor).toBe(100_000);
    expect(excluded.includedAccountIds).toEqual(['cash']);
    expect(excluded.excludedAccountIds).toEqual(['loan', 'closed']);
    expect(excluded.reasons.join(' ')).toContain('fuera de presupuesto están excluidas');
  });
  it('treats an explicitly known zero balance as zero rather than unknown', () => {
    const result = assessNetWorth([
      { id: 'zero-cash', closed: false, offBudget: false, classification: 'asset', displayBalanceMinor: 0, displayCurrency: 'EUR' },
    ], 'EUR');
    expect(result.status).toBe('available');
    expect(result.amountMinor).toBe(0);
    expect(result.includedAccountIds).toEqual(['zero-cash']);
  });

});
