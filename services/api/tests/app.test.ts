import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetAccount, BudgetCategory, BudgetRepository, BudgetTransaction, TransactionCategoryBatchChange, TransactionCategoryBatchResult, TransactionStructureUpdate, TransactionUpdate, TransactionWriteResult } from '@personal-budget/finance-core';
import { ActualAdapterError } from '@personal-budget/actual-adapter';
import type { ActualBudgetMonthRecord, ActualImportRecord, ActualImportResult } from '@personal-budget/actual-adapter';
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


  it('serves versioned financial findings, persists review state and works without local AI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'financial-intelligence-api-'));
    temporaryDirectories.push(directory);
    const historicalTransactions: readonly BudgetTransaction[] = [
      { id: 'old-income-1', account: 'account-1', currencyCode: 'EUR', date: '2026-08-03', amount: 30_000, category: 'salary' },
      { id: 'old-income-2', account: 'account-1', currencyCode: 'EUR', date: '2026-08-10', amount: 30_000, category: 'salary' },
      { id: 'old-income-3', account: 'account-1', currencyCode: 'EUR', date: '2026-08-20', amount: 30_000, category: 'salary' },
      { id: 'old-expense-1', account: 'account-1', currencyCode: 'EUR', date: '2026-08-04', amount: -10_000, category: 'food' },
      { id: 'old-expense-2', account: 'account-1', currencyCode: 'EUR', date: '2026-08-11', amount: -10_000, category: 'food' },
      { id: 'old-expense-3', account: 'account-1', currencyCode: 'EUR', date: '2026-08-21', amount: -10_000, category: 'food' },
      { id: 'new-income-1', account: 'account-1', currencyCode: 'EUR', date: '2026-09-03', amount: 20_000, category: 'salary' },
      { id: 'new-income-2', account: 'account-1', currencyCode: 'EUR', date: '2026-09-10', amount: 20_000, category: 'salary' },
      { id: 'new-income-3', account: 'account-1', currencyCode: 'EUR', date: '2026-09-20', amount: 20_000, category: 'salary' },
      { id: 'new-expense-1', account: 'account-1', currencyCode: 'EUR', date: '2026-09-04', amount: -20_000, category: 'food' },
      { id: 'new-expense-2', account: 'account-1', currencyCode: 'EUR', date: '2026-09-11', amount: -20_000, category: 'food' },
      { id: 'new-expense-3', account: 'account-1', currencyCode: 'EUR', date: '2026-09-21', amount: -20_000, category: 'food' },
      { id: 'possible-duplicate-1', account: 'account-1', currencyCode: 'EUR', date: '2026-09-25', amount: -3_000, category: 'food', payee_name: 'Café Norte' },
      { id: 'possible-duplicate-2', account: 'account-1', currencyCode: 'EUR', date: '2026-09-25', amount: -3_000, category: 'food', payee_name: 'cafe-norte' },
      { id: 'uncategorized-expense', account: 'account-1', currencyCode: 'EUR', date: '2026-09-23', amount: -8_000 },
      { id: 'internal-transfer', account: 'account-1', currencyCode: 'EUR', date: '2026-09-24', amount: -90_000, transfer_id: 'transfer-pair' },
    ];
    const listTransactions = vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
      historicalTransactions.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate));
    const repository = createRepository({ listTransactions });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const url = '/api/v1/intelligence/findings?startDate=2026-09-01&endDate=2026-09-30';
    const initial = await app.inject({ method: 'GET', url });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data.schemaVersion).toBe(1);
    expect(initial.json().data.qualityMetrics).toMatchObject({ feedbackCount: 0, usefulCount: 0, dismissedCount: 0, dismissalRatePercent: null });
    const findings = initial.json().data.findings as Array<{ id: string; fingerprint: string; type: string; reviewStatus: string; evidence: unknown[] }>;
    expect(findings.map((item) => item.type)).toContain('expense-change');
    expect(findings.map((item) => item.type)).toContain('income-change');
    expect(findings.map((item) => item.type)).toContain('pending-categorization');
    expect(findings.every((item) => item.id.length > 0 && /^[0-9a-f]{16}$/.test(item.fingerprint))).toBe(true);
    expect(findings.find((item) => item.type === 'expense-change')?.evidence.length).toBeGreaterThan(0);

    const configured = await app.inject({
      method: 'GET',
      url: '/api/v1/intelligence/findings?startDate=2026-09-01&endDate=2026-09-30&referenceWindows=3&minimumAbsoluteChangeMinor=2500&minimumRelativeChangePercent=20&enabledAnomalyKinds=possible-duplicate',
    });
    expect(configured.statusCode).toBe(200);
    const anomalyFindings = configured.json().data.findings.filter((item: { type: string }) => item.type === 'financial-anomaly');
    expect(anomalyFindings).toHaveLength(1);
    expect(anomalyFindings[0].metrics.anomalyKind).toBe('possible-duplicate');
    expect(anomalyFindings[0].reviewStatus).toBe('new');

    const pending = findings.find((item) => item.type === 'pending-categorization');
    expect(pending?.reviewStatus).toBe('new');
    const review = await app.inject({
      method: 'POST',
      url: '/api/v1/intelligence/review',
      payload: { findingId: pending!.id, startDate: '2026-09-01', endDate: '2026-09-30', status: 'dismissed' },
    });
    expect(review.statusCode).toBe(200);
    const afterReview = await app.inject({ method: 'GET', url });
    expect(afterReview.json().data.findings.find((item: { id: string }) => item.id === pending!.id).reviewStatus).toBe('dismissed');
    expect(afterReview.json().data.qualityMetrics).toMatchObject({ feedbackCount: 1, usefulCount: 0, dismissedCount: 1, dismissalRatePercent: 100 });

    const explanation = await app.inject({
      method: 'POST',
      url: '/api/v1/intelligence/explain',
      payload: { findingId: pending!.id, startDate: '2026-09-01', endDate: '2026-09-30' },
    });
    expect(explanation.statusCode).toBe(503);
    expect(explanation.json().error.code).toBe('AI_DISABLED');

    const invalidReview = await app.inject({
      method: 'POST', url: '/api/v1/intelligence/review',
      payload: { findingId: 'fi-v1-not-present', startDate: '2026-09-01', endDate: '2026-09-30', status: 'reviewed' },
    });
    expect(invalidReview.statusCode).toBe(404);
    const expected = await app.inject({
      method: 'POST', url: '/api/v1/intelligence/review',
      payload: { findingId: anomalyFindings[0].id, startDate: '2026-09-01', endDate: '2026-09-30', status: 'expected', referenceWindows: 3, minimumAbsoluteChangeMinor: 2500, minimumRelativeChangePercent: 20, enabledAnomalyKinds: ['possible-duplicate'] },
    });
    expect(expected.statusCode).toBe(200);
    const expectedState = await app.inject({ method: 'GET', url: '/api/v1/intelligence/findings?startDate=2026-09-01&endDate=2026-09-30&referenceWindows=3&minimumAbsoluteChangeMinor=2500&minimumRelativeChangePercent=20&enabledAnomalyKinds=possible-duplicate' });
    expect(expectedState.json().data.findings.find((item: { id: string }) => item.id === anomalyFindings[0].id).reviewStatus).toBe('expected');
    expect(expectedState.json().data.qualityMetrics.expectedCount).toBe(1);
  });

  it('generates and persists a guided periodic review without AI or financial mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'periodic-review-api-'));
    temporaryDirectories.push(directory);
    const today = new Date().toISOString().slice(0, 10);
    const syntheticTransactions: readonly BudgetTransaction[] = [
      { id: 'review-uncategorized', account: 'account-1', currencyCode: 'EUR', date: today, amount: -5_000 },
    ];
    const listTransactions = vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
      syntheticTransactions.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate));
    const repository = createRepository({ listTransactions });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });

    const emptyHistory = await app.inject({ method: 'GET', url: '/api/v1/reviews/periodic' });
    expect(emptyHistory.statusCode).toBe(200);
    expect(emptyHistory.json().data).toEqual({ version: 1, reviews: [] });

    const invalidFuture = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/periodic',
      payload: { periodType: 'weekly', anchorDate: '9999-01-01' },
    });
    expect(invalidFuture.statusCode).toBe(400);

    const generated = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/periodic',
      payload: { periodType: 'monthly', anchorDate: today },
    });
    expect(generated.statusCode).toBe(201);
    const data = generated.json().data;
    expect(data.schemaVersion).toBe(1);
    expect(data.asOfDate).toBe(today);
    expect(data.summary).toMatchObject({ currency: 'EUR', incomeMinor: 0, expenseMinor: 5_000, savingsMinor: -5_000, savingsRatePercent: null });
    expect(data.budgetAssessment).toMatchObject({ available: false, overBudgetCategoryCount: 0 });
    expect(data.budgetAssessment.reason).toBeTruthy();
    expect(data.goalAssessment).toMatchObject({ evaluatedGoalCount: 0, onTrackCount: 0, atRiskCount: 0, projections: [] });
    expect(data.period.startDate).toBe(today.slice(0, 7) + '-01');
    expect(data.period.endDate).toBe(today);
    const previousMonthLastDay = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0));
    const previousMonthStart = previousMonthLastDay.toISOString().slice(0, 7) + '-01';
    const previousMonthEndDay = Math.min(Number(today.slice(8, 10)), previousMonthLastDay.getUTCDate());
    const previousMonthEnd = previousMonthStart.slice(0, 8) + String(previousMonthEndDay).padStart(2, '0');
    expect(data.comparison.period).toEqual({ startDate: previousMonthStart, endDate: previousMonthEnd });
    expect(data.warnings.some((warning: string) => warning.includes('incompleto'))).toBe(
      today !== new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10),
    );
    const item = data.run.items.find((candidate: { findingType: string }) => candidate.findingType === 'pending-categorization');
    expect(item).toMatchObject({ status: 'pending', fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });

    const postponedUntilDate = new Date(today + 'T00:00:00.000Z');
    postponedUntilDate.setUTCDate(postponedUntilDate.getUTCDate() + 7);
    const postponedUntil = postponedUntilDate.toISOString().slice(0, 10);
    const postponed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/reviews/periodic/' + data.run.id + '/items',
      payload: { findingId: item.findingId, status: 'postponed', postponedUntil },
    });
    expect(postponed.statusCode).toBe(200);
    expect(postponed.json().data.items[0]).toMatchObject({ status: 'postponed', postponedUntil });

    const regenerated = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/periodic',
      payload: { periodType: 'monthly', anchorDate: today },
    });
    expect(regenerated.statusCode).toBe(201);
    expect(regenerated.json().data.run.items.find((candidate: { findingId: string }) => candidate.findingId === item.findingId))
      .toMatchObject({ status: 'postponed', postponedUntil });

    const history = await app.inject({ method: 'GET', url: '/api/v1/reviews/periodic' });
    expect(history.statusCode).toBe(200);
    expect(history.json().data.reviews).toHaveLength(2);
    expect(repository.listTransactions).toHaveBeenCalled();
    expect(listTransactions.mock.calls.every(([, start, end]) => start <= end)).toBe(true);
  });

  it('keeps an empty zero-income review explicit and deterministic with no findings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'periodic-review-empty-api-'));
    temporaryDirectories.push(directory);
    const today = new Date().toISOString().slice(0, 10);
    const listTransactions = vi.fn(async () => [] as readonly BudgetTransaction[]);
    const repository = createRepository({ listTransactions });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory, aiEnabled: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/periodic',
      payload: { periodType: 'weekly', anchorDate: today },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.summary).toMatchObject({
      incomeMinor: 0, expenseMinor: 0, savingsMinor: 0, savingsRatePercent: null,
      transactionCount: 0, unconvertedTransactionCount: 0,
    });
    expect(response.json().data.findings).toEqual([]);
    expect(response.json().data.run).toMatchObject({ periodType: 'weekly', status: 'completed', items: [] });
    const monday = new Date(today + 'T00:00:00.000Z');
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    expect(response.json().data.period.startDate).toBe(monday.toISOString().slice(0, 10));
    const previousMonday = new Date(monday);
    previousMonday.setUTCDate(previousMonday.getUTCDate() - 7);
    const previousWeekEnd = new Date(previousMonday);
    previousWeekEnd.setUTCDate(previousWeekEnd.getUTCDate() + ((new Date(today + 'T00:00:00.000Z').getUTCDay() + 6) % 7));
    expect(response.json().data.comparison.period).toEqual({
      startDate: previousMonday.toISOString().slice(0, 10),
      endDate: previousWeekEnd.toISOString().slice(0, 10),
    });
    expect(response.json().data.budgetAssessment).toMatchObject({ available: false });
    expect(response.json().data.goalAssessment).toMatchObject({ evaluatedGoalCount: 0, projections: [] });
    expect(response.json().data.warnings.some((warning: string) => warning.includes('Cumplimiento presupuestario no evaluable'))).toBe(true);
    expect(response.json().data.capabilities).toMatchObject({ aiEnabled: false, deterministicReportAvailable: true });
  });

  it('keeps missing exchange rates explicit across multiple accounts and does not require Ollama', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'periodic-review-multicurrency-api-'));
    temporaryDirectories.push(directory);
    const today = new Date().toISOString().slice(0, 10);
    const gbpAccount: BudgetAccount = {
      id: 'account-gbp', name: 'Cuenta GBP', currencyCode: 'GBP',
      closed: false, offBudget: false, currentBalanceMinor: 0,
    };
    const historicalTransactions: readonly BudgetTransaction[] = [
      { id: 'review-eur-expense', account: 'account-1', currencyCode: 'EUR', date: today, amount: -1_000, category: 'food' },
      { id: 'review-gbp-expense', account: 'account-gbp', currencyCode: 'GBP', date: today, amount: -2_000, category: 'food' },
    ];
    const listTransactions = vi.fn(async (accountId: string, startDate: string, endDate: string) =>
      historicalTransactions.filter((transaction) => transaction.account === accountId && transaction.date >= startDate && transaction.date <= endDate));
    const repository = createRepository({
      listAccounts: vi.fn(async () => [...accounts, gbpAccount]),
      listTransactions,
    });
    const app = await createTestApp(repository, {
      ...config, actualDataDir: directory, aiEnabled: true,
      ollamaBaseURL: 'http://127.0.0.1:1', ollamaModel: 'unavailable-synthetic-model',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/periodic',
      payload: { periodType: 'monthly', anchorDate: today },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      currency: 'EUR',
      accountScope: { mode: 'all' },
      summary: { expenseMinor: 1_000, unconvertedTransactionCount: 1 },
      capabilities: { aiEnabled: true, deterministicReportAvailable: true },
    });
    expect(response.json().data.warnings.some((warning: string) => /conversión|GBP/i.test(warning))).toBe(true);
    const ids = response.json().data.run.items.map((item: { findingId: string }) => item.findingId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(listTransactions).toHaveBeenCalledWith('account-1', expect.any(String), expect.any(String));
    expect(listTransactions).toHaveBeenCalledWith('account-gbp', expect.any(String), expect.any(String));
  });

  it('explains a verified deterministic finding through local Ollama and rejects an unknown finding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'financial-intelligence-ai-api-'));
    temporaryDirectories.push(directory);
    const ollama = await createOllamaFixture(200, 'Explicación cualitativa sintética sin cifras nuevas.');
    const historicalTransactions: readonly BudgetTransaction[] = [
      { id: 'aug-income-1', account: 'account-1', currencyCode: 'EUR', date: '2026-08-03', amount: 30_000, category: 'salary' },
      { id: 'aug-income-2', account: 'account-1', currencyCode: 'EUR', date: '2026-08-10', amount: 30_000, category: 'salary' },
      { id: 'aug-income-3', account: 'account-1', currencyCode: 'EUR', date: '2026-08-20', amount: 30_000, category: 'salary' },
      { id: 'aug-expense-1', account: 'account-1', currencyCode: 'EUR', date: '2026-08-04', amount: -10_000, category: 'food' },
      { id: 'aug-expense-2', account: 'account-1', currencyCode: 'EUR', date: '2026-08-11', amount: -10_000, category: 'food' },
      { id: 'aug-expense-3', account: 'account-1', currencyCode: 'EUR', date: '2026-08-21', amount: -10_000, category: 'food' },
      { id: 'sep-income-1', account: 'account-1', currencyCode: 'EUR', date: '2026-09-03', amount: 20_000, category: 'salary' },
      { id: 'sep-income-2', account: 'account-1', currencyCode: 'EUR', date: '2026-09-10', amount: 20_000, category: 'salary' },
      { id: 'sep-income-3', account: 'account-1', currencyCode: 'EUR', date: '2026-09-20', amount: 20_000, category: 'salary' },
      { id: 'sep-expense-1', account: 'account-1', currencyCode: 'EUR', date: '2026-09-04', amount: -20_000, category: 'food' },
      { id: 'sep-expense-2', account: 'account-1', currencyCode: 'EUR', date: '2026-09-11', amount: -20_000, category: 'food' },
      { id: 'sep-expense-3', account: 'account-1', currencyCode: 'EUR', date: '2026-09-21', amount: -20_000, category: 'food' },
    ];
    const listTransactions = vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
      historicalTransactions.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate));
    const app = await createTestApp(createRepository({ listTransactions }), {
      ...config, actualDataDir: directory, aiEnabled: true, ollamaBaseURL: ollama.url, ollamaModel: 'synthetic-model',
    });
    try {
      const url = '/api/v1/intelligence/findings?startDate=2026-09-01&endDate=2026-09-30';
      const findingsResponse = await app.inject({ method: 'GET', url });
      expect(findingsResponse.statusCode).toBe(200);
      const finding = findingsResponse.json().data.findings.find((item: { type: string }) => item.type === 'expense-change');
      expect(finding).toBeDefined();

      const explained = await app.inject({
        method: 'POST',
        url: '/api/v1/intelligence/explain',
        payload: { findingId: finding.id, startDate: '2026-09-01', endDate: '2026-09-30' },
      });
      expect(explained.statusCode).toBe(200);
      expect(explained.json().data).toMatchObject({
        findingId: finding.id,
        explanation: 'Explicación cualitativa sintética sin cifras nuevas.',
        kind: 'qualitative_explanation',
        source: 'local',
      });

      const unknown = await app.inject({
        method: 'POST', url: '/api/v1/intelligence/explain',
        payload: { findingId: 'fi-v1-not-present', startDate: '2026-09-01', endDate: '2026-09-30' },
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('FINDING_NOT_FOUND');
    } finally {
      await ollama.close();
    }
  });

  it('rejects stale snooze dates before computing any findings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'financial-intelligence-snooze-api-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(createRepository(), { ...config, actualDataDir: directory });
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.parse(today + 'T00:00:00.000Z') - 86_400_000).toISOString().slice(0, 10);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/intelligence/review',
      payload: { findingId: 'fi-v1-not-present', startDate: '2026-10-01', endDate: today, status: 'snoozed', snoozedUntil: yesterday },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_SNOOZE_WINDOW');
  });

  it('surfaces budget deviations only for a full completed calendar month', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'financial-intelligence-budget-window-'));
    temporaryDirectories.push(directory);
    const listTransactions = vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
      transactions.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate));
    const getBudgetMonth = vi.fn(async (month: string) => ({
      month,
      categoryGroups: [{
        id: 'spending', name: 'Gastos', is_income: false,
        categories: [{ id: 'food', name: 'Alimentación', budgeted: 10_000, spent: 50_000 }],
      }],
    }));
    const repository = {
      ...createRepository({ listTransactions }),
      getBudgetMonth,
    } as BudgetRepository & { getBudgetMonth: (month: string) => Promise<ActualBudgetMonthRecord> };
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const partial = await app.inject({
      method: 'GET', url: '/api/v1/intelligence/findings?startDate=2026-09-01&endDate=2026-09-15',
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json().data.findings.some((item: { type: string }) => item.type === 'budget-overspend')).toBe(false);
    expect(partial.json().data.warnings).toContain('Desviaciones de presupuesto no incluidas: el intervalo no cubre un mes natural completo ya cerrado.');
    expect(getBudgetMonth).not.toHaveBeenCalled();

    const complete = await app.inject({
      method: 'GET', url: '/api/v1/intelligence/findings?startDate=2026-09-01&endDate=2026-09-30',
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().data.findings.some((item: { type: string }) => item.type === 'budget-overspend')).toBe(true);
    expect(getBudgetMonth).toHaveBeenCalledWith('2026-09');
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

  it('scans multi-month transaction history in disjoint month windows without duplicates across pages', async () => {
    const rows: BudgetTransaction[] = Array.from({ length: 80 }, (_, index) => {
      const date = index < 40
        ? new Date(Date.UTC(2026, 8, 25 + (index % 6))).toISOString().slice(0, 10)
        : new Date(Date.UTC(2026, 9, 1 + ((index - 40) % 6))).toISOString().slice(0, 10);
      return {
        id: 'month-' + String(index).padStart(3, '0'),
        account: 'account-1',
        currencyCode: 'EUR',
        date,
        amount: -100,
        category: 'food',
      };
    });
    const listTransactions = vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
      rows.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate));
    const app = await createTestApp(createRepository({ listTransactions }));
    const firstPage = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions?startDate=2026-09-25&endDate=2026-10-06&limit=40&offset=0&sortBy=date&order=asc',
    });
    const secondPage = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions?startDate=2026-09-25&endDate=2026-10-06&limit=40&offset=40&sortBy=date&order=asc',
    });

    expect(firstPage.statusCode).toBe(200);
    expect(secondPage.statusCode).toBe(200);
    expect(firstPage.json().pagination.total).toBe(80);
    expect(secondPage.json().pagination.total).toBe(80);
    const firstIds = firstPage.json().data.map((item: BudgetTransaction) => item.id);
    const secondIds = secondPage.json().data.map((item: BudgetTransaction) => item.id);
    const allIds = [...firstIds, ...secondIds];
    const expectedIds = [...rows]
      .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
      .map((transaction) => transaction.id);
    expect(allIds).toEqual(expectedIds);
    expect(new Set(allIds).size).toBe(80);
    expect(listTransactions).toHaveBeenCalledTimes(4);
    expect(listTransactions.mock.calls.slice(0, 2)).toEqual([
      ['account-1', '2026-09-25', '2026-09-30'],
      ['account-1', '2026-10-01', '2026-10-06'],
    ]);
  });

  it('preserves split semantics when child dates cross monthly scan windows', async () => {
    const splitParent: BudgetTransaction = {
      id: 'split-parent-cross-month',
      account: 'account-1',
      currencyCode: 'EUR',
      date: '2026-09-30',
      amount: -1_000,
      is_parent: true,
      subtransactions: [
        { id: 'split-child-september', account: 'account-1', date: '2026-09-30', amount: -400, parent_id: 'split-parent-cross-month', is_child: true },
        { id: 'split-child-october', account: 'account-1', date: '2026-10-01', amount: -600, parent_id: 'split-parent-cross-month', is_child: true },
      ],
    };
    const rows: readonly BudgetTransaction[] = [
      splitParent,
      { id: 'split-child-september', account: 'account-1', currencyCode: 'EUR', date: '2026-09-30', amount: -400, parent_id: splitParent.id, is_child: true },
      { id: 'split-child-october', account: 'account-1', currencyCode: 'EUR', date: '2026-10-01', amount: -600, parent_id: splitParent.id, is_child: true },
      { id: 'independent-october', account: 'account-1', currencyCode: 'EUR', date: '2026-10-02', amount: -200 },
    ];
    const listTransactions = vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
      rows.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate));
    const app = await createTestApp(createRepository({ listTransactions }));
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions?startDate=2026-09-25&endDate=2026-10-06&limit=20&offset=0&sortBy=date&order=asc',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().pagination.total).toBe(3);
    expect(response.json().data.map((item: BudgetTransaction) => item.id)).toEqual([
      'split-child-september',
      'split-child-october',
      'independent-october',
    ]);
    expect(new Set(response.json().data.map((item: BudgetTransaction) => item.id)).size).toBe(3);
    expect(listTransactions).toHaveBeenCalledTimes(2);
    expect(listTransactions.mock.calls).toEqual([
      ['account-1', '2026-09-25', '2026-09-30'],
      ['account-1', '2026-10-01', '2026-10-06'],
    ]);
  });

  it('records a reproducible bounded-page benchmark at 10k/50k/100k synthetic movements', async () => {
    let syntheticTransactions: readonly BudgetTransaction[] = [];
    const listTransactions = vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
      syntheticTransactions.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate));
    const app = await createTestApp(createRepository({ listTransactions }));
    const measurements: Array<{
      records: number;
      medianLatencyMs: number;
      maxObservedHeapDeltaBytes: number;
      repositoryReadsPerRequest: number;
    }> = [];

    for (const size of [10_000, 50_000, 100_000]) {
      // Reverse source order and deliberately share date/amount to exercise the
      // ID tie-breaker rather than relying on insertion order.
      syntheticTransactions = Array.from({ length: size }, (_, index) => ({
        id: 'synthetic-' + String(size - index - 1).padStart(6, '0'),
        account: 'account-1',
        currencyCode: 'EUR',
        date: '2026-' + String((index % 12) + 1).padStart(2, '0') + '-15',
        amount: -100,
        category: 'food',
      }));
      const latencies: number[] = [];
      let maxObservedHeapDeltaBytes = 0;
      for (let repeat = 0; repeat < 3; repeat += 1) {
        listTransactions.mockClear();
        const heapBefore = process.memoryUsage().heapUsed;
        const started = performance.now();
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/transactions?startDate=2026-01-01&endDate=2026-12-31&limit=20&offset=0&sortBy=amount&order=asc',
        });
        latencies.push(performance.now() - started);
        maxObservedHeapDeltaBytes = Math.max(
          maxObservedHeapDeltaBytes,
          process.memoryUsage().heapUsed - heapBefore,
        );
        expect(response.statusCode).toBe(200);
        expect(response.json().pagination.total).toBe(size);
        expect(response.json().data).toHaveLength(20);
        const expectedFirstPage = [...syntheticTransactions]
          .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
          .slice(0, 20)
          .map((transaction) => transaction.id);
        expect(response.json().data.map((item: BudgetTransaction) => item.id)).toEqual(expectedFirstPage);
        expect(listTransactions).toHaveBeenCalledTimes(12);
      }
      latencies.sort((left, right) => left - right);
      measurements.push({
        records: size,
        medianLatencyMs: Number(latencies[1]!.toFixed(2)),
        maxObservedHeapDeltaBytes,
        repositoryReadsPerRequest: 12,
      });
    }

    // Regression ceilings are deliberately generous multiples of the recorded baseline
    // so ordinary CI scheduling variance does not cause false failures.
    expect(measurements.every((measurement) => measurement.medianLatencyMs < 3_000)).toBe(true);
    expect(measurements.every((measurement) => measurement.maxObservedHeapDeltaBytes < 128 * 1024 * 1024)).toBe(true);

    console.info('TRANSACTION_PAGINATION_BENCHMARK ' + JSON.stringify({
      node: process.version,
      syntheticOnly: true,
      measurements,
      regressionCeilings: { medianLatencyMs: 3_000, maxObservedHeapDeltaBytes: 128 * 1024 * 1024 },
    }));

    const overBudgetRows: readonly BudgetTransaction[] = Array.from({ length: 100_001 }, (_, index) => ({
      id: 'over-budget-' + String(index).padStart(6, '0'),
      account: 'account-1',
      currencyCode: 'EUR',
      date: '2026-09-01',
      amount: -100,
      category: 'food',
    }));
    const overBudgetReads = vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
      startDate === '2026-09-01' && endDate === '2026-09-30' ? overBudgetRows : []);
    const broadApp = await createTestApp(createRepository({ listTransactions: overBudgetReads }));
    const overBudget = await broadApp.inject({
      method: 'GET',
      url: '/api/v1/transactions?startDate=2026-09-01&endDate=2026-10-31&limit=20&offset=0',
    });
    expect(overBudget.statusCode).toBe(422);
    expect(overBudget.json().error.code).toBe('TRANSACTION_QUERY_TOO_BROAD');
    expect(overBudgetReads).toHaveBeenCalledTimes(1);
    expect(overBudgetReads).toHaveBeenCalledWith('account-1', '2026-09-01', '2026-09-30');
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

  it('blocks OFX preview and commit when the declared currency differs from the destination account', async () => {
    const importTransactions = vi.fn(async (): Promise<ActualImportResult> => ({ errors: [], added: ['should-not-write'], updated: [] }));
    const repository = Object.assign(createRepository(), { importTransactions }) as BudgetRepository & {
      importTransactions: typeof importTransactions;
    };
    const app = await createTestApp(repository);
    const payload = {
      accountId: 'account-1',
      sourceFormat: 'ofx',
      sourceCurrencyCode: 'USD',
      allowUnverifiedCurrency: false,
      records: [{ date: '2026-10-12', amount: -1299, payee_name: 'Compra', imported_id: 'personal-budget-ofx:test-1' }],
    };
    const preview = await app.inject({ method: 'POST', url: '/api/v1/import/preview', payload });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().error.code).toBe('IMPORT_CURRENCY_MISMATCH');
    const commit = await app.inject({ method: 'POST', url: '/api/v1/import/commit', payload });
    expect(commit.statusCode).toBe(409);
    expect(commit.json().error.code).toBe('IMPORT_CURRENCY_MISMATCH');
    expect(importTransactions).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation when OFX or destination currency cannot be verified', async () => {
    const importTransactions = vi.fn(async (
      _accountId: string,
      _records: readonly ActualImportRecord[],
      options?: { readonly dryRun?: boolean },
    ): Promise<ActualImportResult> => ({
      errors: [], added: [options?.dryRun ? 'preview-id' : 'saved-id'], updated: [],
    }));
    const repository = Object.assign(createRepository(), { importTransactions }) as BudgetRepository & {
      importTransactions: typeof importTransactions;
    };
    const app = await createTestApp(repository);
    const payload = {
      accountId: 'account-1',
      sourceFormat: 'ofx',
      records: [{ date: '2026-10-12', amount: -1299, payee_name: 'Compra', imported_id: 'personal-budget-ofx:test-2' }],
    };
    const unverified = await app.inject({ method: 'POST', url: '/api/v1/import/preview', payload });
    expect(unverified.statusCode).toBe(422);
    expect(unverified.json().error.code).toBe('IMPORT_CURRENCY_UNVERIFIED');
    expect(importTransactions).not.toHaveBeenCalled();

    const acknowledged = await app.inject({
      method: 'POST',
      url: '/api/v1/import/preview',
      payload: { ...payload, allowUnverifiedCurrency: true },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().data).toMatchObject({ dryRun: true, added: 1 });
    expect(importTransactions).toHaveBeenCalledWith('account-1', expect.any(Array), { dryRun: true });
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
    const updateTransactionCategoriesBatch = vi.fn(async (
      changes: readonly TransactionCategoryBatchChange[],
    ): Promise<TransactionCategoryBatchResult> => ({
      requested: changes.length,
      updatedTransactionIds: changes.map((change) => change.transactionId),
      persisted: true,
    }));
    const listTransactions = vi.fn(async () => transactions);
    const repository = createRepository({ listTransactions, updateTransactionCategoriesBatch });
    const app = await createTestApp(repository);
    const body = {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      transactions: [{ transactionId: 'expense-1', categoryId: 'food' }],
    };
    const preview = await app.inject({ method: 'POST', url: '/api/v1/insights/categorize', payload: { ...body, commit: false } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toMatchObject({ preview: true, changes: 1 });
    expect(updateTransactionCategoriesBatch).not.toHaveBeenCalled();

    const baseline = preview.json().data.baseline as { transactionId: string; expectedCategoryId: string | null }[];
    const commit = await app.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: {
        ...body,
        commit: true,
        transactions: body.transactions.map((change) => ({
          ...change,
          expectedCategoryId: baseline.find((entry) => entry.transactionId === change.transactionId)!.expectedCategoryId,
        })),
      },
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().data).toMatchObject({ preview: false, changes: 1 });
    expect(updateTransactionCategoriesBatch).toHaveBeenCalledTimes(1);
    expect(updateTransactionCategoriesBatch).toHaveBeenCalledWith([{
      transactionId: 'expense-1', categoryId: 'food', expectedCategoryId: 'food',
      accountId: 'account-1', date: '2026-10-02',
    }]);
  });

  it('returns exact applied and pending ids after a partial category batch', async () => {
    const secondExpense: BudgetTransaction = {
      id: 'expense-2', account: 'account-1', currencyCode: 'EUR',
      date: '2026-10-03', amount: -2_500, category: null,
    };
    const listTransactions = vi.fn(async () => [...transactions, secondExpense]);
    const updateTransactionCategoriesBatch = vi.fn(async (
      changes: readonly TransactionCategoryBatchChange[],
    ): Promise<TransactionCategoryBatchResult> => ({
      requested: changes.length,
      updatedTransactionIds: ['expense-1'],
      failedTransactionId: 'expense-2',
      persisted: false,
    }));
    const app = await createTestApp(createRepository({ listTransactions, updateTransactionCategoriesBatch }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/insights/categorize',
      payload: {
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        commit: true,
        transactions: [
          { transactionId: 'expense-1', categoryId: 'food', expectedCategoryId: 'food' },
          { transactionId: 'expense-2', categoryId: 'food', expectedCategoryId: null },
        ],
      },
    });

    expect(response.statusCode).toBe(207);
    expect(response.json().data).toMatchObject({
      preview: false,
      requested: 2,
      applied: 1,
      appliedTransactionIds: ['expense-1'],
      pendingTransactionIds: ['expense-2'],
      failedTransactionId: 'expense-2',
      persisted: false,
      partial: true,
    });
    expect(updateTransactionCategoriesBatch).toHaveBeenCalledTimes(1);
  });

  it('validates all categories before invoking a category batch write', async () => {
    const secondExpense: BudgetTransaction = {
      id: 'expense-2', account: 'account-1', currencyCode: 'EUR',
      date: '2026-10-03', amount: -2_500, category: null,
    };
    const updateTransactionCategoriesBatch = vi.fn(async (
      changes: readonly TransactionCategoryBatchChange[],
    ): Promise<TransactionCategoryBatchResult> => ({
      requested: changes.length,
      updatedTransactionIds: changes.map((change) => change.transactionId),
      persisted: true,
    }));
    const app = await createTestApp(createRepository({
      listTransactions: vi.fn(async () => [...transactions, secondExpense]),
      updateTransactionCategoriesBatch,
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/insights/categorize',
      payload: {
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        commit: true,
        transactions: [
          { transactionId: 'expense-1', categoryId: 'food', expectedCategoryId: 'food' },
          { transactionId: 'expense-2', categoryId: 'not-an-expense-category', expectedCategoryId: null },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_CATEGORY');
    expect(updateTransactionCategoriesBatch).not.toHaveBeenCalled();
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
      payload: { startDate: '2026-10-01', endDate: '2026-10-31', commit: true, transactions: [{ transactionId: 'missing', categoryId: 'food', expectedCategoryId: null }] },
    });
    expect(unknownTransaction.statusCode).toBe(400);
    expect(unknownTransaction.json().error.code).toBe('INVALID_TRANSACTION');

    const incomeCategory = await app.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: { startDate: '2026-10-01', endDate: '2026-10-31', commit: true, transactions: [{ transactionId: 'expense-1', categoryId: 'salary', expectedCategoryId: 'food' }] },
    });
    expect(incomeCategory.statusCode).toBe(400);
    expect(incomeCategory.json().error.code).toBe('INVALID_CATEGORY');
    expect(updateTransactionCategory).not.toHaveBeenCalled();

    const withoutCapability = await createTestApp(createRepository({ listTransactions }));
    const unsupported = await withoutCapability.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: { startDate: '2026-10-01', endDate: '2026-10-31', commit: true, transactions: [{ transactionId: 'expense-1', categoryId: 'food', expectedCategoryId: 'food' }] },
    });
    expect(unsupported.statusCode).toBe(503);
    expect(unsupported.json().error.code).toBe('TRANSACTION_BATCH_UPDATE_NOT_SUPPORTED');
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


  it('persists a global account scope and applies it consistently to reports and movements', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'budget-account-scope-api-'));
    temporaryDirectories.push(directory);
    const scopedAccounts: readonly BudgetAccount[] = [
      { id: 'account-1', name: 'Cuenta corriente', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 200_000 },
      { id: 'account-2', name: 'Ahorro', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 45_000 },
      { id: 'account-closed', name: 'Cuenta cerrada', currencyCode: 'EUR', closed: true, offBudget: false, currentBalanceMinor: 0 },
    ];
    const txByAccount: Record<string, readonly BudgetTransaction[]> = {
      'account-1': [
        { id: 'main-income', account: 'account-1', currencyCode: 'EUR', date: '2026-10-01', amount: 200_000, category: 'salary' },
        { id: 'main-expense', account: 'account-1', currencyCode: 'EUR', date: '2026-10-02', amount: -10_000, category: 'food' },
        { id: 'internal-transfer', account: 'account-1', currencyCode: 'EUR', date: '2026-10-03', amount: -50_000, transfer_id: 'transfer-1' },
      ],
      'account-2': [
        { id: 'savings-income', account: 'account-2', currencyCode: 'EUR', date: '2026-10-04', amount: 50_000, category: 'salary' },
        { id: 'savings-expense', account: 'account-2', currencyCode: 'EUR', date: '2026-10-05', amount: -5_000, category: 'food' },
        { id: 'transfer-to-savings', account: 'account-2', currencyCode: 'EUR', date: '2026-10-03', amount: 50_000, transfer_id: 'transfer-1' },
      ],
    };
    const listTransactions = vi.fn(async (accountId: string) => txByAccount[accountId] ?? []);
    const repository = createRepository({
      listAccounts: vi.fn(async () => scopedAccounts),
      listTransactions,
    });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });

    const initial = await app.inject({ method: 'GET', url: '/api/v1/preferences/accounts' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data).toMatchObject({
      mode: 'all', accountIds: [], activeAccountIds: ['account-1', 'account-2'],
      label: 'Todas las cuentas abiertas (2)',
    });

    const allSummary = await app.inject({
      method: 'GET', url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(allSummary.statusCode).toBe(200);
    expect(allSummary.json().data).toMatchObject({
      incomeMinor: 250_000, expenseMinor: 15_000, savingsMinor: 235_000, excludedTransferCount: 2,
      accountScope: { mode: 'all', accountIds: ['account-1', 'account-2'] },
    });

    const selected = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['account-2'] },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().data).toMatchObject({
      mode: 'selected', accountIds: ['account-2'], activeAccountIds: ['account-2'], label: 'Cuentas seleccionadas: Ahorro',
    });

    listTransactions.mockClear();
    const report = await app.inject({
      method: 'GET', url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().data).toMatchObject({
      incomeMinor: 50_000, expenseMinor: 5_000, savingsMinor: 45_000, excludedTransferCount: 1,
      accountScope: { mode: 'selected', accountIds: ['account-2'], accountNames: ['Ahorro'] },
    });
    expect(listTransactions).toHaveBeenCalledTimes(1);
    expect(listTransactions).toHaveBeenCalledWith('account-2', '2026-10-01', '2026-10-31');

    listTransactions.mockClear();
    const movements = await app.inject({
      method: 'GET', url: '/api/v1/transactions?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(movements.statusCode).toBe(200);
    expect(movements.json().data.map((transaction: { id: string }) => transaction.id)).toEqual(['savings-expense', 'savings-income', 'transfer-to-savings']);
    expect(movements.json().accountScope).toMatchObject({ accountIds: ['account-2'], label: 'Cuentas seleccionadas: Ahorro' });
    expect(listTransactions).toHaveBeenCalledTimes(1);
    expect(listTransactions).toHaveBeenCalledWith('account-2', '2026-10-01', '2026-10-31');

    const attemptsToExpand = await app.inject({
      method: 'GET', url: '/api/v1/transactions?accountId=account-1&startDate=2026-10-01&endDate=2026-10-31',
    });
    const multiScope = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['account-1', 'account-2'] },
    });
    expect(multiScope.statusCode).toBe(200);
    const multiReport = await app.inject({
      method: 'GET', url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(multiReport.json().data).toMatchObject({
      incomeMinor: 250_000, expenseMinor: 15_000, excludedTransferCount: 2,
      accountScope: { mode: 'selected', accountIds: ['account-1', 'account-2'] },
    });

    expect(attemptsToExpand.statusCode).toBe(400);
    expect(attemptsToExpand.json().error.code).toBe('ACCOUNT_OUTSIDE_SCOPE');
    expect(attemptsToExpand.json().error.message).toMatch(/no puede ampliar/i);
  });

  it('rejects unknown or closed accounts and treats an empty selection as zero accounts, not all', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'budget-empty-account-scope-'));
    temporaryDirectories.push(directory);
    const scopedAccounts: readonly BudgetAccount[] = [
      { id: 'account-1', name: 'Cuenta corriente', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 200_000 },
      { id: 'account-closed', name: 'Cuenta cerrada', currencyCode: 'EUR', closed: true, offBudget: false, currentBalanceMinor: 0 },
    ];
    const repository = createRepository({
      listAccounts: vi.fn(async () => scopedAccounts),
      listTransactions: vi.fn(async () => transactions),
    });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });

    for (const accountId of ['account-closed', 'not-in-budget']) {
      const invalid = await app.inject({
        method: 'PUT', url: '/api/v1/preferences/accounts',
        payload: { mode: 'selected', accountIds: [accountId] },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('INVALID_ACCOUNT_SCOPE');
    }

    const empty = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: [] },
    });
    expect(empty.statusCode).toBe(200);
    const report = await app.inject({
      method: 'GET', url: '/api/v1/reports/summary?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().data).toMatchObject({
      incomeMinor: 0, expenseMinor: 0, savingsMinor: 0, transactionCount: 0,
      accountScope: { mode: 'selected', accountIds: [], accountNames: [], label: 'Ninguna cuenta seleccionada' },
    });
    const movementResult = await app.inject({
      method: 'GET', url: '/api/v1/transactions?startDate=2026-10-01&endDate=2026-10-31',
    });
    expect(movementResult.statusCode).toBe(200);
    expect(movementResult.json().data).toEqual([]);
    expect(movementResult.json().pagination.total).toBe(0);
  });

  it('applies the selected scope to the assistant, recurring insights, suggestions and forecasts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'budget-account-scope-all-surfaces-'));
    temporaryDirectories.push(directory);
    const ollama = await createOllamaFixture();
    const scopedAccounts: readonly BudgetAccount[] = [
      { id: 'account-1', name: 'Cuenta corriente', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 200_000 },
      { id: 'account-2', name: 'Ahorro', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 45_000 },
    ];
    const txByAccount: Record<string, readonly BudgetTransaction[]> = {
      'account-1': transactions,
      'account-2': [
        { id: 'scoped-income', account: 'account-2', currencyCode: 'EUR', date: '2026-10-04', amount: 50_000, category: 'salary' },
        { id: 'scoped-expense', account: 'account-2', currencyCode: 'EUR', date: '2026-10-05', amount: -5_000, category: 'food' },
        { id: 'scoped-expense-old', account: 'account-2', currencyCode: 'EUR', date: '2026-09-05', amount: -5_000, category: 'food' },
      ],
    };
    const listTransactions = vi.fn(async (accountId: string) => txByAccount[accountId] ?? []);
    const repository = createRepository({
      listAccounts: vi.fn(async () => scopedAccounts),
      listTransactions,
    });
    const app = await createTestApp(repository, {
      ...config, actualDataDir: directory, aiEnabled: true, ollamaBaseURL: ollama.url, ollamaModel: 'synthetic-model',
    });
    try {
      const saved = await app.inject({
        method: 'PUT', url: '/api/v1/preferences/accounts',
        payload: { mode: 'selected', accountIds: ['account-2'] },
      });
      expect(saved.statusCode).toBe(200);

      const assistant = await app.inject({
        method: 'POST', url: '/api/v1/assistant/chat',
        payload: {
          question: 'Resume octubre', startDate: '2026-10-01', endDate: '2026-10-31',
          previousStartDate: '2026-09-01', previousEndDate: '2026-09-30',
        },
      });
      expect(assistant.statusCode).toBe(200);
      expect(assistant.json().data.summary).toMatchObject({ incomeMinor: 50_000, expenseMinor: 5_000 });
      expect(assistant.json().data.accountScope).toMatchObject({ accountIds: ['account-2'] });
      expect(listTransactions.mock.calls.every((call) => call[0] === 'account-2')).toBe(true);

      listTransactions.mockClear();
      const recurring = await app.inject({
        method: 'GET', url: '/api/v1/insights/recurring?startDate=2026-01-01&endDate=2026-10-31',
      });
      expect(recurring.statusCode).toBe(200);
      expect(recurring.json().accountScope).toMatchObject({ accountIds: ['account-2'] });
      expect(listTransactions.mock.calls.every((call) => call[0] === 'account-2')).toBe(true);

      listTransactions.mockClear();
      const suggestions = await app.inject({
        method: 'GET', url: '/api/v1/insights/category-suggestions?startDate=2026-10-01&endDate=2026-10-31',
      });
      expect(suggestions.statusCode).toBe(200);
      expect(suggestions.json().accountScope).toMatchObject({ accountIds: ['account-2'] });
      expect(listTransactions.mock.calls.every((call) => call[0] === 'account-2')).toBe(true);

      listTransactions.mockClear();
      const forecast = await app.inject({
        method: 'POST', url: '/api/v1/forecasts/simulate',
        payload: {
          startDate: '2026-06-01', endDate: '2026-10-31', horizonMonths: 3,
          scenario: { type: 'income_change', percent: 0 },
        },
      });
      expect(forecast.statusCode).toBe(200);
      expect(forecast.json().data.accountScope).toMatchObject({ accountIds: ['account-2'] });
      expect(listTransactions.mock.calls.every((call) => call[0] === 'account-2')).toBe(true);
    } finally {
      await ollama.close();
    }
  });


  it('previews and commits a verified same-currency transfer through Actual linked payees', async () => {
    const transferAccounts: readonly BudgetAccount[] = [
      { id: 'account-1', name: 'Cuenta corriente', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 200_000 },
      { id: 'account-2', name: 'Cuenta de ahorro', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 100_000 },
    ];
    const importTransactions = vi.fn(async (
      _accountId: string,
      _records: readonly ActualImportRecord[],
      options?: { readonly dryRun?: boolean },
    ): Promise<ActualImportResult> => ({
      errors: [], added: [options?.dryRun ? 'preview-transfer' : 'linked-transfer'], updated: [],
    }));
    const listTransferPayees = vi.fn(async () => [{ name: 'Transfer: Cuenta de ahorro', accountId: 'account-2' }]);
    const repository = Object.assign(
      createRepository({ listAccounts: vi.fn(async () => transferAccounts) }),
      { importTransactions, listTransferPayees },
    ) as BudgetRepository & { importTransactions: typeof importTransactions; listTransferPayees: typeof listTransferPayees };
    const dataDir = await mkdtemp(join(tmpdir(), 'personal-budget-transfer-test-'));
    temporaryDirectories.push(dataDir);
    const app = await createTestApp(repository, { ...config, actualDataDir: dataDir });
    const payload = {
      sourceAccountId: 'account-1', destinationAccountId: 'account-2', date: '2026-10-15',
      amountMinor: 12_500, importedId: 'transfer-idempotency-key',
    };

    const preview = await app.inject({ method: 'POST', url: '/api/v1/transfers/preview', payload });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toMatchObject({ dryRun: true, linkedTransfer: true, sourceAccountId: 'account-1', destinationAccountId: 'account-2' });
    expect(importTransactions).toHaveBeenNthCalledWith(1, 'account-1', [
      expect.objectContaining({
        amount: -12_500, payee_name: 'Transfer: Cuenta de ahorro',
        imported_payee: 'Transfer: Cuenta de ahorro', imported_id: 'transfer-idempotency-key',
      }),
    ], { dryRun: true });

    const commit = await app.inject({ method: 'POST', url: '/api/v1/transfers/commit', payload });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().data).toMatchObject({ dryRun: false, linkedTransfer: true });
    expect(importTransactions).toHaveBeenNthCalledWith(2, 'account-1', [
      expect.objectContaining({ amount: -12_500, payee_name: 'Transfer: Cuenta de ahorro', imported_id: 'transfer-idempotency-key' }),
    ], { dryRun: false });
  });

  it('rejects transfers with unsupported currencies, mismatched budget scope or an excluded account', async () => {
    const transferAccounts: readonly BudgetAccount[] = [
      { id: 'account-1', name: 'Cuenta corriente', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 200_000 },
      { id: 'account-2', name: 'Cuenta externa', currencyCode: 'GBP', closed: false, offBudget: false, currentBalanceMinor: 100_000 },
    ];
    const importTransactions = vi.fn(async (): Promise<ActualImportResult> => ({ errors: [], added: ['unexpected'], updated: [] }));
    const listTransferPayees = vi.fn(async () => [{ name: 'Transfer: Cuenta externa', accountId: 'account-2' }]);
    const repository = Object.assign(
      createRepository({ listAccounts: vi.fn(async () => transferAccounts) }),
      { importTransactions, listTransferPayees },
    ) as BudgetRepository & { importTransactions: typeof importTransactions; listTransferPayees: typeof listTransferPayees };
    const dataDir = await mkdtemp(join(tmpdir(), 'personal-budget-transfer-guards-'));
    temporaryDirectories.push(dataDir);
    const app = await createTestApp(repository, { ...config, actualDataDir: dataDir });
    const payload = {
      sourceAccountId: 'account-1', destinationAccountId: 'account-2', date: '2026-10-15',
      amountMinor: 12_500, importedId: 'transfer-guard-id',
    };

    const currencyMismatch = await app.inject({ method: 'POST', url: '/api/v1/transfers/preview', payload });
    expect(currencyMismatch.statusCode).toBe(422);
    expect(currencyMismatch.json().error.code).toBe('TRANSFER_CURRENCY_MISMATCH');
    expect(importTransactions).not.toHaveBeenCalled();

    const scopeResponse = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['account-1'] },
    });
    expect(scopeResponse.statusCode).toBe(200);
    const outsideScope = await app.inject({ method: 'POST', url: '/api/v1/transfers/preview', payload });
    expect(outsideScope.statusCode).toBe(400);
    expect(outsideScope.json().error.code).toBe('ACCOUNT_OUTSIDE_SCOPE');
    expect(importTransactions).not.toHaveBeenCalled();
  });


  it('edits only validated ordinary transactions and rejects a resulting amount/category mismatch', async () => {
    const listTransactions = vi.fn(async () => transactions);
    const updateTransaction = vi.fn(async (id: string, fields: TransactionUpdate) => { void id; void fields; });
    const updateTransactionSafely = vi.fn(async (
      id: string,
      _accountId: string,
      _beforeDate: string,
      fields: TransactionStructureUpdate,
    ): Promise<TransactionWriteResult> => {
      await updateTransaction(id, fields as TransactionUpdate);
      return { persisted: true, verified: true };
    });
    const repository = createRepository({ listTransactions, updateTransactionSafely }) as BudgetRepository;
    const appConfig = { ...config, actualDataDir: await mkdtemp(join(tmpdir(), 'personal-budget-edit-test-')) };
    temporaryDirectories.push(appConfig.actualDataDir);
    const app = await createTestApp(repository, appConfig);

    const response = await app.inject({
      method: 'PUT', url: '/api/v1/transactions/expense-1',
      payload: {
        accountId: 'account-1', startDate: '2026-10-01', endDate: '2026-10-31',
        changes: { date: '2026-10-04', amount: -12_000, category: 'food', notes: 'Updated locally', cleared: true },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ transactionId: 'expense-1', persisted: true });
    expect(updateTransaction).toHaveBeenCalledWith('expense-1', {
      date: '2026-10-04', amount: -12_000, category: 'food', notes: 'Updated locally', cleared: true,
    });

    const mismatch = await app.inject({
      method: 'PUT', url: '/api/v1/transactions/expense-1',
      payload: {
        accountId: 'account-1', startDate: '2026-10-01', endDate: '2026-10-31',
        changes: { amount: 12_000 },
      },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('CATEGORY_AMOUNT_MISMATCH');
    expect(updateTransaction).toHaveBeenCalledTimes(1);

    const transfer = await app.inject({
      method: 'PUT', url: '/api/v1/transactions/transfer-1',
      payload: {
        accountId: 'account-1', startDate: '2026-10-01', endDate: '2026-10-31',
        changes: { notes: 'Do not split transfer pair' },
      },
    });
    expect(transfer.statusCode).toBe(409);
    expect(transfer.json().error.code).toBe('TRANSFER_COUNTERPART_NOT_AVAILABLE');
    expect(updateTransaction).toHaveBeenCalledTimes(1);
  });

  it('updates both verified legs of a transfer and refuses direction reversal', async () => {
    const pairAccounts: readonly BudgetAccount[] = [
      ...accounts,
      { id: 'account-2', name: 'Cuenta de ahorro', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 50_000 },
    ];
    const pairTransactions: readonly BudgetTransaction[] = [
      { id: 'pair-out', account: 'account-1', currencyCode: 'EUR', date: '2026-10-02', amount: -50_000, transfer_id: 'pair-in' },
      { id: 'pair-in', account: 'account-2', currencyCode: 'EUR', date: '2026-10-02', amount: 50_000, transfer_id: 'pair-out' },
    ];
    const listTransactions = vi.fn(async (accountId: string) => pairTransactions.filter((item) => item.account === accountId));
    const updateTransaction = vi.fn(async (id: string, fields: TransactionUpdate) => { void id; void fields; });
    const updateTransactionSafely = vi.fn(async (
      id: string,
      _accountId: string,
      _beforeDate: string,
      fields: TransactionStructureUpdate,
    ): Promise<TransactionWriteResult> => {
      await updateTransaction(id, fields as TransactionUpdate);
      return { persisted: true, verified: true };
    });
    const repository = createRepository({
      listAccounts: vi.fn(async () => pairAccounts),
      listTransactions,
      updateTransaction,
      updateTransactionSafely,
    });
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-transfer-edit-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });

    const updated = await app.inject({
      method: 'PUT', url: '/api/v1/transactions/pair-out',
      payload: {
        accountId: 'account-1', startDate: '2026-10-01', endDate: '2026-10-31', syncTransferDate: true,
        changes: { date: '2026-10-04', amount: -60_000 },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({
      transactionId: 'pair-out', counterpartTransactionId: 'pair-in',
      updatedTransactionIds: ['pair-out', 'pair-in'], verified: true, partial: false,
    });
    expect(updateTransaction).toHaveBeenNthCalledWith(1, 'pair-out', { date: '2026-10-04', amount: -60_000 });
    expect(updateTransaction).toHaveBeenNthCalledWith(2, 'pair-in', { date: '2026-10-04', amount: 60_000 });
    expect(updateTransactionSafely).toHaveBeenCalledTimes(2);

    const countBeforeReverse = updateTransaction.mock.calls.length;
    const reverse = await app.inject({
      method: 'PUT', url: '/api/v1/transactions/pair-out',
      payload: {
        accountId: 'account-1', startDate: '2026-10-01', endDate: '2026-10-31',
        changes: { amount: 60_000 },
      },
    });
    expect(reverse.statusCode).toBe(400);
    expect(reverse.json().error.code).toBe('TRANSFER_DIRECTION_CHANGE_NOT_ALLOWED');
    expect(updateTransaction).toHaveBeenCalledTimes(countBeforeReverse);
  });

  it('keeps transfer dates independent by default while verifying shared notes on both legs', async () => {
    const pairAccounts: readonly BudgetAccount[] = [
      ...accounts,
      { id: 'account-2', name: 'Cuenta de ahorro', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 50_000 },
    ];
    const pairTransactions: readonly BudgetTransaction[] = [
      { id: 'pair-out', account: 'account-1', currencyCode: 'EUR', date: '2026-10-02', amount: -50_000, transfer_id: 'pair-in' },
      { id: 'pair-in', account: 'account-2', currencyCode: 'EUR', date: '2026-11-03', amount: 50_000, transfer_id: 'pair-out' },
    ];
    const listTransactions = vi.fn(async (accountId: string, startDate: string, endDate: string) => pairTransactions.filter((item) => item.account === accountId && item.date >= startDate && item.date <= endDate));
    const updateTransaction = vi.fn(async (id: string, fields: TransactionUpdate) => { void id; void fields; });
    const updateTransactionSafely = vi.fn(async (
      id: string,
      _accountId: string,
      _beforeDate: string,
      fields: TransactionStructureUpdate,
    ): Promise<TransactionWriteResult> => {
      await updateTransaction(id, fields as TransactionUpdate);
      return { persisted: true, verified: true };
    });
    const repository = createRepository({
      listAccounts: vi.fn(async () => pairAccounts),
      listTransactions,
      updateTransaction,
      updateTransactionSafely,
    });
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-transfer-date-semantics-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });

    const response = await app.inject({
      method: 'PUT', url: '/api/v1/transactions/pair-out',
      payload: {
        accountId: 'account-1', startDate: '2026-10-01', endDate: '2026-10-31',
        changes: { date: '2026-10-04', notes: 'Nota compartida', cleared: true },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      updatedTransactionIds: ['pair-out', 'pair-in'], verified: true, partial: false,
    });
    expect(updateTransaction).toHaveBeenNthCalledWith(1, 'pair-out', {
      date: '2026-10-04', notes: 'Nota compartida', cleared: true,
    });
    expect(updateTransaction).toHaveBeenNthCalledWith(2, 'pair-in', { notes: 'Nota compartida' });
    expect(updateTransactionSafely).toHaveBeenCalledTimes(2);
    expect(updateTransactionSafely).toHaveBeenNthCalledWith(2, 'pair-in', 'account-2', '2026-11-03', { notes: 'Nota compartida' });
  });

  it('updates a split child through its parent while preserving all child IDs and the parent sum', async () => {
    const parent: BudgetTransaction = {
      id: 'split-parent',
      account: 'account-1',
      currencyCode: 'EUR',
      date: '2026-10-02',
      amount: -5_000,
      is_parent: true,
      subtransactions: [
        { id: 'split-food', account: 'account-1', date: '2026-10-02', amount: -2_000, parent_id: 'split-parent', is_child: true, category: 'food' },
        { id: 'split-other', account: 'account-1', date: '2026-10-02', amount: -3_000, parent_id: 'split-parent', is_child: true },
      ],
    };
    const updateTransaction = vi.fn(async (id: string, fields: TransactionUpdate) => { void id; void fields; });
    const updateTransactionSafely = vi.fn(async (
      id: string,
      _accountId: string,
      _beforeDate: string,
      fields: TransactionStructureUpdate,
    ): Promise<TransactionWriteResult> => {
      await updateTransaction(id, fields as TransactionUpdate);
      return { persisted: true, verified: true };
    });
    const repository = createRepository({
      listTransactions: vi.fn(async (accountId: string) => accountId === 'account-1' ? [parent] : []),
      updateTransaction,
      updateTransactionSafely,
    });
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-split-edit-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });

    const response = await app.inject({
      method: 'PUT', url: '/api/v1/transactions/split-food',
      payload: {
        accountId: 'account-1', startDate: '2026-10-01', endDate: '2026-10-31',
        changes: { amount: -2_500, notes: 'Ajuste sintético' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ transactionId: 'split-food', parentTransactionId: 'split-parent', parentAmount: -5_500, verified: true });
    expect(updateTransaction).toHaveBeenCalledOnce();
    expect(updateTransactionSafely).toHaveBeenCalledOnce();
    const [parentId, fields] = updateTransaction.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(parentId).toBe('split-parent');
    expect(fields.amount).toBe(-5_500);
    const children = fields.subtransactions as BudgetTransaction[];
    expect(children.map((child) => child.id)).toEqual(['split-food', 'split-other']);
    expect(children.map((child) => child.amount)).toEqual([-2_500, -3_000]);
    expect(children.reduce((sum, child) => sum + child.amount, 0)).toBe(fields.amount);
    expect(children[0]).toMatchObject({ parent_id: 'split-parent', is_child: true, notes: 'Ajuste sintético' });
  });

  it('reports a partial transfer write if Actual confirms only the first leg', async () => {
    const pairAccounts: readonly BudgetAccount[] = [
      ...accounts,
      { id: 'account-2', name: 'Cuenta de ahorro', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 50_000 },
    ];
    const pairTransactions: readonly BudgetTransaction[] = [
      { id: 'pair-out', account: 'account-1', date: '2026-10-02', amount: -50_000, transfer_id: 'pair-in' },
      { id: 'pair-in', account: 'account-2', date: '2026-10-02', amount: 50_000, transfer_id: 'pair-out' },
    ];
    const updateTransactionSafely = vi.fn(async (id: string) => ({ persisted: id === 'pair-out', verified: id === 'pair-out' }));
    const repository = Object.assign(createRepository({
      listAccounts: vi.fn(async () => pairAccounts),
      listTransactions: vi.fn(async (accountId: string) => pairTransactions.filter((item) => item.account === accountId)),
    }), { updateTransactionSafely }) as BudgetRepository;
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-transfer-partial-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const response = await app.inject({
      method: 'PUT', url: '/api/v1/transactions/pair-out',
      payload: {
        accountId: 'account-1', startDate: '2026-10-01', endDate: '2026-10-31',
        changes: { amount: -60_000 },
      },
    });
    expect(response.statusCode).toBe(207);
    expect(response.json().data).toMatchObject({
      updatedTransactionIds: ['pair-out'], failedTransactionId: 'pair-in', persisted: true, verified: false, partial: true,
    });
  });

  it('returns explicit partial outcomes for category batches and prevalidates transfer rows', async () => {
    const batchTransactions: readonly BudgetTransaction[] = [
      ...transactions,
      { id: 'expense-2', account: 'account-1', currencyCode: 'EUR', date: '2026-10-03', amount: -3_000, category: null },
    ];
    const listTransactions = vi.fn(async () => batchTransactions);
    const updateTransactionCategoriesBatch = vi.fn(async (changes: readonly TransactionCategoryBatchChange[]): Promise<TransactionCategoryBatchResult> => ({
      requested: changes.length,
      updatedTransactionIds: [changes[0]!.transactionId],
      ...(changes[1] ? { failedTransactionId: changes[1].transactionId } : {}),
      persisted: true,
    }));
    const repository = Object.assign(createRepository({ listTransactions }), { updateTransactionCategoriesBatch }) as BudgetRepository;
    const batchDataDirectory = await mkdtemp(join(tmpdir(), 'personal-budget-batch-test-'));
    temporaryDirectories.push(batchDataDirectory);
    const app = await createTestApp(repository, { ...config, actualDataDir: batchDataDirectory });

    const partial = await app.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: {
        startDate: '2026-10-01', endDate: '2026-10-31', commit: true,
        transactions: [
          { transactionId: 'expense-1', categoryId: 'food', expectedCategoryId: 'food' },
          { transactionId: 'expense-2', categoryId: 'food', expectedCategoryId: null },
        ],
      },
    });
    expect(partial.statusCode).toBe(207);
    expect(partial.json().data).toMatchObject({
      requested: 2, applied: 1, appliedTransactionIds: ['expense-1'],
      failedTransactionId: 'expense-2', persisted: true, partial: true,
    });

    updateTransactionCategoriesBatch.mockResolvedValueOnce({
      requested: 1, updatedTransactionIds: [], failedTransactionId: 'expense-2',
      conflictTransactionId: 'expense-2', persisted: true,
    });
    const adapterConflict = await app.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: {
        startDate: '2026-10-01', endDate: '2026-10-31', commit: true,
        transactions: [{ transactionId: 'expense-2', categoryId: 'food', expectedCategoryId: null }],
      },
    });
    expect(adapterConflict.statusCode).toBe(409);
    expect(adapterConflict.json().error.code).toBe('TRANSACTION_CHANGED_SINCE_PREVIEW');
    expect(updateTransactionCategoriesBatch).toHaveBeenLastCalledWith([
      { transactionId: 'expense-2', categoryId: 'food', expectedCategoryId: null, accountId: 'account-1', date: '2026-10-03' },
    ]);

    const callsBeforeInvalidRequest = updateTransactionCategoriesBatch.mock.calls.length;
    const transfer = await app.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: {
        startDate: '2026-10-01', endDate: '2026-10-31', commit: true,
        transactions: [{ transactionId: 'transfer-1', categoryId: 'food', expectedCategoryId: null }],
      },
    });
    expect(transfer.statusCode).toBe(409);
    expect(updateTransactionCategoriesBatch).toHaveBeenCalledTimes(callsBeforeInvalidRequest);

    const duplicate = await app.inject({
      method: 'POST', url: '/api/v1/insights/categorize',
      payload: {
        startDate: '2026-10-01', endDate: '2026-10-31', commit: true,
        transactions: [
          { transactionId: 'expense-1', categoryId: 'food', expectedCategoryId: 'food' },
          { transactionId: 'expense-1', categoryId: 'food', expectedCategoryId: 'food' },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(updateTransactionCategoriesBatch).toHaveBeenCalledTimes(callsBeforeInvalidRequest);
  });

  it('persists app preferences locally and scopes reset to app-owned preference files', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'personal-budget-preferences-api-test-'));
    temporaryDirectories.push(dataDirectory);
    const app = await createTestApp(createRepository(), { ...config, actualDataDir: dataDirectory });

    const initial = await app.inject({ method: 'GET', url: '/api/v1/preferences/app' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data).toEqual({ theme: 'system', locale: 'es-ES' });

    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/app',
      payload: { theme: 'dark', locale: 'en-GB' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toEqual({ theme: 'dark', locale: 'en-GB' });

    const invalid = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/app',
      payload: { theme: 'light', locale: 'es-ES', password: 'must-not-be-accepted' },
    });
    expect(invalid.statusCode).toBe(400);

    const currency = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: { displayCurrency: 'GBP', accountCurrencyOverrides: {}, exchangeRates: [] },
    });
    expect(currency.statusCode).toBe(200);
    const scope = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['account-1'] },
    });
    expect(scope.statusCode).toBe(200);

    const unconfirmedReset = await app.inject({
      method: 'POST', url: '/api/v1/preferences/reset', payload: { confirmation: 'RESET' },
    });
    expect(unconfirmedReset.statusCode).toBe(400);

    const reset = await app.inject({
      method: 'POST', url: '/api/v1/preferences/reset',
      payload: { confirmation: 'RESET_APP_PREFERENCES' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().data).toMatchObject({
      reset: true,
      app: { theme: 'system', locale: 'es-ES' },
      currency: { displayCurrency: 'EUR', accountCurrencyOverrides: {}, exchangeRates: [] },
      accountScope: { mode: 'all', accountIds: [] },
    });

    const unchangedTransactions = await app.inject({
      method: 'GET', url: '/api/v1/transactions?startDate=2026-10-01&endDate=2026-10-31&limit=20',
    });
    expect(unchangedTransactions.statusCode).toBe(200);
    expect(unchangedTransactions.json().pagination.total).toBe(transactions.length);
  });


});