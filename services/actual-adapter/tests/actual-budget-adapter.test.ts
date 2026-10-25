import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { BudgetTransaction } from '@personal-budget/finance-core';
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
      id: 'account-2', name: 'Ahorro', closed: false, offBudget: false, currentBalanceMinor: null,
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
    await expect(adapter.listAccounts()).resolves.toEqual([{ id: 'account-1', name: 'Cuenta', closed: false, offBudget: false, currentBalanceMinor: 1200 }]);
    await expect(adapter.listCategories()).resolves.toEqual([{ id: 'food', name: 'Alimentación', groupId: 'expenses', isIncome: false }]);
    expect(api.init).toHaveBeenCalledTimes(1);
    expect(api.downloadBudget).toHaveBeenCalledWith('budget-uuid');
    expect(api.sync).toHaveBeenCalledTimes(2);
    await adapter.close();
    expect(api.shutdown).toHaveBeenCalledTimes(1);
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
});
