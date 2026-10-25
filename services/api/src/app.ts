import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import { calculateSummary, isIsoDate, normalizeTransactions, validatePeriod } from '@personal-budget/finance-core';
import type { BudgetRepository } from '@personal-budget/finance-core';
import { ActualAdapterError } from '@personal-budget/actual-adapter';
import { z, ZodError } from 'zod';
import type { AppConfig } from './config.js';

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
      const accounts = query.accountId
        ? [{ id: query.accountId, name: '', closed: false }]
        : (await repository.listAccounts()).filter((account) => !account.closed);
      const groups = await Promise.all(accounts.map((account) =>
        repository.listTransactions(account.id, query.startDate, query.endDate),
      ));
      const flattened = groups.flat().flatMap((transaction) => {
        if (transaction.is_child === true || transaction.parent_id) return [];
        if (transaction.subtransactions && transaction.subtransactions.length > 0) {
          return transaction.subtransactions.map((child, index) => ({
            ...child,
            id: child.id || transaction.id + ':split:' + index,
            account: child.account || transaction.account,
            date: child.date || transaction.date,
            payee_id: child.payee_id ?? transaction.payee_id,
            payee_name: ('payee_name' in child ? child.payee_name : undefined) ?? ('payee_name' in transaction ? transaction.payee_name : undefined),
            imported_payee: ('imported_payee' in child ? child.imported_payee : undefined) ?? ('imported_payee' in transaction ? transaction.imported_payee : undefined),
            is_child: false,
            parent_id: null,
          }));
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

  return app;
}
