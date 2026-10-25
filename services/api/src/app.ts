import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import { calculateSummary, isIsoDate, normalizeTransactions, validatePeriod } from '@personal-budget/finance-core';
import type { BudgetRepository } from '@personal-budget/finance-core';
import { ActualAdapterError } from '@personal-budget/actual-adapter';
import { z, ZodError } from 'zod';
import type { AppConfig } from './config.js';

const TransactionQuerySchema = z.object({
  accountId: z.string().trim().min(1).max(128),
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
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
    if (error.code === 'NOT_CONFIGURED') return { statusCode: 503, body: { error: { code: error.code, message: error.message } } };
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
    disableRequestLogging: true,
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
    maxParamLength: 128,
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
      return { data: await repository.listTransactions(query.accountId, query.startDate, query.endDate) };
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
