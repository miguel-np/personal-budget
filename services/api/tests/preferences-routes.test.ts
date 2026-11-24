import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BudgetAccount, BudgetRepository } from '@personal-budget/finance-core';
import { ZodError } from 'zod';
import type { AppConfig } from '../src/config.js';
import { AccountScopeError, readAccountScope } from '../src/account-scope.js';
import { readCurrencyPreferences } from '../src/currency-preferences.js';
import { registerPreferencesRoutes } from '../src/preferences-routes.js';

const accounts: readonly BudgetAccount[] = [
  { id: 'checking', name: 'Synthetic checking', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 100_000 },
  { id: 'savings', name: 'Synthetic savings', currencyCode: null, closed: false, offBudget: false, currentBalanceMinor: 250_000 },
  { id: 'closed', name: 'Synthetic closed account', currencyCode: 'EUR', closed: true, offBudget: false, currentBalanceMinor: 0 },
];
const repository: BudgetRepository = {
  isConfigured: true,
  listAccounts: async () => accounts,
  listCategories: async () => [],
  listTransactions: async () => [],
};
const baseConfig: Omit<AppConfig, 'actualDataDir'> = {
  environment: 'test', host: '127.0.0.1', port: 3000, logLevel: 'silent',
  actualServerURL: 'http://127.0.0.1:5006', ollamaBaseURL: 'http://127.0.0.1:11434',
  aiEnabled: false, aiCategoryClassificationEnabled: false, aiCategoryClassificationIncludePayee: false,
  ollamaTimeoutMs: 120_000, aiMaxContextChars: 4_000,
  webSearchEnabled: false, webSearchBaseURL: 'http://127.0.0.1:8080', webSearchTimeoutMs: 8_000,
  webSearchMaxResults: 5, webSearchMaxQueryChars: 300, webSearchMaxResponseBytes: 131_072,
  budgetCurrency: 'EUR', allowedOrigins: ['http://127.0.0.1:5173'],
};
const openApps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

function sanitizedErrorResponse(error: unknown) {
  if (error instanceof AccountScopeError) {
    return { statusCode: 400, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof ZodError) {
    return { statusCode: 400, body: { error: { code: 'INVALID_REQUEST', message: 'Request parameters are invalid.' } } };
  }
  return { statusCode: 502, body: { error: { code: 'UPSTREAM_FAILURE', message: 'The local finance service could not complete this request.' } } };
}

async function createPreferencesApp() {
  const directory = await mkdtemp(join(tmpdir(), 'personal-budget-preferences-routes-'));
  temporaryDirectories.push(directory);
  const app = Fastify({ logger: false });
  await registerPreferencesRoutes(app, {
    repository, config: { ...baseConfig, actualDataDir: directory },
    currencyPreferences: () => readCurrencyPreferences(directory, 'EUR'),
    accountScopePreference: () => readAccountScope(directory),
    sanitizedErrorResponse,
  });
  openApps.push(app);
  return { app, directory };
}
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('preferences routes plugin', () => {
  it('preserves account-scope defaults, selected accounts and closed-account validation', async () => {
    const { app } = await createPreferencesApp();
    const initial = await app.inject({ method: 'GET', url: '/api/v1/preferences/accounts' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data).toMatchObject({
      mode: 'all', activeAccountIds: ['checking', 'savings'],
      accountNames: ['Synthetic checking', 'Synthetic savings'],
    });
    const selected = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['savings'] },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().data).toMatchObject({ mode: 'selected', activeAccountIds: ['savings'] });
    const closed = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['closed'] },
    });
    expect(closed.statusCode).toBe(400);
    expect(closed.json().error.code).toBe('INVALID_ACCOUNT_SCOPE');
  });

  it('rejects unknown or conflicting account-currency overrides and persists valid preferences', async () => {
    const { app } = await createPreferencesApp();
    const conflicting = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: { displayCurrency: 'USD', accountCurrencyOverrides: { checking: 'USD' }, exchangeRates: [] },
    });
    expect(conflicting.statusCode).toBe(400);
    expect(conflicting.json().error.code).toBe('NATIVE_CURRENCY_IS_AUTHORITATIVE');
    const unknown = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: { displayCurrency: 'USD', accountCurrencyOverrides: { missing: 'EUR' }, exchangeRates: [] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('INVALID_ACCOUNT_CURRENCY');
    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: { displayCurrency: 'USD', accountCurrencyOverrides: {}, exchangeRates: [] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({ displayCurrency: 'USD', budgetCurrency: 'EUR' });
    const loaded = await app.inject({ method: 'GET', url: '/api/v1/preferences/currency' });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().data.displayCurrency).toBe('USD');
  });

  it('validates app preferences and resets only app-owned preference files after exact confirmation', async () => {
    const { app, directory } = await createPreferencesApp();
    const sentinelPath = join(directory, 'provider-owned-state.sentinel');
    await writeFile(sentinelPath, 'keep-this-file');
    const invalid = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/app',
      payload: { theme: 'light', locale: 'es-ES', secret: 'must-not-persist' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_REQUEST');
    const updated = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/app',
      payload: { theme: 'light', locale: 'en-GB' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toEqual({ theme: 'light', locale: 'en-GB' });
    await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: { displayCurrency: 'USD', accountCurrencyOverrides: {}, exchangeRates: [] },
    });
    await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['checking'] },
    });
    const wrongConfirmation = await app.inject({
      method: 'POST', url: '/api/v1/preferences/reset', payload: { confirmation: 'RESET' },
    });
    expect(wrongConfirmation.statusCode).toBe(400);
    const reset = await app.inject({
      method: 'POST', url: '/api/v1/preferences/reset',
      payload: { confirmation: 'RESET_APP_PREFERENCES' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().data).toMatchObject({
      reset: true,
      app: { theme: 'system', locale: 'es-ES' },
      currency: { displayCurrency: 'EUR', accountCurrencyOverrides: {}, exchangeRates: [], budgetCurrency: 'EUR' },
      accountScope: { mode: 'all', accountIds: [] },
    });
    expect(await readFile(sentinelPath, 'utf8')).toBe('keep-this-file');
  });
});
