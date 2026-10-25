import { describe, expect, it } from 'vitest';
import type { BudgetTransaction } from '../src/domain.js';
import { InvalidTransactionError, normalizeTransactions } from '../src/ledger.js';

const raw = (overrides: Partial<BudgetTransaction> = {}): BudgetTransaction => ({
  id: 'tx-1', account: 'account-1', date: '2026-10-01', amount: -1_000,
  category: 'food', transfer_id: null, ...overrides,
});

describe('normalizeTransactions', () => {
  it('maps a normal transaction to a ledger entry', () => {
    expect(normalizeTransactions([raw()])).toEqual([{
      id: 'tx-1', accountId: 'account-1', date: '2026-10-01', amountMinor: -1_000,
      categoryId: 'food', transferId: null, isTransfer: false,
    }]);
  });
  it('flattens split parents and skips duplicate flat child rows', () => {
    const parent = raw({
      id: 'parent', amount: -1_000, is_parent: true,
      subtransactions: [
        raw({ id: 'split-a', amount: -600, category: 'food' }),
        raw({ id: 'split-b', amount: -400, category: 'home' }),
      ],
    });
    const children = [raw({ id: 'split-a', is_child: true, parent_id: 'parent' })];
    const result = normalizeTransactions([parent, ...children]);
    expect(result).toHaveLength(2);
    expect(result.reduce((sum, entry) => sum + entry.amountMinor, 0)).toBe(-1_000);
  });
  it('marks transfer entries', () => {
    expect(normalizeTransactions([raw({ transfer_id: 'paired-transfer' })])[0]?.isTransfer).toBe(true);
  });
  it('rejects non-integer amounts, empty identifiers and missing account/date', () => {
    expect(() => normalizeTransactions([raw({ amount: 1.25 })])).toThrow(InvalidTransactionError);
    expect(() => normalizeTransactions([raw({ id: ' ' })])).toThrow(/id/);
    expect(() => normalizeTransactions([raw({ account: '' })])).toThrow(/account/);
    expect(() => normalizeTransactions([raw({ date: '2026-02-29' })])).toThrow(/date/);
  });
});
