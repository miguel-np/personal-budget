import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetAccount, BudgetCategory, BudgetRepository, BudgetTransaction } from '@personal-budget/finance-core';
import { ActualAdapterError } from '@personal-budget/actual-adapter';
import type { ActualImportRecord, ActualImportResult } from '@personal-budget/actual-adapter';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const accounts: readonly BudgetAccount[] = [
  { id: 'account-1', name: 'Cuenta corriente', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 200_000 },
];
const categories: readonly BudgetCategory[] = [
  { id: 'salary', name: 'Salario', groupId: 'income', isIncome: true },
  { id: 'food', name: 'Alimentación', groupId: 'spend', isIncome: false },
];
const transactions: readonly BudgetTransaction[] = [
  { id: 'income-1', account: 'account-1', currencyCode: 'EUR', date: '2026-10-01', amount: 200_000, category: 'salary' },
  { id: 'expense-1', account: 'account-1', currencyCode: 'EUR', date: '2026-10-02', amount: -10_000, category: 'food' },
  { id: 'transfer-1', account: 'account-1', currencyCode: 'EUR', date: '2026-10-02', amount: -50_000, transfer_id: 'transfer-pair' },
];

function createRepository(overrides: Partial<BudgetRepository> = {}): BudgetRepository {
  return {
    isConfigured: true,
    listAccounts: vi.fn(async () => accounts),
    listCategories: vi.fn(async () => categories),
    listTransactions: vi.fn(async () => transactions),
    ...overrides,
  };
}

const config: AppConfig = {
  environment: 'test', host: '127.0.0.1', port: 3000, logLevel: 'silent',
  actualServerURL: 'http://127.0.0.1:5006', actualDataDir: './.local/actual-api',
  ollamaBaseURL: 'http://127.0.0.1:11434', aiEnabled: false, ollamaTimeoutMs: 120_000, aiMaxContextChars: 4_000,
  budgetCurrency: 'EUR', allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
};
const openApps: Array<{ close: () => Promise<void> }> = [];
const temporaryDirectories: string[] = [];

async function createOllamaFixture(chatStatus = 200, narrative = 'Los gastos parecen estables.') {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') {
      response.writeHead(200);
      response.end(JSON.stringify({ models: [{ name: 'synthetic-model' }] }));
      return;
    }
    if (request.url === '/api/chat') {
      response.writeHead(chatStatus);
      response.end(JSON.stringify(chatStatus >= 200 && chatStatus < 300
        ? { message: { content: narrative } }
        : { error: 'synthetic upstream failure' }));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind synthetic Ollama server.');
  return {
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTestApp(repository: BudgetRepository = createRepository(), appConfig: AppConfig = config) {
  const app = await buildApp({ repository, config: appConfig, logger: false });
  openApps.push(app);
  return app;
}

describe('local API', () => {
  it('exposes health without requiring a configured budget', async () => {
    const app = await createTestApp(createRepository({ isConfigured: false }));
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'personal-budget-api' });
  });

  it('returns readiness without exposing settings', async () => {
    const app = await createTestApp(createRepository({ isConfigured: false }));
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_configured' });
    expect(response.body).not.toContain('127.0.0.1');
  });

  it('reports the assistant disabled without contacting Ollama by default', async () => {
    const app = await createTestApp();
    const status = await app.inject({ method: 'GET', url: '/api/v1/assistant/status' });
    const chat = await app.inject({ method: 'POST', url: '/api/v1/assistant/chat', payload: { question: 'Resume octubre', startDate: '2026-10-01', endDate: '2026-10-31' } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ enabled: false, status: 'disabled' });
    expect(chat.statusCode).toBe(503);
    expect(chat.json().error.code).toBe('AI_DISABLED');
  });

  it('validates assistant period and bounds without fetching finance data', async () => {
    const repository = createRepository();
    const app = await createTestApp(repository);
    const response = await app.inject({ method: 'POST', url: '/api/v1/assistant/chat', payload: { question: 'x', startDate: '2020-01-01', endDate: '2026-01-01' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_PERIOD');
    expect(repository.listAccounts).not.toHaveBeenCalled();
  });

  it('covers assistant comparison, account validation and successful local explanations', async () => {
    const ollama = await createOllamaFixture();
    const listTransactions = vi.fn(async () => transactions);
    const repository = createRepository({ listTransactions });
    const app = await createTestApp(repository, {
      ...config,
      aiEnabled: true,
      ollamaBaseURL: ollama.url,
      ollamaModel: 'synthetic-model',
    });
    try {
      const incompleteComparison = await app.inject({
        method: 'POST',
        url: '/api/v1/assistant/chat',
        payload: { question: 'Compara periodos', startDate: '2026-10-01', endDate: '2026-10-31', previousStartDate: '2026-09-01' },
      });
      expect(incompleteComparison.statusCode).toBe(400);
      expect(incompleteComparison.json().error.code).toBe('INVALID_REQUEST');

      const invalidAccount = await app.inject({
        method: 'POST',
        url: '/api/v1/assistant/chat',
        payload: { question: 'Resume octubre', startDate: '2026-10-01', endDate: '2026-10-31', accountId: 'missing-account' },
      });
      expect(invalidAccount.statusCode).toBe(400);
      expect(invalidAccount.json().error.code).toBe('INVALID_ACCOUNT');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/assistant/chat',
        payload: {
          question: 'Compara octubre con septiembre',
          startDate: '2026-10-01',
          endDate: '2026-10-31',
          previousStartDate: '2026-09-01',
          previousEndDate: '2026-09-30',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        answer: 'Los gastos parecen estables.',
        answerKind: 'qualitative_explanation',
        comparison: { startDate: '2026-09-01', endDate: '2026-09-30' },
      });
      expect(listTransactions).toHaveBeenCalledTimes(2);
      expect(listTransactions).toHaveBeenCalledWith('account-1', '2026-10-01', '2026-10-31');
      expect(listTransactions).toHaveBeenCalledWith('account-1', '2026-09-01', '2026-09-30');
    } finally {
      await ollama.close();
    }
  });

  it('maps local assistant upstream failures to a sanitized 503 response', async () => {
    const ollama = await createOllamaFixture(503);
    const app = await createTestApp(createRepository(), {
      ...config,
      aiEnabled: true,
      ollamaBaseURL: ollama.url,
      ollamaModel: 'synthetic-model',
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/assistant/chat',
        payload: { question: 'Resume octubre', startDate: '2026-10-01', endDate: '2026-10-31' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('AI_UNAVAILABLE');
      expect(response.body).not.toContain('synthetic upstream failure');
    } finally {
      await ollama.close();
    }
  });

  it('returns accounts and categories through the repository boundary', async () => {
    const repository = createRepository();
    const app = await createTestApp(repository);
    const accountsResponse = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    const categoriesResponse = await app.inject({ method: 'GET', url: '/api/v1/categories' });
    expect(accountsResponse.statusCode).toBe(200);
    expect(accountsResponse.json().data).toMatchObject(accounts);
    expect(accountsResponse.json().data[0]).toMatchObject({ currencyCode: 'EUR', nativeCurrencyCode: 'EUR', displayCurrency: 'EUR', displayBalanceMinor: 200_000 });
    expect(categoriesResponse.statusCode).toBe(200);
    expect(categoriesResponse.json().data).toEqual(categories);
    expect(repository.listAccounts).toHaveBeenCalledTimes(1);
    expect(repository.listCategories).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed transaction query parameters', async () => {
    const repository = createRepository();
    const app = await createTestApp(repository);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions?accountId=account-1&startDate=2026-02-29&endDate=2026-03-01',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(repository.listTransactions).not.toHaveBeenCalled();
  });

  it('rejects periods beyond five years', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions?accountId=account-1&startDate=2020-01-01&endDate=2026-01-01',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_PERIOD');
  });

  it('rejects unknown browser origins and accepts explicitly allowed loopback origins', async () => {
    const app = await createTestApp();
    const blocked = await app.inject({
      method: 'GET', url: '/api/v1/accounts', headers: { origin: 'https://attacker.example' },
    });
    const allowed = await app.inject({
      method: 'GET', url: '/api/v1/accounts', headers: { origin: 'http://127.0.0.1:5173' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(allowed.statusCode).toBe(200);
  });

  it('calculates reports with finance-core and excludes internal transfers', async () => {
    const repository = createRepository();
    const app = await createTestApp(repository);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      currency: 'EUR', incomeMinor: 200_000, expenseMinor: 10_000,
      savingsMinor: 190_000, excludedTransferCount: 1,
    });
    expect(repository.listTransactions).toHaveBeenCalledWith('account-1', '2026-10-01', '2026-10-31');
  });


  it('filters transactions and bounds each page at the API boundary', async () => {
    const repository = createRepository();
    const app = await createTestApp(repository);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions?startDate=2026-10-01&endDate=2026-10-31&categoryId=food&limit=1&offset=0&sortBy=amount&order=asc',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0]).toMatchObject({ id: 'expense-1', category: 'food' });
    expect(response.json().pagination).toMatchObject({ total: 1, limit: 1, offset: 0, sortBy: 'amount', order: 'asc' });
    expect(repository.listAccounts).toHaveBeenCalledTimes(1);
    expect(repository.listTransactions).toHaveBeenCalledTimes(1);
  });

  it('reports unsupported budget read and write capabilities without exposing details', async () => {
    const repository = createRepository();
    const app = await createTestApp(repository);
    const read = await app.inject({ method: 'GET', url: '/api/v1/budgets/2026-10' });
    expect(read.statusCode).toBe(503);
    expect(read.json().error.code).toBe('BUDGET_QUERY_NOT_SUPPORTED');

    const write = await app.inject({
      method: 'PUT',
      url: '/api/v1/budgets/2026-10/food',
      payload: { amountMinor: 1_000 },
    });
    expect(write.statusCode).toBe(503);
    expect(write.json().error.code).toBe('BUDGET_WRITE_NOT_SUPPORTED');
  });

  it('rejects malformed budget month and unsafe category allocations', async () => {
    const app = await createTestApp();
    const badMonth = await app.inject({ method: 'GET', url: '/api/v1/budgets/2026-13' });
    expect(badMonth.statusCode).toBe(400);
    expect(badMonth.json().error.code).toBe('INVALID_REQUEST');

    const negative = await app.inject({
      method: 'PUT', url: '/api/v1/budgets/2026-10/food',
      payload: { amountMinor: -1 },
    });
    expect(negative.statusCode).toBe(400);

    const fractional = await app.inject({
      method: 'PUT', url: '/api/v1/budgets/2026-10/food',
      payload: { amountMinor: 1.5 },
    });
    expect(fractional.statusCode).toBe(400);
  });

  it('uses the official monthly budget when explicit allocation rows are unavailable', async () => {
    const getBudgetMonth = vi.fn(async (month: string) => ({
      month,
      categoryGroups: [{
        id: 'spend',
        name: 'Gastos',
        is_income: false,
        categories: [{ id: 'food', name: 'Alimentación', budgeted: 1_500, spent: -400, balance: 1_100 }],
      }],
    }));
    const repository = Object.assign(createRepository(), { getBudgetMonth }) as BudgetRepository & {
      getBudgetMonth: typeof getBudgetMonth;
    };
    const app = await createTestApp(repository);
    const response = await app.inject({ method: 'GET', url: '/api/v1/budgets/2026-10' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.categories[0]).toMatchObject({ categoryId: 'food', budgetedMinor: 1_500, state: 'budgeted' });
    expect(response.json().data.notes.at(-1)).toContain('no pueden distinguirse');
  });

  it('normalizes Actual monthly category budget amounts and deviation', async () => {
    const getBudgetMonth = vi.fn(async (month: string) => ({
      month,
      totalBudgeted: 5_000,
      totalSpent: -6_000,
      totalBalance: -1_000,
      totalIncome: 200_000,
      incomeAvailable: 190_000,
      toBudget: 10_000,
      categoryGroups: [{
        id: 'spend',
        name: 'Gastos',
        is_income: false,
        categories: [
          { id: 'food', name: 'Alimentación', budgeted: 5_000, spent: -6_000, balance: -1_000, carryover: false, hidden: false },
          { id: 'salary', name: 'Ingreso', budgeted: 0, spent: 0, balance: 0, carryover: false, hidden: true },
        ],
      }],
    }));
    const repository = Object.assign(createRepository(), { getBudgetMonth }) as BudgetRepository & {
      getBudgetMonth: typeof getBudgetMonth;
    };
    const app = await createTestApp(repository);
    const response = await app.inject({ method: 'GET', url: '/api/v1/budgets/2026-10' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.totals).toMatchObject({ totalBudgetedMinor: 5_000, totalSpentMinor: 6_000, totalBalanceMinor: -1_000 });
    expect(response.json().data.categories).toHaveLength(1);
    expect(response.json().data.categories[0]).toMatchObject({
      categoryId: 'food',
      budgetedMinor: 5_000,
      spentMinor: 6_000,
      availableMinor: -1_000,
      percentUsed: 120,
      state: 'budgeted',
    });
    expect(getBudgetMonth).toHaveBeenCalledWith('2026-10');
  });

  it('distinguishes unassigned categories from explicit zero allocations', async () => {
    const getBudgetMonth = vi.fn(async (month: string) => ({
      month,
      categoryGroups: [{
        id: 'spend',
        name: 'Gastos',
        is_income: false,
        categories: [
          { id: 'food', name: 'Alimentación', budgeted: 0, spent: -1_000, balance: -1_000 },
          { id: 'other', name: 'Otros', budgeted: 0, spent: 0, balance: 0 },
          { id: 'zero', name: 'Presupuesto cero', budgeted: 0, spent: 0, balance: 0 },
        ],
      }],
    }));
    const getBudgetAllocations = vi.fn(async () => [
      { categoryId: 'food', amountMinor: 5_000 },
      { categoryId: 'zero', amountMinor: 0 },
    ]);
    const repository = Object.assign(createRepository(), { getBudgetMonth, getBudgetAllocations }) as BudgetRepository & {
      getBudgetMonth: typeof getBudgetMonth;
      getBudgetAllocations: typeof getBudgetAllocations;
    };
    const app = await createTestApp(repository);
    const response = await app.inject({ method: 'GET', url: '/api/v1/budgets/2026-10' });
    expect(response.statusCode).toBe(200);
    const rows = response.json().data.categories as Array<{ categoryId: string; state: string; budgetedMinor: number }>;
    expect(rows.find((item) => item.categoryId === 'food')).toMatchObject({ state: 'budgeted', budgetedMinor: 5_000 });
    expect(rows.find((item) => item.categoryId === 'other')).toMatchObject({ state: 'unbudgeted', budgetedMinor: 0 });
    expect(rows.find((item) => item.categoryId === 'zero')).toMatchObject({ state: 'zero', budgetedMinor: 0 });
  });

  it('updates category allocations only for an existing expense category', async () => {
    const getBudgetMonth = vi.fn(async (month: string) => ({ month, categoryGroups: [] }));
    const setBudgetAmount = vi.fn(async () => undefined);
    const repository = Object.assign(createRepository(), { getBudgetMonth, setBudgetAmount }) as BudgetRepository & {
      getBudgetMonth: typeof getBudgetMonth;
      setBudgetAmount: typeof setBudgetAmount;
    };
    const app = await createTestApp(repository);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/budgets/2026-10/food',
      payload: { amountMinor: 12_345 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ month: '2026-10', categoryId: 'food', amountMinor: 12_345, updated: true });
    expect(setBudgetAmount).toHaveBeenCalledWith('2026-10', 'food', 12_345);

    const income = await app.inject({
      method: 'PUT',
      url: '/api/v1/budgets/2026-10/salary',
      payload: { amountMinor: 1_000 },
    });
    expect(income.statusCode).toBe(400);
    expect(income.json().error.code).toBe('INVALID_CATEGORY');
    expect(setBudgetAmount).toHaveBeenCalledTimes(1);
  });

  it('previews and explicitly commits validated, idempotent transaction imports', async () => {
    const importTransactions = vi.fn(async (
      _accountId: string,
      _records: readonly ActualImportRecord[],
      options?: { readonly dryRun?: boolean },
    ): Promise<ActualImportResult> => ({
      errors: [],
      added: [options?.dryRun ? 'preview-id' : 'saved-id'],
      updated: [],
    }));
    const repository = Object.assign(createRepository(), { importTransactions }) as BudgetRepository & {
      importTransactions: typeof importTransactions;
    };
    const app = await createTestApp(repository);
    const body = {
      accountId: 'account-1',
      records: [{
        date: '2026-10-12',
        amount: -1299,
        payee_name: 'Supermercado',
        imported_payee: 'SUPERMERCADO MADRID',
        category: 'food',
        imported_id: 'personal-budget-manual:test-123',
      }],
    };
    const preview = await app.inject({ method: 'POST', url: '/api/v1/import/preview', payload: body });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toMatchObject({ added: 1, updated: 0, errors: 0, submitted: 1, dryRun: true });
    expect(importTransactions).toHaveBeenLastCalledWith('account-1', expect.any(Array), { dryRun: true });

    const commit = await app.inject({ method: 'POST', url: '/api/v1/import/commit', payload: body });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().data).toMatchObject({ added: 1, updated: 0, errors: 0, submitted: 1, dryRun: false });
    expect(importTransactions).toHaveBeenLastCalledWith('account-1', expect.any(Array), { dryRun: false });
    expect(importTransactions.mock.calls[0]?.[1]?.[0]?.imported_id).toBe(body.records[0]?.imported_id);
    expect(importTransactions.mock.calls[1]?.[1]?.[0]?.imported_id).toBe(body.records[0]?.imported_id);
  });

  it('rejects invalid categories and malformed import rows without writing', async () => {
    const importTransactions = vi.fn(async (): Promise<ActualImportResult> => ({ errors: [], added: [], updated: [] }));
    const repository = Object.assign(createRepository(), { importTransactions }) as BudgetRepository & {
      importTransactions: typeof importTransactions;
    };
    const app = await createTestApp(repository);
    const invalidCategory = await app.inject({
      method: 'POST', url: '/api/v1/import/commit',
      payload: { accountId: 'account-1', records: [{ date: '2026-10-12', amount: -1299, payee_name: 'Compra', category: 'missing', imported_id: 'id-1' }] },
    });
    expect(invalidCategory.statusCode).toBe(400);
    expect(invalidCategory.json().error.code).toBe('INVALID_CATEGORY');
    const invalidAmount = await app.inject({
      method: 'POST', url: '/api/v1/import/commit',
      payload: { accountId: 'account-1', records: [{ date: '2026-10-12', amount: 1.25, payee_name: 'Compra', imported_id: 'id-2' }] },
    });
    expect(invalidAmount.statusCode).toBe(400);
    expect(importTransactions).not.toHaveBeenCalled();
  });

  it('reports import capability gaps without exposing adapter details', async () => {
    const app = await createTestApp(createRepository());
    const preview = await app.inject({
      method: 'POST', url: '/api/v1/import/preview',
      payload: { accountId: 'account-1', records: [{ date: '2026-10-12', amount: -1299, payee_name: 'Compra', imported_id: 'id-1' }] },
    });
    expect(preview.statusCode).toBe(503);
    expect(preview.json().error.code).toBe('IMPORT_NOT_SUPPORTED');
    expect(preview.body).not.toContain('importTransactions');
  });

  it('rejects imports for accounts that are not open in the configured budget', async () => {
    const importTransactions = vi.fn(async (): Promise<ActualImportResult> => ({ errors: [], added: [], updated: [] }));
    const repository = Object.assign(createRepository(), { importTransactions }) as BudgetRepository & {
      importTransactions: typeof importTransactions;
    };
    const app = await createTestApp(repository);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/import/commit',
      payload: { accountId: 'closed-or-missing', records: [{ date: '2026-10-12', amount: -1299, payee_name: 'Compra', imported_id: 'id-1' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_ACCOUNT');
    expect(importTransactions).not.toHaveBeenCalled();
  });

  it('reports reconciliation failures as conflicts without leaking import internals', async () => {
    const importTransactions = vi.fn(async (): Promise<ActualImportResult> => ({
      errors: [{ message: 'private upstream reconciliation dump' }],
      added: [], updated: [],
    }));
    const repository = Object.assign(createRepository(), { importTransactions }) as BudgetRepository & {
      importTransactions: typeof importTransactions;
    };
    const app = await createTestApp(repository);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/import/commit',
      payload: { accountId: 'account-1', records: [{ date: '2026-10-12', amount: -1299, payee_name: 'Compra', imported_id: 'id-1' }] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('IMPORT_RECONCILIATION_FAILED');
    expect(response.json().result).toMatchObject({ added: 0, updated: 0, errors: 1, dryRun: false });
    expect(response.body).not.toContain('reconciliation dump');
  });

  it('returns transactions for a validated account and date range', async () => {
    const repository = createRepository();
    const app = await createTestApp(repository);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions?accountId=account-1&startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject([transactions[1], transactions[2], transactions[0]]);
    expect(response.json().pagination).toMatchObject({ total: 3, limit: 50, offset: 0, sortBy: 'date', order: 'desc' });
    expect(repository.listTransactions).toHaveBeenCalledWith('account-1', '2026-10-01', '2026-10-31');
  });

  it('maps unavailable Actual sessions without disclosing configuration', async () => {
    const notConfigured = createRepository({
      listAccounts: vi.fn(async () => { throw new ActualAdapterError('NOT_CONFIGURED', 'Configure private server settings.'); }),
    });
    const notConfiguredApp = await createTestApp(notConfigured);
    const notConfiguredResponse = await notConfiguredApp.inject({ method: 'GET', url: '/api/v1/accounts' });
    expect(notConfiguredResponse.statusCode).toBe(503);
    expect(notConfiguredResponse.json().error.code).toBe('NOT_CONFIGURED');
    expect(notConfiguredResponse.body).not.toContain('ACTUAL_SERVER_PASSWORD');
    expect(notConfiguredResponse.body).not.toContain('private server settings');

    const closed = createRepository({
      listAccounts: vi.fn(async () => { throw new ActualAdapterError('CLOSED', 'private upstream details'); }),
    });
    const closedApp = await createTestApp(closed);
    const closedResponse = await closedApp.inject({ method: 'GET', url: '/api/v1/accounts' });
    expect(closedResponse.statusCode).toBe(503);
    expect(closedResponse.json().error.code).toBe('CLOSED');
    expect(closedResponse.body).not.toContain('private upstream details');
  });

  it('sanitizes category and summary upstream failures', async () => {
    const repository = createRepository({
      listCategories: vi.fn(async () => { throw new Error('sensitive category dump'); }),
    });
    const app = await createTestApp(repository);
    const categoriesResponse = await app.inject({ method: 'GET', url: '/api/v1/categories' });
    const summaryResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(categoriesResponse.statusCode).toBe(502);
    expect(summaryResponse.statusCode).toBe(502);
    expect(categoriesResponse.body).not.toContain('sensitive category dump');
    expect(summaryResponse.body).not.toContain('sensitive category dump');
  });

  it('does not request transactions from closed accounts in a consolidated report', async () => {
    const closedAccount: BudgetAccount = { ...accounts[0]!, id: 'closed-account', name: 'Cuenta cerrada', closed: true };
    const listTransactions = vi.fn(async () => transactions);
    const repository = createRepository({
      listAccounts: vi.fn(async () => [...accounts, closedAccount]),
      listTransactions,
    });
    const app = await createTestApp(repository);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(response.statusCode).toBe(200);
    expect(listTransactions).toHaveBeenCalledTimes(1);
    expect(listTransactions).toHaveBeenCalledWith('account-1', '2026-10-01', '2026-10-31');
  });

  it('does not expose upstream exception details', async () => {
    const repository = createRepository({
      listAccounts: vi.fn(async () => { throw new Error('secret transaction content'); }),
    });
    const app = await createTestApp(repository);
    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('secret transaction content');
  });

  it('detects recurring candidates from local history without writing anything', async () => {
    const recurringTransactions: readonly BudgetTransaction[] = [
      { id: 'gym-1', account: 'account-1', date: '2026-08-01', amount: -1000, category: null, payee_name: 'Gimnasio' },
      { id: 'gym-2', account: 'account-1', date: '2026-09-01', amount: -1000, category: null, payee_name: 'Gimnasio' },
      { id: 'gym-3', account: 'account-1', date: '2026-10-01', amount: -1000, category: null, payee_name: 'Gimnasio' },
      { id: 'one-off', account: 'account-1', date: '2026-10-05', amount: -400, category: null, payee_name: 'Café' },
    ];
    const listTransactions = vi.fn(async () => recurringTransactions);
    const app = await createTestApp(createRepository({ listTransactions }));
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/insights/recurring?startDate=2026-08-01&endDate=2026-10-31',
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data as Array<{ payee: string; occurrenceCount: number; confidence: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ payee: 'gimnasio', occurrenceCount: 3, confidence: 'candidate_only' });
    expect(response.json().notes.some((note: string) => note.includes('no garantizan'))).toBe(true);
  });

  it('suggests categories from local history with rule-based confidence', async () => {
    const history: readonly BudgetTransaction[] = [
      { id: 'h-1', account: 'account-1', date: '2026-09-03', amount: -4200, category: 'food', payee_name: 'Supermercado' },
      { id: 'u-1', account: 'account-1', date: '2026-10-07', amount: -3890, category: null, payee_name: 'Supermercado' },
    ];
    const listTransactions = vi.fn(async () => history);
    const app = await createTestApp(createRepository({ listTransactions }));
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/insights/category-suggestions?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0]).toMatchObject({
      transactionId: 'u-1', suggestedCategoryId: 'food', suggestedCategoryName: 'Alimentación', confidence: 'rule_based',
    });
  });

  it('previews categorization without writing and commits only when asked', async () => {
    const updateTransactionCategory = vi.fn(async () => undefined);
    const listTransactions = vi.fn(async () => transactions);
    const repository = Object.assign(createRepository({ listTransactions }), { updateTransactionCategory }) as BudgetRepository & {
      updateTransactionCategory: typeof updateTransactionCategory;
    };
    const app = await createTestApp(repository);
    const body = {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      transactions: [{ transactionId: 'expense-1', categoryId: 'food' }],
    };
    const preview = await app.inject({ method: 'POST', url: '/api/v1/insights/categorize', payload: { ...body, commit: false } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toMatchObject({ preview: true, changes: 1 });
    expect(updateTransactionCategory).not.toHaveBeenCalled();

    const commit = await app.inject({ method: 'POST', url: '/api/v1/insights/categorize', payload: { ...body, commit: true } });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().data).toMatchObject({ preview: false, changes: 1 });
    expect(updateTransactionCategory).toHaveBeenCalledTimes(1);
    expect(updateTransactionCategory).toHaveBeenCalledWith('expense-1', 'food');
  });

  it('fails closed on unknown transactions, income categories and missing update capability', async () => {
    const updateTransactionCategory = vi.fn(async () => undefined);
    const listTransactions = vi.fn(async () => transactions);
    const repository = Object.assign(createRepository({ listTransactions }), { updateTransactionCategory }) as BudgetRepository & {
      updateTransactionCategory: typeof updateTransactionCategory;
    };
    const app = await createTestApp(repository);
    const unknownTransaction = await app.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: { startDate: '2026-10-01', endDate: '2026-10-31', commit: true, transactions: [{ transactionId: 'missing', categoryId: 'food' }] },
    });
    expect(unknownTransaction.statusCode).toBe(400);
    expect(unknownTransaction.json().error.code).toBe('INVALID_TRANSACTION');

    const incomeCategory = await app.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: { startDate: '2026-10-01', endDate: '2026-10-31', commit: true, transactions: [{ transactionId: 'expense-1', categoryId: 'salary' }] },
    });
    expect(incomeCategory.statusCode).toBe(400);
    expect(incomeCategory.json().error.code).toBe('INVALID_CATEGORY');
    expect(updateTransactionCategory).not.toHaveBeenCalled();

    const withoutCapability = await createTestApp(createRepository({ listTransactions }));
    const unsupported = await withoutCapability.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: { startDate: '2026-10-01', endDate: '2026-10-31', commit: true, transactions: [{ transactionId: 'expense-1', categoryId: 'food' }] },
    });
    expect(unsupported.statusCode).toBe(503);
    expect(unsupported.json().error.code).toBe('TRANSACTION_UPDATE_NOT_SUPPORTED');
  });

  it('simulates forecasts deterministically and rejects malformed scenarios', async () => {
    const listTransactions = vi.fn(async () => transactions);
    const app = await createTestApp(createRepository({ listTransactions }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/forecasts/simulate',
      payload: {
        startDate: '2026-10-01', endDate: '2026-10-31', horizonMonths: 3,
        scenario: { type: 'income_change', percent: 10 },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ isEstimate: true, currency: 'EUR', horizonMonths: 3 });
    expect(response.json().data.monthlyProjection).toHaveLength(3);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/forecasts/simulate',
      payload: {
        startDate: '2026-10-01', endDate: '2026-10-31', horizonMonths: 3,
        scenario: { type: 'category_reduction', categoryId: 'missing', percent: 10 },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(listTransactions).toHaveBeenCalledTimes(2);
  });
  it('converts foreign currency with a dated manual rate and preserves conversion provenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'budget-currency-api-'));
    temporaryDirectories.push(directory);
    const foreignAccount: BudgetAccount = { ...accounts[0]!, currencyCode: null };
    const foreignTransactions: readonly BudgetTransaction[] = [
      { id: 'usd-income', account: 'account-1', currencyCode: 'USD', date: '2026-10-01', amount: 10_000, category: 'salary' },
      { id: 'usd-expense', account: 'account-1', currencyCode: 'USD', date: '2026-10-02', amount: -2_500, category: 'food' },
    ];
    const repository = createRepository({
      listAccounts: vi.fn(async () => [foreignAccount]),
      listTransactions: vi.fn(async () => foreignTransactions),
    });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: {
        displayCurrency: 'EUR',
        accountCurrencyOverrides: { 'account-1': 'USD' },
        exchangeRates: [{ fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.9', effectiveDate: '2026-01-01', source: 'manual statement rate' }],
      },
    });
    expect(saved.statusCode).toBe(200);
    const report = await app.inject({
      method: 'GET', url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().data).toMatchObject({
      currency: 'EUR', incomeMinor: 9_000, expenseMinor: 2_250, savingsMinor: 6_750,
      unconvertedTransactionCount: 0,
      exchangeRatesUsed: [{ fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.9', effectiveDate: '2026-01-01', source: 'manual statement rate', inverseRate: false, transactionCount: 2 }],
    });
    const preferences = await app.inject({ method: 'GET', url: '/api/v1/preferences/currency' });
    expect(preferences.json().data).toMatchObject({
      displayCurrency: 'EUR', budgetCurrency: 'EUR', accountCurrencyOverrides: { 'account-1': 'USD' },
    });
  });

  it('does not create a consolidated total when native currency is unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'budget-currency-unknown-'));
    temporaryDirectories.push(directory);
    const unknownAccount: BudgetAccount = { ...accounts[0]!, currencyCode: null };
    const unknownTransactions: readonly BudgetTransaction[] = [
      { id: 'unknown-income', account: 'account-1', date: '2026-10-01', amount: 10_000, category: 'salary' },
      { id: 'unknown-expense', account: 'account-1', date: '2026-10-02', amount: -2_500, category: 'food' },
    ];
    const repository = createRepository({
      listAccounts: vi.fn(async () => [unknownAccount]),
      listTransactions: vi.fn(async () => unknownTransactions),
    });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const report = await app.inject({
      method: 'GET', url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().data).toMatchObject({
      currency: 'EUR', incomeMinor: 0, expenseMinor: 0, savingsMinor: 0, unconvertedTransactionCount: 2,
    });
    expect(report.json().data.warnings.join(' ')).toMatch(/divisa nativa o un tipo de cambio válido/i);
    const movements = await app.inject({
      method: 'GET', url: '/api/v1/transactions?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(movements.statusCode).toBe(200);
    expect(movements.json().data[0]).toMatchObject({
      currencyCode: null, displayCurrency: 'EUR', displayAmountMinor: null,
      conversion: { warning: expect.stringMatching(/desconocida/i) },
    });
  });

});
