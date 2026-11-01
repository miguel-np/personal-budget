import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetAccount, BudgetCategory, BudgetRepository, BudgetTransaction, TransactionCategoryBatchChange, TransactionCategoryBatchResult, TransactionStructureUpdate, TransactionUpdate, TransactionWriteResult } from '@personal-budget/finance-core';
import { ActualAdapterError } from '@personal-budget/actual-adapter';
import type { BudgetMonthRecord, ImportRecord, ImportResult } from '@personal-budget/finance-core';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { SearXNGSearchProvider } from '../src/web-search.js';
import type { WebSearchProvider } from '../src/web-search.js';

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
  ollamaBaseURL: 'http://127.0.0.1:11434', aiEnabled: false, aiCategoryClassificationEnabled: false, aiCategoryClassificationIncludePayee: true, ollamaTimeoutMs: 120_000, aiMaxContextChars: 4_000,
  webSearchEnabled: false, webSearchBaseURL: 'http://127.0.0.1:8080', webSearchTimeoutMs: 8_000,
  webSearchMaxResults: 5, webSearchMaxQueryChars: 300, webSearchMaxResponseBytes: 131_072,
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

async function createTestApp(
  repository: BudgetRepository = createRepository(),
  appConfig: AppConfig = config,
  webSearchProvider?: WebSearchProvider,
) {
  const app = await buildApp({
    repository, config: appConfig, logger: false,
    ...(webSearchProvider ? { webSearchProvider } : {}),
  });
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

  it('keeps web search disabled by default and requires explicit consent', async () => {
    const app = await createTestApp(createRepository(), { ...config, aiEnabled: true });
    const status = await app.inject({ method: 'GET', url: '/api/v1/assistant/web-search/status' });
    const disabled = await app.inject({
      method: 'POST', url: '/api/v1/assistant/web-search',
      payload: { consent: true, query: 'BOE IRPF', mode: 'general', domains: [] },
    });
    const noConsent = await app.inject({
      method: 'POST', url: '/api/v1/assistant/web-search',
      payload: { query: 'BOE IRPF', mode: 'general', domains: [] },
    });
    expect(status.json()).toMatchObject({ enabled: false, provider: 'SearXNG', explicitConsentRequired: true });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json().error.code).toBe('WEB_SEARCH_DISABLED');
    expect(noConsent.statusCode).toBe(400);
  });

  it('requires explicit fiscal context and rejects domains outside the official allowlist', async () => {
    const app = await createTestApp();
    const incompleteTax = await app.inject({
      method: 'POST', url: '/api/v1/assistant/web-search',
      payload: { consent: true, query: 'IRPF', mode: 'tax' },
    });
    const unapprovedDomain = await app.inject({
      method: 'POST', url: '/api/v1/assistant/web-search',
      payload: { consent: true, query: 'IRPF', mode: 'general', domains: ['example.com'] },
    });
    const duplicateDomains = await app.inject({
      method: 'POST', url: '/api/v1/assistant/web-search',
      payload: { consent: true, query: 'IRPF', mode: 'general', domains: ['boe.es', 'boe.es'] },
    });
    const approvedDgtDomain = await app.inject({
      method: 'POST', url: '/api/v1/assistant/web-search',
      payload: { consent: true, query: 'consulta DGT', mode: 'general', domains: ['petete.tributos.hacienda.gob.es'] },
    });
    expect(incompleteTax.statusCode).toBe(400);
    expect(unapprovedDomain.statusCode).toBe(400);
    expect(duplicateDomains.statusCode).toBe(400);
    expect(approvedDgtDomain.statusCode).toBe(503);
    expect(approvedDgtDomain.json().error.code).toBe('AI_DISABLED');
  });

  it('applies a bounded per-process rate limit before Ollama or the external search provider is invoked', async () => {
    const app = await createTestApp(createRepository(), {
      ...config, aiEnabled: true, webSearchEnabled: true,
    });
    const payload = { consent: true, query: 'consulta de prueba', mode: 'general', domains: [] };
    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/assistant/web-search', payload });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('AI_UNAVAILABLE');
    }
    const limited = await app.inject({ method: 'POST', url: '/api/v1/assistant/web-search', payload });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('WEB_SEARCH_RATE_LIMIT');
    expect(limited.headers['retry-after']).toBe('60');
  });

  it('uses only the approved query for web search and never reads financial context', async () => {
    let chatCall = 0;
    const modelRequests: Array<Record<string, unknown>> = [];
    const ollama = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') {
        response.writeHead(200);
        response.end(JSON.stringify({ models: [{ name: 'synthetic-model' }] }));
        return;
      }
      if (request.url !== '/api/chat') {
        response.writeHead(404); response.end('{}'); return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        modelRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        chatCall += 1;
        response.writeHead(200);
        response.end(JSON.stringify(chatCall === 1 ? {
          message: { role: 'assistant', content: '', tool_calls: [{
            function: { name: 'web_search', arguments: { query: 'normativa IRPF ejercicio 2025' } },
          }] },
        } : { message: { role: 'assistant', content: 'La fuente oficial publica la norma aplicable [S1].' } }));
      });
    });
    const search = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.writeHead(200);
      response.end(JSON.stringify({ results: [{
        title: 'Disposición publicada en BOE',
        url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2025-1',
        content: 'Texto normativo oficial. Fecha de publicación indicada por la fuente.',
        publishedDate: '2025-03-01',
      }] }));
      expect(url.searchParams.get('q')).toBe('normativa IRPF ejercicio 2025');
    });
    const listen = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const address = (server: ReturnType<typeof createServer>) => {
      const value = server.address();
      if (!value || typeof value === 'string') throw new Error('Expected a local test server address.');
      return 'http://127.0.0.1:' + (value as AddressInfo).port;
    };
    await Promise.all([listen(ollama), listen(search)]);
    const repository = createRepository();
    const appConfig: AppConfig = {
      ...config,
      aiEnabled: true,
      ollamaBaseURL: address(ollama),
      ollamaModel: 'synthetic-model',
      webSearchEnabled: true,
      webSearchBaseURL: address(search),
    };
    const searchProvider = new SearXNGSearchProvider({
      baseURL: appConfig.webSearchBaseURL,
      timeoutMs: appConfig.webSearchTimeoutMs,
      maxResults: appConfig.webSearchMaxResults,
      maxQueryChars: appConfig.webSearchMaxQueryChars,
      maxResponseBytes: appConfig.webSearchMaxResponseBytes,
    });
    // The search provider remains real; official-source retrieval is separately
    // unit-tested and must not make this synthetic API test depend on the Internet.
    searchProvider.retrieveOfficialDocuments = async (searchResponse) => searchResponse;
    const app = await createTestApp(repository, appConfig, searchProvider);
    try {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/assistant/web-search',
        payload: {
          consent: true, query: 'normativa IRPF ejercicio 2025', mode: 'tax', domains: ['boe.es'],
          jurisdiction: 'España', matter: 'IRPF', taxYear: '2025', filingYear: '2026', referenceDate: '2026-11-01',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        answer: 'La fuente oficial publica la norma aplicable [S1].',
        provider: 'SearXNG', mode: 'tax',
        taxContext: { jurisdiction: 'España', matter: 'IRPF', taxYear: '2025', filingYear: '2026', referenceDate: '2026-11-01' },
        sourceCount: 1,
      });
      expect(repository.listAccounts).not.toHaveBeenCalled();
      expect(repository.listTransactions).not.toHaveBeenCalled();
      expect(JSON.stringify(modelRequests[0])).not.toContain('account-1');
      expect(JSON.stringify(modelRequests[0])).not.toContain('Alimentación');
      expect(JSON.stringify(modelRequests[0])).not.toContain('200000');
      expect(modelRequests[0]?.tools).toBeDefined();
      expect(modelRequests[1]?.tools).toBeUndefined();
      const secondMessages = modelRequests[1]?.messages as Array<{ role: string; content: string }>;
      expect(secondMessages.some((message) => message.role === 'tool' && message.content.includes('www.boe.es'))).toBe(true);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) => ollama.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => search.close((error) => error ? reject(error) : resolve())),
      ]);
    }
  });

  it('rejects a model search query different from the exact text approved by the user', async () => {
    let searchCalls = 0;
    let chatCall = 0;
    const ollama = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') {
        response.writeHead(200); response.end(JSON.stringify({ models: [{ name: 'synthetic-model' }] })); return;
      }
      chatCall += 1;
      response.writeHead(200);
      response.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{
        function: { name: 'web_search', arguments: { query: 'consulta ampliada con datos inventados' } },
      }] } }));
    });
    const search = createServer((_request, response) => { searchCalls += 1; response.writeHead(200); response.end(JSON.stringify({ results: [] })); });
    const listen = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const address = (server: ReturnType<typeof createServer>) => {
      const value = server.address();
      if (!value || typeof value === 'string') throw new Error('Expected a local test server address.');
      return 'http://127.0.0.1:' + (value as AddressInfo).port;
    };
    await Promise.all([listen(ollama), listen(search)]);
    const app = await createTestApp(createRepository(), {
      ...config, aiEnabled: true, ollamaBaseURL: address(ollama), ollamaModel: 'synthetic-model',
      webSearchEnabled: true, webSearchBaseURL: address(search),
    });
    try {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/assistant/web-search',
        payload: { consent: true, query: 'consulta aprobada', mode: 'general', domains: [] },
      });
      expect(chatCall).toBe(1);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('WEB_SEARCH_TOOL_UNSUPPORTED');
      expect(searchCalls).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) => ollama.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => search.close((error) => error ? reject(error) : resolve())),
      ]);
    }
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
    const reviewTimeZone = 'Europe/Madrid';
    const madridDateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: reviewTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const today = ['year', 'month', 'day'].map((type) =>
      madridDateParts.find((part) => part.type === type)?.value ?? '',
    ).join('-');
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
    const invalidTimeZone = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/periodic',
      payload: { periodType: 'weekly', anchorDate: today, timeZone: 'Not/A-Time-Zone' },
    });
    expect(invalidTimeZone.statusCode).toBe(400);

    const generated = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/periodic',
      payload: { periodType: 'monthly', anchorDate: today, timeZone: reviewTimeZone },
    });
    expect(generated.statusCode).toBe(201);
    const data = generated.json().data;
    expect(data.schemaVersion).toBe(1);
    expect(data.asOfDate).toBe(today);
    expect(data.timeZone).toBe(reviewTimeZone);
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
      payload: { findingId: item.findingId, status: 'postponed', postponedUntil, timeZone: reviewTimeZone },
    });
    expect(postponed.statusCode).toBe(200);
    expect(postponed.json().data.items[0]).toMatchObject({ status: 'postponed', postponedUntil });

    const regenerated = await app.inject({
      method: 'POST',
      url: '/api/v1/reviews/periodic',
      payload: { periodType: 'monthly', anchorDate: today, timeZone: reviewTimeZone },
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

  it('returns expired postponed decisions to pending when the same period is regenerated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'periodic-review-expired-postpone-api-'));
    temporaryDirectories.push(directory);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'));
    try {
      const reviewTimeZone = 'Europe/Madrid';
      const syntheticTransactions: readonly BudgetTransaction[] = [
        { id: 'expired-postpone-uncategorized', account: 'account-1', currencyCode: 'EUR', date: '2026-10-10', amount: -5_000 },
      ];
      const repository = createRepository({
        listTransactions: vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
          syntheticTransactions.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate)),
      });
      const app = await createTestApp(repository, { ...config, actualDataDir: directory, aiEnabled: false });
      const initial = await app.inject({
        method: 'POST',
        url: '/api/v1/reviews/periodic',
        payload: { periodType: 'monthly', anchorDate: '2026-10-15', timeZone: reviewTimeZone },
      });
      expect(initial.statusCode).toBe(201);
      expect(initial.json().data.period).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-31', complete: true });
      const item = initial.json().data.run.items.find((candidate: { findingType: string }) => candidate.findingType === 'pending-categorization');
      expect(item).toBeTruthy();

      const postponed = await app.inject({
        method: 'PATCH',
        url: '/api/v1/reviews/periodic/' + initial.json().data.run.id + '/items',
        payload: {
          findingId: item.findingId,
          status: 'postponed',
          postponedUntil: '2026-11-08',
          timeZone: reviewTimeZone,
        },
      });
      expect(postponed.statusCode).toBe(200);

      // The October period remains closed and has the same full evidence fingerprint;
      // only the postponement expiry has moved into the past.
      vi.setSystemTime(new Date('2026-11-10T10:00:00.000Z'));
      const regenerated = await app.inject({
        method: 'POST',
        url: '/api/v1/reviews/periodic',
        payload: { periodType: 'monthly', anchorDate: '2026-10-15', timeZone: reviewTimeZone },
      });
      expect(regenerated.statusCode).toBe(201);
      const regeneratedItem = regenerated.json().data.run.items.find((candidate: { findingId: string }) => candidate.findingId === item.findingId);
      expect(regeneratedItem).toMatchObject({ status: 'pending' });
      expect(regeneratedItem.postponedUntil).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates postponed review dates in the submitted IANA time zone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'periodic-review-time-zone-api-'));
    temporaryDirectories.push(directory);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T01:30:00.000Z'));
    try {
      const syntheticTransactions: readonly BudgetTransaction[] = [
        { id: 'review-local-boundary', account: 'account-1', currencyCode: 'EUR', date: '2026-11-01', amount: -5_000 },
      ];
      const listTransactions = vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
        syntheticTransactions.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate));
      const repository = createRepository({ listTransactions });
      const app = await createTestApp(repository, { ...config, actualDataDir: directory, aiEnabled: false });
      const generated = await app.inject({
        method: 'POST',
        url: '/api/v1/reviews/periodic',
        payload: { periodType: 'weekly', anchorDate: '2026-11-01', timeZone: 'America/Los_Angeles' },
      });
      expect(generated.statusCode).toBe(201);
      expect(generated.json().data.asOfDate).toBe('2026-11-01');
      const item = generated.json().data.run.items.find((candidate: { findingType: string }) => candidate.findingType === 'pending-categorization');
      expect(item).toBeTruthy();

      // At this instant UTC is already Nov 2, while the browser's LA civil date is still Nov 1.
      // Expiring on the browser's current day is valid and must use the same calendar as generation.
      const postponed = await app.inject({
        method: 'PATCH',
        url: '/api/v1/reviews/periodic/' + generated.json().data.run.id + '/items',
        payload: {
          findingId: item.findingId,
          status: 'postponed',
          postponedUntil: '2026-11-01',
          timeZone: 'America/Los_Angeles',
        },
      });
      expect(postponed.statusCode).toBe(200);
      expect(postponed.json().data.items[0]).toMatchObject({ status: 'postponed', postponedUntil: '2026-11-01' });

      const invalidTimeZone = await app.inject({
        method: 'PATCH',
        url: '/api/v1/reviews/periodic/' + generated.json().data.run.id + '/items',
        payload: {
          findingId: item.findingId,
          status: 'reviewed',
          timeZone: 'Not/A-Time-Zone',
        },
      });
      expect(invalidTimeZone.statusCode).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compares repeated findings by stable identity and stores only metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'periodic-review-comparison-api-'));
    temporaryDirectories.push(directory);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T09:30:00.000Z'));
    try {
      let syntheticTransactions: readonly BudgetTransaction[] = [
        { id: 'previous-uncategorized', account: 'account-1', currencyCode: 'EUR', date: '2026-10-10', amount: -1_000 },
        { id: 'current-uncategorized', account: 'account-1', currencyCode: 'EUR', date: '2026-11-01', amount: -2_500 },
      ];
      const repository = createRepository({
        listTransactions: vi.fn(async (_accountId: string, startDate: string, endDate: string) =>
          syntheticTransactions.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate)),
      });
      const app = await createTestApp(repository, { ...config, actualDataDir: directory, aiEnabled: false });

      const previous = await app.inject({
        method: 'POST',
        url: '/api/v1/reviews/periodic',
        payload: { periodType: 'monthly', anchorDate: '2026-10-15', timeZone: 'Europe/Madrid' },
      });
      expect(previous.statusCode).toBe(201);
      expect(previous.json().data.period).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-31', complete: true });
      expect(previous.json().data.run.items).toHaveLength(1);
      expect(previous.json().data.run.items[0]).toMatchObject({
        identityKey: expect.stringMatching(/^[0-9a-f]{16}$/),
        evidenceFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
      expect(previous.json().data.comparisonToPreviousReview).toBeNull();

      const current = await app.inject({
        method: 'POST',
        url: '/api/v1/reviews/periodic',
        payload: { periodType: 'monthly', anchorDate: '2026-11-01', timeZone: 'Europe/Madrid' },
      });
      expect(current.statusCode).toBe(201);
      expect(current.json().data.run.items).toHaveLength(1);
      expect(current.json().data.run.items[0].findingId).not.toBe(previous.json().data.run.items[0].findingId);
      expect(current.json().data.run.items[0].identityKey).toBe(previous.json().data.run.items[0].identityKey);
      expect(current.json().data.comparisonToPreviousReview).toMatchObject({
        previousReview: { startDate: '2026-10-01', endDate: '2026-10-31' },
        newFindingCount: 0,
        repeatedFindingCount: 1,
        changedEvidenceCount: 1,
        noLongerPresentCount: 0,
      });

      // When the current period no longer contains the same kind of finding, the earlier
      // comparable review must report it as no longer present rather than as a new item.
      syntheticTransactions = [];
      const cleared = await app.inject({
        method: 'POST',
        url: '/api/v1/reviews/periodic',
        payload: { periodType: 'monthly', anchorDate: '2026-11-01', timeZone: 'Europe/Madrid' },
      });
      expect(cleared.statusCode).toBe(201);
      expect(cleared.json().data.run.items).toHaveLength(0);
      expect(cleared.json().data.comparisonToPreviousReview).toMatchObject({
        newFindingCount: 0,
        repeatedFindingCount: 0,
        changedEvidenceCount: 0,
        noLongerPresentCount: 1,
      });

      const state = await readFile(join(directory, 'periodic-reviews.json'), 'utf8');
      expect(state).not.toContain('incomeMinor');
      expect(state).not.toContain('expenseMinor');
      expect(state).not.toContain('amountMinor');
      expect(state).not.toContain('previous-uncategorized');
      expect(state).not.toContain('current-uncategorized');
      expect(state).not.toContain('account-1');
    } finally {
      vi.useRealTimers();
    }
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
    } as BudgetRepository & { getBudgetMonth: (month: string) => Promise<BudgetMonthRecord> };
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
    const dataDir = await mkdtemp(join(tmpdir(), 'personal-budget-benchmark-'));
    temporaryDirectories.push(dataDir);
    const benchmarkConfig = { ...config, actualDataDir: dataDir };
    const measurements: Array<{
      scenario: string;
      records: number;
      accounts: number;
      medianLatencyMs: number;
      maxSampledHeapDeltaBytes: number;
      repositoryReadsPerRequest: number;
    }> = [];

    const measureScenario = async (options: {
      scenario: string;
      rows: readonly BudgetTransaction[];
      accounts: readonly BudgetAccount[];
      url: string;
      expectedTotal: number;
      expectedReads: number;
      expectedFirstPageIds?: readonly string[];
    }) => {
      const listTransactions = vi.fn(async (accountId: string, startDate: string, endDate: string) =>
        options.rows.filter((transaction) =>
          transaction.account === accountId && transaction.date >= startDate && transaction.date <= endDate));
      const app = await createTestApp(createRepository({
        listAccounts: vi.fn(async () => options.accounts),
        listTransactions,
      }), benchmarkConfig);
      const latencies: number[] = [];
      let maxSampledHeapDeltaBytes = 0;
      for (let repeat = 0; repeat < 3; repeat += 1) {
        listTransactions.mockClear();
        const heapBefore = process.memoryUsage().heapUsed;
        let sampledPeakHeapDeltaBytes = 0;
        const sampleHeap = () => {
          sampledPeakHeapDeltaBytes = Math.max(
            sampledPeakHeapDeltaBytes,
            process.memoryUsage().heapUsed - heapBefore,
          );
        };
        // Heap deltas measured only before/after a request can miss transient
        // allocations that are reclaimed before the response resolves. Sample
        // while the request is in flight and once more after it completes, and
        // keep the maximum across the three repetitions so neither a single run
        // nor a final post-GC reading can determine the reported peak.
        const heapSampler = setInterval(sampleHeap, 1);
        const started = performance.now();
        let response: Awaited<ReturnType<typeof app.inject>>;
        try {
          response = await app.inject({ method: 'GET', url: options.url });
        } finally {
          clearInterval(heapSampler);
          sampleHeap();
        }
        latencies.push(performance.now() - started);
        maxSampledHeapDeltaBytes = Math.max(maxSampledHeapDeltaBytes, sampledPeakHeapDeltaBytes);
        expect(response!.statusCode).toBe(200);
        expect(response.json().pagination.total).toBe(options.expectedTotal);
        expect(response.json().data).toHaveLength(20);
        if (options.expectedFirstPageIds) {
          expect(response.json().data.map((item: BudgetTransaction) => item.id)).toEqual(options.expectedFirstPageIds);
        }
        expect(listTransactions).toHaveBeenCalledTimes(options.expectedReads);
      }
      latencies.sort((left, right) => left - right);
      measurements.push({
        scenario: options.scenario,
        records: options.expectedTotal,
        accounts: options.accounts.length,
        medianLatencyMs: Number(latencies[1]!.toFixed(2)),
        maxSampledHeapDeltaBytes,
        repositoryReadsPerRequest: options.expectedReads,
      });
    };

    // (a) Twelve-month spread on a single account: the original baseline dataset.
    for (const size of [10_000, 50_000, 100_000]) {
      // Reverse source order and deliberately share date/amount to exercise the
      // ID tie-breaker rather than relying on insertion order.
      const rows: readonly BudgetTransaction[] = Array.from({ length: size }, (_, index) => ({
        id: 'synthetic-' + String(size - index - 1).padStart(6, '0'),
        account: 'account-1',
        currencyCode: 'EUR',
        date: '2026-' + String((index % 12) + 1).padStart(2, '0') + '-15',
        amount: -100,
        category: 'food',
      }));
      const expectedFirstPage = [...rows]
        .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
        .slice(0, 20)
        .map((transaction) => transaction.id);
      await measureScenario({
        scenario: 'spread-12-months',
        rows,
        accounts,
        url: '/api/v1/transactions?startDate=2026-01-01&endDate=2026-12-31&limit=20&offset=0&sortBy=amount&order=asc',
        expectedTotal: size,
        expectedReads: 12,
        expectedFirstPageIds: expectedFirstPage,
      });
    }

    // (b) Dense month: 100k movements concentrated in one calendar month so the
    // per-month SDK materialization cannot be amortized across twelve windows.
    {
      const rows: readonly BudgetTransaction[] = Array.from({ length: 100_000 }, (_, index) => ({
        id: 'dense-' + String(100_000 - index - 1).padStart(6, '0'),
        account: 'account-1',
        currencyCode: 'EUR',
        date: '2026-09-15',
        amount: -100,
        category: 'food',
      }));
      await measureScenario({
        scenario: 'dense-single-month',
        rows,
        accounts,
        url: '/api/v1/transactions?startDate=2026-09-01&endDate=2026-09-30&limit=20&offset=0&sortBy=amount&order=asc',
        expectedTotal: 100_000,
        expectedReads: 1,
        expectedFirstPageIds: [...rows].sort((left, right) => left.id.localeCompare(right.id)).slice(0, 20).map((transaction) => transaction.id),
      });
    }

    // (c) Several accounts: 100k movements distributed across four accounts so
    // reads and heap scale with the number of accounts, not a single stream.
    {
      const benchmarkAccounts: readonly BudgetAccount[] = Array.from({ length: 4 }, (_, accountIndex) => ({
        id: 'bench-account-' + accountIndex,
        name: 'Cuenta de benchmark ' + accountIndex,
        currencyCode: 'EUR',
        closed: false,
        offBudget: false,
        currentBalanceMinor: 0,
      }));
      const rows: readonly BudgetTransaction[] = Array.from({ length: 100_000 }, (_, index) => ({
        id: 'multi-' + String(100_000 - index - 1).padStart(6, '0'),
        account: 'bench-account-' + (index % 4),
        currencyCode: 'EUR',
        date: '2026-' + String((index % 12) + 1).padStart(2, '0') + '-15',
        amount: -100,
        category: 'food',
      }));
      await measureScenario({
        scenario: 'multi-account-spread',
        rows,
        accounts: benchmarkAccounts,
        url: '/api/v1/transactions?startDate=2026-01-01&endDate=2026-12-31&limit=20&offset=0&sortBy=amount&order=asc',
        expectedTotal: 100_000,
        expectedReads: 4 * 12,
      });
    }

    // Regression ceilings are deliberately generous multiples of the recorded baseline
    // so ordinary CI scheduling variance does not cause false failures. They are fixed
    // limits that apply to every scenario and repetition.
    expect(measurements.every((measurement) => measurement.medianLatencyMs < 3_000)).toBe(true);
    expect(measurements.every((measurement) => measurement.maxSampledHeapDeltaBytes < 128 * 1024 * 1024)).toBe(true);

    console.info('TRANSACTION_PAGINATION_BENCHMARK ' + JSON.stringify({
      node: process.version,
      syntheticOnly: true,
      measurements,
      regressionCeilings: { medianLatencyMs: 3_000, maxSampledHeapDeltaBytes: 128 * 1024 * 1024 },
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

  it('traverses every page of a static multi-account history without skipping or duplicating movements', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'personal-budget-traversal-'));
    temporaryDirectories.push(dataDir);
    const traversalAccounts: readonly BudgetAccount[] = [
      { id: 'account-a', name: 'Cuenta A', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 0 },
      { id: 'account-b', name: 'Cuenta B', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 0 },
      { id: 'account-c', name: 'Cuenta C', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 0 },
    ];
    // Forty rows sharing the exact same date and amount, inserted in reverse ID
    // order: the deterministic ID tie-breaker must decide their position.
    const identicalCluster: BudgetTransaction[] = Array.from({ length: 40 }, (_, index) => ({
      id: 'dup-' + String(40 - index - 1).padStart(2, '0'),
      account: 'account-' + String.fromCharCode(97 + (index % 3)),
      currencyCode: 'EUR',
      date: '2026-06-15',
      amount: -10_000,
      category: 'food',
    }));
    // Three hundred rows across three months and three accounts, mixing
    // categorized and uncategorized movements.
    const spreadRows: BudgetTransaction[] = Array.from({ length: 300 }, (_, index) => ({
      id: 'spread-' + String(300 - index - 1).padStart(3, '0'),
      account: 'account-' + String.fromCharCode(97 + (index % 3)),
      currencyCode: 'EUR',
      date: '2026-' + String(6 + (index % 3)).padStart(2, '0') + '-' + String(1 + (index % 28)).padStart(2, '0'),
      amount: -(100 + (index % 7) * 1_000),
      ...(index % 3 === 0 ? { category: 'food' } : {}),
    }));
    // A split whose children cross the July/August month boundary.
    const splitParent: BudgetTransaction = {
      id: 'split-parent-cross-month',
      account: 'account-a',
      currencyCode: 'EUR',
      date: '2026-07-31',
      amount: -1_000,
      is_parent: true,
      category: 'food',
      subtransactions: [
        { id: 'split-child-july', account: 'account-a', date: '2026-07-31', amount: -400, category: 'food', parent_id: 'split-parent-cross-month', is_child: true },
        { id: 'split-child-august', account: 'account-a', date: '2026-08-01', amount: -600, category: 'food', parent_id: 'split-parent-cross-month', is_child: true },
      ],
    };
    const rows: readonly BudgetTransaction[] = [...identicalCluster, ...spreadRows, splitParent];
    interface TraversalPresentedRow {
      readonly id: string;
      readonly account: string;
      readonly date: string;
      readonly amount: number;
      readonly category: string | null | undefined;
    }
    const presentedRows: readonly TraversalPresentedRow[] = rows.flatMap((transaction): TraversalPresentedRow[] => {
      if (transaction.is_child === true || transaction.parent_id) return [];
      if (transaction.subtransactions && transaction.subtransactions.length > 0) {
        return transaction.subtransactions.map((child, index) => ({
          id: child.id || transaction.id + ':split:' + index,
          account: child.account || transaction.account,
          date: child.date || transaction.date,
          amount: child.amount,
          category: child.category ?? transaction.category,
        }));
      }
      return [{ id: transaction.id, account: transaction.account, date: transaction.date, amount: transaction.amount, category: transaction.category }];
    });
    const compareForTraversal = (
      left: Pick<TraversalPresentedRow, 'id' | 'account' | 'date'>,
      right: Pick<TraversalPresentedRow, 'id' | 'account' | 'date'>,
    ): number => left.date.localeCompare(right.date) || left.id.localeCompare(right.id) || left.account.localeCompare(right.account);
    const expectedIds = [...presentedRows].sort(compareForTraversal).map((transaction) => transaction.id);
    const expectedFoodIds = presentedRows
      .filter((transaction) => transaction.category === 'food')
      .sort(compareForTraversal)
      .map((transaction) => transaction.id);

    const listTransactions = vi.fn(async (accountId: string, startDate: string, endDate: string) =>
      rows.filter((transaction) => transaction.account === accountId && transaction.date >= startDate && transaction.date <= endDate));
    const app = await createTestApp(createRepository({
      listAccounts: vi.fn(async () => traversalAccounts),
      listTransactions,
    }), { ...config, actualDataDir: dataDir });

    const collectPages = async (urlWithoutOffset: string, pageLimit: number, expectedTotal: number, expectedReadsPerPage: number): Promise<string[]> => {
      const collected: string[] = [];
      let offset = 0;
      let reads = 0;
      while (offset < expectedTotal) {
        const response = await app.inject({
          method: 'GET',
          url: urlWithoutOffset + '&offset=' + offset,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().pagination.total).toBe(expectedTotal);
        expect(response.json().data).toHaveLength(Math.min(pageLimit, expectedTotal - offset));
        collected.push(...response.json().data.map((item: BudgetTransaction) => item.id));
        offset += pageLimit;
        reads += expectedReadsPerPage;
      }
      expect(listTransactions).toHaveBeenCalledTimes(reads);
      return collected;
    };

    // Every page keeps the same total; the union of all pages equals the
    // reference order exactly, so nothing is skipped, duplicated or reordered.
    const allPages = await collectPages(
      '/api/v1/transactions?startDate=2026-06-01&endDate=2026-08-31&limit=37&sortBy=date&order=asc',
      37,
      expectedIds.length,
      3 * 3,
    );
    expect(allPages).toEqual(expectedIds);
    expect(new Set(allPages).size).toBe(allPages.length);

    // The same guarantee holds with an active filter over a subset of rows.
    listTransactions.mockClear();
    const foodPages = await collectPages(
      '/api/v1/transactions?startDate=2026-06-01&endDate=2026-08-31&categoryId=food&limit=19&sortBy=date&order=asc',
      19,
      expectedFoodIds.length,
      3 * 3,
    );
    expect(foodPages).toEqual(expectedFoodIds);
    expect(new Set(foodPages).size).toBe(foodPages.length);
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
      _records: readonly ImportRecord[],
      options?: { readonly dryRun?: boolean },
    ): Promise<ImportResult> => ({
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
    const importTransactions = vi.fn(async (): Promise<ImportResult> => ({ errors: [], added: ['should-not-write'], updated: [] }));
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
      _records: readonly ImportRecord[],
      options?: { readonly dryRun?: boolean },
    ): Promise<ImportResult> => ({
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
    const importTransactions = vi.fn(async (): Promise<ImportResult> => ({ errors: [], added: [], updated: [] }));
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
    const importTransactions = vi.fn(async (): Promise<ImportResult> => ({ errors: [], added: [], updated: [] }));
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
    const importTransactions = vi.fn(async (): Promise<ImportResult> => ({
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
      transactionId: 'u-1', suggestedCategoryId: 'food', suggestedCategoryName: 'Alimentación', confidence: 'rule_based', source: 'rule_based',
    });
  });

  it('uses local AI only for fallback candidates and returns a validated, review-only category suggestion', async () => {
    const ollama = await createOllamaFixture(200, JSON.stringify({
      suggestions: [
        {
          reference: 'c1',
          categoryId: 'food',
          rationale: 'La etiqueta coincide con una variante ortográfica del comercio histórico.',
          uncertainty: 'low',
        },
        {
          reference: 'c2',
          categoryId: 'food',
          rationale: 'La etiqueta contiene un término explícito de panadería.',
          uncertainty: 'low',
        },
      ],
    }));
    const history: readonly BudgetTransaction[] = [
      { id: 'h-1', account: 'account-1', date: '2026-08-03', amount: -4200, category: 'food', payee_name: 'Supermercado' },
      { id: 'h-2', account: 'account-1', date: '2026-09-03', amount: -3100, category: 'food', payee_name: 'Supermercado' },
      { id: 'u-rule', account: 'account-1', date: '2026-10-04', amount: -3900, category: null, payee_name: 'Supermercado' },
      { id: 'u-typo', account: 'account-1', date: '2026-10-06', amount: -1600, category: null, payee_name: 'Supermercdo Valle' },
      { id: 'u-new', account: 'account-1', date: '2026-10-07', amount: -1200, category: null, payee_name: 'Panadería Aurora', notes: 'nota financiera que no debe enviarse' },
      { id: 'u-income', account: 'account-1', date: '2026-10-08', amount: 4000, category: null, payee_name: 'Ingreso de prueba' },
      { id: 'u-transfer', account: 'account-1', date: '2026-10-09', amount: -5000, category: null, payee_name: 'Traspaso', transfer_id: 'transfer-pair' },
      { id: 'u-refund', account: 'account-1', date: '2026-10-10', amount: 500, category: null, payee_name: 'Reembolso comercio' },
    ];
    const updateTransactionCategoriesBatch = vi.fn();
    const repository = createRepository({
      listTransactions: vi.fn(async () => history),
      updateTransactionCategoriesBatch,
    });
    const app = await createTestApp(repository, {
      ...config,
      aiEnabled: true,
      aiCategoryClassificationEnabled: true,
      aiCategoryClassificationIncludePayee: true,
      ollamaBaseURL: ollama.url,
      ollamaModel: 'synthetic-model',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/insights/category-suggestions?startDate=2026-10-01&endDate=2026-10-31',
    });
    await ollama.close();

    expect(response.statusCode).toBe(200);
    const data = response.json().data as Array<Record<string, unknown>>;
    expect(data.find((entry) => entry.transactionId === 'u-rule')).toMatchObject({
      source: 'rule_based', suggestedCategoryId: 'food', confidence: 'rule_based',
    });
    expect(data.find((entry) => entry.transactionId === 'u-typo')).toMatchObject({
      source: 'local_ai', suggestedCategoryId: 'food', confidence: 'local_ai', uncertainty: 'low',
    });
    expect(data.find((entry) => entry.transactionId === 'u-new')).toMatchObject({
      source: 'local_ai', suggestedCategoryId: 'food', confidence: 'local_ai', uncertainty: 'low',
    });
    expect(data.some((entry) => ['u-income', 'u-transfer', 'u-refund'].includes(String(entry.transactionId)))).toBe(false);
    expect(response.json().classification).toMatchObject({ enabled: true, outcome: 'completed', batchesAttempted: 1 });
    expect(updateTransactionCategoriesBatch).not.toHaveBeenCalled();
  });

  it('rejects unknown category IDs and non-structured model output without writing', async () => {
    const ollama = await createOllamaFixture(200, JSON.stringify({
      suggestions: [{
        reference: 'c1',
        categoryId: 'not-in-the-real-catalog',
        rationale: 'Respuesta sintética inválida.',
        uncertainty: 'low',
      }],
    }));
    const history: readonly BudgetTransaction[] = [
      { id: 'u-invalid', account: 'account-1', date: '2026-10-07', amount: -1200, category: null, payee_name: 'Comercio nuevo' },
    ];
    const updateTransactionCategoriesBatch = vi.fn();
    const app = await createTestApp(createRepository({
      listTransactions: vi.fn(async () => history),
      updateTransactionCategoriesBatch,
    }), {
      ...config,
      aiEnabled: true,
      aiCategoryClassificationEnabled: true,
      aiCategoryClassificationIncludePayee: true,
      ollamaBaseURL: ollama.url,
      ollamaModel: 'synthetic-model',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/insights/category-suggestions?startDate=2026-10-01&endDate=2026-10-31',
    });
    await ollama.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0]).toMatchObject({
      transactionId: 'u-invalid', source: 'none', confidence: 'none', suggestedCategoryId: null,
    });
    expect(response.json().classification.outcome).toBe('invalid_response');
    expect(updateTransactionCategoriesBatch).not.toHaveBeenCalled();
  });

  it('rejects existing but inapplicable income categories from the local model', async () => {
    const ollama = await createOllamaFixture(200, JSON.stringify({
      suggestions: [{
        reference: 'c1',
        categoryId: 'salary',
        rationale: 'Respuesta sintética que propone una categoría de ingreso.',
        uncertainty: 'low',
      }],
    }));
    const history: readonly BudgetTransaction[] = [
      { id: 'u-income-category', account: 'account-1', date: '2026-10-07', amount: -1200, category: null, payee_name: 'Comercio de gasto nuevo' },
    ];
    const updateTransactionCategoriesBatch = vi.fn();
    const app = await createTestApp(createRepository({
      listTransactions: vi.fn(async () => history),
      updateTransactionCategoriesBatch,
    }), {
      ...config,
      aiEnabled: true,
      aiCategoryClassificationEnabled: true,
      aiCategoryClassificationIncludePayee: true,
      ollamaBaseURL: ollama.url,
      ollamaModel: 'synthetic-model',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/insights/category-suggestions?startDate=2026-10-01&endDate=2026-10-31',
    });
    await ollama.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0]).toMatchObject({
      transactionId: 'u-income-category', source: 'none', suggestedCategoryId: null, confidence: 'none',
    });
    expect(response.json().classification.outcome).toBe('invalid_response');
    expect(updateTransactionCategoriesBatch).not.toHaveBeenCalled();
  });

  it('degrades to manual review when the local model is unavailable', async () => {
    const ollama = await createOllamaFixture(503);
    const history: readonly BudgetTransaction[] = [
      { id: 'u-model-down', account: 'account-1', date: '2026-10-07', amount: -1200, category: null, payee_name: 'Comercio nuevo' },
    ];
    const updateTransactionCategoriesBatch = vi.fn();
    const app = await createTestApp(createRepository({
      listTransactions: vi.fn(async () => history),
      updateTransactionCategoriesBatch,
    }), {
      ...config,
      aiEnabled: true,
      aiCategoryClassificationEnabled: true,
      aiCategoryClassificationIncludePayee: true,
      ollamaBaseURL: ollama.url,
      ollamaModel: 'synthetic-model',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/insights/category-suggestions?startDate=2026-10-01&endDate=2026-10-31',
    });
    await ollama.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject([
      { transactionId: 'u-model-down', source: 'none', suggestedCategoryId: null, confidence: 'none' },
    ]);
    expect(response.json().classification.outcome).toBe('unavailable');
    expect(updateTransactionCategoriesBatch).not.toHaveBeenCalled();
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
      _records: readonly ImportRecord[],
      options?: { readonly dryRun?: boolean },
    ): Promise<ImportResult> => ({
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
    const importTransactions = vi.fn(async (): Promise<ImportResult> => ({ errors: [], added: ['unexpected'], updated: [] }));
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

describe('phase 2 financial utility APIs', () => {
  function todayInProcessTimeZone(): string {
    const timeZone = 'UTC';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const value = (type: 'year' | 'month' | 'day') => parts.find((item) => item.type === type)?.value ?? '';
    return value('year') + '-' + value('month') + '-' + value('day');
  }

  function plusDays(date: string, days: number): string {
    const result = new Date(date + 'T00:00:00.000Z');
    result.setUTCDate(result.getUTCDate() + days);
    return result.toISOString().slice(0, 10);
  }

  it('projects Actual movements and commitments without double counting an exact match; scenarios remain ephemeral', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-cash-flow-'));
    temporaryDirectories.push(directory);
    const asOfDate = todayInProcessTimeZone();
    const billDate = plusDays(asOfDate, 3);
    const scenarioDate = plusDays(asOfDate, 5);
    const futureTransaction: BudgetTransaction = {
      id: 'future-internet', account: 'account-1', currencyCode: 'EUR', date: billDate,
      amount: -15_000, category: 'food', payee_name: 'Factura internet', cleared: false,
    };
    const repository = createRepository({
      listTransactions: vi.fn(async () => [...transactions, futureTransaction]),
    });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });

    const exactCommitment = await app.inject({
      method: 'POST', url: '/api/v1/planning/commitments',
      payload: { title: 'Factura internet', amountMinor: 15_000, date: billDate, direction: 'expense', frequency: 'once' },
    });
    expect(exactCommitment.statusCode).toBe(201);
    const uniqueCommitment = await app.inject({
      method: 'POST', url: '/api/v1/planning/commitments',
      payload: { title: 'Seguro anual', amountMinor: 20_000, date: billDate, direction: 'expense', frequency: 'once' },
    });
    expect(uniqueCommitment.statusCode).toBe(201);

    const response = await app.inject({
      method: 'POST', url: '/api/v1/cash-flow/project',
      payload: { horizonDays: 7, reserveMinor: 170_000 },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json().data;
    expect(result.openingBalanceMinor).toBe(200_000);
    expect(result.actualEvents).toContainEqual(expect.objectContaining({
      id: 'actual:future-internet', date: billDate, amountMinor: -15_000, source: 'actual_transaction', clearedStatus: 'pending',
    }));
    expect(result.manualEvents).toHaveLength(1);
    expect(result.manualEvents[0]).toMatchObject({ amountMinor: -20_000, source: 'manual_commitment' });
    expect(result.duplicateCommitmentIds).toHaveLength(1);
    expect(result.projection.endingBalanceMinor).toBe(165_000);
    expect(result.projection.firstReserveBreachDate).toBe(billDate);

    const withScenario = await app.inject({
      method: 'POST', url: '/api/v1/cash-flow/project',
      payload: { horizonDays: 7, scenario: { date: scenarioDate, amountMinor: 5_000, direction: 'expense', label: 'Compra hipotética' } },
    });
    expect(withScenario.statusCode).toBe(200);
    expect(withScenario.json().data.scenarioEvents).toHaveLength(1);
    expect(withScenario.json().data.projection.endingBalanceMinor).toBe(160_000);
    const planning = await app.inject({ method: 'GET', url: '/api/v1/planning' });
    expect(planning.json().data.commitments).toHaveLength(2);
    expect(planning.json().data.commitments.some((item: { title: string }) => item.title === 'Compra hipotética')).toBe(false);
  });

  it('separates confirmed recurring commitments from optional recurring-candidate scenarios', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-recurring-cash-flow-'));
    temporaryDirectories.push(directory);
    const asOfDate = todayInProcessTimeZone();
    const recurringTransactions: BudgetTransaction[] = [-90, -60, -30].map((days, index) => ({
      id: 'streaming-history-' + index,
      account: 'account-1',
      currencyCode: 'EUR',
      date: plusDays(asOfDate, days),
      amount: -1_200,
      category: 'food',
      payee_name: 'Streaming service',
    }));
    const repository = createRepository({
      listTransactions: vi.fn(async () => [...transactions, ...recurringTransactions]),
    });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const commitment = await app.inject({
      method: 'POST', url: '/api/v1/planning/commitments',
      payload: {
        title: 'Alquiler confirmado', amountMinor: 80_000, date: plusDays(asOfDate, 10),
        direction: 'expense', frequency: 'monthly',
      },
    });
    expect(commitment.statusCode).toBe(201);

    const base = await app.inject({
      method: 'POST', url: '/api/v1/cash-flow/project', payload: { horizonDays: 90 },
    });
    expect(base.statusCode).toBe(200);
    const baseData = base.json().data;
    expect(baseData.confirmedRecurringEvents.length).toBeGreaterThan(0);
    expect(baseData.confirmedRecurringEvents.every((event: { source: string }) => event.source === 'confirmed_recurring')).toBe(true);
    const candidate = baseData.recurringCandidates.find((item: { payee: string }) => item.payee === 'streaming service');
    expect(candidate).toBeDefined();
    expect(candidate.upcomingEventsCount).toBeGreaterThan(0);
    expect(baseData.recurringCandidateEvents.some((event: { candidateId: string }) => event.candidateId === candidate.id)).toBe(true);
    expect(baseData.projection.sourceTotals.recurring_candidate.eventCount).toBe(0);

    const selected = await app.inject({
      method: 'POST', url: '/api/v1/cash-flow/project',
      payload: { horizonDays: 90, recurringCandidateIds: [candidate.id] },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().data.projection.sourceTotals.recurring_candidate.eventCount).toBe(candidate.upcomingEventsCount);
    expect(selected.json().data.projection.sourceTotals.confirmed_recurring.eventCount).toBe(baseData.confirmedRecurringEvents.length);

    const staleCandidate = await app.inject({
      method: 'POST', url: '/api/v1/cash-flow/project',
      payload: { horizonDays: 90, recurringCandidateIds: ['rc_000000000000000000000000'] },
    });
    expect(staleCandidate.statusCode).toBe(400);
  });

  it('projects annual commitments and split transactions in the analysis currency without counting the split parent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-cash-flow-splits-currency-'));
    temporaryDirectories.push(directory);
    const asOfDate = todayInProcessTimeZone();
    const splitDate = plusDays(asOfDate, 5);
    const annualDate = plusDays(asOfDate, 10);
    const splitParent: BudgetTransaction = {
      id: 'future-split-parent', account: 'account-1', currencyCode: 'EUR', date: splitDate,
      amount: -10_000, category: null, is_parent: true,
      subtransactions: [
        { id: 'future-split-a', account: 'account-1', currencyCode: 'EUR', date: splitDate, amount: -4_000, category: 'food', payee_name: 'Compra dividida A' },
        { id: 'future-split-b', account: 'account-1', currencyCode: 'EUR', date: splitDate, amount: -6_000, category: 'food', payee_name: 'Compra dividida B' },
      ],
    };
    const repository = createRepository({
      listTransactions: vi.fn(async (accountId: string) => accountId === 'account-1' ? [...transactions, splitParent] : []),
    });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const annual = await app.inject({
      method: 'POST', url: '/api/v1/planning/commitments',
      payload: { title: 'Seguro anual', amountMinor: 12_000, date: annualDate, direction: 'expense', frequency: 'yearly' },
    });
    expect(annual.statusCode).toBe(201);

    const preferences = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: {
        displayCurrency: 'GBP', accountCurrencyOverrides: {},
        exchangeRates: [{ fromCurrency: 'EUR', toCurrency: 'GBP', rate: '0.8', effectiveDate: asOfDate, source: 'synthetic test rate' }],
      },
    });
    expect(preferences.statusCode).toBe(200);

    const converted = await app.inject({
      method: 'POST', url: '/api/v1/cash-flow/project', payload: { horizonDays: 30 },
    });
    expect(converted.statusCode).toBe(200);
    const data = converted.json().data;
    expect(data.currency).toBe('GBP');
    expect(data.actualEvents.filter((event: { id: string }) => event.id.startsWith('actual:future-split-'))).toHaveLength(2);
    expect(data.actualEvents.some((event: { id: string }) => event.id === 'actual:future-split-parent')).toBe(false);
    expect(data.actualEvents.filter((event: { id: string }) => event.id.startsWith('actual:future-split-'))
      .reduce((sum: number, event: { amountMinor: number }) => sum + event.amountMinor, 0)).toBe(-8_000);
    expect(data.confirmedRecurringEvents).toContainEqual(expect.objectContaining({
      date: annualDate, amountMinor: -9_600, source: 'confirmed_recurring', label: 'Seguro anual',
    }));
    expect(data.projection.endingBalanceMinor).toBe(142_400);

    const withoutRate = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: { displayCurrency: 'GBP', accountCurrencyOverrides: {}, exchangeRates: [] },
    });
    expect(withoutRate.statusCode).toBe(200);
    const unavailable = await app.inject({
      method: 'POST', url: '/api/v1/cash-flow/project', payload: { horizonDays: 30 },
    });
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.json().data.openingBalanceMinor).toBeNull();
    expect(unavailable.json().data.confirmedRecurringEvents).toHaveLength(0);
    expect(unavailable.json().data.projection.warnings.join(' ')).toContain('Seguro anual');
  });

  it('nets internal transfers for all accounts and shows the in-scope effect when one counterparty is excluded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-cash-flow-transfers-'));
    temporaryDirectories.push(directory);
    const asOfDate = todayInProcessTimeZone();
    const transferDate = plusDays(asOfDate, 4);
    const twoAccounts: BudgetAccount[] = [
      ...accounts,
      { id: 'account-2', name: 'Ahorro', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 50_000 },
    ];
    const outgoing: BudgetTransaction = {
      id: 'transfer-out-future', account: 'account-1', currencyCode: 'EUR', date: transferDate,
      amount: -25_000, transfer_id: 'future-paired-transfer', payee_name: 'Transfer to Ahorro',
    };
    const incoming: BudgetTransaction = {
      id: 'transfer-in-future', account: 'account-2', currencyCode: 'EUR', date: transferDate,
      amount: 25_000, transfer_id: 'future-paired-transfer', payee_name: 'Transfer from Current',
    };
    const repository = createRepository({
      listAccounts: vi.fn(async () => twoAccounts),
      listTransactions: vi.fn(async (accountId: string) => accountId === 'account-1'
        ? [...transactions.filter((item) => item.account === accountId), outgoing]
        : [incoming]),
    });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const consolidated = await app.inject({
      method: 'POST', url: '/api/v1/cash-flow/project', payload: { horizonDays: 7 },
    });
    expect(consolidated.statusCode).toBe(200);
    expect(consolidated.json().data.openingBalanceMinor).toBe(250_000);
    expect(consolidated.json().data.projection).toMatchObject({
      endingBalanceMinor: 250_000, netChangeMinor: 0,
      totalInflowMinor: 0, totalOutflowMinor: 0,
      totalTransferInflowMinor: 25_000, totalTransferOutflowMinor: 25_000,
    });

    const selectedScope = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['account-1'] },
    });
    expect(selectedScope.statusCode).toBe(200);
    const scoped = await app.inject({
      method: 'POST', url: '/api/v1/cash-flow/project', payload: { horizonDays: 7 },
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().data.openingBalanceMinor).toBe(200_000);
    expect(scoped.json().data.projection).toMatchObject({
      endingBalanceMinor: 175_000, netChangeMinor: -25_000,
      totalInflowMinor: 0, totalOutflowMinor: 0,
      totalTransferInflowMinor: 0, totalTransferOutflowMinor: 25_000,
    });
  });

  it('keeps projected balances and deficit dates unknown if any selected account balance is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-cash-flow-'));
    temporaryDirectories.push(directory);
    const repository = createRepository({
      listAccounts: vi.fn(async () => [{ ...accounts[0]!, currentBalanceMinor: null }]),
    });
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const response = await app.inject({ method: 'POST', url: '/api/v1/cash-flow/project', payload: { horizonDays: 7 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.openingBalanceMinor).toBeNull();
    expect(response.json().data.projection.endingBalanceMinor).toBeNull();
    expect(response.json().data.projection.firstDeficitDate).toBeNull();
    expect(response.json().data.unknownOpeningAccounts).toHaveLength(1);
  });

  it('persists alert rules and snoozes across an API restart while creating a fresh event for the next month', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-alerts-restart-'));
    temporaryDirectories.push(directory);
    const repository = Object.assign(createRepository(), {
      getBudgetMonth: vi.fn(async (month: string) => ({
        month,
        categoryGroups: [{
          id: 'spend', name: 'Gastos', is_income: false,
          categories: [{ id: 'food', name: 'Alimentación', budgeted: 100_000, spent: -120_000, balance: -20_000 }],
        }],
        totalBudgeted: 100_000, totalSpent: -120_000, totalBalance: -20_000,
      })),
      getBudgetAllocations: vi.fn(async () => [{ categoryId: 'food', amountMinor: 100_000 }]),
    }) as BudgetRepository;
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const today = todayInProcessTimeZone();
    const month = today.slice(0, 7);
    const nextMonthDate = new Date(month + '-01T00:00:00.000Z');
    nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1);
    const nextMonth = nextMonthDate.toISOString().slice(0, 7);
    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/budget-alerts/rules',
      payload: { rules: [{ categoryId: 'food', metric: 'percent_used', threshold: 90, enabled: true }] },
    });
    expect(saved.statusCode).toBe(200);
    const active = await app.inject({ method: 'GET', url: '/api/v1/budget-alerts?month=' + month });
    expect(active.statusCode).toBe(200);
    expect(active.json().data.alerts).toHaveLength(1);
    const event = active.json().data.alerts[0];
    const snoozed = await app.inject({
      method: 'PATCH', url: '/api/v1/budget-alerts/events/' + event.eventId,
      payload: {
        ruleId: event.ruleId, categoryId: event.categoryId, month: event.month,
        status: 'snoozed', snoozedUntil: plusDays(today, 7),
      },
    });
    expect(snoozed.statusCode).toBe(200);

    const openAppIndex = openApps.indexOf(app);
    if (openAppIndex >= 0) openApps.splice(openAppIndex, 1);
    await app.close();
    const restarted = await createTestApp(repository, { ...config, actualDataDir: directory });
    const currentMonth = await restarted.inject({ method: 'GET', url: '/api/v1/budget-alerts?month=' + month });
    expect(currentMonth.statusCode).toBe(200);
    expect(currentMonth.json().data.rules).toHaveLength(1);
    expect(currentMonth.json().data.alerts).toHaveLength(0);
    const nextPeriod = await restarted.inject({ method: 'GET', url: '/api/v1/budget-alerts?month=' + nextMonth });
    expect(nextPeriod.statusCode).toBe(200);
    expect(nextPeriod.json().data.alerts).toHaveLength(1);
    expect(nextPeriod.json().data.alerts[0].eventId).not.toBe(event.eventId);
  });

  it('requires an explicit category classification and returns deterministic budget-improvement baselines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-improvements-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(createRepository(), { ...config, actualDataDir: directory });
    const initial = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=6' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data.baseline.periodMonths).toBe(6);
    expect(initial.json().data.categoryChoices.find((item: { categoryId: string }) => item.categoryId === 'food').classification).toBe('unclassified');
    expect(initial.json().data.proposals).toEqual([]);

    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/budget-improvements/preferences',
      payload: { goal: 'reach_savings_goal', categories: [{ categoryId: 'food', classification: 'flexible' }] },
    });
    expect(saved.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=6' });
    expect(after.statusCode).toBe(200);
    expect(after.json().data.goal).toBe('reach_savings_goal');
    expect(after.json().data.categoryChoices.find((item: { categoryId: string }) => item.categoryId === 'food').classification).toBe('flexible');

    const insufficientHistory = await app.inject({
      method: 'POST', url: '/api/v1/budget-improvements/simulate',
      payload: { periodMonths: 6, reductions: [{ categoryId: 'food', reductionPercent: 10 }] },
    });
    expect(insufficientHistory.statusCode).toBe(400);
    const invalidCategoryPreference = await app.inject({
      method: 'PUT', url: '/api/v1/budget-improvements/preferences',
      payload: { goal: 'reduce_variable_spending', categories: [{ categoryId: 'salary', classification: 'flexible' }] },
    });
    expect(invalidCategoryPreference.statusCode).toBe(400);
  });

  it('creates proposals from completed-month Actual budget evidence and preserves protected classifications', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-improvement-evidence-'));
    temporaryDirectories.push(directory);
    const expenseCategories: BudgetCategory[] = [
      ...categories,
      { id: 'variable', name: 'Gasto variable', groupId: 'spend', isIncome: false },
      { id: 'protected-spend', name: 'Gasto protegido', groupId: 'spend', isIncome: false },
    ];
    const historical: BudgetTransaction[] = [
      { id: 'variable-aug', account: 'account-1', currencyCode: 'EUR', date: '2026-08-15', amount: -10_000, category: 'variable' },
      { id: 'variable-sep', account: 'account-1', currencyCode: 'EUR', date: '2026-09-15', amount: -10_000, category: 'variable' },
      { id: 'variable-oct', account: 'account-1', currencyCode: 'EUR', date: '2026-10-15', amount: -15_000, category: 'variable' },
      { id: 'protected-aug', account: 'account-1', currencyCode: 'EUR', date: '2026-08-16', amount: -20_000, category: 'protected-spend' },
      { id: 'protected-sep', account: 'account-1', currencyCode: 'EUR', date: '2026-09-16', amount: -20_000, category: 'protected-spend' },
      { id: 'protected-oct', account: 'account-1', currencyCode: 'EUR', date: '2026-10-16', amount: -30_000, category: 'protected-spend' },
    ];
    const repository = Object.assign(createRepository({
      listCategories: vi.fn(async () => expenseCategories),
      listTransactions: vi.fn(async (accountId: string) => accountId === 'account-1' ? [...transactions, ...historical] : []),
    }), {
      getBudgetMonth: vi.fn(async (month: string) => ({
        month,
        categoryGroups: [{
          id: 'spend', name: 'Gastos', is_income: false,
          categories: [
            { id: 'variable', name: 'Gasto variable', budgeted: 10_000, spent: -15_000, balance: -5_000 },
            { id: 'protected-spend', name: 'Gasto protegido', budgeted: 20_000, spent: -30_000, balance: -10_000 },
          ],
        }],
        totalBudgeted: 30_000, totalSpent: -45_000, totalBalance: -15_000,
      })),
      getBudgetAllocations: vi.fn(async () => [
        { categoryId: 'variable', amountMinor: 10_000 },
        { categoryId: 'protected-spend', amountMinor: 20_000 },
      ]),
    }) as BudgetRepository;
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const goalCreation = await app.inject({
      method: 'POST', url: '/api/v1/planning/goals',
      payload: {
        name: 'Fondo de emergencia', targetAmountMinor: 500_000, initialAmountMinor: 100_000,
        monthlyContributionMinor: 20_000, targetDate: plusDays(todayInProcessTimeZone(), 180),
      },
    });
    expect(goalCreation.statusCode).toBe(201);
    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/budget-improvements/preferences',
      payload: {
        goal: 'reach_savings_goal',
        categories: [
          { categoryId: 'variable', classification: 'flexible' },
          { categoryId: 'protected-spend', classification: 'protected' },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    const response = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=3' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.baseline.startDate).toBe('2026-08-01');
    expect(response.json().data.baseline.endDate).toBe('2026-10-31');
    expect(response.json().data.proposals).toHaveLength(1);
    expect(response.json().data.proposals[0]).toMatchObject({
      categoryId: 'variable',
      evidence: { signal: 'budget_overrun', budgetedMinor: 10_000, budgetSpentMinor: 15_000 },
    });
    expect(response.json().data.proposals[0].assumptions.join(' ')).toContain('No equivale necesariamente al exceso presupuestario');
    expect(response.json().data.proposals[0]).toMatchObject({
      priorityRank: 1, goalImpact: { goalName: 'Fondo de emergencia' },
    });
    expect(response.json().data.proposals[0].priorityReason).toContain('Fondo de emergencia');
    expect(response.json().data.proposals.some((proposal: { categoryId: string }) => proposal.categoryId === 'protected-spend')).toBe(false);

    const simulation = await app.inject({
      method: 'POST', url: '/api/v1/budget-improvements/simulate',
      payload: { periodMonths: 3, reductions: [{ categoryId: 'variable', reductionPercent: 10 }] },
    });
    expect(simulation.statusCode).toBe(200);
    expect(simulation.json().data.goalImpacts).toContainEqual(expect.objectContaining({
      goalId: goalCreation.json().data.id, goalName: 'Fondo de emergencia',
      scenarioMonthlyContributionMinor: expect.any(Number), projectedBalanceIncreaseMinor: expect.any(Number),
    }));
    const goalImpact = simulation.json().data.goalImpacts[0];
    expect(goalImpact.scenarioMonthlyContributionMinor).toBeGreaterThan(goalImpact.baselineMonthlyContributionMinor);
    expect(goalImpact.estimatedMonthlySavingsAllocatedMinor).toBe(simulation.json().data.simulation.estimatedMonthlySavingsMinor);
    expect(goalImpact.scenarioProjectedBalanceMinor).toBeGreaterThan(goalImpact.baselineProjectedBalanceMinor);
    expect(simulation.json().data.comparison).toMatchObject({
      referenceStartDate: '2026-08-01', referenceEndDate: '2026-10-31',
      improvementMonthlyMinor: simulation.json().data.simulation.estimatedMonthlySavingsMinor,
    });

    const proposalId = response.json().data.proposals[0].id as string;
    for (const decisionStatus of ['accepted', 'postponed', 'rejected'] as const) {
      const decision = await app.inject({
        method: 'PATCH', url: '/api/v1/budget-improvements/decisions',
        payload: { proposalId, status: decisionStatus, periodMonths: 3 },
      });
      expect(decision.statusCode).toBe(200);
      expect(decision.json().data).toMatchObject({ proposalId, status: decisionStatus });
    }
    const withDecision = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=3' });
    expect(withDecision.json().data.decisions).toContainEqual(expect.objectContaining({ proposalId, status: 'rejected' }));
    const stalePeriodDecision = await app.inject({
      method: 'PATCH', url: '/api/v1/budget-improvements/decisions',
      payload: { proposalId, status: 'accepted', periodMonths: 12 },
    });
    expect(stalePeriodDecision.statusCode).toBe(409);

    const scenario = await app.inject({
      method: 'POST', url: '/api/v1/budget-improvements/scenarios',
      payload: { name: 'Ahorro variable', periodMonths: 3, reductions: [{ categoryId: 'variable', reductionPercent: 10 }] },
    });
    expect(scenario.statusCode).toBe(201);
    const scenarioId = scenario.json().data.id as string;
    const withScenario = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=3' });
    expect(withScenario.json().data.scenarios).toContainEqual(expect.objectContaining({
      id: scenarioId, name: 'Ahorro variable', comparisonStatus: 'comparable',
      comparison: expect.objectContaining({
        baselineMonthlySavingsMinor: expect.any(Number),
        estimatedMonthlySavingsMinor: expect.any(Number),
        projectedMonthlySavingsMinor: expect.any(Number),
      }),
    }));
    const differentPeriod = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=6' });
    expect(differentPeriod.json().data.scenarios).toContainEqual(expect.objectContaining({
      id: scenarioId, comparisonStatus: 'different_period', comparison: null,
    }));
    const selectedScope = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['account-1'] },
    });
    expect(selectedScope.statusCode).toBe(200);
    const differentScope = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=3' });
    expect(differentScope.json().data.scenarios).toContainEqual(expect.objectContaining({
      id: scenarioId, comparisonStatus: 'different_scope', comparison: null,
    }));
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/budget-improvements/scenarios/' + scenarioId });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.deleted).toBe(true);
    const afterDelete = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=3' });
    expect(afterDelete.json().data.scenarios.some((item: { id: string }) => item.id === scenarioId)).toBe(false);
  });

  it('prioritizes proposals by the selected budget improvement goal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-goal-priority-'));
    temporaryDirectories.push(directory);
    const expenseCategories: BudgetCategory[] = [
      ...categories,
      { id: 'variable-trend', name: 'Gasto variable con aumento', groupId: 'spend', isIncome: false },
      { id: 'budget-overrun', name: 'Categoría con exceso', groupId: 'spend', isIncome: false },
    ];
    const historical: BudgetTransaction[] = [
      { id: 'trend-aug', account: 'account-1', currencyCode: 'EUR', date: '2026-08-10', amount: -10_000, category: 'variable-trend' },
      { id: 'trend-sep', account: 'account-1', currencyCode: 'EUR', date: '2026-09-10', amount: -10_000, category: 'variable-trend' },
      { id: 'trend-oct', account: 'account-1', currencyCode: 'EUR', date: '2026-10-10', amount: -15_000, category: 'variable-trend' },
      { id: 'overrun-aug', account: 'account-1', currencyCode: 'EUR', date: '2026-08-11', amount: -10_000, category: 'budget-overrun' },
      { id: 'overrun-sep', account: 'account-1', currencyCode: 'EUR', date: '2026-09-11', amount: -10_000, category: 'budget-overrun' },
      { id: 'overrun-oct', account: 'account-1', currencyCode: 'EUR', date: '2026-10-11', amount: -10_000, category: 'budget-overrun' },
    ];
    const repository = Object.assign(createRepository({
      listCategories: vi.fn(async () => expenseCategories),
      listTransactions: vi.fn(async (accountId: string) => accountId === 'account-1' ? [...transactions, ...historical] : []),
    }), {
      getBudgetMonth: vi.fn(async (month: string) => ({
        month,
        categoryGroups: [{
          id: 'spend', name: 'Gastos', is_income: false,
          categories: [
            { id: 'variable-trend', name: 'Gasto variable con aumento', budgeted: 20_000, spent: -15_000, balance: 5_000 },
            { id: 'budget-overrun', name: 'Categoría con exceso', budgeted: 5_000, spent: -10_000, balance: -5_000 },
          ],
        }],
        totalBudgeted: 25_000, totalSpent: -25_000, totalBalance: 0,
      })),
      getBudgetAllocations: vi.fn(async () => [
        { categoryId: 'variable-trend', amountMinor: 20_000 },
        { categoryId: 'budget-overrun', amountMinor: 5_000 },
      ]),
    }) as BudgetRepository;
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/budget-improvements/preferences',
      payload: {
        goal: 'reduce_variable_spending',
        categories: [
          { categoryId: 'variable-trend', classification: 'flexible' },
          { categoryId: 'budget-overrun', classification: 'flexible' },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    const response = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=3' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.proposals.map((proposal: { categoryId: string }) => proposal.categoryId)).toEqual([
      'variable-trend', 'budget-overrun',
    ]);
    expect(response.json().data.proposals[0]).toMatchObject({
      priorityRank: 1, evidence: { signal: 'recent_increase' },
    });
    expect(response.json().data.proposals[1]).toMatchObject({
      priorityRank: 2, evidence: { signal: 'budget_overrun' },
    });
  });

  it('nets refunds into monthly proposal evidence and avoids suggesting cuts from gross charges alone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-improvement-refunds-'));
    temporaryDirectories.push(directory);
    const refundCategory: BudgetCategory = { id: 'refunds', name: 'Compras reembolsadas', groupId: 'spend', isIncome: false };
    const historical: BudgetTransaction[] = [
      { id: 'refunds-aug-expense', account: 'account-1', currencyCode: 'EUR', date: '2026-08-10', amount: -10_000, category: 'refunds' },
      { id: 'refunds-sep-expense', account: 'account-1', currencyCode: 'EUR', date: '2026-09-10', amount: -10_000, category: 'refunds' },
      { id: 'refunds-oct-expense', account: 'account-1', currencyCode: 'EUR', date: '2026-10-10', amount: -15_000, category: 'refunds' },
      { id: 'refunds-oct-refund', account: 'account-1', currencyCode: 'EUR', date: '2026-10-20', amount: 10_000, category: 'refunds' },
    ];
    const repository = Object.assign(createRepository({
      listCategories: vi.fn(async () => [...categories, refundCategory]),
      listTransactions: vi.fn(async (accountId: string) => accountId === 'account-1' ? [...transactions, ...historical] : []),
    }), {
      getBudgetMonth: vi.fn(async (month: string) => ({
        month,
        categoryGroups: [{
          id: 'spend', name: 'Gastos', is_income: false,
          categories: [{ id: 'refunds', name: 'Compras reembolsadas', budgeted: 10_000, spent: -5_000, balance: 5_000 }],
        }],
        totalBudgeted: 10_000, totalSpent: -5_000, totalBalance: 5_000,
      })),
      getBudgetAllocations: vi.fn(async () => [{ categoryId: 'refunds', amountMinor: 10_000 }]),
    }) as BudgetRepository;
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/budget-improvements/preferences',
      payload: { goal: 'reduce_variable_spending', categories: [{ categoryId: 'refunds', classification: 'flexible' }] },
    });
    expect(saved.statusCode).toBe(200);
    const response = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=3' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.categoryBreakdown.find((item: { categoryId: string }) => item.categoryId === 'refunds')).toMatchObject({
      observedExpenseMinor: 25_000, latestMonthExpenseMinor: 5_000, priorMonthsAverageExpenseMinor: 10_000,
      budgetedMinor: 10_000, budgetSpentMinor: 5_000,
    });
    expect(response.json().data.proposals).toEqual([]);
  });

  it('links budget improvement analysis to saved savings goals in the same currency and account scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-improvement-goal-context-'));
    temporaryDirectories.push(directory);
    const today = todayInProcessTimeZone();
    const targetDate = plusDays(today, 180);
    const app = await createTestApp(createRepository(), { ...config, actualDataDir: directory });
    const goal = await app.inject({
      method: 'POST', url: '/api/v1/planning/goals',
      payload: {
        name: 'Fondo de emergencia', targetAmountMinor: 500_000,
        initialAmountMinor: 100_000, monthlyContributionMinor: 20_000, targetDate,
      },
    });
    expect(goal.statusCode).toBe(201);
    const savedGoal = goal.json().data;
    const preferences = await app.inject({
      method: 'PUT', url: '/api/v1/budget-improvements/preferences',
      payload: { goal: 'reach_savings_goal', categories: [{ categoryId: 'food', classification: 'flexible' }] },
    });
    expect(preferences.statusCode).toBe(200);
    const response = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=6' });
    expect(response.statusCode).toBe(200);
    const context = response.json().data;
    expect(context.savingsGoalContextStatus).toBe('ready');
    expect(context.savingsGoals).toContainEqual(expect.objectContaining({
      id: savedGoal.id, name: 'Fondo de emergencia', targetAmountMinor: 500_000,
      monthlyContributionMinor: 20_000, currency: 'EUR', scopeMatches: true, currencyMatches: true,
      projection: expect.objectContaining({
        requiredMonthlyContributionMinor: expect.any(Number),
        projectedBalanceMinor: expect.any(Number),
        projectedProgressPercent: expect.any(Number),
      }),
    }));

    const reviewScope = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['account-1'] },
    });
    expect(reviewScope.statusCode).toBe(200);
    const scoped = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=6' });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().data.savingsGoals.find((item: { id: string }) => item.id === savedGoal.id)).toMatchObject({
      scopeMatches: false, projection: null,
    });
    expect(scoped.json().data.savingsGoalContextStatus).toBe('review_required');

    const restoreAllScope = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts', payload: { mode: 'all', accountIds: [] },
    });
    expect(restoreAllScope.statusCode).toBe(200);
    const changeCurrency = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: { displayCurrency: 'GBP', accountCurrencyOverrides: {}, exchangeRates: [] },
    });
    expect(changeCurrency.statusCode).toBe(200);
    const changedCurrency = await app.inject({ method: 'GET', url: '/api/v1/budget-improvements?periodMonths=6' });
    expect(changedCurrency.statusCode).toBe(200);
    expect(changedCurrency.json().data.savingsGoalContextStatus).toBe('review_required');
    expect(changedCurrency.json().data.savingsGoals.find((item: { id: string }) => item.id === savedGoal.id)).toMatchObject({
      currencyMatches: false, projection: null,
    });
    expect(changedCurrency.json().data.savingsGoalContextWarnings.join(' ')).toContain('divisa guardada');
  });

  it('evaluates budget rules once per month and supports dismissing the event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-alerts-'));
    temporaryDirectories.push(directory);
    const repository = Object.assign(createRepository(), {
      getBudgetMonth: vi.fn(async (month: string) => ({
        month,
        categoryGroups: [{
          id: 'spend', name: 'Gastos', is_income: false,
          categories: [{ id: 'food', name: 'Alimentación', budgeted: 100_000, spent: -120_000, balance: -20_000 }],
        }],
        totalBudgeted: 100_000, totalSpent: -120_000, totalBalance: -20_000,
      })),
      getBudgetAllocations: vi.fn(async () => [{ categoryId: 'food', amountMinor: 100_000 }]),
    }) as BudgetRepository;
    const app = await createTestApp(repository, { ...config, actualDataDir: directory });
    const alertMonth = todayInProcessTimeZone().slice(0, 7);
    const initial = await app.inject({ method: 'GET', url: '/api/v1/budget-alerts?month=' + alertMonth });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data.alerts).toEqual([]);
    expect(initial.json().data.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/budget-alerts/rules',
      payload: { rules: [
        { categoryId: 'food', metric: 'percent_used', threshold: 90, enabled: true },
        { categoryId: 'food', metric: 'overspend_percent', threshold: 10, enabled: true },
      ] },
    });
    expect(saved.statusCode).toBe(200);
    const active = await app.inject({ method: 'GET', url: '/api/v1/budget-alerts?month=' + alertMonth });
    expect(active.statusCode).toBe(200);
    expect(active.json().data.alerts).toHaveLength(2);
    expect(active.json().data.alerts.find((item: { metric: string }) => item.metric === 'percent_used')?.observedValue).toBe(120);
    expect(active.json().data.alerts.find((item: { metric: string }) => item.metric === 'overspend_percent')?.observedValue).toBe(20);

    const event = active.json().data.alerts.find((item: { metric: string }) => item.metric === 'percent_used');
    const dismissed = await app.inject({
      method: 'PATCH', url: '/api/v1/budget-alerts/events/' + event.eventId,
      payload: { ruleId: event.ruleId, categoryId: event.categoryId, month: event.month, status: 'dismissed' },
    });
    expect(dismissed.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/v1/budget-alerts?month=' + alertMonth });
    expect(after.statusCode).toBe(200);
    expect(after.json().data.alerts).toHaveLength(1);
    expect(after.json().data.alerts[0].metric).toBe('overspend_percent');

    const invalidRule = await app.inject({
      method: 'PUT', url: '/api/v1/budget-alerts/rules',
      payload: { rules: [{ categoryId: 'food', metric: 'overspend_minor', threshold: 0, enabled: true }] },
    });
    expect(invalidRule.statusCode).toBe(400);
  });
});



});