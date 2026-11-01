import { describe, expect, it } from 'vitest';
import { projectCashFlow } from '../src/cash-flow.js';
describe('projectCashFlow', () => {
  it('projects signed movements and commitments by civil date', () => {
    const result = projectCashFlow({ asOfDate: '2026-11-01', startDate: '2026-11-01', endDate: '2026-11-03', openingBalanceMinor: 100_000, reserveMinor: 20_000, events: [
      { id: 'income', date: '2026-11-02', amountMinor: 50_000, source: 'actual_transaction', label: 'Income' },
      { id: 'bill', date: '2026-11-02', amountMinor: -120_000, source: 'manual_commitment', label: 'Bill' },
      { id: 'cleared', date: '2026-11-03', amountMinor: -1_000, source: 'actual_transaction', label: 'Cleared', clearedStatus: 'cleared' },
      { id: 'pending', date: '2026-11-03', amountMinor: -2_000, source: 'actual_transaction', label: 'Pending', clearedStatus: 'pending' },
    ] });
    expect(result.timeline).toHaveLength(3);
    expect(result.timeline[1]?.projectedBalanceMinor).toBe(30_000);
    expect(result.endingBalanceMinor).toBe(27_000);
    expect(result.firstDeficitDate).toBeNull();
    expect(result.firstReserveBreachDate).toBeNull();
    expect(result.sourceTotals.manual_commitment.outflowMinor).toBe(120_000);
    expect(result.timeline[2]).toMatchObject({ actualClearedCount: 1, actualPendingCount: 1, actualUnknownCount: 0 });
  });
  it('separates internal transfers from operating inflows and outflows while retaining their net effect', () => {
    const result = projectCashFlow({ asOfDate: '2026-11-01', startDate: '2026-11-01', endDate: '2026-11-02', openingBalanceMinor: 100_000, events: [
      { id: 'transfer-out', date: '2026-11-02', amountMinor: -25_000, source: 'actual_transaction', label: 'Transfer to savings', isTransfer: true },
      { id: 'transfer-in', date: '2026-11-02', amountMinor: 25_000, source: 'actual_transaction', label: 'Transfer from checking', isTransfer: true },
      { id: 'salary', date: '2026-11-02', amountMinor: 50_000, source: 'actual_transaction', label: 'Salary' },
      { id: 'bill', date: '2026-11-02', amountMinor: -10_000, source: 'actual_transaction', label: 'Utilities' },
    ] });
    expect(result.timeline[1]).toMatchObject({ totalInflowMinor: 50_000, totalOutflowMinor: 10_000, totalTransferInflowMinor: 25_000, totalTransferOutflowMinor: 25_000, netChangeMinor: 40_000, projectedBalanceMinor: 140_000 });
    expect(result.totalTransferInflowMinor).toBe(25_000);
    expect(result.totalTransferOutflowMinor).toBe(25_000);
  });
  it('keeps confirmed recurrences and explicitly selected candidates as separate sources', () => {
    const result = projectCashFlow({ asOfDate: '2026-11-01', startDate: '2026-11-01', endDate: '2026-11-03', openingBalanceMinor: 50_000, events: [
      { id: 'confirmed-rent', date: '2026-11-02', amountMinor: -10_000, source: 'confirmed_recurring', label: 'Rent' },
      { id: 'candidate-streaming', date: '2026-11-03', amountMinor: -1_000, source: 'recurring_candidate', label: 'Possible streaming payment' },
    ] });
    expect(result.timeline[1]).toMatchObject({ confirmedRecurringNetChangeMinor: -10_000, recurringCandidateNetChangeMinor: 0, projectedBalanceMinor: 40_000 });
    expect(result.timeline[2]).toMatchObject({ confirmedRecurringNetChangeMinor: 0, recurringCandidateNetChangeMinor: -1_000, projectedBalanceMinor: 39_000 });
    expect(result.sourceTotals.confirmed_recurring.outflowMinor).toBe(10_000);
    expect(result.sourceTotals.recurring_candidate.outflowMinor).toBe(1_000);
  });
  it('flags the first reserve breach and deficit', () => {
    const result = projectCashFlow({ asOfDate: '2026-11-01', startDate: '2026-11-01', endDate: '2026-11-02', openingBalanceMinor: 10_000, reserveMinor: 5_000, events: [
      { id: 'bill', date: '2026-11-02', amountMinor: -15_000, source: 'actual_transaction', label: 'Bill' },
    ] });
    expect(result.firstReserveBreachDate).toBe('2026-11-02');
    expect(result.firstDeficitDate).toBe('2026-11-02');
    expect(result.minimumProjectedBalanceMinor).toBe(-5_000);
  });
  it('does not fabricate a balance when an account balance is unknown', () => {
    const result = projectCashFlow({ asOfDate: '2026-11-01', startDate: '2026-11-01', endDate: '2026-11-02', openingBalanceMinor: null, events: [
      { id: 'bill', date: '2026-11-02', amountMinor: -1_000, source: 'actual_transaction', label: 'Bill' },
    ] });
    expect(result.timeline[1]?.projectedBalanceMinor).toBeNull();
    expect(result.minimumProjectedBalanceMinor).toBeNull();
    expect(result.firstDeficitDate).toBeNull();
    expect(result.warnings.join(' ')).toContain('saldo inicial consolidado es desconocido');
  });
  it('handles a representative 5,000-event history without changing its exact total', () => {
    const events = Array.from({ length: 5_000 }, (_, index) => ({
      id: 'history-' + index, date: '2026-11-' + String(1 + (index % 30)).padStart(2, '0'),
      amountMinor: index % 2 === 0 ? 100 : -100, source: 'actual_transaction' as const, label: 'Synthetic event',
    }));
    const result = projectCashFlow({ asOfDate: '2026-11-01', startDate: '2026-11-01', endDate: '2026-11-30', openingBalanceMinor: 1_000_000, events });
    expect(result.timeline).toHaveLength(30);
    expect(result.sourceTotals.actual_transaction.eventCount).toBe(5_000);
    expect(result.netChangeMinor).toBe(0);
    expect(result.endingBalanceMinor).toBe(1_000_000);
  });
  it('rejects duplicate IDs, zero amounts, out-of-range events and long horizons', () => {
    const base = { asOfDate: '2026-11-01', startDate: '2026-11-01', endDate: '2026-11-02', openingBalanceMinor: 1_000 };
    const event = { id: 'x', date: '2026-11-02', amountMinor: -1, source: 'scenario' as const, label: 'Test' };
    expect(() => projectCashFlow({ ...base, events: [event, event] })).toThrow(/unique/);
    expect(() => projectCashFlow({ ...base, events: [{ ...event, amountMinor: 0 }] })).toThrow(/non-zero/);
    expect(() => projectCashFlow({ ...base, events: [{ ...event, date: '2026-11-03' }] })).toThrow(/within the selected horizon/);
    expect(() => projectCashFlow({ ...base, endDate: '2028-01-01', events: [] })).toThrow(/between 1 and 366/);
  });
});
