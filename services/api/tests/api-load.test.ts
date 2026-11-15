import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetRepositoryError } from '@personal-budget/finance-core';
import type { BudgetAccount, BudgetCategory, BudgetRepository, BudgetTransaction } from '@personal-budget/finance-core';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const accounts: readonly BudgetAccount[] = [{
  id: 'synthetic-account', name: 'Synthetic account', currencyCode: 'EUR',
  closed: false, offBudget: false, currentBalanceMinor: 100_000,
}];
const categories: readonly BudgetCategory[] = [
  { id: 'salary', name: 'Synthetic income', groupId: 'income', isIncome: true },
  { id: 'food', name: 'Synthetic food', groupId: 'expenses', isIncome: false },
];
const transactions: readonly BudgetTransaction[] = [{
  id: 'synthetic-transaction', account: 'synthetic-account', currencyCode: 'EUR',
  date: '2026-11-05', amount: -2_500, category: 'food', payee_name: 'Synthetic payee',
}];
const baseConfig: Omit<AppConfig, 'actualDataDir'> = {
  environment: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  actualServerURL: 'http://127.0.0.1:5006',
  ollamaBaseURL: 'http://127.0.0.1:11434',
  aiEnabled: false,
  aiCategoryClassificationEnabled: false,
  aiCategoryClassificationIncludePayee: false,
  ollamaTimeoutMs: 120_000,
  aiMaxContextChars: 4_000,
  webSearchEnabled: false,
  webSearchBaseURL: 'http://127.0.0.1:8080',
  webSearchTimeoutMs: 8_000,
  webSearchMaxResults: 5,
  webSearchMaxQueryChars: 300,
  webSearchMaxResponseBytes: 131_072,
  budgetCurrency: 'EUR',
  allowedOrigins: ['http://127.0.0.1:5173'],
};
const openApps: Array<{ close: () => Promise<void> }> = [];
const temporaryDirectories: string[] = [];

function createRepository(overrides: Partial<BudgetRepository> = {}): BudgetRepository {
  return {
    isConfigured: true,
    listAccounts: vi.fn(async () => accounts),
    listCategories: vi.fn(async () => categories),
    listTransactions: vi.fn(async () => transactions),
    ...overrides,
  };
}

async function createListeningApp(repository: BudgetRepository) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-budget-api-load-test-'));
  temporaryDirectories.push(directory);
  const app = await buildApp({
    repository,
    config: { ...baseConfig, actualDataDir: directory },
    logger: false,
  });
  openApps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind the synthetic API test server.');
  return { baseUrl: 'http://127.0.0.1:' + (address as AddressInfo).port };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('synthetic API load and recovery contracts', () => {
  it('keeps health responsive when a slow provider request is cancelled by its caller', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => { release = resolve; });
    const repository = createRepository({
      listTransactions: vi.fn(async () => {
        markStarted();
        await providerGate;
        return transactions;
      }),
    });
    const { baseUrl } = await createListeningApp(repository);
    const controller = new AbortController();
    const abandonedRequest = fetch(
      baseUrl + '/api/v1/reports/summary?startDate=2026-11-01&endDate=2026-11-15',
      { signal: controller.signal },
    );
    try {
      await started;
      controller.abort();
      await expect(abandonedRequest).rejects.toMatchObject({ name: 'AbortError' });
      // Keep the provider promise unresolved: health must not wait for that caller.
      const health = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(3_000) });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok', service: 'personal-budget-api' });
    } finally {
      release();
      await abandonedRequest.catch(() => undefined);
    }
  }, 15_000);

  it('sanitizes provider failures and serves later requests after the failed operation', async () => {
    let calls = 0;
    const repository = createRepository({
      listTransactions: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new BudgetRepositoryError('UPSTREAM_FAILURE', 'private synthetic provider detail');
        return transactions;
      }),
    });
    const { baseUrl } = await createListeningApp(repository);
    const failed = await fetch(
      baseUrl + '/api/v1/reports/summary?startDate=2026-11-01&endDate=2026-11-15',
    );
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await failed.text()).not.toContain('private synthetic provider detail');

    const recovered = await fetch(
      baseUrl + '/api/v1/reports/summary?startDate=2026-11-01&endDate=2026-11-15',
    );
    expect(recovered.status).toBe(200);
    expect(calls).toBe(2);
  }, 15_000);

  it('serves a burst of independent health requests without leaving the runtime wedged', async () => {
    const { baseUrl } = await createListeningApp(createRepository());
    const responses = await Promise.all(Array.from({ length: 10 }, () =>
      fetch(baseUrl + '/health', { signal: AbortSignal.timeout(3_000) })));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const finalHealth = await fetch(baseUrl + '/health');
    expect(finalHealth.status).toBe(200);
  }, 15_000);
});
