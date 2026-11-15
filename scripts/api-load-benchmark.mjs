import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ActualBudgetAdapter } from '../services/actual-adapter/dist/actual-budget-adapter.js';
import { addDocument } from '../services/api/dist/documents-store.js';
import { buildApp } from '../services/api/dist/app.js';
import { writePlanningData } from '../services/api/dist/planning-store.js';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeMode = process.argv.includes('--smoke');
const concurrencyLevels = [1, 5, 10];
const repetitions = readInteger('API_LOAD_REPEATS', smokeMode ? 1 : 3, 1, 10);
const iterationsPerClient = readInteger('API_LOAD_ITERATIONS_PER_CLIENT', smokeMode ? 1 : 5, 1, 100);
const transactionsPerAccount = readInteger('API_LOAD_TRANSACTIONS_PER_ACCOUNT', smokeMode ? 40 : 1_200, 20, 20_000);
const requestTimeoutMs = 15_000;

function readInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum + '.');
  }
  return value;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const shifted = new Date(date + 'T00:00:00.000Z');
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return isoDate(shifted);
}

function monthStart(date, offset = 0) {
  const shifted = new Date(date + 'T00:00:00.000Z');
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + offset);
  return isoDate(shifted);
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

function summarizeLatencies(values) {
  if (values.length === 0) {
    return { sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: Number(sorted[0].toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

function createSyntheticInventory(today) {
  const accounts = Array.from({ length: 4 }, (_, index) => ({
    id: 'synthetic-account-' + String(index + 1).padStart(3, '0'),
    name: 'Synthetic account ' + (index + 1),
    currencyCode: 'EUR',
    closed: false,
    offBudget: false,
    currentBalanceMinor: 250_000 + index * 50_000,
  }));
  const categories = [
    { id: 'salary', name: 'Synthetic income', groupId: 'income', isIncome: true },
    { id: 'food', name: 'Synthetic food', groupId: 'expenses', isIncome: false },
    { id: 'transport', name: 'Synthetic transport', groupId: 'expenses', isIncome: false },
    { id: 'utilities', name: 'Synthetic utilities', groupId: 'expenses', isIncome: false },
  ];
  const transactionsByAccount = new Map();
  for (let accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
    const account = accounts[accountIndex];
    const rows = [];
    for (let index = 0; index < transactionsPerAccount; index += 1) {
      const daysAgo = Math.floor(index * 729 / transactionsPerAccount);
      const income = index % 13 === 0;
      rows.push({
        id: 'synthetic-' + (accountIndex + 1) + '-' + String(index + 1).padStart(5, '0'),
        account: account.id,
        currencyCode: 'EUR',
        date: addDays(today, -daysAgo),
        amount: income ? 125_000 + (index % 7) * 5_000 : -(450 + (index % 31) * 125),
        category: income ? 'salary' : categories[1 + (index % 3)].id,
        payee_name: 'Synthetic payee ' + String((index % 24) + 1).padStart(2, '0'),
        cleared: index % 2 === 0,
      });
    }
    transactionsByAccount.set(account.id, rows);
  }
  return { accounts, categories, transactionsByAccount };
}

function createTrackedApi(inventory, month) {
  const budgetMonth = {
    month,
    totalBudgeted: 180_000,
    totalSpent: -92_000,
    totalBalance: 88_000,
    categoryGroups: [{
      id: 'expenses',
      name: 'Synthetic expenses',
      is_income: false,
      categories: [
        { id: 'food', name: 'Synthetic food', budgeted: 90_000, spent: -48_000, balance: 42_000 },
        { id: 'transport', name: 'Synthetic transport', budgeted: 40_000, spent: -21_000, balance: 19_000 },
        { id: 'utilities', name: 'Synthetic utilities', budgeted: 50_000, spent: -23_000, balance: 27_000 },
      ],
    }],
  };
  const state = { sdkCalls: 0, syncCalls: 0, activeCalls: 0, maxConcurrentSdkCalls: 0 };
  const track = async (operation) => {
    state.sdkCalls += 1;
    state.activeCalls += 1;
    state.maxConcurrentSdkCalls = Math.max(state.maxConcurrentSdkCalls, state.activeCalls);
    try {
      return await operation();
    } finally {
      state.activeCalls -= 1;
    }
  };
  const api = {
    init: async () => track(async () => undefined),
    downloadBudget: async () => track(async () => undefined),
    sync: async () => track(async () => { state.syncCalls += 1; }),
    shutdown: async () => track(async () => undefined),
    getAccounts: async () => track(async () => inventory.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      currency: account.currencyCode,
      closed: account.closed,
      offbudget: account.offBudget,
      balance_current: account.currentBalanceMinor,
    }))),
    getCategories: async () => track(async () => inventory.categories.map((category) => ({
      id: category.id,
      name: category.name,
      group_id: category.groupId,
      is_income: category.isIncome,
    }))),
    getTransactions: async (accountId, startDate, endDate) => track(async () =>
      (inventory.transactionsByAccount.get(accountId) ?? []).filter((row) => row.date >= startDate && row.date <= endDate)),
    getBudgetMonth: async () => track(async () => budgetMonth),
    getBudgetAllocations: async () => track(async () => [
      { categoryId: 'food', amountMinor: 90_000 },
      { categoryId: 'transport', amountMinor: 40_000 },
      { categoryId: 'utilities', amountMinor: 50_000 },
    ]),
    setBudgetAmount: async () => track(async () => null),
    importTransactions: async () => track(async () => ({ errors: [], added: [], updated: [] })),
  };
  return { api, state };
}

async function createSyntheticPlanningState(directory, today) {
  const now = new Date().toISOString();
  const scope = { mode: 'all', accountIds: [] };
  await writePlanningData(directory, {
    version: 1,
    goals: [{
      id: '00000000-0000-4000-8000-000000000101',
      name: 'Synthetic emergency fund',
      targetAmountMinor: 1_000_000,
      initialAmountMinor: 100_000,
      monthlyContributionMinor: 25_000,
      targetDate: addDays(today, 365),
      monthlyIncomeMinor: 250_000,
      monthlyExpenseMinor: 175_000,
      currency: 'EUR',
      scope,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }],
    commitments: [{
      id: '00000000-0000-4000-8000-000000000102',
      title: 'Synthetic recurring bill',
      amountMinor: 8_500,
      date: addDays(today, 5),
      direction: 'expense',
      frequency: 'monthly',
      notes: 'Synthetic benchmark fixture',
      currency: 'EUR',
      scope,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }],
  });
}

async function captureResponse(baseUrl, path, counters) {
  try {
    const response = await fetch(baseUrl + path, { signal: AbortSignal.timeout(requestTimeoutMs) });
    const body = await response.arrayBuffer();
    counters.httpRequests += 1;
    counters.responseBytes += body.byteLength;
    counters.statusCounts[String(response.status)] = (counters.statusCounts[String(response.status)] ?? 0) + 1;
    if (response.status >= 400 && response.status < 500) counters.http4xx += 1;
    if (response.status >= 500) counters.http5xx += 1;
    return response.ok;
  } catch (error) {
    counters.transportErrors += 1;
    if (error instanceof Error && error.name === 'TimeoutError') counters.timeouts += 1;
    return false;
  }
}

async function capturePaths(baseUrl, paths, counters) {
  const results = await Promise.all(paths.map((path) => captureResponse(baseUrl, path, counters)));
  return results.every(Boolean);
}

async function measureRepeat(baseUrl, scenario, concurrency, repeatNumber) {
  const baseline = process.memoryUsage();
  let peakRssDeltaBytes = 0;
  let peakHeapDeltaBytes = 0;
  const sampleMemory = () => {
    const current = process.memoryUsage();
    peakRssDeltaBytes = Math.max(peakRssDeltaBytes, current.rss - baseline.rss, 0);
    peakHeapDeltaBytes = Math.max(peakHeapDeltaBytes, current.heapUsed - baseline.heapUsed, 0);
  };
  const sampler = setInterval(sampleMemory, 10);
  if (typeof sampler.unref === 'function') sampler.unref();
  const counters = {
    httpRequests: 0, responseBytes: 0, http4xx: 0, http5xx: 0,
    transportErrors: 0, timeouts: 0, statusCounts: {},
  };
  const latencies = [];
  const startedAt = performance.now();
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let iteration = 0; iteration < iterationsPerClient; iteration += 1) {
        const operationStartedAt = performance.now();
        const ok = await scenario.execute(baseUrl, counters);
        latencies.push(performance.now() - operationStartedAt);
        if (!ok) counters.logicalFailures = (counters.logicalFailures ?? 0) + 1;
        sampleMemory();
      }
    }));
  } finally {
    sampleMemory();
    clearInterval(sampler);
  }
  const durationMs = performance.now() - startedAt;
  const endingMemory = process.memoryUsage();
  const healthStartedAt = performance.now();
  let healthStatus = null;
  try {
    const health = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(requestTimeoutMs) });
    healthStatus = health.status;
    await health.arrayBuffer();
  } catch {
    healthStatus = null;
  }
  const healthRecoveryMs = Number((performance.now() - healthStartedAt).toFixed(2));
  return {
    repeat: repeatNumber,
    durationMs: Number(durationMs.toFixed(2)),
    logicalOperations: latencies.length,
    ...summarizeLatencies(latencies),
    logicalOperationsPerSecond: Number((latencies.length / (durationMs / 1_000)).toFixed(2)),
    httpRequestsPerSecond: Number((counters.httpRequests / (durationMs / 1_000)).toFixed(2)),
    httpRequests: counters.httpRequests,
    responseBytes: counters.responseBytes,
    http4xx: counters.http4xx,
    http5xx: counters.http5xx,
    transportErrors: counters.transportErrors,
    timeouts: counters.timeouts,
    logicalFailures: counters.logicalFailures ?? 0,
    statusCounts: counters.statusCounts,
    peakObservedRssDeltaBytes: peakRssDeltaBytes,
    peakObservedHeapDeltaBytes: peakHeapDeltaBytes,
    retainedRssDeltaBytes: endingMemory.rss - baseline.rss,
    retainedHeapDeltaBytes: endingMemory.heapUsed - baseline.heapUsed,
    healthRecoveryMs,
    healthStatus,
    _latencies: latencies,
  };
}

function aggregateRepeats(repeats) {
  const latencies = repeats.flatMap((repeat) => repeat._latencies);
  const durations = repeats.map((repeat) => repeat.durationMs);
  const repeatP50s = repeats.map((repeat) => repeat.p50Ms).filter((value) => value !== null);
  const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
  const httpRequests = repeats.reduce((sum, value) => sum + value.httpRequests, 0);
  const logicalOperations = repeats.reduce((sum, value) => sum + value.logicalOperations, 0);
  const statusCounts = {};
  for (const repeat of repeats) {
    for (const [status, count] of Object.entries(repeat.statusCounts)) {
      statusCounts[status] = (statusCounts[status] ?? 0) + count;
    }
  }
  const cleanRepeats = repeats.map(({ _latencies, ...rest }) => rest);
  return {
    repeats: cleanRepeats,
    aggregate: {
      ...summarizeLatencies(latencies),
      repeatP50MedianMs: percentile(repeatP50s, 0.5),
      repeatP50MinMs: repeatP50s.length ? Math.min(...repeatP50s) : null,
      repeatP50MaxMs: repeatP50s.length ? Math.max(...repeatP50s) : null,
      durationMs: Number(totalDurationMs.toFixed(2)),
      logicalOperations,
      logicalOperationsPerSecond: totalDurationMs > 0 ? Number((logicalOperations / (totalDurationMs / 1_000)).toFixed(2)) : 0,
      httpRequestsPerSecond: totalDurationMs > 0 ? Number((httpRequests / (totalDurationMs / 1_000)).toFixed(2)) : 0,
      httpRequests,
      responseBytes: repeats.reduce((sum, value) => sum + value.responseBytes, 0),
      http4xx: repeats.reduce((sum, value) => sum + value.http4xx, 0),
      http5xx: repeats.reduce((sum, value) => sum + value.http5xx, 0),
      transportErrors: repeats.reduce((sum, value) => sum + value.transportErrors, 0),
      timeouts: repeats.reduce((sum, value) => sum + value.timeouts, 0),
      logicalFailures: repeats.reduce((sum, value) => sum + value.logicalFailures, 0),
      statusCounts,
      peakObservedRssDeltaBytes: Math.max(...repeats.map((value) => value.peakObservedRssDeltaBytes)),
      peakObservedHeapDeltaBytes: Math.max(...repeats.map((value) => value.peakObservedHeapDeltaBytes)),
      retainedRssDeltaBytesByRepeat: repeats.map((value) => value.retainedRssDeltaBytes),
      retainedHeapDeltaBytesByRepeat: repeats.map((value) => value.retainedHeapDeltaBytes),
      healthRecoveryMs: repeats.map((value) => value.healthRecoveryMs),
      healthStatuses: repeats.map((value) => value.healthStatus),
    },
  };
}

async function main() {
  const createdAt = new Date();
  const today = isoDate(createdAt);
  const month = today.slice(0, 7);
  const previousMonthEnd = addDays(monthStart(today), -1);
  const previousMonthStart = monthStart(previousMonthEnd);
  const yearHistoryStart = addDays(today, -364);
  const intelligenceStart = addDays(today, -29);
  const inventory = createSyntheticInventory(today);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'personal-budget-api-load-'));
  const appDataDirectory = join(temporaryDirectory, 'app-state');
  const adapterDataDirectory = join(temporaryDirectory, 'adapter-state');
  const { api, state: syntheticApiMetrics } = createTrackedApi(inventory, month);
  const repository = new ActualBudgetAdapter({
    serverURL: 'http://127.0.0.1:5006',
    dataDir: adapterDataDirectory,
    budgetId: 'synthetic-budget-id',
  }, api);
  let app;
  let appStarted = false;
  try {
    await mkdir(appDataDirectory, { recursive: true, mode: 0o700 });
    await chmod(appDataDirectory, 0o700).catch(() => undefined);
    await createSyntheticPlanningState(appDataDirectory, today);
    const document = await addDocument(appDataDirectory,
      Buffer.from('%PDF-1.4\n% Synthetic benchmark evidence\n%%EOF\n', 'ascii'),
      { displayName: 'Synthetic benchmark receipt', documentDate: today, classification: 'receipt', tags: ['synthetic'] });
    const config = {
      environment: 'production',
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      actualServerURL: 'http://127.0.0.1:5006',
      actualDataDir: appDataDirectory,
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
      allowedOrigins: ['http://127.0.0.1:4173'],
    };
    app = await buildApp({ repository, config, logger: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    appStarted = true;
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('The synthetic API did not bind a loopback TCP port.');
    const baseUrl = 'http://127.0.0.1:' + address.port;
    const yearHistoryQuery = '?startDate=' + yearHistoryStart + '&endDate=' + today;
    const reportCurrentQuery = '?startDate=' + monthStart(today) + '&endDate=' + today;
    const reportPreviousQuery = '?startDate=' + previousMonthStart + '&endDate=' + previousMonthEnd;
    const intelligenceQuery = '?startDate=' + intelligenceStart + '&endDate=' + today;

    const scenarios = [
      {
        id: 'dashboard-overview',
        description: 'Parallel overview reads: accounts, categories, preferences, summary and current budget. Does not call the transaction-list endpoint.',
        execute: (url, counters) => capturePaths(url, [
          '/api/v1/accounts',
          '/api/v1/categories',
          '/api/v1/preferences/accounts',
          '/api/v1/preferences/currency',
          '/api/v1/preferences/app',
          '/api/v1/reports/summary' + yearHistoryQuery,
          '/api/v1/budgets/' + month,
        ], counters),
      },
      {
        id: 'reports-comparison',
        description: 'Current-month and previous-month report summaries requested concurrently.',
        execute: (url, counters) => capturePaths(url, [
          '/api/v1/reports/summary' + reportCurrentQuery,
          '/api/v1/reports/summary' + reportPreviousQuery,
        ], counters),
      },
      {
        id: 'monthly-budget',
        description: 'Budget month and category allocation read through the synthetic adapter.',
        execute: (url, counters) => capturePaths(url, ['/api/v1/budgets/' + month], counters),
      },
      {
        id: 'planning',
        description: 'Planning dashboard with synthetic goals, commitments, 12-month history and current-month occurrences.',
        execute: (url, counters) => capturePaths(url, ['/api/v1/planning?month=' + month], counters),
      },
      {
        id: 'financial-intelligence',
        description: 'Deterministic findings over synthetic current-period, anomaly and recurring-payment history.',
        execute: (url, counters) => capturePaths(url, ['/api/v1/intelligence/findings' + intelligenceQuery], counters),
      },
      {
        id: 'local-state-and-documents',
        description: 'Local wealth state, document index and one synthetic document binary read.',
        execute: (url, counters) => capturePaths(url, [
          '/api/v1/wealth',
          '/api/v1/wealth/summary',
          '/api/v1/documents',
          '/api/v1/documents/' + document.id + '/file',
        ], counters),
      },
    ];

    const results = [];
    for (const scenario of scenarios) {
      const warmup = { httpRequests: 0, responseBytes: 0, http4xx: 0, http5xx: 0, transportErrors: 0, timeouts: 0, statusCounts: {} };
      if (!await scenario.execute(baseUrl, warmup)) {
        throw new Error('Synthetic warm-up failed for scenario ' + scenario.id + '.');
      }
      for (const concurrency of concurrencyLevels) {
        const measured = [];
        for (let repetition = 1; repetition <= repetitions; repetition += 1) {
          measured.push(await measureRepeat(baseUrl, scenario, concurrency, repetition));
        }
        results.push({
          scenario: scenario.id,
          description: scenario.description,
          concurrency,
          iterationsPerClient,
          ...aggregateRepeats(measured),
        });
      }
    }

    const totalHttp4xx = results.reduce((sum, item) => sum + item.aggregate.http4xx, 0);
    const totalHttp5xx = results.reduce((sum, item) => sum + item.aggregate.http5xx, 0);
    const totalTransportErrors = results.reduce((sum, item) => sum + item.aggregate.transportErrors, 0);
    const report = {
      schemaVersion: 1,
      benchmark: 'personal-budget-api-load',
      createdAt: createdAt.toISOString(),
      mode: smokeMode ? 'ci-smoke' : 'opt-in-full',
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        logicalCpuCount: cpus().length,
        mode: 'compiled Fastify API with synthetic in-memory Actual API contract',
      },
      fixture: {
        accounts: inventory.accounts.length,
        categories: inventory.categories.length,
        transactionsPerAccount,
        totalSyntheticTransactions: inventory.accounts.length * transactionsPerAccount,
        historyDays: 730,
        planningGoals: 1,
        planningCommitments: 1,
        localDocuments: 1,
        externalServicesEnabled: false,
        actualServerContacted: false,
      },
      methodology: {
        concurrencyLevels,
        repetitions,
        iterationsPerClient,
        requestTimeoutMs,
        memorySamplingIntervalMs: 10,
        metricsAreObservationsNotThresholds: true,
        excludesTransactionPaginationBenchmark28: true,
        storesNoResponseBodiesOrFinancialRows: true,
      },
      syntheticAdapter: {
        sdkCalls: syntheticApiMetrics.sdkCalls,
        syncCalls: syntheticApiMetrics.syncCalls,
        maxConcurrentSdkCalls: syntheticApiMetrics.maxConcurrentSdkCalls,
        note: 'The adapter queue is real; the upstream SDK is synthetic and in-memory. These timings are not Actual server latency.',
      },
      results,
      outcome: {
        successful: totalHttp4xx === 0 && totalHttp5xx === 0 && totalTransportErrors === 0 &&
          results.every((item) => item.aggregate.logicalFailures === 0 && item.aggregate.healthStatuses.every((status) => status === 200)),
        logicalFailures: results.reduce((sum, item) => sum + item.aggregate.logicalFailures, 0),
        http4xx: totalHttp4xx,
        http5xx: totalHttp5xx,
        transportErrors: totalTransportErrors,
      },
    };

    const outputDirectory = join(repositoryRoot, '.local', 'benchmarks');
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await chmod(outputDirectory, 0o700).catch(() => undefined);
    const outputName = 'api-load-' + createdAt.toISOString().replace(/[:.]/g, '-') + '.json';
    const outputPath = join(outputDirectory, outputName);
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await chmod(outputPath, 0o600).catch(() => undefined);
    process.stdout.write(JSON.stringify({
      output: '.local/benchmarks/' + outputName,
      mode: report.mode,
      fixture: report.fixture,
      scenarios: results.map((item) => ({
        scenario: item.scenario,
        concurrency: item.concurrency,
        p50Ms: item.aggregate.p50Ms,
        p95Ms: item.aggregate.p95Ms,
        p99Ms: item.aggregate.p99Ms,
        logicalOperationsPerSecond: item.aggregate.logicalOperationsPerSecond,
        peakObservedRssDeltaBytes: item.aggregate.peakObservedRssDeltaBytes,
        peakObservedHeapDeltaBytes: item.aggregate.peakObservedHeapDeltaBytes,
        errors: item.aggregate.http4xx + item.aggregate.http5xx + item.aggregate.transportErrors,
      })),
      syntheticAdapter: report.syntheticAdapter,
      outcome: report.outcome,
    }, null, 2) + '\n');
    if (!report.outcome.successful) process.exitCode = 1;
  } finally {
    try {
      if (appStarted && app) await app.close();
    } finally {
      try { await repository.close().catch(() => undefined); }
      finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
    }
  }
}

main().catch((error) => {
  process.stderr.write('Synthetic API load benchmark failed: ' +
    (error instanceof Error ? error.message : 'unknown error') + '\n');
  process.exitCode = 1;
});
