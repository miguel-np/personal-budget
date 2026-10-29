import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import { buildPeriodChangeFindings, buildUncategorizedFinding, calculateSummary, convertAmountMinor, createFinancialFinding, detectRecurringCandidates, estimatePlanningCashFlow, expandCommitmentOccurrences, isIsoDate, normalizeCurrencyCode, normalizeTransactions, projectSavings, projectSavingsGoal, sortFinancialFindings, suggestCategories, validatePeriod } from '@personal-budget/finance-core';
import type { BudgetRepository, BudgetTransaction, FinancialFinding, FindingPriority, ForecastScenario, PlanningCommitment, TransactionCategoryBatchChange, TransactionStructureUpdate } from '@personal-budget/finance-core';
import { ActualAdapterError } from '@personal-budget/actual-adapter';
import type { ActualBudgetMonthRecord, ActualImportRecord, ActualImportResult } from '@personal-budget/actual-adapter';
import { z, ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { LocalAiBusyError, LocalAiCancelledError, LocalAiClient, LocalAiContextBudgetError, LocalAiUnavailableError } from './local-ai.js';
import type { AssistantContext } from './local-ai.js';
import { CurrencyPreferencesSchema, defaultCurrencyPreferences, readCurrencyPreferences, writeCurrencyPreferences } from './currency-preferences.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import { AccountScopeError, AccountScopePreferenceSchema, defaultAccountScope, readAccountScope, resolveAccountScope, writeAccountScope } from './account-scope.js';
import { AppPreferencesSchema, defaultAppPreferences, readAppPreferences, writeAppPreferences } from './app-preferences.js';
import type { AccountScopePreference, AccountScopeMetadata } from './account-scope.js';
import { PlanningCommitmentInputSchema, PlanningGoalInputSchema, readPlanningData, resetPlanningData, updatePlanningData, StoredPlanningCommitmentSchema, StoredPlanningGoalSchema } from './planning-store.js';
import type { StoredPlanningCommitment } from './planning-store.js';
import { effectiveFindingReview, readFindingReviewState, updateFindingReviewState } from './intelligence-store.js';


const TransactionQuerySchema = z.object({
  accountId: z.string().trim().min(1).max(128).optional(),
  categoryId: z.string().trim().min(1).max(128).optional(),
  search: z.string().trim().max(200).optional(),
  uncategorized: z.enum(['true', 'false']).optional(),
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  sortBy: z.enum(['date', 'amount', 'description']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict();
const SummaryQuerySchema = z.object({
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
}).strict();
const ImportRecordSchema = z.object({
  date: z.string().refine(isIsoDate, 'date must be a valid YYYY-MM-DD date.'),
  amount: z.number().int().refine(Number.isSafeInteger, 'amount must be a safe integer.').refine((amount) => amount !== 0, 'amount cannot be zero.'),
  payee_name: z.string().trim().min(1).max(200),
  imported_payee: z.string().trim().max(500).optional(),
  category: z.string().trim().min(1).max(128).optional(),
  notes: z.string().max(2_000).optional(),
  imported_id: z.string().trim().min(1).max(500),
}).strict();
const ImportRequestSchema = z.object({
  accountId: z.string().trim().min(1).max(128),
  sourceFormat: z.literal('ofx').optional(),
  sourceCurrencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'sourceCurrencyCode must be an ISO-style currency code.').optional(),
  allowUnverifiedCurrency: z.boolean().optional().default(false),
  records: z.array(ImportRecordSchema).min(1).max(2_000),
}).strict().superRefine((request, context) => {
  if (request.sourceFormat !== 'ofx' && (request.sourceCurrencyCode !== undefined || request.allowUnverifiedCurrency)) {
    context.addIssue({
      code: 'custom',
      path: ['sourceFormat'],
      message: 'OFX currency metadata requires sourceFormat=ofx.',
    });
  }
});
const TransferRequestSchema = z.object({
  sourceAccountId: z.string().trim().min(1).max(128),
  destinationAccountId: z.string().trim().min(1).max(128),
  date: z.string().refine(isIsoDate, 'date must be a valid YYYY-MM-DD date.'),
  amountMinor: z.number().int().refine(Number.isSafeInteger, 'amount must be a safe integer.').positive().max(Number.MAX_SAFE_INTEGER),
  notes: z.string().max(2_000).optional(),
  importedId: z.string().trim().min(1).max(500),
}).strict();
const BudgetMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must use YYYY-MM.');
const BudgetAmountSchema = z.object({ amountMinor: z.number().int().refine(Number.isSafeInteger, 'amount must be a safe integer.').min(0) }).strict();
const InsightsQuerySchema = z.object({
  accountId: z.string().trim().min(1).max(128).optional(),
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
}).strict();
const FinancialFindingContractSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(200),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  type: z.enum(['expense-change', 'income-change', 'budget-overspend', 'pending-categorization', 'commitment-upcoming', 'recurring-candidate-upcoming', 'goal-at-risk', 'goal-progress']),
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(2_000),
  period: z.object({
    startDate: z.string().refine(isIsoDate),
    endDate: z.string().refine(isIsoDate),
  }).strict().superRefine((period, context) => {
    if (period.startDate > period.endDate) context.addIssue({ code: 'custom', path: ['endDate'], message: 'Finding period is inverted.' });
  }),
  accountScope: z.object({
    mode: z.enum(['all', 'selected']),
    accountIds: z.array(z.string().min(1).max(128)).max(2_000),
    label: z.string().min(1).max(500),
  }).strict(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  confidence: z.enum(['observed', 'estimated', 'candidate', 'suggestion']),
  priority: z.enum(['low', 'medium', 'high']),
  priorityReason: z.string().min(1).max(500),
  impactMinor: z.number().int().nonnegative().refine(Number.isSafeInteger).nullable(),
  metrics: z.record(z.string().max(100), z.union([z.number().finite(), z.string().max(1_000), z.boolean(), z.null()])),
  evidence: z.array(z.object({
    label: z.string().min(1).max(200),
    value: z.union([z.number().finite(), z.string().max(1_000)]),
    source: z.string().min(1).max(200),
    rule: z.string().min(1).max(1_000),
  }).strict()).max(100),
  limitations: z.array(z.string().min(1).max(1_000)).max(100),
  calculatedAt: z.string().datetime(),
  reviewStatus: z.enum(['new', 'reviewed', 'dismissed', 'snoozed']),
  snoozedUntil: z.string().refine(isIsoDate).optional(),
  navigationTarget: z.enum(['/reports', '/movements', '/budgets', '/planning', '/goals']),
}).strict().superRefine((finding, context) => {
  if (finding.reviewStatus === 'snoozed' && !finding.snoozedUntil) {
    context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Snoozed findings require an expiry date.' });
  }
  if (finding.reviewStatus !== 'snoozed' && finding.snoozedUntil !== undefined) {
    context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Only snoozed findings may have an expiry date.' });
  }
});
const IntelligenceDatesSchema = z.object({
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
}).strict();
const IntelligenceReviewRequestSchema = IntelligenceDatesSchema.extend({
  findingId: z.string().trim().min(1).max(200),
  status: z.enum(['reviewed', 'dismissed', 'snoozed']),
  snoozedUntil: z.string().refine(isIsoDate, 'snoozedUntil must be a valid YYYY-MM-DD date.').optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'snoozed' && !value.snoozedUntil) {
    context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Choose an expiry date to postpone a finding.' });
  }
  if (value.status !== 'snoozed' && value.snoozedUntil !== undefined) {
    context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Only snoozed findings may have an expiry date.' });
  }
});
const IntelligenceExplainRequestSchema = IntelligenceDatesSchema.extend({
  findingId: z.string().trim().min(1).max(200),
}).strict();
const CategorizeRequestSchema = z.object({
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
  commit: z.boolean().default(false),
  transactions: z.array(z.object({
    transactionId: z.string().trim().min(1).max(128),
    categoryId: z.string().trim().min(1).max(128),
    expectedCategoryId: z.string().trim().min(1).max(128).nullable().optional(),
  }).strict()).min(1).max(200).superRefine((changes, context) => {
    const seen = new Set<string>();
    changes.forEach((change, index) => {
      if (seen.has(change.transactionId)) context.addIssue({ code: 'custom', path: [index, 'transactionId'], message: 'Transaction ids must be unique.' });
      seen.add(change.transactionId);
    });
  }),
}).strict().superRefine((value, context) => {
  if (!value.commit) return;
  value.transactions.forEach((change, index) => {
    if (change.expectedCategoryId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['transactions', index, 'expectedCategoryId'],
        message: 'A confirmed category batch must include its preview baseline.',
      });
    }
  });
});
const TransactionUpdateRequestSchema = z.object({
  accountId: z.string().trim().min(1).max(128),
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
  syncTransferDate: z.boolean().optional().default(false),
  changes: z.object({
    date: z.string().refine(isIsoDate, 'date must be a valid YYYY-MM-DD date.').optional(),
    amount: z.number().int().refine(Number.isSafeInteger, 'amount must be a safe integer.').refine((amount) => amount !== 0, 'amount cannot be zero.').optional(),
    imported_payee: z.string().max(500).transform((value) => value.trim()).optional(),
    category: z.string().trim().min(1).max(128).nullable().optional(),
    notes: z.string().max(2_000).optional(),
    cleared: z.boolean().optional(),
  }).strict().refine((fields) => Object.keys(fields).length > 0, 'At least one supported field must change.'),
}).strict();
const ResetPreferencesRequestSchema = z.object({ confirmation: z.literal('RESET_APP_PREFERENCES') }).strict();
const ForecastScenarioSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('category_reduction'), categoryId: z.string().trim().min(1).max(128), percent: z.number().min(0).max(100) }).strict(),
  z.object({ type: z.literal('income_change'), percent: z.number().min(-100).max(1000) }).strict(),
]);
const ForecastRequestSchema = z.object({
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
  horizonMonths: z.number().int().min(1).max(60),
  scenario: ForecastScenarioSchema,
}).strict();
const PlanningMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must use YYYY-MM.');
const PlanningStatusRequestSchema = z.object({ status: z.enum(['active', 'paused']) }).strict();
const SafeMinorAmountSchema = z.number().int().refine(Number.isSafeInteger, 'Amounts must be safe integers in minor currency units.');
const PlanningScenarioRequestSchema = z.object({
  monthlyContributionMinor: SafeMinorAmountSchema.nonnegative(),
  monthlyIncomeMinor: SafeMinorAmountSchema,
  monthlyExpenseMinor: SafeMinorAmountSchema.nonnegative(),
}).strict();
const DeletePlanningDataRequestSchema = z.object({ confirmation: z.literal('DELETE_PLANNING_DATA') }).strict();
const AssistantRequestSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
  previousStartDate: z.string().refine(isIsoDate, 'previousStartDate must be a valid YYYY-MM-DD date.').optional(),
  previousEndDate: z.string().refine(isIsoDate, 'previousEndDate must be a valid YYYY-MM-DD date.').optional(),
  accountId: z.string().trim().min(1).max(128).optional(),
}).strict().superRefine((value, context) => {
  if ((value.previousStartDate === undefined) !== (value.previousEndDate === undefined)) {
    context.addIssue({ code: 'custom', message: 'Both previous period dates must be supplied together.' });
  }
});
const MAX_REPORT_DAYS = 366 * 5;
const MAX_TRANSACTION_SCAN = 100_000;

/**
 * The official Actual SDK has no cursor API. Query one calendar month at a time so
 * a multi-year history never has to be materialized as one SDK result. The route
 * stops scanning after MAX_TRANSACTION_SCAN presented rows and does not fetch later
 * months once that budget is exhausted.
 */
function* transactionDateRanges(startDate: string, endDate: string): Generator<{ startDate: string; endDate: string }> {
  let cursor = startDate;
  while (cursor <= endDate) {
    const boundary = new Date(cursor + 'T00:00:00.000Z');
    boundary.setUTCDate(1);
    boundary.setUTCMonth(boundary.getUTCMonth() + 1);
    boundary.setUTCDate(0);
    const monthEnd = boundary.toISOString().slice(0, 10);
    const rangeEnd = monthEnd < endDate ? monthEnd : endDate;
    yield { startDate: cursor, endDate: rangeEnd };
    const next = new Date(rangeEnd + 'T00:00:00.000Z');
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
}

class TransactionQueryTooBroadError extends Error {
  public constructor() {
    super('The transaction query exceeded the bounded scan budget.');
    this.name = 'TransactionQueryTooBroadError';
  }
}

export interface AppDependencies {
  readonly repository: BudgetRepository;
  readonly config: AppConfig;
  readonly logger?: FastifyServerOptions['logger'];
}

function isWithinMaximumPeriod(startDate: string, endDate: string): boolean {
  const start = Date.parse(startDate + 'T00:00:00.000Z');
  const end = Date.parse(endDate + 'T00:00:00.000Z');
  return end >= start && Math.floor((end - start) / 86_400_000) <= MAX_REPORT_DAYS;
}

function sanitizedErrorResponse(error: unknown): { statusCode: number; body: { error: { code: string; message: string } } } {
  if (error instanceof AccountScopeError) {
    return { statusCode: 400, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof ZodError) {
    return { statusCode: 400, body: { error: { code: 'INVALID_REQUEST', message: 'Request parameters are invalid.' } } };
  }
  if (error instanceof ActualAdapterError) {
    if (error.code === 'INVALID_INPUT') return { statusCode: 400, body: { error: { code: error.code, message: error.message } } };
    if (error.code === 'NOT_CONFIGURED') return { statusCode: 503, body: { error: { code: error.code, message: 'The local Actual Budget connection is not configured.' } } };
    if (error.code === 'CLOSED') return { statusCode: 503, body: { error: { code: error.code, message: 'The local Actual Budget connection is closed.' } } };
  }
  if (error instanceof RangeError || (error instanceof Error && error.name === 'InvalidPeriodError')) {
    return { statusCode: 400, body: { error: { code: 'INVALID_PERIOD', message: error.message } } };
  }
  return { statusCode: 502, body: { error: { code: 'UPSTREAM_FAILURE', message: 'The local finance service could not complete this request.' } } };
}

function assertPeriod(startDate: string, endDate: string): void {
  validatePeriod({ startDate, endDate });
  if (!isWithinMaximumPeriod(startDate, endDate)) throw new RangeError('The requested period cannot exceed five years.');
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { repository, config } = dependencies;
  const app = Fastify({
    logger: dependencies.logger ?? {
      level: config.logLevel,
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["set-cookie"]'], censor: '[REDACTED]' },
      serializers: { req(request) { return { method: request.method, id: request.id }; } },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 128 },
    forceCloseConnections: true,
  });

  const localAi = new LocalAiClient({
    enabled: config.aiEnabled,
    baseURL: config.ollamaBaseURL,
    ...(config.ollamaModel ? { model: config.ollamaModel } : {}),
    timeoutMs: config.ollamaTimeoutMs,
    maxContextChars: config.aiMaxContextChars,
  }, fetch, (metric) => {
    app.log.info({ component: 'local-ai', ...metric }, 'Local AI request metrics.');
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed.' } });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = sanitizedErrorResponse(error);
    if (normalized.statusCode >= 500) {
      request.log.error({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed.');
    }
    return reply.code(normalized.statusCode).send(normalized.body);
  });

  app.get('/health', async () => ({ status: 'ok', service: 'personal-budget-api' }));
  app.get('/ready', async (_request, reply) => {
    if (!repository.isConfigured) return reply.code(503).send({ status: 'not_configured' });
    return { status: 'configured' };
  });


  async function currencyPreferences(): Promise<CurrencyPreferences> {
    return readCurrencyPreferences(config.actualDataDir, config.budgetCurrency);
  }

  async function accountScopePreference(): Promise<AccountScopePreference> {
    return readAccountScope(config.actualDataDir);
  }

  function accountNativeCurrency(
    account: { readonly id: string; readonly currencyCode?: string | null },
    preferences: CurrencyPreferences,
  ): string | null {
    return normalizeCurrencyCode(account.currencyCode) ??
      normalizeCurrencyCode(preferences.accountCurrencyOverrides[account.id]);
  }

  function withNativeCurrency(
    transaction: BudgetTransaction,
    nativeCurrency: string | null,
  ): BudgetTransaction {
    const explicit = normalizeCurrencyCode(transaction.currencyCode) ??
      normalizeCurrencyCode(transaction.currency_code);
    const currencyCode = explicit ?? nativeCurrency;
    return {
      ...transaction,
      currencyCode,
      ...(transaction.subtransactions === undefined ? {} : {
        subtransactions: transaction.subtransactions.map((child) => withNativeCurrency(child, explicit ?? nativeCurrency)),
      }),
    };
  }

  async function transactionsForAccounts(
    accounts: readonly { readonly id: string; readonly currencyCode?: string | null }[],
    startDate: string,
    endDate: string,
    preferences: CurrencyPreferences,
  ): Promise<readonly BudgetTransaction[]> {
    const groups = await Promise.all(accounts.map(async (account) => {
      const nativeCurrency = accountNativeCurrency(account, preferences);
      const transactions = await repository.listTransactions(account.id, startDate, endDate);
      return transactions.map((transaction) => withNativeCurrency(transaction, nativeCurrency));
    }));
    return groups.flat();
  }

  function convertTransactionsForAnalysis(
    transactions: readonly BudgetTransaction[],
    preferences: CurrencyPreferences,
  ): { readonly transactions: readonly BudgetTransaction[]; readonly warnings: readonly string[] } {
    const converted: BudgetTransaction[] = [];
    let unconvertedCount = 0;
    let firstWarning: string | undefined;
    const convertOne = (transaction: BudgetTransaction): BudgetTransaction | null => {
      const sourceCurrency = normalizeCurrencyCode(transaction.currencyCode) ??
        normalizeCurrencyCode(transaction.currency_code);
      if (transaction.subtransactions && transaction.subtransactions.length > 0) {
        const children = transaction.subtransactions.map(convertOne).filter((child): child is BudgetTransaction => child !== null);
        if (children.length === 0) return null;
        return { ...transaction, amount: children.reduce((sum, child) => sum + child.amount, 0), currencyCode: preferences.displayCurrency, subtransactions: children };
      }
      const conversion = convertAmountMinor(
        transaction.amount,
        sourceCurrency,
        preferences.displayCurrency,
        transaction.date,
        preferences.exchangeRates,
      );
      if (conversion.amountMinor === null) {
        unconvertedCount += 1;
        if (!firstWarning && conversion.warning) firstWarning = conversion.warning;
        return null;
      }
      return { ...transaction, amount: conversion.amountMinor, currencyCode: preferences.displayCurrency, currency_code: preferences.displayCurrency };
    };
    for (const transaction of transactions) {
      if (transaction.is_child === true || transaction.parent_id) continue;
      const item = convertOne(transaction);
      if (item) converted.push(item);
    }
    return {
      transactions: converted,
      warnings: unconvertedCount === 0 ? [] : [
        unconvertedCount + ' movimiento(s) no se consolidaron por falta de divisa nativa o tipo de cambio válido.',
        ...(firstWarning ? [firstWarning] : []),
      ],
    };
  }

  app.get('/api/v1/assistant/status', async () => localAi.status());

  app.post('/api/v1/assistant/chat', async (request, reply) => {
    const requestAbort = new AbortController();
    const abortRequest = () => requestAbort.abort();
    const abortResponse = () => { if (!reply.raw.writableEnded) requestAbort.abort(); };
    request.raw.once('aborted', abortRequest);
    reply.raw.once('close', abortResponse);
    try {
      const query = AssistantRequestSchema.parse(request.body);
      assertPeriod(query.startDate, query.endDate);
      if (query.previousStartDate && query.previousEndDate) {
        assertPeriod(query.previousStartDate, query.previousEndDate);
      }
      if (!config.aiEnabled) {
        return reply.code(503).send({ error: { code: 'AI_DISABLED', message: 'El asistente local está desactivado. La aplicación financiera sigue disponible.' } });
      }
      const status = await localAi.status(requestAbort.signal);
      if (status.status !== 'available') {
        return reply.code(503).send({ error: { code: 'AI_UNAVAILABLE', message: 'Ollama o el modelo configurado no están disponibles en local.' } });
      }
      const [allAccounts, categories, preferences, preference] = await Promise.all([
        repository.listAccounts(), repository.listCategories(), currencyPreferences(), accountScopePreference(),
      ]);
      const scope = resolveAccountScope(allAccounts, preference, query.accountId);
      const accounts = scope.accounts;
      const summarize = async (startDate: string, endDate: string) => {
        const transactions = await transactionsForAccounts(accounts, startDate, endDate, preferences);
        return calculateSummary(normalizeTransactions(transactions), categories, {
          startDate, endDate, currency: preferences.displayCurrency, exchangeRates: preferences.exchangeRates,
        });
      };
      const summary = await summarize(query.startDate, query.endDate);
      const comparison = query.previousStartDate && query.previousEndDate
        ? await summarize(query.previousStartDate, query.previousEndDate) : undefined;
      const context: AssistantContext = {
        question: query.question,
        deduplicationKey: JSON.stringify({
          accountIds: scope.accounts.map((account) => account.id).sort(),
          currency: summary.currency,
          period: [query.startDate, query.endDate],
          comparison: [query.previousStartDate ?? null, query.previousEndDate ?? null],
        }),
        summary: {
          currency: summary.currency, startDate: summary.startDate, endDate: summary.endDate,
          incomeMinor: summary.incomeMinor, expenseMinor: summary.expenseMinor,
          savingsMinor: summary.savingsMinor, savingsRatePercent: summary.savingsRatePercent,
          transactionCount: summary.transactionCount, excludedTransferCount: summary.excludedTransferCount,
          unconvertedTransactionCount: summary.unconvertedTransactionCount, warnings: summary.warnings,
        },
        expensesByCategory: summary.expensesByCategory.slice(0, 15).map((item) => ({
          categoryName: item.categoryName, amountMinor: item.amountMinor, transactionCount: item.transactionCount,
        })),
        ...(comparison ? { comparison: {
          startDate: comparison.startDate, endDate: comparison.endDate,
          incomeMinor: comparison.incomeMinor, expenseMinor: comparison.expenseMinor, savingsMinor: comparison.savingsMinor,
        } } : {}),
      };
      const answer = await localAi.explain(context, requestAbort.signal);
      return { data: { summary, ...(comparison ? { comparison } : {}), answer, answerKind: 'qualitative_explanation', accountScope: scope.metadata } };
    } catch (error) {
      if (error instanceof LocalAiCancelledError) {
        if (request.raw.aborted || reply.raw.destroyed) return;
        return reply.code(499).send({ error: { code: 'AI_CANCELLED', message: 'La consulta local se ha cancelado.' } });
      }
      if (error instanceof LocalAiBusyError) {
        return reply.code(503).header('retry-after', '1').send({
          error: { code: 'AI_BUSY', message: 'El asistente local está ocupado; vuelve a intentarlo en unos segundos.' },
        });
      }
      if (error instanceof LocalAiContextBudgetError) {
        return reply.code(413).send({ error: { code: 'AI_CONTEXT_TOO_LARGE', message: 'El contexto de la consulta supera el límite local permitido.' } });
      }
      if (error instanceof LocalAiUnavailableError) {
        return reply.code(503).send({ error: { code: 'AI_UNAVAILABLE', message: 'Ollama no ha podido completar la explicación local.' } });
      }
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    } finally {
      request.raw.removeListener('aborted', abortRequest);
      reply.raw.removeListener('close', abortResponse);
    }
  });

  app.get('/api/v1/accounts', async (_request, reply) => {
    try {
      const [accounts, preferences] = await Promise.all([repository.listAccounts(), currencyPreferences()]);
      const today = new Date().toISOString().slice(0, 10);
      return { data: accounts.map((account) => {
        const nativeCurrencyCode = normalizeCurrencyCode(account.currencyCode);
        const currencyCode = accountNativeCurrency(account, preferences);
        const conversion = account.currentBalanceMinor === null || currencyCode === null
          ? null
          : convertAmountMinor(account.currentBalanceMinor, currencyCode, preferences.displayCurrency, today, preferences.exchangeRates);
        return {
          ...account, nativeCurrencyCode, currencyCode, displayCurrency: preferences.displayCurrency,
          displayBalanceMinor: conversion?.amountMinor ?? null,
          balanceConversion: conversion ? {
            fromCurrency: conversion.fromCurrency, toCurrency: conversion.toCurrency, rate: conversion.rate,
            effectiveDate: conversion.effectiveDate, source: conversion.source, inverseRate: conversion.inverseRate,
            ...(conversion.warning ? { warning: conversion.warning } : {}),
          } : { warning: currencyCode === null ? 'La divisa nativa es desconocida.' : 'El saldo no está disponible.' },
        };
      }) };
    } catch (error) { const normalized = sanitizedErrorResponse(error); return reply.code(normalized.statusCode).send(normalized.body); }
  });
  app.get('/api/v1/categories', async (_request, reply) => {
    try { return { data: await repository.listCategories() }; }
    catch (error) { const normalized = sanitizedErrorResponse(error); return reply.code(normalized.statusCode).send(normalized.body); }
  });
  app.get('/api/v1/preferences/accounts', async (_request, reply) => {
    try {
      const [accounts, preference] = await Promise.all([repository.listAccounts(), accountScopePreference()]);
      try {
        const resolved = resolveAccountScope(accounts, preference);
        return { data: { ...preference, label: resolved.metadata.label, activeAccountIds: resolved.metadata.accountIds, accountNames: resolved.metadata.accountNames } };
      } catch (error) {
        if (!(error instanceof AccountScopeError) || error.code !== 'INVALID_ACCOUNT_SCOPE') throw error;
        // Preserve access to settings so a user can repair a persisted scope after an account was closed or removed.
        return { data: {
          ...preference,
          label: 'Configuración pendiente: revisa las cuentas seleccionadas',
          activeAccountIds: [],
          accountNames: [],
          warning: error.message,
        } };
      }
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.put('/api/v1/preferences/accounts', async (request, reply) => {
    try {
      const preference = AccountScopePreferenceSchema.parse(request.body);
      const accounts = await repository.listAccounts();
      const resolved = resolveAccountScope(accounts, preference);
      await writeAccountScope(config.actualDataDir, preference);
      return { data: { ...preference, label: resolved.metadata.label, activeAccountIds: resolved.metadata.accountIds, accountNames: resolved.metadata.accountNames } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.get('/api/v1/preferences/currency', async (_request, reply) => {
    try { return { data: { ...(await currencyPreferences()), budgetCurrency: config.budgetCurrency } }; }
    catch (error) { const normalized = sanitizedErrorResponse(error); return reply.code(normalized.statusCode).send(normalized.body); }
  });
  app.put('/api/v1/preferences/currency', async (request, reply) => {
    try {
      const preferences = CurrencyPreferencesSchema.parse(request.body);
      const accounts = await repository.listAccounts();
      const accountById = new Map(accounts.filter((account) => !account.closed).map((account) => [account.id, account]));
      for (const [accountId, currencyCode] of Object.entries(preferences.accountCurrencyOverrides)) {
        const account = accountById.get(accountId);
        if (!account) return reply.code(400).send({ error: { code: 'INVALID_ACCOUNT_CURRENCY', message: 'La divisa solo se puede asignar a una cuenta abierta del presupuesto configurado.' } });
        const sourceCurrency = normalizeCurrencyCode(account.currencyCode);
        if (sourceCurrency && sourceCurrency !== currencyCode) {
          return reply.code(400).send({ error: { code: 'NATIVE_CURRENCY_IS_AUTHORITATIVE', message: 'Actual Budget proporciona la divisa nativa de esta cuenta y tiene prioridad sobre la preferencia local.' } });
        }
      }
      await writeCurrencyPreferences(config.actualDataDir, preferences);
      return { data: { ...(await currencyPreferences()), budgetCurrency: config.budgetCurrency } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.get('/api/v1/preferences/app', async (_request, reply) => {
    try { return { data: await readAppPreferences(config.actualDataDir) }; }
    catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.put('/api/v1/preferences/app', async (request, reply) => {
    try {
      const preferences = AppPreferencesSchema.parse(request.body);
      await writeAppPreferences(config.actualDataDir, preferences);
      return { data: await readAppPreferences(config.actualDataDir) };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.post('/api/v1/preferences/reset', async (request, reply) => {
    try {
      ResetPreferencesRequestSchema.parse(request.body);
      // Reset only app-owned JSON preferences. Never remove Actual's data directory, backups or browser downloads.
      await Promise.all([
        writeAppPreferences(config.actualDataDir, defaultAppPreferences()),
        writeCurrencyPreferences(config.actualDataDir, defaultCurrencyPreferences(config.budgetCurrency)),
        writeAccountScope(config.actualDataDir, defaultAccountScope()),
      ]);
      return {
        data: {
          reset: true,
          app: await readAppPreferences(config.actualDataDir),
          currency: { ...(await readCurrencyPreferences(config.actualDataDir, config.budgetCurrency)), budgetCurrency: config.budgetCurrency },
          accountScope: await readAccountScope(config.actualDataDir),
        },
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.get('/api/v1/transactions', async (request, reply) => {
    try {
      const query = TransactionQuerySchema.parse(request.query);
      assertPeriod(query.startDate, query.endDate);
      const [allAccounts, preferences, preference, categories] = await Promise.all([
        repository.listAccounts(), currencyPreferences(), accountScopePreference(), repository.listCategories(),
      ]);
      const scope = resolveAccountScope(allAccounts, preference, query.accountId);
      const accounts = scope.accounts;
      type PresentedTransaction = BudgetTransaction & {
        readonly payee_name?: string | null;
        readonly imported_payee?: string | null;
        readonly is_split_child?: boolean;
        readonly parent_transaction_id?: string;
        readonly is_split_editable?: boolean;
      };
      const categoriesById = new Map(categories.map((category) => [category.id, category]));
      const accountsById = new Map(accounts.map((account) => [account.id, account]));
      const queryText = query.search?.toLocaleLowerCase('es') ?? '';
      const descriptionOf = (transaction: PresentedTransaction): string =>
        transaction.payee_name || transaction.imported_payee || transaction.notes || transaction.payee_id || '';
      const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
      const compareTransactions = (left: PresentedTransaction, right: PresentedTransaction): number => {
        let comparison = 0;
        if (query.sortBy === 'amount') {
          comparison = left.amount < right.amount ? -1 : left.amount > right.amount ? 1 : 0;
        } else if (query.sortBy === 'description') {
          comparison = descriptionOf(left).localeCompare(descriptionOf(right), 'es');
        } else {
          comparison = compareText(left.date, right.date);
        }
        if (comparison !== 0) return query.order === 'asc' ? comparison : -comparison;

        if (query.sortBy !== 'date') {
          comparison = compareText(left.date, right.date);
          if (comparison !== 0) return query.order === 'asc' ? comparison : -comparison;
        }
        // IDs are the final, direction-independent tie-breaker. This makes offset
        // pages deterministic when date, amount or description are identical.
        comparison = compareText(left.id, right.id);
        return comparison !== 0 ? comparison : compareText(left.account, right.account);
      };
      const matchesFilters = (transaction: PresentedTransaction): boolean => {
        if (query.categoryId && transaction.category !== query.categoryId) return false;
        if (query.uncategorized === 'true' && transaction.category) return false;
        if (query.uncategorized === 'false' && !transaction.category) return false;
        if (!queryText) return true;
        const description = descriptionOf(transaction);
        const accountName = accountsById.get(transaction.account)?.name ?? '';
        const categoryName = categoriesById.get(transaction.category ?? '')?.name ?? '';
        return [description, accountName, categoryName, transaction.notes ?? '']
          .some((value) => value.toLocaleLowerCase('es').includes(queryText));
      };

      // The official Actual SDK has no limit/cursor parameter. Read calendar-month
      // windows sequentially so multi-year ranges are not materialized as one result.
      // Keep only the best offset+limit candidates; do not build flattened/filtered
      // collections. The scan budget prevents fetching later months after it is exceeded.
      const maxSelected = query.offset + query.limit;
      const selected: PresentedTransaction[] = [];
      let total = 0;
      let scanned = 0;

      const siftUp = (index: number): void => {
        let child = index;
        while (child > 0) {
          const parent = Math.floor((child - 1) / 2);
          if (compareTransactions(selected[child]!, selected[parent]!) <= 0) break;
          [selected[parent], selected[child]] = [selected[child]!, selected[parent]!];
          child = parent;
        }
      };
      const siftDown = (index: number): void => {
        let parent = index;
        while (true) {
          const left = parent * 2 + 1;
          const right = left + 1;
          let worst = parent;
          if (left < selected.length && compareTransactions(selected[left]!, selected[worst]!) > 0) worst = left;
          if (right < selected.length && compareTransactions(selected[right]!, selected[worst]!) > 0) worst = right;
          if (worst === parent) return;
          [selected[parent], selected[worst]] = [selected[worst]!, selected[parent]!];
          parent = worst;
        }
      };
      const collectCandidate = (transaction: PresentedTransaction): void => {
        scanned += 1;
        if (scanned > MAX_TRANSACTION_SCAN) throw new TransactionQueryTooBroadError();
        if (!matchesFilters(transaction)) return;
        total += 1;
        if (selected.length < maxSelected) {
          selected.push(transaction);
          siftUp(selected.length - 1);
          return;
        }
        // The heap root is the worst item currently retained. Replace it only
        // when this candidate sorts ahead of that item.
        if (compareTransactions(transaction, selected[0]!) < 0) {
          selected[0] = transaction;
          siftDown(0);
        }
      };

      for (const account of accounts) {
        const nativeCurrency = accountNativeCurrency(account, preferences);
        for (const dateRange of transactionDateRanges(query.startDate, query.endDate)) {
          const transactions = await repository.listTransactions(account.id, dateRange.startDate, dateRange.endDate);
          for (const source of transactions) {
            const transaction = source as PresentedTransaction;
            if (transaction.is_child === true || transaction.parent_id) continue;
            const parentCurrency = normalizeCurrencyCode(transaction.currencyCode) ??
              normalizeCurrencyCode(transaction.currency_code) ?? nativeCurrency;
            if (transaction.subtransactions && transaction.subtransactions.length > 0) {
              for (let index = 0; index < transaction.subtransactions.length; index += 1) {
                const child = transaction.subtransactions[index]! as PresentedTransaction;
                const payeeId = child.payee_id ?? transaction.payee_id;
                const payeeName = child.payee_name ?? transaction.payee_name;
                const importedPayee = child.imported_payee ?? transaction.imported_payee;
                const childCurrency = normalizeCurrencyCode(child.currencyCode) ??
                  normalizeCurrencyCode(child.currency_code) ?? parentCurrency;
                collectCandidate({
                  ...child,
                  id: child.id || transaction.id + ':split:' + index,
                  account: child.account || transaction.account || account.id,
                  date: child.date || transaction.date,
                  currencyCode: childCurrency,
                  ...(payeeId === undefined ? {} : { payee_id: payeeId }),
                  ...(payeeName === undefined ? {} : { payee_name: payeeName }),
                  ...(importedPayee === undefined ? {} : { imported_payee: importedPayee }),
                  is_child: false,
                  parent_id: null,
                  is_split_child: true,
                  parent_transaction_id: transaction.id,
                  is_split_editable: Boolean(child.id),
                });
              }
            } else {
              collectCandidate({ ...transaction, currencyCode: parentCurrency });
            }
          }
        }
      }

      selected.sort(compareTransactions);
      const page = selected.slice(query.offset, query.offset + query.limit).map((transaction) => {
        const sourceCurrency = normalizeCurrencyCode(transaction.currencyCode) ?? normalizeCurrencyCode(transaction.currency_code);
        const conversion = convertAmountMinor(transaction.amount, sourceCurrency, preferences.displayCurrency, transaction.date, preferences.exchangeRates);
        return {
          ...transaction,
          currencyCode: sourceCurrency,
          displayCurrency: preferences.displayCurrency,
          displayAmountMinor: conversion.amountMinor,
          conversion: {
            fromCurrency: conversion.fromCurrency, toCurrency: conversion.toCurrency, rate: conversion.rate,
            effectiveDate: conversion.effectiveDate, source: conversion.source, inverseRate: conversion.inverseRate,
            ...(conversion.warning ? { warning: conversion.warning } : {}),
          },
        };
      });
      return { data: page, pagination: { total, limit: query.limit, offset: query.offset, sortBy: query.sortBy, order: query.order }, accountScope: scope.metadata };
    } catch (error) {
      if (error instanceof TransactionQueryTooBroadError) {
        return reply.code(422).send({ error: {
          code: 'TRANSACTION_QUERY_TOO_BROAD',
          message: 'La consulta supera el límite de 100.000 movimientos. Reduce el rango de fechas o selecciona una cuenta.',
        } });
      }
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.put('/api/v1/transactions/:transactionId', async (request, reply) => {
    try {
      const params = z.object({ transactionId: z.string().trim().min(1).max(128) }).strict().parse(request.params);
      const parsed = TransactionUpdateRequestSchema.parse(request.body);
      assertPeriod(parsed.startDate, parsed.endDate);
      const updater = repository as BudgetRepository & {
        updateTransactionSafely?: (
          transactionId: string,
          accountId: string,
          beforeDate: string,
          fields: TransactionStructureUpdate,
        ) => Promise<{ readonly persisted: boolean; readonly verified: boolean }>;
      };
      if (typeof updater.updateTransactionSafely !== 'function') {
        return reply.code(503).send({ error: {
          code: 'TRANSACTION_SAFE_UPDATE_NOT_SUPPORTED',
          message: 'The configured local adapter cannot verify transaction writes; no changes were written.',
        } });
      }
      // Load all accounts inside the persisted global scope so a linked transfer's other
      // leg can be verified without letting the request widen that scope.
      const { transactions, accounts } = await openAccountTransactions(undefined, parsed.startDate, parsed.endDate);
      if (!accounts.some((account) => account.id === parsed.accountId && !account.closed)) {
        return reply.code(400).send({ error: { code: 'INVALID_ACCOUNT', message: 'Choose an open account from the configured account scope.' } });
      }

      // Actual returns split children nested under their parent; resolve only real child IDs.
      const splitParent = transactions.find((item) =>
        item.account === parsed.accountId && item.is_parent === true &&
        item.subtransactions?.some((child) => child.id === params.transactionId &&
          (child.account ?? item.account) === parsed.accountId),
      );
      const splitChild = splitParent?.subtransactions?.find((child) => child.id === params.transactionId);
      const topLevelTransaction = transactions.find((item) => item.id === params.transactionId && item.account === parsed.accountId);
      const transaction = topLevelTransaction ?? (splitParent && splitChild ? {
        ...splitChild,
        account: splitChild.account || splitParent.account,
        date: splitChild.date || splitParent.date,
      } : undefined);
      if (!transaction) {
        return reply.code(404).send({ error: { code: 'INVALID_TRANSACTION', message: 'The transaction does not belong to the selected account and date range.' } });
      }
      // A legacy repository can still edit ordinary rows, but linked structures require
      // the adapter's read-after-write verification. Never fall back to an unverified write.
      if ((Boolean(transaction.transfer_id) || Boolean(splitParent && splitChild)) &&
          typeof updater.updateTransactionSafely !== 'function') {
        return reply.code(503).send({ error: {
          code: 'LINKED_TRANSACTION_SAFE_UPDATE_NOT_SUPPORTED',
          message: 'This adapter cannot verify the linked records safely; no changes were written.',
        } });
      }

      const categories = await repository.listCategories();
      const categoryExistsAndMatchesAmount = (categoryId: string | null | undefined, amount: number): boolean => {
        if (!categoryId) return true;
        const category = categories.find((item) => item.id === categoryId);
        return Boolean(category && ((amount > 0) === category.isIncome));
      };
      const writeOne = async (
        id: string,
        accountId: string,
        beforeDate: string,
        fields: TransactionStructureUpdate,
      ): Promise<{ readonly persisted: boolean; readonly verified: boolean }> =>
        updater.updateTransactionSafely!(id, accountId, beforeDate, fields);

      if (transaction.transfer_id) {
        // Actual links transfer amount and notes across both legs. Reconcile status stays local;
        // date stays independent unless the user explicitly requests date synchronization.
        if (parsed.changes.category !== undefined || parsed.changes.imported_payee !== undefined) {
          return reply.code(409).send({ error: { code: 'TRANSFER_FIELDS_RESTRICTED', message: 'For linked transfers, only date, amount, notes and cleared status may be edited.' } });
        }
        let counterpart = transactions.find((item) =>
          item.id === transaction.transfer_id && item.transfer_id === transaction.id &&
          item.account !== transaction.account,
        );
        // Transfer legs may legitimately fall on different dates, including different months.
        // If the selected period omitted the other leg, search the remaining active accounts
        // across history; never widen the persisted account scope or silently edit one side.
        if (!counterpart) {
          for (const candidateAccount of accounts) {
            if (candidateAccount.closed || candidateAccount.id === transaction.account) continue;
            const candidates = await repository.listTransactions(candidateAccount.id, '0001-01-01', '9999-12-31');
            counterpart = candidates.find((item) =>
              item.id === transaction.transfer_id && item.transfer_id === transaction.id &&
              item.account !== transaction.account,
            );
            if (counterpart) break;
          }
        }
        if (!counterpart || !accounts.some((account) => account.id === counterpart.account && !account.closed)) {
          return reply.code(409).send({ error: { code: 'TRANSFER_COUNTERPART_NOT_AVAILABLE', message: 'The matching transfer leg is outside the active account scope or could not be verified. No changes were written.' } });
        }
        if (transaction.amount === 0 || counterpart.amount !== -transaction.amount) {
          return reply.code(409).send({ error: { code: 'TRANSFER_PAIR_INCONSISTENT', message: 'The transfer pair is inconsistent. Review it in Actual Budget before editing.' } });
        }
        const nextAmount = parsed.changes.amount ?? transaction.amount;
        if (Math.sign(nextAmount) !== Math.sign(transaction.amount)) {
          return reply.code(400).send({ error: { code: 'TRANSFER_DIRECTION_CHANGE_NOT_ALLOWED', message: 'Changing the direction of a linked transfer is not supported.' } });
        }
        const primaryFields: TransactionStructureUpdate = {
          ...(parsed.changes.date === undefined ? {} : { date: parsed.changes.date }),
          ...(parsed.changes.amount === undefined ? {} : { amount: nextAmount }),
          ...(parsed.changes.notes === undefined ? {} : { notes: parsed.changes.notes }),
          ...(parsed.changes.cleared === undefined ? {} : { cleared: parsed.changes.cleared }),
        };
        const primaryResult = await writeOne(transaction.id, transaction.account, transaction.date, primaryFields);
        if (!primaryResult.persisted || !primaryResult.verified) {
          return reply.code(503).send({ error: { code: 'TRANSACTION_PERSISTENCE_UNVERIFIED', message: 'Actual Budget did not confirm the transfer update. Reopen the movement and verify both legs before retrying.' } });
        }

        const pairFields: TransactionStructureUpdate = {
          ...(parsed.changes.date === undefined || !parsed.syncTransferDate ? {} : { date: parsed.changes.date }),
          ...(parsed.changes.amount === undefined ? {} : { amount: -nextAmount }),
          ...(parsed.changes.notes === undefined ? {} : { notes: parsed.changes.notes }),
        };
        if (Object.keys(pairFields).length > 0) {
          const counterpartResult = await writeOne(counterpart.id, counterpart.account, counterpart.date, pairFields);
          if (!counterpartResult.persisted || !counterpartResult.verified) {
            return reply.code(207).send({ data: {
              transactionId: transaction.id,
              counterpartTransactionId: counterpart.id,
              updatedFields: Object.keys(parsed.changes),
              updatedTransactionIds: [transaction.id],
              failedTransactionId: counterpart.id,
              persisted: true,
              verified: false,
              partial: true,
            } });
          }
        }
        return { data: {
          transactionId: transaction.id,
          counterpartTransactionId: counterpart.id,
          updatedFields: Object.keys(parsed.changes),
          updatedTransactionIds: Object.keys(pairFields).length > 0 ? [transaction.id, counterpart.id] : [transaction.id],
          persisted: true,
          verified: true,
          partial: false,
        } };
      }

      if (splitParent && splitChild) {
        // The only supported split write is a complete parent update with every original child
        // retained, the same IDs preserved, and the parent total equal to the sum of its children.
        const originalChildren = splitParent.subtransactions ?? [];
        if (originalChildren.length === 0 || originalChildren.some((child) => !child.id) ||
            new Set(originalChildren.map((child) => child.id)).size !== originalChildren.length) {
          return reply.code(409).send({ error: { code: 'SPLIT_STRUCTURE_UNSAFE', message: 'The split structure has missing or duplicate child IDs and cannot be safely edited.' } });
        }
        const originalTotal = originalChildren.reduce((sum, child) => sum + child.amount, 0);
        if (!Number.isSafeInteger(originalTotal) || originalTotal !== splitParent.amount) {
          return reply.code(409).send({ error: { code: 'SPLIT_TOTAL_MISMATCH', message: 'The split parts do not match the parent total. Review the movement in Actual Budget before editing.' } });
        }
        const nextChildAmount = parsed.changes.amount ?? splitChild.amount;
        if (Math.sign(nextChildAmount) !== Math.sign(splitChild.amount)) {
          return reply.code(400).send({ error: { code: 'SPLIT_PART_DIRECTION_CHANGE_NOT_ALLOWED', message: 'A split part cannot change from expense to income or from income to expense in this editor.' } });
        }
        const nextCategory = Object.hasOwn(parsed.changes, 'category')
          ? parsed.changes.category ?? null
          : splitChild.category ?? null;
        if (!categoryExistsAndMatchesAmount(nextCategory, nextChildAmount)) {
          return reply.code(400).send({ error: { code: 'CATEGORY_AMOUNT_MISMATCH', message: 'The category must match the income or expense direction of this split part.' } });
        }
        if (parsed.changes.imported_payee !== undefined && parsed.changes.imported_payee.length > 500) {
          return reply.code(400).send({ error: { code: 'INVALID_PAYEE', message: 'The concept is too long.' } });
        }
        const nextDate = parsed.changes.date ?? splitParent.date;
        const updatedChildren: BudgetTransaction[] = originalChildren.map((child) => {
          const target = child.id === splitChild.id;
          return {
            ...child,
            account: child.account || splitParent.account,
            date: parsed.changes.date === undefined ? (child.date || splitParent.date) : nextDate,
            parent_id: splitParent.id,
            is_child: true,
            is_parent: false,
            ...(target && parsed.changes.amount !== undefined ? { amount: nextChildAmount } : {}),
            ...(target && parsed.changes.category !== undefined ? { category: nextCategory } : {}),
            ...(target && parsed.changes.notes !== undefined ? { notes: parsed.changes.notes } : {}),
          };
        });
        const nextTotal = updatedChildren.reduce((sum, child) => sum + child.amount, 0);
        if (!Number.isSafeInteger(nextTotal) || nextTotal === 0) {
          return reply.code(400).send({ error: { code: 'INVALID_SPLIT_TOTAL', message: 'The resulting split total must be a safe, non-zero amount.' } });
        }
        const parentFields: TransactionStructureUpdate = {
          is_parent: true,
          subtransactions: updatedChildren,
          amount: nextTotal,
          ...(parsed.changes.date === undefined ? {} : { date: nextDate }),
          ...(parsed.changes.imported_payee === undefined ? {} : { imported_payee: parsed.changes.imported_payee }),
          ...(parsed.changes.cleared === undefined ? {} : { cleared: parsed.changes.cleared }),
        };
        const result = await writeOne(splitParent.id, splitParent.account, splitParent.date, parentFields);
        if (!result.persisted || !result.verified) {
          return reply.code(503).send({ error: { code: 'TRANSACTION_PERSISTENCE_UNVERIFIED', message: 'Actual Budget did not confirm the split update. Reopen the movement and inspect the parent and all parts before retrying.' } });
        }
        return { data: {
          transactionId: splitChild.id,
          parentTransactionId: splitParent.id,
          updatedFields: Object.keys(parsed.changes),
          parentAmount: nextTotal,
          persisted: true,
          verified: true,
        } };
      }

      if (transaction.is_child || transaction.parent_id || transaction.is_parent || (transaction.subtransactions?.length ?? 0) > 0) {
        return reply.code(409).send({ error: { code: 'SPLIT_EDIT_NOT_SUPPORTED', message: 'This split row cannot be resolved to a complete, verifiable parent structure.' } });
      }
      if (parsed.changes.category !== undefined || parsed.changes.amount !== undefined) {
        const resultingCategoryId = Object.hasOwn(parsed.changes, 'category')
          ? parsed.changes.category ?? null
          : transaction.category ?? null;
        const resultingAmount = parsed.changes.amount ?? transaction.amount;
        if (!categoryExistsAndMatchesAmount(resultingCategoryId, resultingAmount)) {
          const categoryExists = categories.some((item) => item.id === resultingCategoryId);
          return reply.code(400).send({
            error: {
              code: categoryExists ? 'CATEGORY_AMOUNT_MISMATCH' : 'INVALID_CATEGORY',
              message: categoryExists
                ? 'Income movements require an income category and expense movements require an expense category.'
                : 'Choose a category from the configured budget.',
            },
          });
        }
      }
      const update: TransactionStructureUpdate = {
        ...(parsed.changes.date === undefined ? {} : { date: parsed.changes.date }),
        ...(parsed.changes.amount === undefined ? {} : { amount: parsed.changes.amount }),
        ...(parsed.changes.imported_payee === undefined ? {} : { imported_payee: parsed.changes.imported_payee }),
        ...(parsed.changes.category === undefined ? {} : { category: parsed.changes.category }),
        ...(parsed.changes.notes === undefined ? {} : { notes: parsed.changes.notes }),
        ...(parsed.changes.cleared === undefined ? {} : { cleared: parsed.changes.cleared }),
      };
      const result = await writeOne(transaction.id, transaction.account, transaction.date, update);
      if (!result.persisted || !result.verified) {
        return reply.code(503).send({ error: { code: 'TRANSACTION_PERSISTENCE_UNVERIFIED', message: 'Actual Budget did not confirm the edit. Reopen the movement and verify its stored values before retrying.' } });
      }
      return { data: { transactionId: params.transactionId, updatedFields: Object.keys(parsed.changes), persisted: true, verified: true } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  const handleImport = async (
    request: FastifyRequest,
    reply: FastifyReply,
    dryRun: boolean,
  ) => {
    try {
      const parsed = ImportRequestSchema.parse(request.body);
      const importer = repository as BudgetRepository & {
        importTransactions?: (
          accountId: string,
          records: readonly ActualImportRecord[],
          options?: { readonly dryRun?: boolean },
        ) => Promise<ActualImportResult>;
      };
      if (typeof importer.importTransactions !== 'function') {
        return reply.code(503).send({ error: { code: 'IMPORT_NOT_SUPPORTED', message: 'The configured local adapter does not support transaction imports.' } });
      }
      const [accounts, categories] = await Promise.all([
        repository.listAccounts(),
        repository.listCategories(),
      ]);
      const destinationAccount = accounts.find((account) => account.id === parsed.accountId && !account.closed);
      if (!destinationAccount) {
        return reply.code(400).send({ error: { code: 'INVALID_ACCOUNT', message: 'Choose an open account from the configured budget.' } });
      }
      if (parsed.sourceFormat === 'ofx') {
        const destinationCurrency = destinationAccount.currencyCode?.trim().toUpperCase() ?? '';
        if (parsed.sourceCurrencyCode && destinationCurrency && parsed.sourceCurrencyCode !== destinationCurrency) {
          return reply.code(409).send({
            error: { code: 'IMPORT_CURRENCY_MISMATCH', message: 'The OFX statement currency does not match the destination account native currency. No transactions were written.' },
          });
        }
        if ((!parsed.sourceCurrencyCode || !destinationCurrency) && !parsed.allowUnverifiedCurrency) {
          return reply.code(422).send({
            error: { code: 'IMPORT_CURRENCY_UNVERIFIED', message: 'The OFX statement or destination account has no verifiable currency. An explicit confirmation is required before importing.' },
          });
        }
      }
      const categoryIds = new Set(categories.map((category) => category.id));
      if (parsed.records.some((record) => record.category !== undefined && !categoryIds.has(record.category))) {
        return reply.code(400).send({ error: { code: 'INVALID_CATEGORY', message: 'One or more records use a category that does not exist in the configured budget.' } });
      }
      const records: ActualImportRecord[] = parsed.records.map((record) => ({
        date: record.date,
        amount: record.amount,
        payee_name: record.payee_name,
        imported_id: record.imported_id,
        ...(record.imported_payee === undefined ? {} : { imported_payee: record.imported_payee }),
        ...(record.category === undefined ? {} : { category: record.category }),
        ...(record.notes === undefined ? {} : { notes: record.notes }),
      }));
      const result = await importer.importTransactions(parsed.accountId, records, { dryRun });
      if (result.errors.length > 0) {
        return reply.code(409).send({
          error: { code: 'IMPORT_RECONCILIATION_FAILED', message: 'Actual Budget reported an import error; check the budget in Actual before retrying.' },
          result: { added: result.added.length, updated: result.updated.length, errors: result.errors.length, dryRun },
        });
      }
      return {
        data: {
          added: result.added.length,
          updated: result.updated.length,
          errors: result.errors.length,
          submitted: records.length,
          dryRun,
        },
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  };
  app.post('/api/v1/import/preview', async (request, reply) => handleImport(request, reply, true));
  app.post('/api/v1/import/commit', async (request, reply) => handleImport(request, reply, false));

  const handleTransfer = async (request: FastifyRequest, reply: FastifyReply, dryRun: boolean) => {
    try {
      const parsed = TransferRequestSchema.parse(request.body);
      const transferRepository = repository as BudgetRepository & {
        importTransactions?: (
          accountId: string,
          records: readonly ActualImportRecord[],
          options?: { readonly dryRun?: boolean },
        ) => Promise<ActualImportResult>;
        listTransferPayees?: () => Promise<readonly { readonly name: string; readonly accountId: string }[]>;
      };
      if (typeof transferRepository.importTransactions !== 'function' || typeof transferRepository.listTransferPayees !== 'function') {
        return reply.code(503).send({
          error: { code: 'TRANSFER_NOT_SUPPORTED', message: 'The configured Actual Budget adapter does not support safe linked transfers.' },
        });
      }

      const [allAccounts, preference, preferences] = await Promise.all([
        repository.listAccounts(),
        accountScopePreference(),
        currencyPreferences(),
      ]);
      const scope = resolveAccountScope(allAccounts, preference);
      const scopeIds = new Set(scope.accounts.map((account) => account.id));
      const source = allAccounts.find((account) => account.id === parsed.sourceAccountId);
      const destination = allAccounts.find((account) => account.id === parsed.destinationAccountId);

      if (!source || source.closed || !destination || destination.closed) {
        return reply.code(400).send({
          error: { code: 'INVALID_TRANSFER_ACCOUNT', message: 'El origen y el destino deben ser cuentas abiertas del presupuesto configurado.' },
        });
      }
      if (source.id === destination.id) {
        return reply.code(400).send({
          error: { code: 'INVALID_TRANSFER_ACCOUNTS', message: 'El origen y el destino de una transferencia deben ser distintos.' },
        });
      }
      if (!scopeIds.has(source.id) || !scopeIds.has(destination.id)) {
        return reply.code(400).send({
          error: { code: 'ACCOUNT_OUTSIDE_SCOPE', message: 'Ambas cuentas deben estar incluidas en el ámbito global de análisis. Revisa Configuración antes de transferir.' },
        });
      }
      if (source.offBudget !== destination.offBudget) {
        return reply.code(422).send({
          error: { code: 'TRANSFER_BUDGET_SCOPE_MISMATCH', message: 'Esta versión no transfiere entre cuentas dentro y fuera de presupuesto porque Actual puede requerir una categoría presupuestaria explícita. No se ha escrito ningún cambio.' },
        });
      }

      const sourceCurrency = accountNativeCurrency(source, preferences);
      const destinationCurrency = accountNativeCurrency(destination, preferences);
      if (!sourceCurrency || !destinationCurrency) {
        return reply.code(422).send({
          error: { code: 'TRANSFER_CURRENCY_UNKNOWN', message: 'No se puede confirmar la divisa de ambas cuentas. Configura sus divisas antes de transferir.' },
        });
      }
      if (sourceCurrency !== destinationCurrency) {
        return reply.code(422).send({
          error: { code: 'TRANSFER_CURRENCY_MISMATCH', message: 'La transferencia automática solo admite cuentas en la misma divisa. No se convierte ni se inventa un tipo de cambio.' },
        });
      }

      const transferPayees = await transferRepository.listTransferPayees();
      const transferPayee = transferPayees.find((payee) => payee.accountId === destination.id && payee.name.trim().length > 0);
      if (!transferPayee) {
        return reply.code(422).send({
          error: { code: 'TRANSFER_PAYEE_NOT_FOUND', message: 'Actual no ha devuelto un beneficiario de transferencia verificable para la cuenta destino. No se ha escrito ningún cambio.' },
        });
      }

      const record: ActualImportRecord = {
        date: parsed.date,
        amount: -parsed.amountMinor,
        payee_name: transferPayee.name,
        imported_payee: transferPayee.name,
        imported_id: parsed.importedId,
        ...(parsed.notes?.trim() ? { notes: parsed.notes.trim() } : {}),
      };
      const result = await transferRepository.importTransactions(source.id, [record], { dryRun });
      if (result.errors.length > 0) {
        return reply.code(409).send({
          error: { code: 'TRANSFER_RECONCILIATION_FAILED', message: 'Actual Budget no ha podido validar la transferencia. Comprueba las cuentas en Actual antes de reintentar.' },
          result: { added: result.added.length, updated: result.updated.length, errors: result.errors.length, dryRun },
        });
      }
      return {
        data: {
          added: result.added.length,
          updated: result.updated.length,
          errors: 0,
          submitted: 1,
          dryRun,
          sourceAccountId: source.id,
          destinationAccountId: destination.id,
          linkedTransfer: true,
        },
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  };
  app.post('/api/v1/transfers/preview', async (request, reply) => handleTransfer(request, reply, true));
  app.post('/api/v1/transfers/commit', async (request, reply) => handleTransfer(request, reply, false));

  app.get('/api/v1/budgets/:month', async (request, reply) => {
    try {
      const params = z.object({ month: BudgetMonthSchema }).strict().parse(request.params);
      const query = z.object({ includeHidden: z.enum(['true', 'false']).default('false') }).strict().parse(request.query);
      const budgetRepository = repository as BudgetRepository & {
        getBudgetMonth?: (month: string) => Promise<ActualBudgetMonthRecord>;
        getBudgetAllocations?: (month: string) => Promise<readonly { readonly categoryId: string; readonly amountMinor: number }[]>;
      };
      if (typeof budgetRepository.getBudgetMonth !== 'function') {
        return reply.code(503).send({ error: { code: 'BUDGET_QUERY_NOT_SUPPORTED', message: 'The configured local adapter does not support budget queries.' } });
      }
      const allocationSourceAvailable = typeof budgetRepository.getBudgetAllocations === 'function';
      const [budget, categories, allocations] = await Promise.all([
        budgetRepository.getBudgetMonth(params.month),
        repository.listCategories(),
        allocationSourceAvailable ? budgetRepository.getBudgetAllocations!(params.month) : Promise.resolve(null),
      ]);
      const categoriesById = new Map(categories.map((category) => [category.id, category]));
      const allocationsByCategory = new Map((allocations ?? []).map((allocation) => [allocation.categoryId, allocation.amountMinor]));
      const categoryRows = budget.categoryGroups.flatMap((group) =>
        (group.categories ?? []).map((category) => {
          const metadata = categoriesById.get(category.id);
          const explicitAllocation = allocationsByCategory.get(category.id);
          const budgetedMinor = allocationSourceAvailable
            ? (explicitAllocation ?? 0)
            : category.budgeted === undefined || category.budgeted === null ? null : category.budgeted;
          const spentMinor = category.spent === undefined || category.spent === null
            ? null
            : Math.abs(category.spent);
          const availableMinor = category.balance === undefined || category.balance === null
            ? null
            : category.balance;
          const state = allocationSourceAvailable
            ? explicitAllocation === undefined ? 'unbudgeted' : explicitAllocation === 0 ? 'zero' : 'budgeted'
            : category.budgeted === undefined ? 'unbudgeted'
              : category.budgeted === null ? 'unknown'
                : category.budgeted === 0 ? 'zero' : 'budgeted';
          return {
            categoryId: category.id,
            categoryName: metadata?.name ?? category.name,
            groupId: group.id,
            groupName: group.name,
            isIncome: group.is_income ?? metadata?.isIncome ?? false,
            hidden: category.hidden ?? group.hidden ?? false,
            budgetedMinor,
            spentMinor,
            availableMinor,
            percentUsed: budgetedMinor === null || budgetedMinor === 0 || spentMinor === null
              ? null : (spentMinor / budgetedMinor) * 100,
            carryover: category.carryover ?? null,
            state,
          };
        }),
      ).filter((category) => query.includeHidden === 'true' || !category.hidden);
      return {
        data: {
          month: budget.month,
          totals: {
            totalBudgetedMinor: budget.totalBudgeted ?? null,
            totalSpentMinor: budget.totalSpent === undefined ? null : Math.abs(budget.totalSpent),
            totalBalanceMinor: budget.totalBalance ?? null,
            totalIncomeMinor: budget.totalIncome ?? null,
            incomeAvailableMinor: budget.incomeAvailable ?? null,
            toBudgetMinor: budget.toBudget ?? null,
          },
          categories: categoryRows,
          notes: [
            'Importes procedentes de getBudgetMonth de la API oficial de Actual Budget.',
            allocationSourceAvailable
              ? 'Sin asignación significa que no existe una fila explícita de presupuesto para esa categoría y mes; cero presupuestado significa que existe una asignación guardada con importe cero.'
              : 'El adaptador no expone las filas de asignación explícitas; los estados de cero y sin asignación no pueden distinguirse con certeza.',
          ],
        },
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.put('/api/v1/budgets/:month/:categoryId', async (request, reply) => {
    try {
      const params = z.object({
        month: BudgetMonthSchema,
        categoryId: z.string().trim().min(1).max(128),
      }).strict().parse(request.params);
      const body = BudgetAmountSchema.parse(request.body);
      const budgetRepository = repository as BudgetRepository & {
        setBudgetAmount?: (month: string, categoryId: string, amountMinor: number) => Promise<void>;
      };
      if (typeof budgetRepository.setBudgetAmount !== 'function') {
        return reply.code(503).send({ error: { code: 'BUDGET_WRITE_NOT_SUPPORTED', message: 'The configured local adapter does not support budget updates.' } });
      }
      const categories = await repository.listCategories();
      const category = categories.find((item) => item.id === params.categoryId);
      if (!category || category.isIncome) {
        return reply.code(400).send({ error: { code: 'INVALID_CATEGORY', message: 'Choose an expense category from the configured budget.' } });
      }
      await budgetRepository.setBudgetAmount(params.month, params.categoryId, body.amountMinor);
      return { data: { month: params.month, categoryId: params.categoryId, amountMinor: body.amountMinor, updated: true } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.get('/api/v1/reports/summary', async (request, reply) => {
    try {
      const query = SummaryQuerySchema.parse(request.query);
      assertPeriod(query.startDate, query.endDate);
      const [accounts, categories, preferences, preference] = await Promise.all([
        repository.listAccounts(), repository.listCategories(), currencyPreferences(), accountScopePreference(),
      ]);
      const scope = resolveAccountScope(accounts, preference);
      const transactions = await transactionsForAccounts(scope.accounts, query.startDate, query.endDate, preferences);
      const summary = calculateSummary(normalizeTransactions(transactions), categories, {
        startDate: query.startDate, endDate: query.endDate, currency: preferences.displayCurrency, exchangeRates: preferences.exchangeRates,
      });
      return { data: { ...summary, accountScope: scope.metadata } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  async function openAccountTransactions(
    accountId: string | undefined,
    startDate: string,
    endDate: string,
  ): Promise<{
    readonly accounts: readonly { readonly id: string; readonly name: string; readonly closed: boolean; readonly currencyCode?: string | null }[];
    readonly transactions: readonly BudgetTransaction[];
    readonly scope: AccountScopeMetadata;
  }> {
    const [allAccounts, preferences, preference] = await Promise.all([
      repository.listAccounts(), currencyPreferences(), accountScopePreference(),
    ]);
    const resolved = resolveAccountScope(allAccounts, preference, accountId);
    const transactions = await transactionsForAccounts(resolved.accounts, startDate, endDate, preferences);
    return { accounts: resolved.accounts, transactions, scope: resolved.metadata };
  }

  function monthsBefore(date: string, months: number): string {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const shifted = new Date(Date.UTC(year, month - 1 - months, 1));
    return shifted.toISOString().slice(0, 10);
  }

  app.get('/api/v1/insights/recurring', async (request, reply) => {
    try {
      const query = InsightsQuerySchema.parse(request.query);
      assertPeriod(query.startDate, query.endDate);
      const { transactions, scope } = await openAccountTransactions(query.accountId, query.startDate, query.endDate);
      const preferences = await currencyPreferences();
      const converted = convertTransactionsForAnalysis(transactions, preferences);
      const candidates = detectRecurringCandidates(converted.transactions, {
        startDate: query.startDate, endDate: query.endDate,
      });
      return {
        data: candidates,
        accountScope: scope,
        notes: [
          'Los candidatos se detectan con señales deterministas (beneficiario, frecuencia, importe y fechas) y no garantizan que el gasto se repita.',
          'Este endpoint no modifica Actual Budget; la confirmación de sugerencias usa un flujo separado con previsualización.',
          ...converted.warnings,
        ],
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.get('/api/v1/insights/category-suggestions', async (request, reply) => {
    try {
      const query = InsightsQuerySchema.parse(request.query);
      assertPeriod(query.startDate, query.endDate);
      const evidenceStart = monthsBefore(query.startDate, 12);
      const [accounts, categories, preferences, preference] = await Promise.all([
        repository.listAccounts(),
        repository.listCategories(),
        currencyPreferences(),
        accountScopePreference(),
      ]);
      const scope = resolveAccountScope(accounts, preference, query.accountId);
      const groups = await transactionsForAccounts(scope.accounts, evidenceStart, query.endDate, preferences);
      const converted = convertTransactionsForAnalysis(groups, preferences);
      const suggestions = suggestCategories(converted.transactions, categories, {
        startDate: query.startDate, endDate: query.endDate,
      });
      return {
        data: suggestions,
        accountScope: scope.metadata,
        notes: [
          'Las sugerencias usan reglas deterministas sobre el historial local de los últimos 12 meses y no aprenden ni almacenan reglas nuevas.',
          'Nada se modifica en Actual Budget sin revisión y confirmación explícita.',
          ...converted.warnings,
        ],
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  function addIntelligenceDays(date: string, offset: number): string {
    const shifted = new Date(date + 'T00:00:00.000Z');
    shifted.setUTCDate(shifted.getUTCDate() + offset);
    return shifted.toISOString().slice(0, 10);
  }

  function dueDatePriority(daysUntil: number, amountMinor: number): { priority: FindingPriority; reason: string } {
    if (daysUntil <= 3 || amountMinor >= 100_000) {
      return { priority: 'high', reason: 'Vence en 3 días o menos, o importe ≥ 100000 unidades menores (regla v1).' };
    }
    if (daysUntil <= 7 || amountMinor >= 25_000) {
      return { priority: 'medium', reason: 'Vence en 7 días o menos, o importe ≥ 25000 unidades menores (regla v1).' };
    }
    return { priority: 'low', reason: 'Vence dentro de los próximos 30 días sin alcanzar los umbrales de prioridad superiores (regla v1).' };
  }

  async function generateIntelligenceData(startDate: string, endDate: string): Promise<{
    readonly findings: readonly FinancialFinding[];
    readonly warnings: readonly string[];
    readonly currentSummary: ReturnType<typeof calculateSummary>;
    readonly accountScope: AccountScopeMetadata;
    readonly currency: string;
    readonly calculatedAt: string;
    readonly asOfDate: string;
  }> {
    assertPeriod(startDate, endDate);
    const calculatedAt = new Date().toISOString();
    const asOfDate = calculatedAt.slice(0, 10);
    const [accounts, categories, preferences, accountPreference, stored] = await Promise.all([
      repository.listAccounts(),
      repository.listCategories(),
      currencyPreferences(),
      accountScopePreference(),
      readPlanningData(config.actualDataDir),
    ]);
    const scope = resolveAccountScope(accounts, accountPreference);
    const findingScope = {
      mode: accountPreference.mode,
      accountIds: scope.accounts.map((account) => account.id).sort(),
      label: scope.metadata.label,
    } as const;
    const currentTransactions = await transactionsForAccounts(scope.accounts, startDate, endDate, preferences);
    const currentSummary = calculateSummary(normalizeTransactions(currentTransactions), categories, {
      startDate, endDate, currency: preferences.displayCurrency, exchangeRates: preferences.exchangeRates,
    });
    const convertedCurrent = convertTransactionsForAnalysis(currentTransactions, preferences);
    const findings: FinancialFinding[] = [];
    const warnings: string[] = [...convertedCurrent.warnings];

    if (endDate < asOfDate) {
      const durationDays = Math.floor((Date.parse(endDate + 'T00:00:00.000Z') - Date.parse(startDate + 'T00:00:00.000Z')) / 86_400_000) + 1;
      const previousEndDate = addIntelligenceDays(startDate, -1);
      const previousStartDate = addIntelligenceDays(startDate, -durationDays);
      assertPeriod(previousStartDate, previousEndDate);
      const previousTransactions = await transactionsForAccounts(scope.accounts, previousStartDate, previousEndDate, preferences);
      const previousSummary = calculateSummary(normalizeTransactions(previousTransactions), categories, {
        startDate: previousStartDate, endDate: previousEndDate,
        currency: preferences.displayCurrency, exchangeRates: preferences.exchangeRates,
      });
      let priorSummary: ReturnType<typeof calculateSummary> | undefined;
      if (durationDays <= 92) {
        const priorEndDate = addIntelligenceDays(previousStartDate, -1);
        const priorStartDate = addIntelligenceDays(previousStartDate, -durationDays);
        assertPeriod(priorStartDate, priorEndDate);
        const priorTransactions = await transactionsForAccounts(scope.accounts, priorStartDate, priorEndDate, preferences);
        priorSummary = calculateSummary(normalizeTransactions(priorTransactions), categories, {
          startDate: priorStartDate, endDate: priorEndDate,
          currency: preferences.displayCurrency, exchangeRates: preferences.exchangeRates,
        });
      }
      const comparison = buildPeriodChangeFindings(currentSummary, previousSummary, {
        accountScope: findingScope, calculatedAt, ...(priorSummary ? { priorSummary } : {}),
      });
      findings.push(...comparison.findings);
      warnings.push(...comparison.limitations);
    } else {
      warnings.push('Las variaciones entre periodos se omiten porque el periodo seleccionado incluye hoy o fechas futuras y todavía no está completo.');
    }

    const uncategorized = buildUncategorizedFinding(normalizeTransactions(convertedCurrent.transactions), {
      period: { startDate, endDate },
      accountScope: findingScope,
      currency: preferences.displayCurrency,
      calculatedAt,
      sourceWarnings: convertedCurrent.warnings,
    });
    if (uncategorized) findings.push(uncategorized);

    const lookaheadEnd = addIntelligenceDays(asOfDate, 30);
    const eligibleCommitments: PlanningCommitment[] = stored.commitments
      .filter((item) => item.status === 'active' && item.currency === preferences.displayCurrency &&
        planningScopeMatches(item.scope, accountPreference))
      .map(toPlanningCommitment);
    for (const item of expandCommitmentOccurrences(eligibleCommitments, asOfDate, lookaheadEnd)) {
      const daysUntil = Math.max(0, Math.floor((Date.parse(item.occurrenceDate + 'T00:00:00.000Z') - Date.parse(asOfDate + 'T00:00:00.000Z')) / 86_400_000));
      const priority = dueDatePriority(daysUntil, item.amountMinor);
      findings.push(createFinancialFinding({
        entityKey: item.id + '|' + item.occurrenceDate,
        type: 'commitment-upcoming',
        title: 'Compromiso próximo: ' + item.title,
        explanation: (item.direction === 'expense' ? 'Hay un compromiso de gasto registrado' : 'Hay un ingreso futuro registrado') +
          ' para la fecha indicada. Es un dato de planificación, no una confirmación de que el cargo o abono se haya producido.',
        period: { startDate: item.occurrenceDate, endDate: item.occurrenceDate },
        accountScope: findingScope,
        currency: item.currency,
        confidence: 'observed',
        priority: priority.priority,
        priorityReason: priority.reason,
        impactMinor: item.amountMinor,
        metrics: {
          amountMinor: item.amountMinor, direction: item.direction, date: item.occurrenceDate,
          daysUntil, frequency: item.frequency, source: 'manual_commitment',
        },
        evidence: [
          { label: 'Importe registrado', value: item.amountMinor, source: 'planning-data.json', rule: 'Compromiso activo introducido por el usuario.' },
          { label: 'Fecha prevista', value: item.occurrenceDate, source: 'planning-data.json', rule: 'Ocurrencia calculada según la frecuencia guardada.' },
          { label: 'Antelación (días)', value: daysUntil, source: 'finance-core.expandCommitmentOccurrences', rule: 'Diferencia de fechas de calendario, calculada en UTC.' },
        ],
        limitations: ['La planificación manual no confirma el movimiento bancario.', 'Solo se consideran compromisos activos de la divisa y el ámbito de cuentas actuales.'],
        calculatedAt,
        navigationTarget: '/planning',
      }));
    }

    const historyStartDate = monthsBefore(asOfDate, 12);
    const historyTransactions = await transactionsForAccounts(scope.accounts, historyStartDate, asOfDate, preferences);
    const convertedHistory = convertTransactionsForAnalysis(historyTransactions, preferences);
    warnings.push(...convertedHistory.warnings);
    const recurringCandidates = detectRecurringCandidates(convertedHistory.transactions, {
      startDate: historyStartDate, endDate: asOfDate,
    });
    for (const candidate of recurringCandidates) {
      if (candidate.estimatedIntervalDays === null || candidate.estimatedIntervalDays <= 0) continue;
      const nextDate = addIntelligenceDays(candidate.lastDate, Math.round(candidate.estimatedIntervalDays));
      if (nextDate < asOfDate || nextDate > lookaheadEnd) continue;
      const daysUntil = Math.max(0, Math.floor((Date.parse(nextDate + 'T00:00:00.000Z') - Date.parse(asOfDate + 'T00:00:00.000Z')) / 86_400_000));
      const priority = dueDatePriority(daysUntil, candidate.meanAbsoluteAmountMinor);
      findings.push(createFinancialFinding({
        entityKey: candidate.payee + '|' + nextDate,
        type: 'recurring-candidate-upcoming',
        title: 'Posible pago recurrente próximo: ' + (candidate.payeeVariants[0] ?? candidate.payee),
        explanation: 'El historial muestra un patrón de pagos compatible con una posible recurrencia próxima. El patrón es estadístico y no confirma una suscripción ni garantiza el siguiente cargo.',
        period: { startDate: nextDate, endDate: nextDate },
        accountScope: findingScope,
        currency: preferences.displayCurrency,
        confidence: 'candidate',
        priority: priority.priority,
        priorityReason: priority.reason,
        impactMinor: candidate.meanAbsoluteAmountMinor,
        metrics: {
          nextExpectedDate: nextDate, daysUntil, occurrenceCount: candidate.occurrenceCount,
          estimatedIntervalDays: candidate.estimatedIntervalDays,
          meanAbsoluteAmountMinor: candidate.meanAbsoluteAmountMinor,
          amountDeviationPercent: candidate.amountDeviationPercent,
        },
        evidence: [
          { label: 'Ocurrencias del patrón', value: candidate.occurrenceCount, source: 'finance-core.detectRecurringCandidates', rule: 'Mínimo de observaciones aplicado por el detector determinista.' },
          { label: 'Intervalo estimado (días)', value: candidate.estimatedIntervalDays, source: 'finance-core.detectRecurringCandidates', rule: 'Estimación a partir de las fechas históricas observadas.' },
          { label: 'Importe absoluto medio', value: candidate.meanAbsoluteAmountMinor, source: 'finance-core.detectRecurringCandidates', rule: 'Media de importes absolutos observados; puede variar por reembolsos o cambios de precio.' },
        ],
        limitations: [
          'Es un candidato estadístico, no una suscripción confirmada.',
          ...candidate.warnings,
          ...convertedHistory.warnings,
        ],
        calculatedAt,
        navigationTarget: '/planning',
      }));
    }

    if (stored.goals.length > 0) {
      const estimate = estimatePlanningCashFlow(convertedHistory.transactions, categories, {
        currency: preferences.displayCurrency, startDate: historyStartDate, endDate: asOfDate,
      });
      for (const goal of stored.goals) {
        if (goal.status !== 'active' || goal.currency !== preferences.displayCurrency ||
            !planningScopeMatches(goal.scope, accountPreference) || goal.targetDate <= asOfDate) continue;
        const projection = projectSavingsGoal({
          asOfDate, targetDate: goal.targetDate, targetAmountMinor: goal.targetAmountMinor,
          initialAmountMinor: goal.initialAmountMinor, monthlyContributionMinor: goal.monthlyContributionMinor,
          currency: preferences.displayCurrency,
          monthlyIncomeMinor: goal.monthlyIncomeMinor ?? estimate.monthlyIncomeMinor,
          monthlyExpenseMinor: goal.monthlyExpenseMinor ?? estimate.monthlyExpenseMinor,
          commitments: eligibleCommitments,
        });
        const onTrack = projection.projectedBalanceMinor >= goal.targetAmountMinor;
        const gapMinor = Math.max(0, goal.targetAmountMinor - projection.projectedBalanceMinor);
        const priority: FindingPriority = !onTrack && gapMinor >= 100_000
          ? 'high' : !onTrack && gapMinor >= 25_000 ? 'medium' : 'low';
        const priorityReason = onTrack
          ? 'La proyección con los supuestos actuales alcanza el objetivo; prioridad informativa baja.'
          : gapMinor >= 100_000
            ? 'Brecha proyectada ≥ 100000 unidades menores (regla v1).'
            : gapMinor >= 25_000
              ? 'Brecha proyectada ≥ 25000 unidades menores (regla v1).'
              : 'Brecha estimada inferior a los umbrales de prioridad media (regla v1).';
        findings.push(createFinancialFinding({
          entityKey: goal.id,
          type: onTrack ? 'goal-progress' : 'goal-at-risk',
          title: onTrack ? 'Proyección del objetivo: ' + goal.name : 'El objetivo podría no alcanzarse a tiempo: ' + goal.name,
          explanation: onTrack
            ? 'La proyección determinista alcanza el importe objetivo con los ingresos, gastos, compromisos y aportaciones configurados. Es una estimación condicional, no una predicción garantizada.'
            : 'La proyección determinista no alcanza el importe objetivo con las aportaciones configuradas. Comprueba los supuestos y la capacidad de contribución; el flujo disponible podría permitir alcanzar la meta con un plan diferente.',
          period: { startDate: asOfDate, endDate: goal.targetDate },
          accountScope: findingScope,
          currency: preferences.displayCurrency,
          confidence: 'estimated',
          priority,
          priorityReason,
          impactMinor: gapMinor,
          metrics: {
            targetAmountMinor: goal.targetAmountMinor,
            projectedBalanceMinor: projection.projectedBalanceMinor,
            gapMinor,
            projectedProgressPercent: projection.projectedProgressPercent,
            targetDate: goal.targetDate,
            monthsRemaining: projection.months,
            achievableUnderCashFlow: projection.achievableUnderCashFlow,
            onTrack,
          },
          evidence: [
            { label: 'Importe objetivo', value: goal.targetAmountMinor, source: 'planning-data.json', rule: 'Objetivo activo configurado por el usuario.' },
            { label: 'Saldo proyectado', value: projection.projectedBalanceMinor, source: 'finance-core.projectSavingsGoal', rule: 'Proyección determinista con supuestos explícitos.' },
            { label: 'Avance proyectado (%)', value: Number(projection.projectedProgressPercent.toFixed(2)), source: 'finance-core.projectSavingsGoal', rule: 'Saldo proyectado dividido por importe objetivo, limitado por la proyección determinista.' },
            { label: 'Brecha estimada', value: gapMinor, source: 'finance-core.projectSavingsGoal', rule: 'Importe objetivo menos saldo proyectado, nunca inferior a cero.' },
          ],
          limitations: [...projection.assumptions, ...projection.warnings, 'El resultado depende del historial disponible y de las aportaciones configuradas; no es una garantía.'],
          calculatedAt,
          navigationTarget: '/goals',
        }));
      }
    }

    const budgetRepository = repository as BudgetRepository & {
      getBudgetMonth?: (month: string) => Promise<ActualBudgetMonthRecord>;
    };
    if (startDate.slice(0, 7) === endDate.slice(0, 7) &&
        typeof budgetRepository.getBudgetMonth === 'function') {
      if (accountPreference.mode !== 'all' || preferences.displayCurrency !== config.budgetCurrency) {
        warnings.push('Desviaciones de presupuesto no incluidas: el presupuesto de Actual es global y/o su divisa no coincide con la divisa de análisis seleccionada.');
      } else {
        try {
          const monthBudget = await budgetRepository.getBudgetMonth(startDate.slice(0, 7));
          for (const group of monthBudget.categoryGroups) {
            for (const category of group.categories ?? []) {
              const metadata = categories.find((item) => item.id === category.id);
              if ((group.is_income ?? metadata?.isIncome ?? false) || category.hidden || group.hidden) continue;
              if (category.budgeted === undefined || category.budgeted === null ||
                  category.spent === undefined || category.spent === null ||
                  !Number.isSafeInteger(category.budgeted) || !Number.isSafeInteger(category.spent) ||
                  category.budgeted <= 0) continue;
              const budgetedMinor = category.budgeted;
              const spentMinor = Math.abs(category.spent);
              const overByMinor = spentMinor - budgetedMinor;
              if (overByMinor <= 0) continue;
              const percentUsed = (spentMinor / budgetedMinor) * 100;
              const priority: FindingPriority = overByMinor >= 100_000 || percentUsed >= 150
                ? 'high' : overByMinor >= 25_000 || percentUsed >= 110 ? 'medium' : 'low';
              const priorityReason = priority === 'high'
                ? 'Exceso ≥ 100000 unidades menores o gasto ≥ 150 % de la asignación (regla v1).'
                : priority === 'medium' ? 'Exceso ≥ 25000 unidades menores o gasto ≥ 110 % de la asignación (regla v1).'
                  : 'La categoría supera la asignación, sin alcanzar los umbrales de prioridad superiores (regla v1).';
              findings.push(createFinancialFinding({
                entityKey: category.id,
                type: 'budget-overspend',
                title: 'Categoría por encima del presupuesto: ' + (metadata?.name ?? category.name),
                explanation: 'El gasto registrado en esta categoría supera la asignación del mes. Comprueba la asignación y los movimientos antes de hacer cambios.',
                period: planningMonthPeriod(startDate.slice(0, 7)),
                accountScope: findingScope,
                currency: preferences.displayCurrency,
                confidence: 'observed',
                priority,
                priorityReason,
                impactMinor: overByMinor,
                metrics: { categoryId: category.id, budgetedMinor, spentMinor, overByMinor, percentUsed },
                evidence: [
                  { label: 'Presupuesto asignado', value: budgetedMinor, source: 'Actual Budget getBudgetMonth', rule: 'Asignación positiva conocida para el mes.' },
                  { label: 'Gasto registrado', value: spentMinor, source: 'Actual Budget getBudgetMonth', rule: 'Valor absoluto del gasto acumulado informado por Actual.' },
                  { label: 'Exceso', value: overByMinor, source: 'finance-core', rule: 'Gasto registrado menos asignación.' },
                  { label: 'Porcentaje utilizado', value: Number(percentUsed.toFixed(2)), source: 'finance-core', rule: 'Gasto registrado dividido por asignación por 100.' },
                ],
                limitations: ['El presupuesto corresponde al mes completo en Actual Budget.', 'Solo se compara cuando la vista incluye todas las cuentas y coincide la divisa del presupuesto con la divisa de análisis.'],
                calculatedAt,
                navigationTarget: '/budgets',
              }));
            }
          }
        } catch {
          warnings.push('Desviaciones de presupuesto omitidas: el presupuesto mensual no devolvió datos verificables.');
        }
      }
    }

    const unique = new Map<string, FinancialFinding>();
    for (const finding of findings) unique.set(finding.id, finding);
    const state = await readFindingReviewState(config.actualDataDir);
    const today = asOfDate;
    const validated = sortFinancialFindings([...unique.values()]).slice(0, 100).map((finding) => {
      const record = state.reviews.find((item) => item.findingId === finding.id);
      const review = effectiveFindingReview(record, finding.fingerprint, today);
      return FinancialFindingContractSchema.parse({
        ...finding,
        reviewStatus: review.status,
        ...(review.snoozedUntil ? { snoozedUntil: review.snoozedUntil } : {}),
      });
    });
    if (findings.length > validated.length) warnings.push('Se muestran los 100 hallazgos con mayor prioridad; el resto queda fuera de esta respuesta para mantener acotado el panel.');
    return {
      findings: validated,
      warnings: [...new Set(warnings)],
      currentSummary,
      accountScope: scope.metadata,
      currency: preferences.displayCurrency,
      calculatedAt,
      asOfDate,
    };
  }

  app.get('/api/v1/intelligence/findings', async (request, reply) => {
    try {
      const query = IntelligenceDatesSchema.parse(request.query);
      const result = await generateIntelligenceData(query.startDate, query.endDate);
      const feedback = result.findings.filter((finding) =>
        finding.reviewStatus === 'reviewed' || finding.reviewStatus === 'dismissed');
      const dismissedCount = feedback.filter((finding) => finding.reviewStatus === 'dismissed').length;
      const usefulCount = feedback.filter((finding) => finding.reviewStatus === 'reviewed').length;
      return {
        data: {
          schemaVersion: 1,
          findings: result.findings,
          warnings: result.warnings,
          period: { startDate: query.startDate, endDate: query.endDate },
          accountScope: result.accountScope,
          currency: result.currency,
          calculatedAt: result.calculatedAt,
          aiEnabled: config.aiEnabled,
          qualityMetrics: {
            feedbackCount: feedback.length,
            usefulCount,
            dismissedCount,
            dismissalRatePercent: feedback.length > 0 ? dismissedCount / feedback.length * 100 : null,
            note: 'La tasa de descarte refleja feedback explícito del usuario, no precisión estadística ni tasa real de falsos positivos.',
          },
        },
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/intelligence/review', async (request, reply) => {
    try {
      const parsed = IntelligenceReviewRequestSchema.parse(request.body);
      assertPeriod(parsed.startDate, parsed.endDate);
      const today = new Date().toISOString().slice(0, 10);
      if (parsed.status === 'snoozed') {
        if (!parsed.snoozedUntil || parsed.snoozedUntil < today ||
            parsed.snoozedUntil > addIntelligenceDays(today, 90)) {
          return reply.code(400).send({ error: { code: 'INVALID_SNOOZE_WINDOW', message: 'El aplazamiento debe vencer entre hoy y los próximos 90 días.' } });
        }
      }
      const result = await generateIntelligenceData(parsed.startDate, parsed.endDate);
      const finding = result.findings.find((item) => item.id === parsed.findingId);
      if (!finding) return reply.code(404).send({ error: { code: 'FINDING_NOT_FOUND', message: 'El hallazgo ya no existe en el periodo y ámbito actuales.' } });
      const record = {
        findingId: finding.id,
        fingerprint: finding.fingerprint,
        status: parsed.status,
        ...(parsed.status === 'snoozed' && parsed.snoozedUntil ? { snoozedUntil: parsed.snoozedUntil } : {}),
        updatedAt: new Date().toISOString(),
      };
      await updateFindingReviewState(config.actualDataDir, record);
      return { data: { findingId: finding.id, status: parsed.status, ...(parsed.status === 'snoozed' ? { snoozedUntil: parsed.snoozedUntil } : {}) } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/intelligence/explain', async (request, reply) => {
    const requestAbort = new AbortController();
    const abortRequest = () => requestAbort.abort();
    const abortResponse = () => { if (!reply.raw.writableEnded) requestAbort.abort(); };
    request.raw.once('aborted', abortRequest);
    reply.raw.once('close', abortResponse);
    try {
      const parsed = IntelligenceExplainRequestSchema.parse(request.body);
      assertPeriod(parsed.startDate, parsed.endDate);
      if (!config.aiEnabled) {
        return reply.code(503).send({ error: { code: 'AI_DISABLED', message: 'La explicación con IA local está desactivada; los hallazgos deterministas siguen disponibles.' } });
      }
      const result = await generateIntelligenceData(parsed.startDate, parsed.endDate);
      const finding = result.findings.find((item) => item.id === parsed.findingId);
      if (!finding) return reply.code(404).send({ error: { code: 'FINDING_NOT_FOUND', message: 'El hallazgo ya no existe en el periodo y ámbito actuales.' } });
      const context: AssistantContext = {
        question: [
          'Redacta una explicación cualitativa breve del siguiente tipo de hallazgo financiero.',
          'Tipo de regla: ' + finding.type + '.',
          'Explicación calculada: ' + finding.explanation,
          'Reglas de evidencia: ' + finding.evidence.map((item) => item.rule).join(' '),
          'Limitaciones: ' + finding.limitations.join(' '),
          'No uses nombres de cuentas, beneficiarios, objetivos ni compromisos, y no afirmes causas que no se hayan medido.',
        ].join(' '),
        deduplicationKey: 'financial-intelligence:' + finding.id + ':' + finding.fingerprint,
        summary: {
          currency: result.currentSummary.currency,
          startDate: result.currentSummary.startDate,
          endDate: result.currentSummary.endDate,
          incomeMinor: result.currentSummary.incomeMinor,
          expenseMinor: result.currentSummary.expenseMinor,
          savingsMinor: result.currentSummary.savingsMinor,
          savingsRatePercent: result.currentSummary.savingsRatePercent,
          transactionCount: result.currentSummary.transactionCount,
          excludedTransferCount: result.currentSummary.excludedTransferCount,
          unconvertedTransactionCount: result.currentSummary.unconvertedTransactionCount,
          warnings: [...result.currentSummary.warnings, ...finding.limitations],
        },
        expensesByCategory: [],
      };
      const explanation = await localAi.explain(context, requestAbort.signal);
      return { data: { findingId: finding.id, explanation, kind: 'qualitative_explanation', source: 'local' } };
    } catch (error) {
      if (error instanceof LocalAiCancelledError) {
        if (request.raw.aborted || reply.raw.destroyed) return;
        return reply.code(499).send({ error: { code: 'AI_CANCELLED', message: 'La explicación local se ha cancelado.' } });
      }
      if (error instanceof LocalAiBusyError) {
        return reply.code(503).header('retry-after', '1').send({ error: { code: 'AI_BUSY', message: 'El asistente local está ocupado; vuelve a intentarlo en unos segundos.' } });
      }
      if (error instanceof LocalAiContextBudgetError) {
        return reply.code(413).send({ error: { code: 'AI_CONTEXT_TOO_LARGE', message: 'El contexto de la explicación supera el límite local permitido.' } });
      }
      if (error instanceof LocalAiUnavailableError) {
        return reply.code(503).send({ error: { code: 'AI_UNAVAILABLE', message: 'Ollama no ha podido completar la explicación; el hallazgo determinista sigue disponible.' } });
      }
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    } finally {
      request.raw.removeListener('aborted', abortRequest);
      reply.raw.removeListener('close', abortResponse);
    }
  });

  app.post('/api/v1/insights/categorize', async (request, reply) => {
    try {
      const parsed = CategorizeRequestSchema.parse(request.body);
      assertPeriod(parsed.startDate, parsed.endDate);
      const categorizer = repository as BudgetRepository & {
        updateTransactionCategoriesBatch?: (changes: readonly TransactionCategoryBatchChange[]) => Promise<{
          requested: number; updatedTransactionIds: readonly string[]; failedTransactionId?: string; conflictTransactionId?: string; persisted: boolean;
        }>;
      };
      const { transactions } = await openAccountTransactions(undefined, parsed.startDate, parsed.endDate);
      const transactionById = new Map(transactions
        .filter((transaction) => !transaction.is_child && !transaction.parent_id)
        .map((transaction) => [transaction.id, transaction]));
      for (const change of parsed.transactions) {
        const transaction = transactionById.get(change.transactionId);
        if (!transaction) {
          return reply.code(400).send({ error: { code: 'INVALID_TRANSACTION', message: 'One or more transaction ids do not belong to an open account in the period.' } });
        }
        if (parsed.commit && change.expectedCategoryId !== (transaction.category ?? null)) {
          return reply.code(409).send({ error: {
            code: 'TRANSACTION_CHANGED_SINCE_PREVIEW',
            message: 'One or more selected transactions or categories changed after preview. Review the current movements and preview the batch again; no changes were written.',
            transactionId: change.transactionId,
          } });
        }
        if (transaction.amount >= 0) {
          return reply.code(400).send({ error: { code: 'CATEGORY_AMOUNT_MISMATCH', message: 'Bulk categorization is limited to ordinary expense movements.' } });
        }
        if (transaction.transfer_id) {
          return reply.code(409).send({ error: { code: 'TRANSFER_EDIT_NOT_SUPPORTED', message: 'Transfer transactions are protected from bulk category changes.' } });
        }
        if (transaction.is_parent || (transaction.subtransactions?.length ?? 0) > 0) {
          return reply.code(409).send({ error: { code: 'SPLIT_EDIT_NOT_SUPPORTED', message: 'Split transactions are protected from bulk category changes.' } });
        }
      }
      const categories = await repository.listCategories();
      const expenseCategories = new Set(categories.filter((category) => !category.isIncome).map((category) => category.id));
      if (parsed.transactions.some((change) => !expenseCategories.has(change.categoryId))) {
        return reply.code(400).send({ error: { code: 'INVALID_CATEGORY', message: 'Choose an expense category from the configured budget.' } });
      }
      if (!parsed.commit) {
        const baseline = parsed.transactions.map((change) => {
          const transaction = transactionById.get(change.transactionId)!;
          return { transactionId: change.transactionId, expectedCategoryId: transaction.category ?? null };
        });
        return { data: { preview: true, requested: parsed.transactions.length, changes: parsed.transactions.length, baseline } };
      }
      if (typeof categorizer.updateTransactionCategoriesBatch === 'function') {
        const verifiedChanges = parsed.transactions.map((change) => {
          const transaction = transactionById.get(change.transactionId);
          if (!transaction) throw new Error('Transaction disappeared during category batch validation.');
          return { ...change, accountId: transaction.account, date: transaction.date, expectedCategoryId: change.expectedCategoryId ?? null };
        });
        const outcome = await categorizer.updateTransactionCategoriesBatch(verifiedChanges);
        const applied = outcome.updatedTransactionIds.length;
        const complete = applied === outcome.requested && outcome.persisted;
        if (!complete) {
          if (outcome.conflictTransactionId && applied === 0) {
            return reply.code(409).send({ error: {
              code: 'TRANSACTION_CHANGED_SINCE_PREVIEW',
              message: 'The transaction or category no longer matches the preview. Review the current movements and preview the batch again; no changes were written by this attempt.',
              transactionId: outcome.conflictTransactionId,
            } });
          }
          const appliedIds = new Set(outcome.updatedTransactionIds);
          const pendingTransactionIds = parsed.transactions
            .map((change) => change.transactionId)
            .filter((transactionId) => !appliedIds.has(transactionId));
          return reply.code(207).send({
            data: {
              preview: false, requested: outcome.requested, applied, changes: applied,
              appliedTransactionIds: outcome.updatedTransactionIds,
              pendingTransactionIds,
              ...(outcome.failedTransactionId ? { failedTransactionId: outcome.failedTransactionId } : {}),
              ...(outcome.conflictTransactionId ? { conflictTransactionId: outcome.conflictTransactionId } : {}),
              persisted: outcome.persisted, partial: true,
              message: outcome.conflictTransactionId
                ? 'The transaction or category no longer matches the preview at the indicated transaction id. Earlier listed updates are verified; only the remaining selections are pending and must be previewed again.'
                : outcome.updatedTransactionIds.length > 0
                  ? 'Some changes were verified and synced. The batch stopped at the indicated transaction id; inspect that movement in Actual before retrying. No automatic undo was attempted.'
                  : 'No change was confirmed as persisted. Inspect the indicated movement in Actual before retrying; no automatic undo was attempted.',
            },
          });
        }
        return { data: { preview: false, requested: outcome.requested, applied, changes: applied, appliedTransactionIds: outcome.updatedTransactionIds, persisted: true, partial: false } };
      }
      return reply.code(503).send({ error: {
        code: 'TRANSACTION_BATCH_UPDATE_NOT_SUPPORTED',
        message: 'The configured adapter cannot verify category batch outcomes; no transaction was changed.',
      } });
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/forecasts/simulate', async (request, reply) => {
    try {
      const parsed = ForecastRequestSchema.parse(request.body);
      assertPeriod(parsed.startDate, parsed.endDate);
      const [accounts, categories, preferences, preference] = await Promise.all([
        repository.listAccounts(), repository.listCategories(), currencyPreferences(), accountScopePreference(),
      ]);
      const scope = resolveAccountScope(accounts, preference);
      const transactions = await transactionsForAccounts(scope.accounts, parsed.startDate, parsed.endDate, preferences);
      const converted = convertTransactionsForAnalysis(transactions, preferences);
      const result = projectSavings(
        converted.transactions,
        categories,
        parsed.scenario as ForecastScenario,
        {
          currency: preferences.displayCurrency,
          horizonMonths: parsed.horizonMonths,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
        },
      );
      return { data: { ...result, warnings: [...result.warnings, ...converted.warnings], accountScope: scope.metadata } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });


  function shiftPlanningMonth(month: string, offset: number): string {
    const year = Number(month.slice(0, 4));
    const monthNumber = Number(month.slice(5, 7));
    const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
    return shifted.toISOString().slice(0, 7);
  }

  function planningMonthPeriod(month: string): { readonly startDate: string; readonly endDate: string } {
    const year = Number(month.slice(0, 4));
    const monthNumber = Number(month.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
    return { startDate: month + '-01', endDate: lastDay };
  }

  function planningScopeMatches(saved: AccountScopePreference, current: AccountScopePreference): boolean {
    if (saved.mode !== current.mode) return false;
    if (saved.mode === 'all') return true;
    const left = [...saved.accountIds].sort();
    const right = [...current.accountIds].sort();
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  function toPlanningCommitment(item: StoredPlanningCommitment): PlanningCommitment {
    return {
      id: item.id,
      title: item.title,
      amountMinor: item.amountMinor,
      date: item.date,
      direction: item.direction,
      frequency: item.frequency,
      currency: item.currency,
      status: item.status,
      ...(item.notes === undefined ? {} : { notes: item.notes }),
    };
  }

  function validateGoalWindow(targetDate: string, asOfDate: string): void {
    if (!isIsoDate(targetDate) || targetDate <= asOfDate) {
      throw new RangeError('La fecha objetivo debe ser posterior a hoy.');
    }
    const currentMonth = Number(asOfDate.slice(0, 4)) * 12 + Number(asOfDate.slice(5, 7)) - 1;
    const targetMonth = Number(targetDate.slice(0, 4)) * 12 + Number(targetDate.slice(5, 7)) - 1;
    if (targetMonth - currentMonth > 120) throw new RangeError('La fecha objetivo no puede superar diez años desde hoy.');
  }

  app.get('/api/v1/planning', async (request, reply) => {
    try {
      const query = z.object({ month: PlanningMonthSchema.optional() }).strict().parse(request.query);
      const asOfDate = new Date().toISOString().slice(0, 10);
      const month = query.month ?? asOfDate.slice(0, 7);
      const monthPeriod = planningMonthPeriod(month);
      const [stored, accounts, categories, preferences, preference] = await Promise.all([
        readPlanningData(config.actualDataDir), repository.listAccounts(), repository.listCategories(),
        currencyPreferences(), accountScopePreference(),
      ]);
      const scope = resolveAccountScope(accounts, preference);
      const historyStartDate = shiftPlanningMonth(asOfDate.slice(0, 7), -11) + '-01';
      const historyTransactions = await transactionsForAccounts(scope.accounts, historyStartDate, asOfDate, preferences);
      const convertedHistory = convertTransactionsForAnalysis(historyTransactions, preferences);
      const estimate = estimatePlanningCashFlow(convertedHistory.transactions, categories, {
        currency: preferences.displayCurrency, startDate: historyStartDate, endDate: asOfDate,
      });
      const eligibleCommitments = stored.commitments.filter((item) =>
        item.status === 'active' && item.currency === preferences.displayCurrency &&
        planningScopeMatches(item.scope, preference),
      ).map(toPlanningCommitment);
      const goals = stored.goals.map((goal) => {
        const scopeMatches = planningScopeMatches(goal.scope, preference);
        const currencyMatches = goal.currency === preferences.displayCurrency;
        const planningWarnings: string[] = [];
        if (!scopeMatches) planningWarnings.push('El ámbito de cuentas guardado ha cambiado. Edita el objetivo para revisar y confirmar el nuevo ámbito antes de recalcularlo.');
        if (!currencyMatches) planningWarnings.push('La divisa de análisis ha cambiado. Edita el objetivo y revisa los importes antes de recalcularlo en la nueva divisa.');
        if (goal.targetDate <= asOfDate) planningWarnings.push('La fecha objetivo ya ha pasado; edita el objetivo para establecer una nueva fecha.');
        const projection = goal.status === 'active' && scopeMatches && currencyMatches && goal.targetDate > asOfDate
          ? projectSavingsGoal({
              asOfDate, targetDate: goal.targetDate, targetAmountMinor: goal.targetAmountMinor,
              initialAmountMinor: goal.initialAmountMinor, monthlyContributionMinor: goal.monthlyContributionMinor,
              currency: preferences.displayCurrency,
              monthlyIncomeMinor: goal.monthlyIncomeMinor ?? estimate.monthlyIncomeMinor,
              monthlyExpenseMinor: goal.monthlyExpenseMinor ?? estimate.monthlyExpenseMinor,
              commitments: eligibleCommitments,
            })
          : null;
        return { ...goal, scopeMatches, currencyMatches, projection, planningWarnings };
      });

      const manualOccurrences = expandCommitmentOccurrences(eligibleCommitments, monthPeriod.startDate, monthPeriod.endDate)
        .map((item) => ({
          id: item.id + '@' + item.occurrenceDate, source: 'manual_commitment' as const,
          title: item.title, date: item.occurrenceDate, amountMinor: item.amountMinor,
          direction: item.direction, frequency: item.frequency, currency: item.currency,
          status: item.status, notes: item.notes ?? '',
        }));

      let actualItems: Array<Record<string, unknown>> = [];
      let actualItemWarnings: string[] = [];
      const scheduledTransactions = await transactionsForAccounts(scope.accounts, monthPeriod.startDate, monthPeriod.endDate, preferences);
      const convertedScheduled = convertTransactionsForAnalysis(scheduledTransactions, preferences);
      actualItemWarnings = [...convertedScheduled.warnings];
      const categoriesById = new Map(categories.map((category) => [category.id, category]));
      const originalPayees = new Map(convertedScheduled.transactions.map((transaction) => [
        transaction.id,
        typeof transaction.payee_name === 'string' ? transaction.payee_name.trim() : '',
      ]));
      actualItems = normalizeTransactions(convertedScheduled.transactions)
        .filter((entry) => entry.date > asOfDate && entry.date >= monthPeriod.startDate && entry.date <= monthPeriod.endDate && !entry.isTransfer)
        .filter((entry) => entry.amountMinor < 0 || (entry.amountMinor > 0 && Boolean(entry.categoryId && categoriesById.get(entry.categoryId)?.isIncome)))
        .map((entry) => ({
          id: 'actual:' + entry.id, source: 'actual_transaction',
          title: originalPayees.get(entry.id) || entry.payeeLabel || 'Movimiento registrado',
          date: entry.date, amountMinor: Math.abs(entry.amountMinor),
          direction: entry.amountMinor < 0 ? 'expense' : 'income', frequency: 'once',
          frequencyLabel: 'Único · registrado en Actual', currency: preferences.displayCurrency,
          status: 'registered', notes: 'Movimiento ya registrado en Actual Budget; esta vista no lo modifica.',
        }));

      const recurringCandidates = detectRecurringCandidates(convertedHistory.transactions, {
        startDate: historyStartDate, endDate: asOfDate,
      });
      const candidateItems: Array<Record<string, unknown>> = [];
      for (const candidate of recurringCandidates) {
        const interval = candidate.estimatedIntervalDays;
        if (!interval || interval < 1 || !candidate.lastDate || candidate.meanAbsoluteAmountMinor <= 0) continue;
        const nextDate = new Date(candidate.lastDate + 'T00:00:00.000Z');
        nextDate.setUTCDate(nextDate.getUTCDate() + Math.round(interval));
        let attempts = 0;
        while ((nextDate.toISOString().slice(0, 10) <= asOfDate || nextDate.toISOString().slice(0, 10) < monthPeriod.startDate) && attempts < 100) {
          nextDate.setUTCDate(nextDate.getUTCDate() + Math.round(interval));
          attempts += 1;
        }
        const date = nextDate.toISOString().slice(0, 10);
        if (date < monthPeriod.startDate || date > monthPeriod.endDate || date <= asOfDate) continue;
        candidateItems.push({
          id: 'candidate:' + candidate.payee + '@' + date, source: 'recurring_candidate',
          title: candidate.payeeVariants[0] ?? candidate.payee, date,
          amountMinor: Math.round(candidate.meanAbsoluteAmountMinor), direction: 'expense',
          frequency: candidate.estimatedFrequency ?? 'estimated', frequencyLabel: 'Candidato · ' + (candidate.estimatedFrequency ?? 'cadencia estimada'),
          currency: preferences.displayCurrency, status: 'candidate',
          notes: 'Estimación estadística sin confirmar. No se añade a las proyecciones ni crea un compromiso automáticamente.',
        });
      }

      const calendarItems: Array<Record<string, unknown>> = [
        ...manualOccurrences.map((item) => ({ ...item, frequencyLabel: item.frequency, scopeMatches: true })),
        ...actualItems,
        ...candidateItems,
      ];
      calendarItems.sort((left, right) =>
        String(left.date).localeCompare(String(right.date)) ||
        String(left.source).localeCompare(String(right.source)) ||
        String(left.title).localeCompare(String(right.title)),
      );
      return {
        data: {
          asOfDate, month, currency: preferences.displayCurrency,
          accountScope: scope.metadata,
          history: estimate,
          goals,
          commitments: stored.commitments.map((item) => ({
            ...item,
            scopeMatches: planningScopeMatches(item.scope, preference),
            currencyMatches: item.currency === preferences.displayCurrency,
          })),
          calendarItems,
          warnings: [...convertedHistory.warnings, ...estimate.warnings, ...actualItemWarnings],
          notes: [
            'Los datos de objetivos y compromisos se guardan localmente en planning-data.json, separados de las transacciones de Actual Budget.',
            'Los compromisos manuales activos y compatibles con la divisa y el ámbito se incluyen en las proyecciones; los candidatos y los movimientos reales futuros se muestran en la agenda con su origen y no se convierten automáticamente en compromisos manuales.',
            'El ámbito de cuentas y la divisa usados para crear cada registro se guardan como referencia. Si cambian, el registro se excluye de la proyección hasta que se edite y confirme de nuevo.',
          ],
        },
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/planning/goals', async (request, reply) => {
    try {
      const body = PlanningGoalInputSchema.parse(request.body);
      const asOfDate = new Date().toISOString().slice(0, 10);
      validateGoalWindow(body.targetDate, asOfDate);
      const [preferences, scope] = await Promise.all([currencyPreferences(), accountScopePreference()]);
      const now = new Date().toISOString();
      const goal = StoredPlanningGoalSchema.parse({
        ...body,
        monthlyIncomeMinor: body.monthlyIncomeMinor ?? null,
        monthlyExpenseMinor: body.monthlyExpenseMinor ?? null,
        id: randomUUID(), currency: preferences.displayCurrency,
        scope: { mode: scope.mode, accountIds: [...scope.accountIds].sort() },
        status: 'active', createdAt: now, updatedAt: now,
      });
      const saved = await updatePlanningData(config.actualDataDir, (current) => {
        if (current.goals.length >= 100) throw new RangeError('No se pueden guardar más de 100 objetivos.');
        return { data: { ...current, goals: [...current.goals, goal] }, result: goal };
      });
      return reply.code(201).send({ data: saved });
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.put('/api/v1/planning/goals/:id', async (request, reply) => {
    try {
      const params = z.object({ id: z.string().uuid() }).strict().parse(request.params);
      const body = PlanningGoalInputSchema.parse(request.body);
      const asOfDate = new Date().toISOString().slice(0, 10);
      validateGoalWindow(body.targetDate, asOfDate);
      const [preferences, scope] = await Promise.all([currencyPreferences(), accountScopePreference()]);
      const now = new Date().toISOString();
      const result = await updatePlanningData(config.actualDataDir, (current) => {
        const index = current.goals.findIndex((item) => item.id === params.id);
        if (index < 0) return { data: current, result: null };
        const existing = current.goals[index]!;
        const updated = StoredPlanningGoalSchema.parse({
          ...body,
          monthlyIncomeMinor: body.monthlyIncomeMinor ?? null,
          monthlyExpenseMinor: body.monthlyExpenseMinor ?? null,
          id: existing.id, currency: preferences.displayCurrency,
          scope: { mode: scope.mode, accountIds: [...scope.accountIds].sort() },
          status: existing.status, createdAt: existing.createdAt, updatedAt: now,
        });
        const goals = [...current.goals];
        goals[index] = updated;
        return { data: { ...current, goals }, result: updated };
      });
      if (!result) return reply.code(404).send({ error: { code: 'PLANNING_GOAL_NOT_FOUND', message: 'No existe ese objetivo de planificación local.' } });
      return { data: result };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/planning/goals/:id/simulate', async (request, reply) => {
    try {
      const params = z.object({ id: z.string().uuid() }).strict().parse(request.params);
      const scenario = PlanningScenarioRequestSchema.parse(request.body);
      const [stored, preferences, currentScope] = await Promise.all([
        readPlanningData(config.actualDataDir), currencyPreferences(), accountScopePreference(),
      ]);
      const goal = stored.goals.find((item) => item.id === params.id);
      if (!goal) return reply.code(404).send({ error: { code: 'PLANNING_GOAL_NOT_FOUND', message: 'No existe ese objetivo de planificación local.' } });
      const asOfDate = new Date().toISOString().slice(0, 10);
      if (goal.status !== 'active') return reply.code(409).send({ error: { code: 'PLANNING_GOAL_PAUSED', message: 'Reanuda el objetivo antes de comparar escenarios.' } });
      if (!planningScopeMatches(goal.scope, currentScope) || goal.currency !== preferences.displayCurrency) {
        return reply.code(409).send({ error: { code: 'PLANNING_CONTEXT_CHANGED', message: 'El ámbito de cuentas o la divisa ha cambiado. Edita el objetivo y confirma el contexto actual antes de simular.' } });
      }
      validateGoalWindow(goal.targetDate, asOfDate);
      const commitments = stored.commitments.filter((item) =>
        item.status === 'active' && item.currency === goal.currency && planningScopeMatches(item.scope, currentScope),
      ).map(toPlanningCommitment);
      const projection = projectSavingsGoal({
        asOfDate, targetDate: goal.targetDate, targetAmountMinor: goal.targetAmountMinor,
        initialAmountMinor: goal.initialAmountMinor, currency: goal.currency,
        monthlyContributionMinor: scenario.monthlyContributionMinor,
        monthlyIncomeMinor: scenario.monthlyIncomeMinor,
        monthlyExpenseMinor: scenario.monthlyExpenseMinor,
        commitments,
      });
      return { data: { saved: false, label: 'Escenario personalizado (no guardado)', inputs: scenario, projection } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.patch('/api/v1/planning/goals/:id/status', async (request, reply) => {
    try {
      const params = z.object({ id: z.string().uuid() }).strict().parse(request.params);
      const body = PlanningStatusRequestSchema.parse(request.body);
      const result = await updatePlanningData(config.actualDataDir, (current) => {
        const existing = current.goals.find((item) => item.id === params.id);
        if (!existing) return { data: current, result: null };
        const updated = StoredPlanningGoalSchema.parse({ ...existing, status: body.status, updatedAt: new Date().toISOString() });
        return { data: { ...current, goals: current.goals.map((item) => item.id === params.id ? updated : item) }, result: updated };
      });
      if (!result) return reply.code(404).send({ error: { code: 'PLANNING_GOAL_NOT_FOUND', message: 'No existe ese objetivo de planificación local.' } });
      return { data: result };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.delete('/api/v1/planning/goals/:id', async (request, reply) => {
    try {
      const params = z.object({ id: z.string().uuid() }).strict().parse(request.params);
      const result = await updatePlanningData(config.actualDataDir, (current) => {
        const exists = current.goals.some((item) => item.id === params.id);
        return { data: { ...current, goals: current.goals.filter((item) => item.id !== params.id) }, result: exists };
      });
      if (!result) return reply.code(404).send({ error: { code: 'PLANNING_GOAL_NOT_FOUND', message: 'No existe ese objetivo de planificación local.' } });
      return { data: { id: params.id, deleted: true } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/planning/commitments', async (request, reply) => {
    try {
      const body = PlanningCommitmentInputSchema.parse(request.body);
      const asOfDate = new Date().toISOString().slice(0, 10);
      if (body.frequency === 'once' && body.date <= asOfDate) throw new RangeError('Un compromiso puntual debe tener una fecha futura.');
      const [preferences, scope] = await Promise.all([currencyPreferences(), accountScopePreference()]);
      const now = new Date().toISOString();
      const commitment = StoredPlanningCommitmentSchema.parse({
        ...body, id: randomUUID(), currency: preferences.displayCurrency,
        scope: { mode: scope.mode, accountIds: [...scope.accountIds].sort() },
        status: 'active', createdAt: now, updatedAt: now,
      });
      const saved = await updatePlanningData(config.actualDataDir, (current) => {
        if (current.commitments.length >= 500) throw new RangeError('No se pueden guardar más de 500 compromisos.');
        return { data: { ...current, commitments: [...current.commitments, commitment] }, result: commitment };
      });
      return reply.code(201).send({ data: saved });
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.put('/api/v1/planning/commitments/:id', async (request, reply) => {
    try {
      const params = z.object({ id: z.string().uuid() }).strict().parse(request.params);
      const body = PlanningCommitmentInputSchema.parse(request.body);
      const asOfDate = new Date().toISOString().slice(0, 10);
      if (body.frequency === 'once' && body.date <= asOfDate) throw new RangeError('Un compromiso puntual debe tener una fecha futura.');
      const [preferences, scope] = await Promise.all([currencyPreferences(), accountScopePreference()]);
      const now = new Date().toISOString();
      const result = await updatePlanningData(config.actualDataDir, (current) => {
        const existing = current.commitments.find((item) => item.id === params.id);
        if (!existing) return { data: current, result: null };
        const updated = StoredPlanningCommitmentSchema.parse({
          ...body, id: existing.id, currency: preferences.displayCurrency,
          scope: { mode: scope.mode, accountIds: [...scope.accountIds].sort() },
          status: existing.status, createdAt: existing.createdAt, updatedAt: now,
        });
        return { data: { ...current, commitments: current.commitments.map((item) => item.id === params.id ? updated : item) }, result: updated };
      });
      if (!result) return reply.code(404).send({ error: { code: 'PLANNING_COMMITMENT_NOT_FOUND', message: 'No existe ese compromiso de planificación local.' } });
      return { data: result };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.patch('/api/v1/planning/commitments/:id/status', async (request, reply) => {
    try {
      const params = z.object({ id: z.string().uuid() }).strict().parse(request.params);
      const body = PlanningStatusRequestSchema.parse(request.body);
      const result = await updatePlanningData(config.actualDataDir, (current) => {
        const existing = current.commitments.find((item) => item.id === params.id);
        if (!existing) return { data: current, result: null };
        const updated = StoredPlanningCommitmentSchema.parse({ ...existing, status: body.status, updatedAt: new Date().toISOString() });
        return { data: { ...current, commitments: current.commitments.map((item) => item.id === params.id ? updated : item) }, result: updated };
      });
      if (!result) return reply.code(404).send({ error: { code: 'PLANNING_COMMITMENT_NOT_FOUND', message: 'No existe ese compromiso de planificación local.' } });
      return { data: result };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.delete('/api/v1/planning/commitments/:id', async (request, reply) => {
    try {
      const params = z.object({ id: z.string().uuid() }).strict().parse(request.params);
      const result = await updatePlanningData(config.actualDataDir, (current) => {
        const exists = current.commitments.some((item) => item.id === params.id);
        return { data: { ...current, commitments: current.commitments.filter((item) => item.id !== params.id) }, result: exists };
      });
      if (!result) return reply.code(404).send({ error: { code: 'PLANNING_COMMITMENT_NOT_FOUND', message: 'No existe ese compromiso de planificación local.' } });
      return { data: { id: params.id, deleted: true } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/planning/reset', async (request, reply) => {
    try {
      DeletePlanningDataRequestSchema.parse(request.body);
      await resetPlanningData(config.actualDataDir);
      return { data: { deleted: true, goals: 0, commitments: 0 } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  return app;
}
