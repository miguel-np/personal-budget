import { describe, expect, it } from 'vitest';
import type { FinancialSummary, LedgerEntry } from '../src/domain.js';
import { buildPeriodChangeFindings, buildUncategorizedFinding, createFinancialFinding, evaluateFindingQuality } from '../src/intelligence.js';

const scope = { mode: 'all' as const, accountIds: ['account-1'], label: 'Todas las cuentas abiertas' };
const calculatedAt = '2026-10-29T12:00:00.000Z';

function summary(overrides: Partial<FinancialSummary> & Pick<FinancialSummary, 'startDate' | 'endDate'>): FinancialSummary {
  return {
    currency: 'EUR', incomeMinor: 200_000, expenseMinor: 100_000, savingsMinor: 100_000,
    savingsRatePercent: 50, uncategorizedOutflowMinor: 0, unclassifiedInflowMinor: 0,
    excludedTransferCount: 0, transactionCount: 5, expensesByCategory: [], incomeByCategory: [],
    warnings: [], unconvertedTransactionCount: 0, exchangeRatesUsed: [],
    ...overrides,
  };
}

describe('financial intelligence findings', () => {
  it('emits traceable facts when equivalent periods cross the documented thresholds', () => {
    const previous = summary({ startDate: '2026-09-01', endDate: '2026-09-30', expenseMinor: 100_000, incomeMinor: 200_000 });
    const current = summary({ startDate: '2026-10-01', endDate: '2026-10-30', expenseMinor: 150_000, incomeMinor: 160_000 });
    const result = buildPeriodChangeFindings(current, previous, { accountScope: scope, calculatedAt });
    expect(result.findings.map((finding) => finding.type)).toEqual(['expense-change', 'income-change']);
    expect(result.findings[0]).toMatchObject({
      schemaVersion: 1, confidence: 'observed', priority: 'high', impactMinor: 50_000,
      metrics: { currentMinor: 150_000, previousMinor: 100_000, deltaMinor: 50_000, percentageChange: 50 },
    });
    expect(result.findings[0]?.evidence.length).toBeGreaterThanOrEqual(4);
    expect(result.findings[0]).not.toHaveProperty('entityKey');
  });

  it('abstains when data are sparse, periods have unequal lengths, or currencies are incompatible', () => {
    const previous = summary({ startDate: '2026-09-01', endDate: '2026-09-30' });
    expect(buildPeriodChangeFindings(
      summary({ startDate: '2026-10-01', endDate: '2026-10-30', transactionCount: 2 }),
      previous, { accountScope: scope, calculatedAt },
    ).findings).toHaveLength(0);
    expect(buildPeriodChangeFindings(
      summary({ startDate: '2026-10-01', endDate: '2026-10-31' }),
      previous, { accountScope: scope, calculatedAt },
    ).limitations[0]).toMatch(/misma duración/);
    expect(buildPeriodChangeFindings(
      summary({ startDate: '2026-10-01', endDate: '2026-10-30', currency: 'USD' }),
      previous, { accountScope: scope, calculatedAt },
    ).findings).toHaveLength(0);
  });

  it('raises priority when the same material direction persists across equivalent windows', () => {
    const prior = summary({ startDate: '2026-08-02', endDate: '2026-08-31', expenseMinor: 80_000, incomeMinor: 250_000 });
    const previous = summary({ startDate: '2026-09-01', endDate: '2026-09-30', expenseMinor: 100_000, incomeMinor: 200_000 });
    const current = summary({ startDate: '2026-10-01', endDate: '2026-10-30', expenseMinor: 130_000, incomeMinor: 160_000 });
    const result = buildPeriodChangeFindings(current, previous, { accountScope: scope, calculatedAt, priorSummary: prior });
    expect(result.findings[0]).toMatchObject({
      type: 'expense-change', priority: 'high',
      metrics: { persistentChange: true, comparisonWindowsSupportingDirection: 2 },
    });
    expect(result.findings[0]?.priorityReason).toMatch(/dos variaciones consecutivas/);
  });

  it('does not infer a rise from net expenses reduced by refunds or from a zero comparison base', () => {
    const previous = summary({ startDate: '2026-09-01', endDate: '2026-09-30', expenseMinor: 100_000, incomeMinor: 200_000 });
    const refundAdjustedCurrent = summary({ startDate: '2026-10-01', endDate: '2026-10-30', expenseMinor: 90_000, incomeMinor: 200_000 });
    const zeroBasePrevious = summary({ startDate: '2026-09-01', endDate: '2026-09-30', expenseMinor: 0, incomeMinor: 200_000 });
    const newSpendCurrent = summary({ startDate: '2026-10-01', endDate: '2026-10-30', expenseMinor: 25_000, incomeMinor: 200_000 });
    const scopeContext = { accountScope: scope, calculatedAt };
    expect(buildPeriodChangeFindings(refundAdjustedCurrent, previous, scopeContext).findings.some((item) => item.type === 'expense-change' && typeof item.metrics.deltaMinor === 'number' && item.metrics.deltaMinor > 0)).toBe(false);
    expect(buildPeriodChangeFindings(newSpendCurrent, zeroBasePrevious, scopeContext).findings.some((item) => item.type === 'expense-change')).toBe(false);
  });

  it('does not compare a period containing unconverted movements', () => {
    const previous = summary({ startDate: '2026-09-01', endDate: '2026-09-30' });
    const current = summary({ startDate: '2026-10-01', endDate: '2026-10-30', unconvertedTransactionCount: 1 });
    expect(buildPeriodChangeFindings(current, previous, { accountScope: scope, calculatedAt }).limitations[0]).toMatch(/sin conversión/);
  });

  it('finds pending categorization but excludes transfers and categorized entries', () => {
    const entries: LedgerEntry[] = [
      { id: 'uncategorized-expense', accountId: 'account-1', currencyCode: 'EUR', date: '2026-10-02', amountMinor: -12_000, categoryId: null, transferId: null, isTransfer: false },
      { id: 'transfer', accountId: 'account-1', currencyCode: 'EUR', date: '2026-10-02', amountMinor: -99_000, categoryId: null, transferId: 'pair', isTransfer: true },
      { id: 'categorized', accountId: 'account-1', currencyCode: 'EUR', date: '2026-10-03', amountMinor: -1_000, categoryId: 'food', transferId: null, isTransfer: false },
    ];
    const finding = buildUncategorizedFinding(entries, {
      period: { startDate: '2026-10-01', endDate: '2026-10-31' }, accountScope: scope,
      currency: 'EUR', calculatedAt,
    });
    expect(finding).toMatchObject({
      type: 'pending-categorization', metrics: { transactionCount: 1, uncategorizedOutflowMinor: 12_000 },
      impactMinor: 12_000,
    });
  });

  it('measures precision, false-positive rate and explicit dismissal rate on labeled data', () => {
    const metrics = evaluateFindingQuality([
      { expectedPositive: true, detected: true },
      { expectedPositive: true, detected: true },
      { expectedPositive: true, detected: false },
      { expectedPositive: false, detected: true, dismissed: true },
      { expectedPositive: false, detected: false },
      { expectedPositive: false, detected: false },
    ]);
    expect(metrics).toMatchObject({
      sampleCount: 6, truePositives: 2, falsePositives: 1, falseNegatives: 1, trueNegatives: 2,
      dismissedCount: 1,
    });
    expect(metrics.precisionPercent).toBeCloseTo(200 / 3, 10);
    expect(metrics.falsePositiveRatePercent).toBeCloseTo(100 / 3, 10);
    expect(metrics.dismissalRatePercent).toBeCloseTo(100 / 6, 10);
    expect(evaluateFindingQuality([])).toMatchObject({
      sampleCount: 0, precisionPercent: null, falsePositiveRatePercent: null, dismissalRatePercent: null,
    });
  });

  it('keeps identity stable for the same rule but changes fingerprint when evidence changes', () => {
    const draft = {
      type: 'pending-categorization' as const, entityKey: 'period',
      title: 'Title', explanation: 'Explanation',
      period: { startDate: '2026-10-01', endDate: '2026-10-31' },
      accountScope: scope, currency: 'EUR', confidence: 'observed' as const,
      priority: 'low' as const, priorityReason: 'Rule', impactMinor: 1,
      metrics: { count: 1 }, evidence: [{ label: 'Count', value: 1, source: 'test', rule: 'test' }],
      limitations: [], calculatedAt, navigationTarget: '/movements' as const,
    };
    const first = createFinancialFinding(draft);
    const repeated = createFinancialFinding({ ...draft, calculatedAt: '2026-10-30T12:00:00.000Z' });
    const changed = createFinancialFinding({ ...draft, impactMinor: 2, metrics: { count: 2 } });
    const changedCurrency = createFinancialFinding({ ...draft, currency: 'USD' });
    expect(first.id).toBe(repeated.id);
    expect(first.fingerprint).toBe(repeated.fingerprint);
    expect(first.fingerprint).not.toBe(changed.fingerprint);
    expect(first.fingerprint).not.toBe(changedCurrency.fingerprint);
  });
});
