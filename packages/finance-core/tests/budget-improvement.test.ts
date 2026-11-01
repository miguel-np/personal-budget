import { describe, expect, it } from 'vitest';
import { buildBudgetImprovementProposals, simulateBudgetImprovement } from '../src/budget-improvement.js';
import type { BudgetImprovementBaseline, BudgetImprovementCategoryPreference } from '../src/budget-improvement.js';
const baseline: BudgetImprovementBaseline = {
  currency: 'EUR', startDate: '2026-05-01', endDate: '2026-10-31', periodMonths: 6,
  monthlyIncomeMinor: 300_000, monthlyExpenseMinor: 250_000, monthlySavingsMinor: 50_000,
  savingsRatePercent: 16.7, transactionCount: 40, unconvertedTransactionCount: 0,
  observations: [
    { categoryId: 'flex', categoryName: 'Flexible', expenseMinor: 120_000, transactionCount: 12, monthsWithActivity: 6 },
    { categoryId: 'essential', categoryName: 'Essential', expenseMinor: 90_000, transactionCount: 18, monthsWithActivity: 6 },
    { categoryId: 'unknown', categoryName: 'Unknown', expenseMinor: 60_000, transactionCount: 10, monthsWithActivity: 4 },
  ],
};
const preferences: BudgetImprovementCategoryPreference[] = [
  { categoryId: 'flex', classification: 'flexible' }, { categoryId: 'essential', classification: 'essential' },
];
describe('budget improvement proposals', () => {
  it('proposes only user-marked flexible categories and attaches evidence', () => {
    const proposals = buildBudgetImprovementProposals(baseline, preferences);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ categoryId: 'flex', confidence: 'high', suggestedReductionPercent: 5, estimatedMonthlySavingsMinor: 1_000, estimatedAnnualSavingsMinor: 12_000 });
    expect(buildBudgetImprovementProposals(baseline, preferences, 'reach_savings_goal')[0]?.explanation).toContain('objetivo de ahorro');
  });
  it('does not infer flexibility from names or cut protected/essential categories', () => {
    expect(buildBudgetImprovementProposals(baseline, [{ categoryId: 'essential', classification: 'protected' }])).toEqual([]);
  });
  it('combines distinct categories deterministically and rejects duplicate reductions', () => {
    const result = simulateBudgetImprovement(baseline, preferences, [{ categoryId: 'flex', reductionPercent: 10 }]);
    expect(result.estimatedMonthlySavingsMinor).toBe(2_000);
    expect(result.projectedMonthlySavingsMinor).toBe(52_000);
    expect(() => simulateBudgetImprovement(baseline, preferences, [{ categoryId: 'flex', reductionPercent: 5 }, { categoryId: 'flex', reductionPercent: 10 }])).toThrow(/double count/);
    expect(() => simulateBudgetImprovement(baseline, preferences, [{ categoryId: 'essential', reductionPercent: 5 }])).toThrow(/explicitly marked/);
  });
  it('rejects short history and out-of-range percentages', () => {
    expect(() => buildBudgetImprovementProposals({ ...baseline, periodMonths: 1 }, preferences)).toThrow(/between 3 and 24/);
    expect(() => simulateBudgetImprovement(baseline, preferences, [{ categoryId: 'flex', reductionPercent: 101 }])).toThrow(/between 1 and 100/);
    expect(() => simulateBudgetImprovement(huge, preferences, [{ categoryId: 'flex', reductionPercent: 100 }])).toThrow(/safe integer range/);
  });
});
