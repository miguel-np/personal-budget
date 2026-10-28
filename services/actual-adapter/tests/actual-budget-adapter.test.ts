import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { BudgetTransaction, TransactionStructureUpdate } from '@personal-budget/finance-core';
import { ActualBudgetAdapter } from '../src/actual-budget-adapter.js';
import { mapActualAccount, mapActualCategory } from '../src/actual-api-contract.js';
import type { ActualApiContract, ActualBudgetMonthRecord, ActualImportRecord } from '../src/actual-api-contract.js';

function createApi(overrides: Partial<ActualApiContract> = {}): ActualApiContract {
  return {
    init: vi.fn(async () => undefined),
    downloadBudget: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    getAccounts: vi.fn(async () => [{ id: 'account-1', name: 'Cuenta', closed: false, offbudget: false, balance_current: 1200 }]),
    getCategories: vi.fn(async () => [{ id: 'food', name: 'Alimentación', group_id: 'expenses', is_income: false }]),
    getTransactions: vi.fn(async () => [] as readonly BudgetTransaction[]),
    importTransactions: vi.fn(async () => ({ errors: [], added: ['new-tx'], updated: [] })),
    ...overrides,
  };
}

const config = { serverURL: 'http://127.0.0.1:5006', dataDir: resolve(tmpdir(), 'personal-budget-adapter-tests'), budgetId: 'budget-uuid' };

describe('ActualBudgetAdapter', () => {

  it('maps absent optional Actual fields to explicit defaults', () => {
    expect(mapActualAccount({ id: 'account-2', name: 'Ahorro' })).toEqual({
      id: 'account-2', name: 'Ahorro', currencyCode: null, closed: false, offBudget: false, currentBalanceMinor: null,
    });
    expect(mapActualCategory({ id: 'other', name: 'Otros', group_id: 'expenses' })).toEqual({
      id: 'other', name: 'Otros', groupId: 'expenses', isIncome: false,
    });
  });

  it('cleans up the API session when budget initialization fails', async () => {
    const api = createApi({ downloadBudget: vi.fn(async () => { throw new Error('private sync failure'); }) });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.listAccounts()).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE' });
    expect(api.shutdown).toHaveBeenCalledTimes(1);
    expect(api.shutdown).toHaveBeenCalledOnce();
  });

  it('sanitizes sync errors and rejects an empty account id', async () => {
    const api = createApi({ sync: vi.fn(async () => { throw new Error('sensitive local payload'); }) });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.listAccounts()).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE', message: 'Actual Budget operation failed.' });
    await expect(adapter.listTransactions('   ', '2026-10-01', '2026-10-31')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('fails clearly when optional budget capabilities are not provided by the API contract', async () => {
    const adapter = new ActualBudgetAdapter(config, createApi());
    await expect(adapter.getBudgetMonth('2026-10')).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE' });
    await expect(adapter.getBudgetAllocations('2026-10')).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE' });
    await expect(adapter.setBudgetAmount('2026-10', 'food', 1_000)).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE' });
  });

  it('waits for Actual read-after-write confirmation before syncing an update', async () => {
    const rows: BudgetTransaction[] = [{
      id: 'delayed-tx', account: 'account-1', date: '2026-10-02', amount: -1_000, category: 'food',
    }];
    const events: string[] = [];
    const api = createApi({
      sync: vi.fn(async () => { events.push('sync'); }),
      getTransactions: vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
        rows.filter((row) => row.date >= startDate && row.date <= endDate)),
      updateTransaction: vi.fn(async (id: string, fields: TransactionStructureUpdate) => {
        setTimeout(() => {
          const existing = rows.find((row) => row.id === id);
          if (existing) Object.assign(existing, fields);
          events.push('applied');
        }, 25);
      }),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    const result = await adapter.updateTransactionSafely('delayed-tx', 'account-1', '2026-10-02', {
      date: '2026-10-04', amount: -1_250,
    });
    expect(result).toEqual({ persisted: true, verified: true });
    expect(rows[0]).toMatchObject({ date: '2026-10-04', amount: -1_250 });
    expect(events.indexOf('applied')).toBeGreaterThan(-1);
    expect(events.lastIndexOf('sync')).toBeGreaterThan(events.indexOf('applied'));
  });

  it('verifies a complete split parent update and every retained child id', async () => {
    const rows: BudgetTransaction[] = [{
      id: 'split-parent', account: 'account-1', date: '2026-10-02', amount: -5_000, is_parent: true,
      subtransactions: [
        { id: 'part-a', account: 'account-1', date: '2026-10-02', amount: -2_000, parent_id: 'split-parent', is_child: true, category: 'food' },
        { id: 'part-b', account: 'account-1', date: '2026-10-02', amount: -3_000, parent_id: 'split-parent', is_child: true },
      ],
    }];
    const api = createApi({
      getTransactions: vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
        rows.filter((row) => row.date >= startDate && row.date <= endDate)),
      updateTransaction: vi.fn(async (id: string, fields: TransactionStructureUpdate) => {
        const existing = rows.find((row) => row.id === id);
        if (existing) Object.assign(existing, fields);
      }),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    const updatedChildren: BudgetTransaction[] = [
      { id: 'part-a', account: 'account-1', date: '2026-10-02', amount: -2_500, parent_id: 'split-parent', is_child: true, category: 'food' },
      { id: 'part-b', account: 'account-1', date: '2026-10-02', amount: -3_000, parent_id: 'split-parent', is_child: true },
    ];
    const result = await adapter.updateTransactionSafely('split-parent', 'account-1', '2026-10-02', {
      is_parent: true, amount: -5_500, subtransactions: updatedChildren,
    });
    expect(result).toEqual({ persisted: true, verified: true });
    expect(rows[0]?.subtransactions?.map((child) => child.id)).toEqual(['part-a', 'part-b']);
    expect(rows[0]?.amount).toBe(rows[0]?.subtransactions?.reduce((sum, child) => sum + child.amount, 0));
  });

  it('does not verify a split update if Actual drops child hierarchy flags', async () => {
    const rows: BudgetTransaction[] = [{
      id: 'split-parent', account: 'account-1', date: '2026-10-02', amount: -5_000, is_parent: true,
      subtransactions: [
        { id: 'part-a', account: 'account-1', date: '2026-10-02', amount: -2_000, parent_id: 'split-parent', is_child: true, is_parent: false, category: 'food' },
        { id: 'part-b', account: 'account-1', date: '2026-10-02', amount: -3_000, parent_id: 'split-parent', is_child: true, is_parent: false },
      ],
    }];
    const api = createApi({
      getTransactions: vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
        rows.filter((row) => row.date >= startDate && row.date <= endDate)),
      updateTransaction: vi.fn(async (id: string, fields: TransactionStructureUpdate) => {
        const existing = rows.find((row) => row.id === id);
        if (!existing) return;
        Object.assign(existing, {
          ...fields,
          subtransactions: (fields.subtransactions ?? []).map((child) => ({
            ...child,
            is_child: false,
            is_parent: true,
          })),
        });
      }),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    const result = await adapter.updateTransactionSafely('split-parent', 'account-1', '2026-10-02', {
      is_parent: true,
      amount: -5_500,
      subtransactions: [
        { id: 'part-a', account: 'account-1', date: '2026-10-02', amount: -2_500, parent_id: 'split-parent', is_child: true, is_parent: false, category: 'food' },
        { id: 'part-b', account: 'account-1', date: '2026-10-02', amount: -3_000, parent_id: 'split-parent', is_child: true, is_parent: false },
      ],
    });
    expect(result).toEqual({ persisted: false, verified: false });
  });

  it('reads transactions for a valid account and date period', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.listTransactions('account-1', '2026-10-01', '2026-10-31')).resolves.toEqual([]);
    expect(api.getTransactions).toHaveBeenCalledWith('account-1', '2026-10-01', '2026-10-31');
  });

  it('reads official budget month data and persists explicit category allocation updates', async () => {
    const monthRecord: ActualBudgetMonthRecord = {
      month: '2026-10',
      totalBudgeted: 15_000,
      totalSpent: -9_000,
      totalBalance: 6_000,
      categoryGroups: [{
        id: 'expenses',
        name: 'Gastos',
        is_income: false,
        categories: [{ id: 'food', name: 'Alimentación', budgeted: 15_000, spent: -9_000, balance: 6_000 }],
      }],
    };
    const api = createApi({
      getBudgetMonth: vi.fn(async () => monthRecord),
      setBudgetAmount: vi.fn(async () => null),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.getBudgetMonth('2026-10')).resolves.toEqual(monthRecord);
    await adapter.setBudgetAmount('2026-10', 'food', 20_000);
    expect(api.getBudgetMonth).toHaveBeenCalledWith('2026-10');
    expect(api.setBudgetAmount).toHaveBeenCalledWith('2026-10', 'food', 20_000);
    expect(api.sync).toHaveBeenCalledTimes(3);
  });

  it('returns explicit category allocations from the budget query contract', async () => {
    const allocations = [{ categoryId: 'food', amountMinor: 0 }];
    const api = createApi({ getBudgetAllocations: vi.fn(async () => allocations) });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.getBudgetAllocations('2026-10')).resolves.toEqual(allocations);
    expect(api.getBudgetAllocations).toHaveBeenCalledWith('2026-10');
  });

  it('rejects malformed budget months and negative budget allocations', async () => {
    const api = createApi({ getBudgetMonth: vi.fn(async () => ({ month: '2026-10', categoryGroups: [] })) });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.getBudgetMonth('2026-13')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(adapter.setBudgetAmount('2026-10', 'food', -1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(api.getBudgetMonth).not.toHaveBeenCalled();
  });

  it('syncs explicitly persisted imports and never asks to reimport deleted transactions', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter(config, api);
    const input: ActualImportRecord[] = [{ date: '2026-10-10', amount: -1299, payee_name: 'Supermercado' }];
    await adapter.importTransactions('account-1', input, { dryRun: false });
    expect(api.importTransactions).toHaveBeenCalledWith('account-1', input, {
      dryRun: false, reimportDeleted: false, defaultCleared: false, payeeNameNormalization: 'original',
    });
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('reports a sanitized failure if shutdown fails', async () => {
    const api = createApi({ shutdown: vi.fn(async () => { throw new Error('private state'); }) });
    const adapter = new ActualBudgetAdapter(config, api);
    await adapter.listAccounts();
    await expect(adapter.close()).rejects.toMatchObject({
      code: 'UPSTREAM_FAILURE',
      message: 'Actual Budget session could not shut down cleanly.',
    });
  });

  it('initializes lazily once, maps records and shuts down cleanly', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.listAccounts()).resolves.toEqual([{ id: 'account-1', name: 'Cuenta', currencyCode: null, closed: false, offBudget: false, currentBalanceMinor: 1200 }]);
    await expect(adapter.listCategories()).resolves.toEqual([{ id: 'food', name: 'Alimentación', groupId: 'expenses', isIncome: false }]);
    expect(api.init).toHaveBeenCalledTimes(1);
    expect(api.downloadBudget).toHaveBeenCalledWith('budget-uuid');
    expect(api.sync).toHaveBeenCalledTimes(2);
    await adapter.close();
    expect(api.shutdown).toHaveBeenCalledTimes(1);
  });
  it('maps only explicit Actual transfer payees to destination account ids', async () => {
    const api = createApi({
      getPayees: vi.fn(async () => [
        { id: 'payee-transfer-1', name: 'Cuenta de destino', transfer_acct: 'account-2' },
        { id: 'ordinary-payee', name: 'Supermercado', transfer_acct: null },
        { id: 'incomplete-payee', name: 'Sin destino' },
      ]),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.listTransferPayees()).resolves.toEqual([{ name: 'Cuenta de destino', accountId: 'account-2' }]);
    expect(api.getPayees).toHaveBeenCalledTimes(1);
    await adapter.close();
  });

  it('does not initialize without a budget id', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter({ serverURL: config.serverURL, dataDir: config.dataDir }, api);
    await expect(adapter.listAccounts()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(api.init).not.toHaveBeenCalled();
  });
  it('validates query periods before calling Actual', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.listTransactions('account-1', '2026-10-30', '2026-10-01')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(api.getTransactions).not.toHaveBeenCalled();
  });
  it('replaces upstream error details with a sanitized message', async () => {
    const api = createApi({ getAccounts: vi.fn(async () => { throw new Error('private transaction payload'); }) });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.listAccounts()).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE', message: 'Actual Budget operation failed.' });
  });
  it('defaults imports to dry-run and prevents deleted transactions being reimported', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter(config, api);
    const input: ActualImportRecord[] = [{ date: '2026-10-10', amount: -1299, payee_name: 'Supermercado' }];
    await adapter.importTransactions('account-1', input);
    expect(api.importTransactions).toHaveBeenCalledWith('account-1', input, {
      dryRun: true, reimportDeleted: false, defaultCleared: false, payeeNameNormalization: 'original',
    });
  });
  it('rejects invalid import records before calling Actual', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.importTransactions('account-1', [{ date: 'not-a-date', amount: 1.5 }] as unknown as ActualImportRecord[]))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(api.importTransactions).not.toHaveBeenCalled();
  });
  it('categorizes a transaction explicitly and syncs before returning', async () => {
    const api = createApi({ updateTransaction: vi.fn(async () => undefined) });
    const adapter = new ActualBudgetAdapter(config, api);
    await adapter.updateTransactionCategory('transaction-1', 'food');
    expect(api.updateTransaction).toHaveBeenCalledWith('transaction-1', { category: 'food' });
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid categorization ids and missing update capability', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.updateTransactionCategory('   ', 'food')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(adapter.updateTransactionCategory('transaction-1', '')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('sanitizes categorization failures without exposing upstream details', async () => {
    const api = createApi({ updateTransaction: vi.fn(async () => { throw new Error('private category dump'); }) });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.updateTransactionCategory('transaction-1', 'food')).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE' });
  });

  it('rejects operations after close', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter(config, api);
    await adapter.listAccounts();
    await adapter.close();
    await expect(adapter.listAccounts()).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it('updates only validated official transaction fields and syncs after a successful write', async () => {
    const updateTransaction = vi.fn(async () => undefined);
    const api = createApi({ updateTransaction });
    const adapter = new ActualBudgetAdapter(config, api);
    const fields = {
      date: '2026-10-13', amount: -12_345, imported_payee: 'Proveedor revisado',
      category: null, notes: 'Nota revisada', cleared: true,
    };
    await adapter.updateTransaction('transaction-1', fields);
    expect(updateTransaction).toHaveBeenCalledWith('transaction-1', fields);
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('validates category batches and verifies each write before syncing the next', async () => {
    const rows: BudgetTransaction[] = [
      { id: 'transaction-1', account: 'account-1', date: '2026-10-10', amount: -1_000, category: null },
      { id: 'transaction-2', account: 'account-1', date: '2026-10-10', amount: -2_000, category: null },
    ];
    const updateTransaction = vi.fn(async (id: string, fields: TransactionStructureUpdate) => {
      const row = rows.find((item) => item.id === id);
      if (row) Object.assign(row, fields);
    });
    const api = createApi({
      updateTransaction,
      getTransactions: vi.fn(async (accountId: string, startDate: string, endDate: string) =>
        rows.filter((row) => row.account === accountId && row.date >= startDate && row.date <= endDate)),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    const changes = [
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
      { transactionId: 'transaction-2', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
    ];
    await expect(adapter.updateTransactionCategoriesBatch(changes)).resolves.toEqual({
      requested: 2, updatedTransactionIds: ['transaction-1', 'transaction-2'], persisted: true,
    });
    expect(updateTransaction).toHaveBeenNthCalledWith(1, 'transaction-1', { category: 'food' });
    expect(updateTransaction).toHaveBeenNthCalledWith(2, 'transaction-2', { category: 'food' });
    // One init sync plus a sync after each verified write; no second write can interrupt a pending one.
    expect(api.sync).toHaveBeenCalledTimes(3);
    expect(rows.map((row) => row.category)).toEqual(['food', 'food']);

    const callsBeforeDuplicate = updateTransaction.mock.calls.length;
    await expect(adapter.updateTransactionCategoriesBatch([
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
    ])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(updateTransaction).toHaveBeenCalledTimes(callsBeforeDuplicate);
  });

  it('preflights the entire category batch before the first write', async () => {
    const rows: BudgetTransaction[] = [
      { id: 'transaction-1', account: 'account-1', date: '2026-10-10', amount: -1_000, category: null },
      // This later row changed after the preview; the first row must remain untouched.
      { id: 'transaction-2', account: 'account-1', date: '2026-10-10', amount: -2_000, category: 'restaurants' },
    ];
    const updateTransaction = vi.fn(async (id: string, fields: TransactionStructureUpdate) => {
      const row = rows.find((item) => item.id === id);
      if (row) Object.assign(row, fields);
    });
    const api = createApi({
      updateTransaction,
      getTransactions: vi.fn(async (accountId: string, startDate: string, endDate: string) =>
        rows.filter((row) => row.account === accountId && row.date >= startDate && row.date <= endDate)),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    const outcome = await adapter.updateTransactionCategoriesBatch([
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
      { transactionId: 'transaction-2', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
    ]);

    expect(outcome).toEqual({
      requested: 2,
      updatedTransactionIds: [],
      failedTransactionId: 'transaction-2',
      conflictTransactionId: 'transaction-2',
      persisted: true,
    });
    expect(updateTransaction).not.toHaveBeenCalled();
    expect(rows.map((row) => row.category)).toEqual([null, 'restaurants']);
    expect(api.sync).toHaveBeenCalledTimes(1);
  });

  it('reports partial category batches without claiming unverified writes were persisted', async () => {
    const rows: BudgetTransaction[] = [
      { id: 'transaction-1', account: 'account-1', date: '2026-10-10', amount: -1_000, category: null },
      { id: 'transaction-2', account: 'account-1', date: '2026-10-10', amount: -2_000, category: null },
    ];
    const updateTransaction = vi.fn(async (id: string, fields: TransactionStructureUpdate) => {
      if (id === 'transaction-2') throw new Error('private upstream detail');
      const row = rows.find((item) => item.id === id);
      if (row) Object.assign(row, fields);
    });
    const api = createApi({
      updateTransaction,
      getTransactions: vi.fn(async (accountId: string, startDate: string, endDate: string) =>
        rows.filter((row) => row.account === accountId && row.date >= startDate && row.date <= endDate)),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    const outcome = await adapter.updateTransactionCategoriesBatch([
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
      { transactionId: 'transaction-2', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
    ]);
    expect(outcome).toEqual({
      requested: 2, updatedTransactionIds: ['transaction-1'],
      failedTransactionId: 'transaction-2', persisted: false,
    });
    expect(rows[0]?.category).toBe('food');
    expect(rows[1]?.category).toBeNull();
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('reports a failed sync as unverified and identifies the current item', async () => {
    let syncCalls = 0;
    const row: BudgetTransaction = { id: 'transaction-1', account: 'account-1', date: '2026-10-10', amount: -1_000, category: null };
    const api = createApi({
      sync: vi.fn(async () => {
        syncCalls += 1;
        if (syncCalls === 2) throw new Error('private sync failure');
      }),
      getTransactions: vi.fn(async () => [row]),
      updateTransaction: vi.fn(async (_id: string, fields: TransactionStructureUpdate) => { Object.assign(row, fields); }),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.updateTransactionCategoriesBatch([
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
    ])).resolves.toMatchObject({
      requested: 1, updatedTransactionIds: [], failedTransactionId: 'transaction-1', persisted: false,
    });
  });

  it('returns unverified without syncing if updateTransaction resolves but readback never observes the new category', async () => {
    const row: BudgetTransaction = { id: 'transaction-1', account: 'account-1', date: '2026-10-10', amount: -1_000, category: null };
    const api = createApi({
      getTransactions: vi.fn(async () => [row]),
      updateTransaction: vi.fn(async () => undefined),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.updateTransactionCategoriesBatch([
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
    ])).resolves.toEqual({
      requested: 1, updatedTransactionIds: [], failedTransactionId: 'transaction-1', persisted: false,
    });
    // Only the enqueue initialization sync occurs; syncing before readback would risk interrupting the pending write.
    expect(api.sync).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale category baseline before writing', async () => {
    const row: BudgetTransaction = { id: 'transaction-1', account: 'account-1', date: '2026-10-10', amount: -1_000, category: 'restaurants' };
    const updateTransaction = vi.fn(async () => undefined);
    const api = createApi({
      updateTransaction,
      getTransactions: vi.fn(async () => [row]),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.updateTransactionCategoriesBatch([
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
    ])).resolves.toEqual({
      requested: 1, updatedTransactionIds: [], failedTransactionId: 'transaction-1',
      conflictTransactionId: 'transaction-1', persisted: true,
    });
    expect(updateTransaction).not.toHaveBeenCalled();
    expect(api.sync).toHaveBeenCalledTimes(1);
  });

  it('treats an already-satisfied category as an idempotent no-op', async () => {
    const row: BudgetTransaction = { id: 'transaction-1', account: 'account-1', date: '2026-10-10', amount: -1_000, category: 'food' };
    const updateTransaction = vi.fn(async () => undefined);
    const api = createApi({
      updateTransaction,
      getTransactions: vi.fn(async () => [row]),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    await expect(adapter.updateTransactionCategoriesBatch([
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: 'food' },
    ])).resolves.toEqual({ requested: 1, updatedTransactionIds: ['transaction-1'], persisted: true });
    expect(updateTransaction).not.toHaveBeenCalled();
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('retries a locally applied category after a sync failure without a duplicate write', async () => {
    const row: BudgetTransaction = { id: 'transaction-1', account: 'account-1', date: '2026-10-10', amount: -1_000, category: null };
    let syncCalls = 0;
    const updateTransaction = vi.fn(async (id: string, fields: TransactionStructureUpdate) => { if (id === row.id) Object.assign(row, fields); });
    const api = createApi({
      sync: vi.fn(async () => {
        syncCalls += 1;
        if (syncCalls === 2) throw new Error('synthetic sync failure');
      }),
      updateTransaction,
      getTransactions: vi.fn(async () => [row]),
    });
    const adapter = new ActualBudgetAdapter(config, api);
    const first = await adapter.updateTransactionCategoriesBatch([
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: null },
    ]);
    expect(first).toEqual({
      requested: 1, updatedTransactionIds: [], failedTransactionId: 'transaction-1', persisted: false,
    });
    expect(row.category).toBe('food');

    const retry = await adapter.updateTransactionCategoriesBatch([
      { transactionId: 'transaction-1', categoryId: 'food', accountId: 'account-1', date: '2026-10-10', expectedCategoryId: 'food' },
    ]);
    expect(retry).toEqual({ requested: 1, updatedTransactionIds: ['transaction-1'], persisted: true });
    expect(updateTransaction).toHaveBeenCalledOnce();
    // The adapter synchronizes at operation start and again to verify the idempotent retry.
    expect(syncCalls).toBe(4);
  });

});
