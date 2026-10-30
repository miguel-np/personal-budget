import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BudgetAccount, BudgetCategory, BudgetRepository, BudgetTransaction } from '@personal-budget/finance-core';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
  environment: 'test', host: '127.0.0.1', port: 3000, logLevel: 'silent',
  actualServerURL: 'http://127.0.0.1:5006', actualDataDir: './.local/actual-api',
  ollamaBaseURL: 'http://127.0.0.1:11434', aiEnabled: false, aiCategoryClassificationEnabled: false, aiCategoryClassificationIncludePayee: true, ollamaTimeoutMs: 120_000, aiMaxContextChars: 4_000,
  budgetCurrency: 'EUR', allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
};

const accounts: readonly BudgetAccount[] = [
  { id: 'account-eur', name: 'Cuenta EUR', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 40_000 },
  { id: 'account-gbp', name: 'Cuenta GBP', currencyCode: 'GBP', closed: false, offBudget: false, currentBalanceMinor: 7_500 },
];
const categories: readonly BudgetCategory[] = [
  { id: 'salary', name: 'Salario', groupId: 'income', isIncome: true },
  { id: 'food', name: 'Alimentación', groupId: 'spend', isIncome: false },
];
const transactions: readonly BudgetTransaction[] = [
  { id: 'eur-income', account: 'account-eur', currencyCode: 'EUR', date: '2026-10-01', amount: 50_000, category: 'salary' },
  { id: 'gbp-income', account: 'account-gbp', currencyCode: 'GBP', date: '2026-10-02', amount: 10_000, category: 'salary' },
  { id: 'gbp-expense', account: 'account-gbp', currencyCode: 'GBP', date: '2026-10-03', amount: -2_500, category: 'food' },
];

function repository(): BudgetRepository {
  return {
    isConfigured: true,
    listAccounts: async () => accounts,
    listCategories: async () => categories,
    listTransactions: async (accountId, startDate, endDate) => transactions.filter((transaction) =>
      transaction.account === accountId &&
      (!startDate || transaction.date >= startDate) &&
      (!endDate || transaction.date <= endDate)),
  };
}

describe('account-scope and multi-currency integration', () => {
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('persists the selected account scope and fails closed when that scope has no dated exchange rate', async () => {
    directory = await mkdtemp(join(tmpdir(), 'budget-scope-currency-integration-'));
    const appConfig = { ...config, actualDataDir: directory };
    app = await buildApp({ repository: repository(), config: appConfig, logger: false });

    const currencySaved = await app.inject({
      method: 'PUT',
      url: '/api/v1/preferences/currency',
      payload: { displayCurrency: 'EUR', accountCurrencyOverrides: { 'account-gbp': 'GBP' }, exchangeRates: [] },
    });
    expect(currencySaved.statusCode).toBe(200);

    const scopeSaved = await app.inject({
      method: 'PUT',
      url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['account-gbp'] },
    });
    expect(scopeSaved.statusCode).toBe(200);

    const firstSummary = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(firstSummary.statusCode).toBe(200);
    expect(firstSummary.json().data).toMatchObject({
      currency: 'EUR',
      incomeMinor: 0,
      expenseMinor: 0,
      savingsMinor: 0,
      unconvertedTransactionCount: 2,
      accountScope: { mode: 'selected', accountIds: ['account-gbp'], accountNames: ['Cuenta GBP'] },
    });
    expect(firstSummary.json().data.warnings.join(' ')).toMatch(/tipo de cambio|divisa nativa/i);

    const firstMovements = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(firstMovements.statusCode).toBe(200);
    expect(firstMovements.json().data).toHaveLength(2);
    expect(firstMovements.json().data.map((item: { id: string }) => item.id).sort()).toEqual(['gbp-expense', 'gbp-income']);
    for (const movement of firstMovements.json().data) {
      expect(movement).toMatchObject({
        account: 'account-gbp',
        currencyCode: 'GBP',
        displayCurrency: 'EUR',
        displayAmountMinor: null,
        conversion: { warning: expect.stringMatching(/tipo de cambio/i) },
      });
    }

    await app.close();
    app = undefined;
    app = await buildApp({ repository: repository(), config: appConfig, logger: false });

    const persistedCurrency = await app.inject({ method: 'GET', url: '/api/v1/preferences/currency' });
    expect(persistedCurrency.statusCode).toBe(200);
    expect(persistedCurrency.json().data).toMatchObject({
      displayCurrency: 'EUR',
      accountCurrencyOverrides: { 'account-gbp': 'GBP' },
      exchangeRates: [],
    });

    const persistedScope = await app.inject({ method: 'GET', url: '/api/v1/preferences/accounts' });
    expect(persistedScope.statusCode).toBe(200);
    expect(persistedScope.json().data).toMatchObject({
      mode: 'selected',
      accountIds: ['account-gbp'],
      activeAccountIds: ['account-gbp'],
      label: 'Cuentas seleccionadas: Cuenta GBP',
    });

    const secondSummary = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(secondSummary.statusCode).toBe(200);
    expect(secondSummary.json().data).toMatchObject({
      incomeMinor: 0,
      expenseMinor: 0,
      savingsMinor: 0,
      unconvertedTransactionCount: 2,
      accountScope: { mode: 'selected', accountIds: ['account-gbp'] },
    });
  });
});
