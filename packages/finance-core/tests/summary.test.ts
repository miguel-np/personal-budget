import { describe, expect, it } from 'vitest';
import type { BudgetCategory, LedgerEntry } from '../src/domain.js';
import { calculateSummary } from '../src/summary.js';

const categories: readonly BudgetCategory[] = [
  { id: 'salary', name: 'Salario', groupId: 'income-group', isIncome: true },
  { id: 'groceries', name: 'Alimentación', groupId: 'expenses', isIncome: false },
  { id: 'utilities', name: 'Suministros', groupId: 'expenses', isIncome: false },
];
const entries: readonly LedgerEntry[] = [
  { id: 'salary-1', accountId: 'checking', currencyCode: 'EUR', date: '2026-10-01', amountMinor: 200_000, categoryId: 'salary', transferId: null, isTransfer: false },
  { id: 'food-1', accountId: 'checking', currencyCode: 'EUR', date: '2026-10-02', amountMinor: -5_000, categoryId: 'groceries', transferId: null, isTransfer: false },
  { id: 'utility-1', accountId: 'checking', currencyCode: 'EUR', date: '2026-10-03', amountMinor: -3_000, categoryId: 'utilities', transferId: null, isTransfer: false },
  { id: 'refund-1', accountId: 'checking', currencyCode: 'EUR', date: '2026-10-04', amountMinor: 2_000, categoryId: 'groceries', transferId: null, isTransfer: false },
  { id: 'uncat-outflow', accountId: 'checking', currencyCode: 'EUR', date: '2026-10-05', amountMinor: -1_000, categoryId: null, transferId: null, isTransfer: false },
  { id: 'uncat-inflow', accountId: 'checking', currencyCode: 'EUR', date: '2026-10-06', amountMinor: 500, categoryId: null, transferId: null, isTransfer: false },
  { id: 'transfer-1', accountId: 'checking', currencyCode: 'EUR', date: '2026-10-06', amountMinor: -100_000, categoryId: null, transferId: 'transfer-leg', isTransfer: true },
  { id: 'outside-period', accountId: 'checking', currencyCode: 'EUR', date: '2026-09-30', amountMinor: -10_000, categoryId: 'groceries', transferId: null, isTransfer: false },
];

describe('calculateSummary', () => {
  it('calculates income, net expenses, savings, transfers and date bounds', () => {
    const report = calculateSummary(entries, categories, { startDate: '2026-10-01', endDate: '2026-10-31', currency: 'EUR' });
    expect(report.incomeMinor).toBe(200_000);
    expect(report.expenseMinor).toBe(7_000);
    expect(report.savingsMinor).toBe(193_000);
    expect(report.savingsRatePercent).toBeCloseTo(96.5);
    expect(report.transactionCount).toBe(6);
    expect(report.excludedTransferCount).toBe(1);
    expect(report.expensesByCategory.find((item) => item.categoryId === 'groceries')?.amountMinor).toBe(3_000);
  });
  it('warns about uncategorized inflows/outflows rather than inventing income', () => {
    const report = calculateSummary(entries, categories, { startDate: '2026-10-01', endDate: '2026-10-31', currency: 'EUR' });
    expect(report.unclassifiedInflowMinor).toBe(500);
    expect(report.uncategorizedOutflowMinor).toBe(1_000);
    expect(report.warnings).toHaveLength(2);
  });
  it('does not divide by zero and rejects invalid currencies and unsafe amounts', () => {
    expect(calculateSummary([], categories, { startDate: '2026-10-01', endDate: '2026-10-31', currency: 'EUR' }).savingsRatePercent).toBeNull();
    expect(() => calculateSummary([], categories, { startDate: '2026-10-01', endDate: '2026-10-31', currency: 'eur' })).toThrow(/currency/);
    expect(() => calculateSummary([{ ...entries[0]!, amountMinor: Number.MAX_SAFE_INTEGER + 1 }], categories, { startDate: '2026-10-01', endDate: '2026-10-31', currency: 'EUR' })).toThrow(/safe integer/);
  });
});
