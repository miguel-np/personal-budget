import { describe, expect, it } from 'vitest';
import type { BudgetTransaction } from '../src/domain.js';
import { detectRecurringCandidates } from '../src/recurring.js';

function expense(id: string, date: string, amount: number, payee: string, overrides: Partial<BudgetTransaction> = {}): BudgetTransaction {
  return { id, account: 'account-1', date, amount, payee_name: payee, category: null, transfer_id: null, ...overrides };
}

const october = { startDate: '2026-01-01', endDate: '2026-12-31' };

describe('detectRecurringCandidates', () => {
  it('detects a stable monthly payment with explained signals', () => {
    const transactions = [
      expense('a', '2026-01-01', -1000, 'Gimnasio'),
      expense('b', '2026-02-01', -1000, 'Gimnasio'),
      expense('c', '2026-03-01', -1000, 'Gimnasio'),
    ];
    const candidates = detectRecurringCandidates(transactions, october);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      payee: 'gimnasio',
      occurrenceCount: 3,
      refundsExcluded: 0,
      meanAbsoluteAmountMinor: 1000,
      estimatedIntervalDays: 30,
      estimatedFrequency: 'mensual',
      confidence: 'candidate_only',
    });
    expect(candidates[0]!.signals.join(' ')).toContain('mensual');
    expect(candidates[0]!.signals.join(' ')).toContain('estable');
    expect(candidates[0]!.warnings.some((warning) => warning.includes('nombres similares'))).toBe(true);
  });

  it('warns about variable amounts instead of guaranteeing recurrence', () => {
    const transactions = [
      expense('a', '2026-01-01', -500, 'Luz'),
      expense('b', '2026-02-01', -1000, 'Luz'),
      expense('c', '2026-03-01', -1400, 'Luz'),
    ];
    const candidates = detectRecurringCandidates(transactions, october);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.amountDeviationPercent).toBeGreaterThan(20);
    expect(candidates[0]!.warnings.some((warning) => warning.includes('variación de importes'))).toBe(true);
  });

  it('keeps shifted-date groups with an irregularity warning', () => {
    const transactions = [
      expense('a', '2026-01-01', -800, 'Taller'),
      expense('b', '2026-01-20', -800, 'Taller'),
      expense('c', '2026-02-28', -800, 'Taller'),
    ];
    const candidates = detectRecurringCandidates(transactions, october);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.estimatedIntervalDays).toBeNull();
    expect(candidates[0]!.warnings.some((warning) => warning.includes('desplazadas'))).toBe(true);
  });

  it('excludes refunds from amounts and reports them', () => {
    const transactions = [
      expense('a', '2026-01-01', -2000, 'Tienda'),
      expense('b', '2026-02-01', -2000, 'Tienda'),
      expense('c', '2026-03-01', -2000, 'Tienda'),
      expense('d', '2026-03-10', 2000, 'Tienda'),
    ];
    const candidates = detectRecurringCandidates(transactions, october);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.refundsExcluded).toBe(1);
    expect(candidates[0]!.meanAbsoluteAmountMinor).toBe(2000);
    expect(candidates[0]!.warnings.some((warning) => warning.includes('reembolsos'))).toBe(true);
  });

  it('treats similar beneficiary names as separate candidates', () => {
    const transactions = [
      expense('a', '2026-01-01', -1500, 'NETFLIX'),
      expense('b', '2026-02-01', -1500, 'NETFLIX'),
      expense('c', '2026-03-01', -1500, 'NETFLIX'),
      expense('d', '2026-01-01', -1500, 'NETFLIX.COM'),
      expense('e', '2026-02-01', -1500, 'NETFLIX.COM'),
      expense('f', '2026-03-01', -1500, 'NETFLIX.COM'),
    ];
    const candidates = detectRecurringCandidates(transactions, october);
    expect(candidates.map((candidate) => candidate.payee).sort()).toEqual(['netflix', 'netflix.com']);
  });

  it('groups normalized label variants under one candidate', () => {
    const transactions = [
      expense('a', '2026-01-01', -900, '  SUPERMERCADO   MADRID '),
      expense('b', '2026-02-01', -900, 'Supermercado Madrid'),
      expense('c', '2026-03-01', -900, 'supermercado madrid'),
    ];
    const candidates = detectRecurringCandidates(transactions, october);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.payee).toBe('supermercado madrid');
    expect(candidates[0]!.payeeVariants).toHaveLength(3);
  });

  it('supports non-monthly cadences through the interval window', () => {
    const weekly = [
      expense('a', '2026-01-05', -700, 'Suscripción'),
      expense('b', '2026-01-12', -700, 'Suscripción'),
      expense('c', '2026-01-19', -700, 'Suscripción'),
    ];
    expect(detectRecurringCandidates(weekly, october)).toHaveLength(0);
    const weeklyWindow = detectRecurringCandidates(weekly, { ...october, intervalWindowDays: [5, 10] });
    expect(weeklyWindow).toHaveLength(1);
    expect(weeklyWindow[0]!.estimatedFrequency).toBe('semanal');
  });

  it('excludes annual cadences from the default monthly window', () => {
    const annual = [
      expense('a', '2025-01-10', -4000, 'Seguro'),
      expense('b', '2026-01-10', -4000, 'Seguro'),
      expense('c', '2027-01-10', -4000, 'Seguro'),
    ];
    expect(detectRecurringCandidates(annual, { startDate: '2025-01-01', endDate: '2027-12-31' })).toHaveLength(0);
    const annualWindow = detectRecurringCandidates(annual, { startDate: '2025-01-01', endDate: '2027-12-31', intervalWindowDays: [300, 400] });
    expect(annualWindow).toHaveLength(1);
    expect(annualWindow[0]!.estimatedFrequency).toBe('anual');
  });

  it('ignores transfers, children, positive-only groups and groups below the occurrence floor', () => {
    const transactions = [
      expense('a', '2026-01-01', -1000, 'Renta', { transfer_id: 'transfer-pair' }),
      expense('b', '2026-01-01', -1000, 'Renta', { is_child: true, parent_id: 'parent' }),
      expense('c', '2026-01-01', 1000, 'Solo abonos'),
      expense('d', '2026-02-01', 1000, 'Solo abonos'),
      expense('e', '2026-01-01', -500, 'Pocos cargos'),
      expense('f', '2026-02-01', -500, 'Pocos cargos'),
    ];
    expect(detectRecurringCandidates(transactions, october)).toHaveLength(0);
  });

  it('rejects invalid options before reading transactions', () => {
    const transactions = [expense('a', '2026-01-01', -1000, 'X')];
    expect(() => detectRecurringCandidates(transactions, { ...october, minOccurrences: 1 })).toThrow(/minOccurrences/);
    expect(() => detectRecurringCandidates(transactions, { ...october, intervalWindowDays: [10, 5] })).toThrow(/intervalWindowDays/);
    expect(() => detectRecurringCandidates(transactions, { ...october, maxAmountDeviationPercent: -1 })).toThrow(/maxAmountDeviationPercent/);
    expect(() => detectRecurringCandidates(transactions, { startDate: '2026-12-31', endDate: '2026-01-01' })).toThrow(/startDate/);
  });
});
