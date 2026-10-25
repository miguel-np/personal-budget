import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import { calculateSummary, detectRecurringCandidates, isIsoDate, normalizeTransactions, projectSavings, suggestCategories, validatePeriod } from '@personal-budget/finance-core';
import type { BudgetRepository, BudgetTransaction, ForecastScenario } from '@personal-budget/finance-core';
import { ActualAdapterError } from '@personal-budget/actual-adapter';
import type { ActualBudgetMonthRecord, ActualImportRecord, ActualImportResult } from '@personal-budget/actual-adapter';
import { z, ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { LocalAiClient, LocalAiUnavailableError } from './local-ai.js';
import type { AssistantContext } from './local-ai.js';

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
  records: z.array(ImportRecordSchema).min(1).max(2_000),
}).strict();
const BudgetMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must use YYYY-MM.');
const BudgetAmountSchema = z.object({ amountMinor: z.number().int().refine(Number.isSafeInteger, 'amount must be a safe integer.').min(0) }).strict();
const InsightsQuerySchema = z.object({
  accountId: z.string().trim().min(1).max(128).optional(),
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
}).strict();
const CategorizeRequestSchema = z.object({
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
  commit: z.boolean().default(false),
  transactions: z.array(z.object({
    transactionId: z.string().trim().min(1).max(128),
    categoryId: z.string().trim().min(1).max(128),
  }).strict()).min(1).max(200),
}).strict();
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
  const localAi = new LocalAiClient({
    enabled: config.aiEnabled,
    baseURL: config.ollamaBaseURL,
    ...(config.ollamaModel ? { model: config.ollamaModel } : {}),
    timeoutMs: config.ollamaTimeoutMs,
    maxContextChars: config.aiMaxContextChars,
  });
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

  app.get('/api/v1/assistant/status', async () => localAi.status());

  app.post('/api/v1/assistant/chat', async (request, reply) => {
    try {
      const query = AssistantRequestSchema.parse(request.body);
      assertPeriod(query.startDate, query.endDate);
      if (query.previousStartDate && query.previousEndDate) {
        assertPeriod(query.previousStartDate, query.previousEndDate);
      }
      if (!config.aiEnabled) {
        return reply.code(503).send({ error: { code: 'AI_DISABLED', message: 'El asistente local está desactivado. La aplicación financiera sigue disponible.' } });
      }
      const status = await localAi.status();
      if (status.status !== 'available') {
        return reply.code(503).send({ error: { code: 'AI_UNAVAILABLE', message: 'Ollama o el modelo configurado no están disponibles en local.' } });
      }
      const [allAccounts, categories] = await Promise.all([repository.listAccounts(), repository.listCategories()]);
      const accounts = allAccounts.filter((account) => !account.closed &&
        (query.accountId === undefined || account.id === query.accountId));
      if (query.accountId && accounts.length === 0) {
        return reply.code(400).send({ error: { code: 'INVALID_ACCOUNT', message: 'Elige una cuenta abierta del presupuesto local.' } });
      }
      const summarize = async (startDate: string, endDate: string) => {
        const groups = await Promise.all(accounts.map((account) => repository.listTransactions(account.id, startDate, endDate)));
        return calculateSummary(normalizeTransactions(groups.flat()), categories, {
          startDate, endDate, currency: config.budgetCurrency,
        });
      };
      const summary = await summarize(query.startDate, query.endDate);
      const comparison = query.previousStartDate && query.previousEndDate
        ? await summarize(query.previousStartDate, query.previousEndDate) : undefined;
      const context: AssistantContext = {
        question: query.question,
        summary: {
          currency: summary.currency, startDate: summary.startDate, endDate: summary.endDate,
          incomeMinor: summary.incomeMinor, expenseMinor: summary.expenseMinor,
          savingsMinor: summary.savingsMinor, savingsRatePercent: summary.savingsRatePercent,
          transactionCount: summary.transactionCount, excludedTransferCount: summary.excludedTransferCount,
        },
        expensesByCategory: summary.expensesByCategory.slice(0, 15).map((item) => ({
          categoryName: item.categoryName, amountMinor: item.amountMinor, transactionCount: item.transactionCount,
        })),
        ...(comparison ? { comparison: {
          startDate: comparison.startDate, endDate: comparison.endDate,
          incomeMinor: comparison.incomeMinor, expenseMinor: comparison.expenseMinor, savingsMinor: comparison.savingsMinor,
        } } : {}),
      };
      const answer = await localAi.explain(context);
      return { data: { summary, ...(comparison ? { comparison } : {}), answer, answerKind: 'qualitative_explanation' } };
    } catch (error) {
      if (error instanceof LocalAiUnavailableError) {
        return reply.code(503).send({ error: { code: 'AI_UNAVAILABLE', message: 'Ollama no ha podido completar la explicación local.' } });
      }
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.get('/api/v1/accounts', async (_request, reply) => {
    try { return { data: await repository.listAccounts() }; }
    catch (error) { const normalized = sanitizedErrorResponse(error); return reply.code(normalized.statusCode).send(normalized.body); }
  });
  app.get('/api/v1/categories', async (_request, reply) => {
    try { return { data: await repository.listCategories() }; }
    catch (error) { const normalized = sanitizedErrorResponse(error); return reply.code(normalized.statusCode).send(normalized.body); }
  });
  app.get('/api/v1/transactions', async (request, reply) => {
    try {
      const query = TransactionQuerySchema.parse(request.query);
      assertPeriod(query.startDate, query.endDate);
      const allAccounts = await repository.listAccounts();
      const accounts = allAccounts.filter((account) =>
        !account.closed && (query.accountId === undefined || account.id === query.accountId),
      );
      if (query.accountId !== undefined && accounts.length === 0) {
        return reply.code(400).send({ error: { code: 'INVALID_ACCOUNT', message: 'Choose an open account from the configured budget.' } });
      }
      const groups = await Promise.all(accounts.map((account) =>
        repository.listTransactions(account.id, query.startDate, query.endDate),
      ));
      type PresentedTransaction = BudgetTransaction & {
        readonly payee_name?: string | null;
        readonly imported_payee?: string | null;
      };
      const flattened: PresentedTransaction[] = groups.flat().flatMap((source): PresentedTransaction[] => {
        const transaction = source as PresentedTransaction;
        if (transaction.is_child === true || transaction.parent_id) return [];
        if (transaction.subtransactions && transaction.subtransactions.length > 0) {
          return transaction.subtransactions.map((sourceChild, index): PresentedTransaction => {
            const child = sourceChild as PresentedTransaction;
            const payeeId = child.payee_id ?? transaction.payee_id;
            const payeeName = child.payee_name ?? transaction.payee_name;
            const importedPayee = child.imported_payee ?? transaction.imported_payee;
            return {
              ...child,
              id: child.id || transaction.id + ':split:' + index,
              account: child.account || transaction.account,
              date: child.date || transaction.date,
              ...(payeeId === undefined ? {} : { payee_id: payeeId }),
              ...(payeeName === undefined ? {} : { payee_name: payeeName }),
              ...(importedPayee === undefined ? {} : { imported_payee: importedPayee }),
              is_child: false,
              parent_id: null,
            };
          });
        }
        return [transaction];
      });
      const categories = await repository.listCategories();
      const categoriesById = new Map(categories.map((category) => [category.id, category]));
      const accountsById = new Map(accounts.map((account) => [account.id, account]));
      const queryText = query.search?.toLocaleLowerCase('es') ?? '';
      const filtered = flattened.filter((transaction) => {
        if (query.categoryId && transaction.category !== query.categoryId) return false;
        if (query.uncategorized === 'true' && transaction.category) return false;
        if (query.uncategorized === 'false' && !transaction.category) return false;
        if (!queryText) return true;
        const extra = transaction as typeof transaction & { payee_name?: string | null; imported_payee?: string | null };
        const description = extra.payee_name || extra.imported_payee || transaction.notes || transaction.payee_id || '';
        const accountName = accountsById.get(transaction.account)?.name ?? '';
        const categoryName = categoriesById.get(transaction.category ?? '')?.name ?? '';
        return [description, accountName, categoryName, transaction.notes ?? '']
          .some((value) => value.toLocaleLowerCase('es').includes(queryText));
      });
      filtered.sort((left, right) => {
        let comparison = 0;
        if (query.sortBy === 'amount') comparison = left.amount - right.amount;
        else if (query.sortBy === 'description') {
          const leftExtra = left as typeof left & { payee_name?: string | null; imported_payee?: string | null };
          const rightExtra = right as typeof right & { payee_name?: string | null; imported_payee?: string | null };
          const leftDescription = leftExtra.payee_name || leftExtra.imported_payee || left.notes || left.payee_id || '';
          const rightDescription = rightExtra.payee_name || rightExtra.imported_payee || right.notes || right.payee_id || '';
          comparison = leftDescription.localeCompare(rightDescription, 'es');
        } else comparison = left.date.localeCompare(right.date);
        return query.order === 'asc' ? comparison : -comparison;
      });
      const total = filtered.length;
      const data = filtered.slice(query.offset, query.offset + query.limit);
      return { data, pagination: { total, limit: query.limit, offset: query.offset, sortBy: query.sortBy, order: query.order } };
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
      if (!accounts.some((account) => account.id === parsed.accountId && !account.closed)) {
        return reply.code(400).send({ error: { code: 'INVALID_ACCOUNT', message: 'Choose an open account from the configured budget.' } });
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
      const [accounts, categories] = await Promise.all([repository.listAccounts(), repository.listCategories()]);
      const activeAccounts = accounts.filter((account) => !account.closed);
      const transactionGroups = await Promise.all(activeAccounts.map((account) =>
        repository.listTransactions(account.id, query.startDate, query.endDate),
      ));
      const entries = normalizeTransactions(transactionGroups.flat());
      return {
        data: calculateSummary(entries, categories, {
          startDate: query.startDate, endDate: query.endDate, currency: config.budgetCurrency,
        }),
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  async function openAccountTransactions(
    accountId: string | undefined,
    startDate: string,
    endDate: string,
  ): Promise<{ readonly accounts: readonly { readonly id: string; readonly name: string }[]; readonly transactions: readonly BudgetTransaction[] }> {
    const allAccounts = await repository.listAccounts();
    const accounts = allAccounts.filter((account) =>
      !account.closed && (accountId === undefined || account.id === accountId));
    if (accountId !== undefined && accounts.length === 0) {
      throw new ActualAdapterError('INVALID_INPUT', 'Choose an open account from the configured budget.');
    }
    const groups = await Promise.all(accounts.map((account) =>
      repository.listTransactions(account.id, startDate, endDate)));
    return { accounts, transactions: groups.flat() };
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
      const { transactions } = await openAccountTransactions(query.accountId, query.startDate, query.endDate);
      const candidates = detectRecurringCandidates(transactions, {
        startDate: query.startDate, endDate: query.endDate,
      });
      return {
        data: candidates,
        notes: [
          'Los candidatos se detectan con señales deterministas (beneficiario, frecuencia, importe y fechas) y no garantizan que el gasto se repita.',
          'Este endpoint no modifica Actual Budget; la confirmación de sugerencias usa un flujo separado con previsualización.',
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
      const [accounts, categories] = await Promise.all([
        repository.listAccounts(),
        repository.listCategories(),
      ]);
      const activeAccounts = accounts.filter((account) =>
        !account.closed && (query.accountId === undefined || account.id === query.accountId));
      if (query.accountId !== undefined && activeAccounts.length === 0) {
        return reply.code(400).send({ error: { code: 'INVALID_ACCOUNT', message: 'Choose an open account from the configured budget.' } });
      }
      const groups = await Promise.all(activeAccounts.map((account) =>
        repository.listTransactions(account.id, evidenceStart, query.endDate)));
      const suggestions = suggestCategories(groups.flat(), categories, {
        startDate: query.startDate, endDate: query.endDate,
      });
      return {
        data: suggestions,
        notes: [
          'Las sugerencias usan reglas deterministas sobre el historial local de los últimos 12 meses y no aprenden ni almacenan reglas nuevas.',
          'Nada se modifica en Actual Budget sin revisión y confirmación explícita.',
        ],
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/insights/categorize', async (request, reply) => {
    try {
      const parsed = CategorizeRequestSchema.parse(request.body);
      assertPeriod(parsed.startDate, parsed.endDate);
      const categorizer = repository as BudgetRepository & {
        updateTransactionCategory?: (transactionId: string, categoryId: string) => Promise<void>;
      };
      if (typeof categorizer.updateTransactionCategory !== 'function') {
        return reply.code(503).send({ error: { code: 'TRANSACTION_UPDATE_NOT_SUPPORTED', message: 'The configured local adapter does not support transaction updates.' } });
      }
      const { transactions } = await openAccountTransactions(undefined, parsed.startDate, parsed.endDate);
      const transactionById = new Map(transactions
        .filter((transaction) => !transaction.is_child && !transaction.parent_id)
        .map((transaction) => [transaction.id, transaction]));
      for (const change of parsed.transactions) {
        if (!transactionById.has(change.transactionId)) {
          return reply.code(400).send({ error: { code: 'INVALID_TRANSACTION', message: 'One or more transaction ids do not belong to an open account in the period.' } });
        }
      }
      const categories = await repository.listCategories();
      const expenseCategories = new Set(categories.filter((category) => !category.isIncome).map((category) => category.id));
      if (parsed.transactions.some((change) => !expenseCategories.has(change.categoryId))) {
        return reply.code(400).send({ error: { code: 'INVALID_CATEGORY', message: 'Choose an expense category from the configured budget.' } });
      }
      if (!parsed.commit) {
        return { data: { preview: true, requested: parsed.transactions.length, changes: parsed.transactions.length } };
      }
      for (const change of parsed.transactions) {
        await categorizer.updateTransactionCategory!(change.transactionId, change.categoryId);
      }
      return { data: { preview: false, requested: parsed.transactions.length, changes: parsed.transactions.length } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/forecasts/simulate', async (request, reply) => {
    try {
      const parsed = ForecastRequestSchema.parse(request.body);
      assertPeriod(parsed.startDate, parsed.endDate);
      const [accounts, categories] = await Promise.all([repository.listAccounts(), repository.listCategories()]);
      const activeAccounts = accounts.filter((account) => !account.closed);
      const groups = await Promise.all(activeAccounts.map((account) =>
        repository.listTransactions(account.id, parsed.startDate, parsed.endDate)));
      const result = projectSavings(
        groups.flat(),
        categories,
        parsed.scenario as ForecastScenario,
        {
          currency: config.budgetCurrency,
          horizonMonths: parsed.horizonMonths,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
        },
      );
      return { data: result };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  return app;
}
