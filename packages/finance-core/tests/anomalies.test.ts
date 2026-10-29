import { describe, expect, it } from 'vitest';
import type { BudgetCategory, LedgerEntry } from '../src/domain.js';
import { buildFinancialAnomalyFindings, type FinancialAnomalyOptions } from '../src/anomalies.js';
import { evaluateFindingQuality } from '../src/intelligence.js';
import { normalizeTransactions } from '../src/ledger.js';

const period = { startDate: '2026-10-01', endDate: '2026-10-31' };
const scope = { mode: 'selected' as const, accountIds: ['account-1'], label: 'Cuenta principal' };
const calculatedAt = '2026-10-29T12:00:00.000Z';
const categories: BudgetCategory[] = [
  { id: 'utilities', name: 'Suministros', groupId: 'fixed', isIncome: false },
  { id: 'salary', name: 'Salario', groupId: 'income', isIncome: true },
];
function entry(overrides: Partial<LedgerEntry> & Pick<LedgerEntry, 'id' | 'date'>): LedgerEntry {
  return {
    accountId: 'account-1', currencyCode: 'EUR', amountMinor: -12_000, categoryId: 'utilities',
    transferId: null, isTransfer: false, payeeLabel: 'Energía SL', ...overrides,
  };
}
function run(entries: readonly LedgerEntry[], overrides: Partial<FinancialAnomalyOptions> = {}) {
  return buildFinancialAnomalyFindings(entries, {
    period, accountScope: scope, currency: 'EUR', calculatedAt, categories,
    historyStartDate: '2026-04-01', referenceWindows: 6,
    minimumAbsoluteChangeMinor: 5_000, minimumRelativeChangePercent: 30, minimumObservations: 3,
    ...overrides,
  });
}
function monthlyBill(currentMinor = 24_000): LedgerEntry[] {
  return [
    entry({ id: 'bill-jul', date: '2026-07-15', amountMinor: -12_000 }),
    entry({ id: 'bill-aug', date: '2026-08-15', amountMinor: -12_300, payeeLabel: 'energia sl' }),
    entry({ id: 'bill-sep', date: '2026-09-15', amountMinor: -12_500, payeeLabel: 'ENERGÍA S.L.' }),
    entry({ id: 'bill-oct', date: '2026-10-15', amountMinor: -currentMinor, payeeLabel: 'Energia SL' }),
  ];
}
function anomalyKind(result: ReturnType<typeof run>, kind: string) {
  return result.findings.find((finding) => finding.metrics.anomalyKind === kind);
}

describe('financial anomaly detection', () => {
  it('detects a material one-off bill increase with a reproducible median, MAD and historical series', () => {
    const result = run(monthlyBill(), { enabledKinds: ['transaction-outlier'] });
    const finding = anomalyKind(result, 'transaction-outlier');
    expect(finding).toMatchObject({
      type: 'financial-anomaly', confidence: 'candidate', navigationTarget: '/movements',
      metrics: { observedMinor: 24_000, baselineMedianMinor: 12_300, historicalObservationCount: 3, triggerThresholdMinor: 5_000 },
    });
    expect(finding?.evidence.map((item) => item.label)).toContain('Serie histórica de importes');
    expect(finding?.limitations.join(' ')).toMatch(/no demuestra error ni fraude/i);
  });

  it('does not flag normal amount variation or a short history as an outlier', () => {
    expect(anomalyKind(run(monthlyBill(13_000), { enabledKinds: ['transaction-outlier'] }), 'transaction-outlier')).toBeUndefined();
    expect(anomalyKind(run([
      entry({ id: 'one', date: '2026-09-01' }),
      entry({ id: 'two', date: '2026-09-15', amountMinor: -13_000 }),
      entry({ id: 'current', date: '2026-10-15', amountMinor: -30_000 }),
    ], { enabledKinds: ['transaction-outlier'] }), 'transaction-outlier')).toBeUndefined();
  });

  it('does not mistake inactive reference windows for a lower typical spend', () => {
    const entries = [
      entry({ id: 'june', date: '2026-06-15', amountMinor: -12_000, payeeLabel: 'Electricidad' }),
      entry({ id: 'july', date: '2026-07-15', amountMinor: -12_000, payeeLabel: 'Electricidad' }),
      entry({ id: 'august', date: '2026-08-15', amountMinor: -12_000, payeeLabel: 'Electricidad' }),
      entry({ id: 'october', date: '2026-10-15', amountMinor: -12_000, payeeLabel: 'Electricidad' }),
    ];
    const result = run(entries, { enabledKinds: ['total-expense-change', 'category-change', 'payee-change'] });
    expect(result.findings).toHaveLength(0);
  });

  it('normalizes accents and punctuation for exact possible-duplicate matches but does not fuzzy-match similar names', () => {
    const exact = run([
      entry({ id: 'cafe-1', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'Café-Norte' }),
      entry({ id: 'cafe-2', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'cafe norte' }),
    ], { enabledKinds: ['possible-duplicate'] });
    expect(anomalyKind(exact, 'possible-duplicate')).toMatchObject({
      navigationTarget: '/movements',
      metrics: { matchingTransactionCount: 2, potentiallyRepeatedAmountMinor: 4_500 },
    });
    const similarNames = run([
      entry({ id: 'market-1', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'Mercado Centro' }),
      entry({ id: 'market-2', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'Centro Mercado' }),
    ], { enabledKinds: ['possible-duplicate'] });
    expect(anomalyKind(similarNames, 'possible-duplicate')).toBeUndefined();
  });

  it('never flags a split allocation or transfer as a second charge', () => {
    const entries = [
      entry({ id: 'normal', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'Mercado Centro' }),
      entry({ id: 'transfer', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'Mercado Centro', isTransfer: true, transferId: 'pair-1' }),
      entry({ id: 'split-a', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'Mercado Centro', isSplitLine: true, transactionGroupId: 'split-parent' }),
      entry({ id: 'split-b', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'Mercado Centro', isSplitLine: true, transactionGroupId: 'split-parent' }),
    ];
    expect(anomalyKind(run(entries, { enabledKinds: ['possible-duplicate'] }), 'possible-duplicate')).toBeUndefined();
  });

  it('detects refund variation separately from income and spending', () => {
    const entries = [
      entry({ id: 'refund-jul', date: '2026-07-10', amountMinor: 1_000, categoryId: 'utilities', payeeLabel: 'Tienda' }),
      entry({ id: 'refund-aug', date: '2026-08-10', amountMinor: 1_100, categoryId: 'utilities', payeeLabel: 'Tienda' }),
      entry({ id: 'refund-sep', date: '2026-09-10', amountMinor: 900, categoryId: 'utilities', payeeLabel: 'Tienda' }),
      entry({ id: 'refund-oct', date: '2026-10-10', amountMinor: 12_000, categoryId: 'utilities', payeeLabel: 'Tienda' }),
    ];
    const result = run(entries, { enabledKinds: ['refund-change', 'income-change', 'total-expense-change'], minimumAbsoluteChangeMinor: 500 });
    expect(anomalyKind(result, 'refund-change')).toBeDefined();
    expect(anomalyKind(result, 'income-change')).toBeUndefined();
    expect(anomalyKind(result, 'total-expense-change')).toBeUndefined();
  });

  it('compares an equivalent calendar month to historical same-month observations when available', () => {
    const entries = [
      entry({ id: 'oct-2024', date: '2024-10-15', amountMinor: -40_000, payeeLabel: null }),
      entry({ id: 'oct-2025', date: '2025-10-15', amountMinor: -40_000, payeeLabel: null }),
      entry({ id: 'oct-2026', date: '2026-10-15', amountMinor: -40_500, payeeLabel: null }),
    ];
    const result = run(entries, {
      referenceWindows: 24, historyStartDate: '2024-10-01', enabledKinds: ['category-change'],
    });
    expect(anomalyKind(result, 'category-change')).toBeUndefined();
  });

  it('excludes unknown-currency and out-of-scope records instead of comparing unlike amounts', () => {
    const result = run([
      entry({ id: 'unknown', date: '2026-10-12', amountMinor: -4_500, currencyCode: null, payeeLabel: 'Duplicado' }),
      entry({ id: 'valid', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'Duplicado' }),
      entry({ id: 'other-account', date: '2026-10-12', amountMinor: -4_500, accountId: 'account-2', payeeLabel: 'Duplicado' }),
    ], { enabledKinds: ['possible-duplicate'] });
    expect(anomalyKind(result, 'possible-duplicate')).toBeUndefined();
    expect(result.limitations.join(' ')).toMatch(/divisa desconocida/i);
  });

  it('normalizes splits with a shared parent identity for frequency analysis', () => {
    const normalized = normalizeTransactions([{
      id: 'parent', account: 'account-1', date: '2026-10-12', amount: -9_000, category: null,
      subtransactions: [
        { id: 'child-1', account: '', date: '', amount: -4_000, category: 'utilities' },
        { id: 'child-2', account: '', date: '', amount: -5_000, category: 'utilities' },
      ],
    }]);
    expect(normalized).toHaveLength(2);
    expect(normalized.map((row) => row.transactionGroupId)).toEqual(['parent', 'parent']);
    expect(normalized.every((row) => row.isSplitLine)).toBe(true);
  });

  it('quantifies precision and false-positive rate using independently labelled synthetic fixtures', () => {
    const positive = anomalyKind(run(monthlyBill(), { enabledKinds: ['transaction-outlier'] }), 'transaction-outlier') !== undefined;
    const normal = anomalyKind(run(monthlyBill(13_000), { enabledKinds: ['transaction-outlier'] }), 'transaction-outlier') !== undefined;
    const legitimateDuplicate = anomalyKind(run([
      entry({ id: 'legit-1', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'Café Norte' }),
      entry({ id: 'legit-2', date: '2026-10-12', amountMinor: -4_500, payeeLabel: 'cafe norte' }),
    ], { enabledKinds: ['possible-duplicate'] }), 'possible-duplicate') !== undefined;
    const metrics = evaluateFindingQuality([
      { expectedPositive: true, detected: positive },
      { expectedPositive: false, detected: normal },
      { expectedPositive: false, detected: legitimateDuplicate },
    ]);
    expect(metrics.sampleCount).toBe(3);
    expect(metrics.truePositives).toBe(1);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.falsePositiveRatePercent).toBe(50);
    expect(metrics.precisionPercent).toBe(50);
  });
});
