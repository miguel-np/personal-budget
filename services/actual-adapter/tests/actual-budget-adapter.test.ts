import { describe, expect, it, vi } from 'vitest';
import type { BudgetTransaction } from '@personal-budget/finance-core';
import { ActualBudgetAdapter } from '../src/actual-budget-adapter.js';
import type { ActualApiContract, ActualImportRecord } from '../src/actual-api-contract.js';

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

const config = { serverURL: 'http://127.0.0.1:5006', dataDir: './.local/actual-api', budgetId: 'budget-uuid' };

describe('ActualBudgetAdapter', () => {
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
  it('rejects operations after close', async () => {
    const api = createApi();
    const adapter = new ActualBudgetAdapter(config, api);
    await adapter.listAccounts();
    await adapter.close();
    await expect(adapter.listAccounts()).rejects.toMatchObject({ code: 'CLOSED' });
  });
});
