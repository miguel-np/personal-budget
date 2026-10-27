import { describe, expect, it } from 'vitest';
import type { BudgetCategory, BudgetTransaction } from '../src/domain.js';
import { estimatePlanningCashFlow, expandCommitmentOccurrences, projectSavingsGoal, type PlanningCommitment } from '../src/planning.js';

const categories: readonly BudgetCategory[] = [
  { id: 'salary', name: 'Salario', groupId: 'income', isIncome: true },
  { id: 'food', name: 'Alimentación', groupId: 'spend', isIncome: false },
];

describe('planning core', () => {
  it('includes empty months as zeroes when computing deterministic history medians', () => {
    const transactions: readonly BudgetTransaction[] = [
      { id: 'income-1', account: 'main', date: '2026-01-12', amount: 200_000, category: 'salary' },
      { id: 'expense-1', account: 'main', date: '2026-01-13', amount: -50_000, category: 'food' },
      { id: 'transfer-1', account: 'main', date: '2026-01-14', amount: -25_000, transfer_id: 'counterpart' },
    ];
    const estimate = estimatePlanningCashFlow(transactions, categories, {
      currency: 'EUR', startDate: '2026-01-01', endDate: '2026-03-31',
    });
    expect(estimate.monthlyHistory).toHaveLength(3);
    expect(estimate.monthlyHistory.map((row) => row.incomeMinor)).toEqual([200_000, 0, 0]);
    expect(estimate.monthlyHistory.map((row) => row.expenseMinor)).toEqual([50_000, 0, 0]);
    expect(estimate.monthlyIncomeMinor).toBe(0);
    expect(estimate.monthlyExpenseMinor).toBe(0);
    expect(estimate.emptyMonths).toBe(2);
    expect(estimate.monthlyHistory[0]?.transactionCount).toBe(2);
    expect(estimate.warnings.some((warning) => warning.includes('mes(es) sin movimientos'))).toBe(true);
  });

  it('expands monthly commitments without drifting from end-of-month dates', () => {
    const commitment: PlanningCommitment = {
      id: 'rent', title: 'Alquiler', amountMinor: 85_000, date: '2026-01-31',
      direction: 'expense', frequency: 'monthly', currency: 'EUR', status: 'active',
    };
    const occurrences = expandCommitmentOccurrences([commitment], '2026-02-01', '2026-04-30');
    expect(occurrences.map((item) => item.occurrenceDate)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('projects savings with explicit future commitments and caps contributions at available cash', () => {
    const commitments: PlanningCommitment[] = [{
      id: 'insurance', title: 'Seguro anual', amountMinor: 60_000, date: '2026-12-15',
      direction: 'expense', frequency: 'once', currency: 'EUR', status: 'active',
    }];
    const result = projectSavingsGoal({
      asOfDate: '2026-10-27', targetDate: '2027-03-31', targetAmountMinor: 300_000,
      initialAmountMinor: 50_000, monthlyContributionMinor: 100_000, currency: 'EUR',
      monthlyIncomeMinor: 200_000, monthlyExpenseMinor: 120_000, commitments,
    });
    expect(result.months).toBe(5);
    expect(result.monthlyProjection.map((row) => row.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
    expect(result.monthlyProjection[1]?.commitmentExpenseMinor).toBe(60_000);
    expect(result.monthlyProjection[1]?.actualContributionMinor).toBe(20_000);
    expect(result.projectedBalanceMinor).toBe(390_000);
    expect(result.achievableUnderCashFlow).toBe(true);
  });

  it('warns when zero or negative income prevents a realistic contribution', () => {
    const result = projectSavingsGoal({
      asOfDate: '2026-10-27', targetDate: '2027-01-01', targetAmountMinor: 50_000,
      initialAmountMinor: 0, monthlyContributionMinor: 20_000, currency: 'EUR',
      monthlyIncomeMinor: 0, monthlyExpenseMinor: 30_000, commitments: [],
    });
    expect(result.monthlyProjection.every((row) => row.actualContributionMinor === 0)).toBe(true);
    expect(result.achievableUnderCashFlow).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('cero o negativos'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('no es alcanzable'))).toBe(true);
  });

  it('distinguishes a reached target from a target outside the remaining monthly horizon', () => {
    const reached = projectSavingsGoal({
      asOfDate: '2026-10-27', targetDate: '2026-12-01', targetAmountMinor: 100_000,
      initialAmountMinor: 120_000, monthlyContributionMinor: 0, currency: 'EUR',
      monthlyIncomeMinor: 100_000, monthlyExpenseMinor: 20_000, commitments: [],
    });
    expect(reached.goalReachedInitially).toBe(true);
    expect(reached.estimatedCompletionDate).toBe('2026-10-27');
    expect(reached.progressPercent).toBe(100);

    const sameMonth = projectSavingsGoal({
      asOfDate: '2026-10-01', targetDate: '2026-10-30', targetAmountMinor: 100_000,
      initialAmountMinor: 1_000, monthlyContributionMinor: 50_000, currency: 'EUR',
      monthlyIncomeMinor: 80_000, monthlyExpenseMinor: 10_000, commitments: [],
    });
    expect(sameMonth.months).toBe(0);
    expect(sameMonth.requiredMonthlyContributionMinor).toBeNull();
    expect(sameMonth.warnings.some((warning) => warning.includes('mes actual'))).toBe(true);
  });

  it('does not silently mix commitment currencies in a projection', () => {
    const result = projectSavingsGoal({
      asOfDate: '2026-10-27', targetDate: '2027-01-01', targetAmountMinor: 100_000,
      initialAmountMinor: 0, monthlyContributionMinor: 10_000, currency: 'EUR',
      monthlyIncomeMinor: 50_000, monthlyExpenseMinor: 20_000,
      commitments: [{
        id: 'usd', title: 'Compromiso USD', amountMinor: 1_000, date: '2026-11-01',
        direction: 'expense', frequency: 'once', currency: 'USD', status: 'active',
      }],
    });
    expect(result.monthlyProjection.every((row) => row.commitmentExpenseMinor === 0)).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('divisa no coincide'))).toBe(true);
  });

  it('rejects invalid dates and unsafe financial amounts', () => {
    expect(() => projectSavingsGoal({
      asOfDate: '2026-10-27', targetDate: '2027-01-01', targetAmountMinor: Number.MAX_SAFE_INTEGER + 1,
      initialAmountMinor: 0, monthlyContributionMinor: 0, currency: 'EUR',
      monthlyIncomeMinor: 50_000, monthlyExpenseMinor: 20_000, commitments: [],
    })).toThrow(/safe integer/);
    expect(() => expandCommitmentOccurrences([], '2026-02-30', '2026-03-31')).toThrow();
  });
});
