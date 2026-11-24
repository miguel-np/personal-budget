import { createHash, randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import { buildFinancialAnomalyFindings, buildPeriodChangeFindings, buildUncategorizedFinding, buildBudgetImprovementProposals, calculateSummary, convertAmountMinor, createFinancialFinding, detectRecurringCandidates, estimatePlanningCashFlow, evaluateBudgetAlertRules, expandCommitmentOccurrences, isIsoDate, normalizeCurrencyCode, normalizeTransactions, projectCashFlow, projectSavings, projectSavingsGoal, simulateBudgetImprovement, sortFinancialFindings, suggestCategories, validatePeriod, BudgetRepositoryError } from '@personal-budget/finance-core';
import type { BudgetAlertCategory, BudgetAlertRule, BudgetImprovementCategoryPreference, CashFlowEvent, BudgetCategoryClassification, BudgetRepository, BudgetTransaction, FinancialFinding, FindingPriority, ForecastScenario, ImportRecord, PlanningCommitment } from '@personal-budget/finance-core';
import { z, ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { validateRequestBoundary } from './request-boundary.js';
import { LocalAiBusyError, LocalAiCancelledError, LocalAiClient, LocalAiContextBudgetError, LocalAiUnavailableError } from './local-ai.js';
import type { AssistantContext } from './local-ai.js';
import { OFFICIAL_SOURCE_DOMAINS, SearXNGSearchProvider } from './web-search.js';
import type { WebSearchProvider } from './web-search.js';
import { readCurrencyPreferences } from './currency-preferences.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import { AccountScopeError, readAccountScope, resolveAccountScope } from './account-scope.js';
import type { AccountScopePreference, AccountScopeMetadata } from './account-scope.js';
import { PlanningCommitmentInputSchema, PlanningGoalInputSchema, readPlanningData, resetPlanningData, updatePlanningData, StoredPlanningCommitmentSchema, StoredPlanningGoalSchema } from './planning-store.js';
import type { StoredPlanningCommitment } from './planning-store.js';
import { effectiveFindingReview, readFindingReviewState, updateFindingReviewState } from './intelligence-store.js';
import { readPeriodicReviewState, updatePeriodicReviewItem } from './periodic-review-store.js';
import { readFinancialActionState, updateFinancialActionState } from './financial-actions-store.js';
import { readWealthData } from './wealth-store.js';
import { registerPortfolioRoutes } from './portfolio-routes.js';
import { registerPreferencesRoutes } from './preferences-routes.js';
import { queryTransactions, TransactionQueryTooBroadError } from './transaction-query.js';
import { handleTransactionUpdate } from './transaction-update.js';
import { handleAssistantWebSearch } from './assistant-web-search.js';
import { buildBudgetCategoryRows } from './budget-category-presentation.js';
import { buildCategorySuggestions } from './category-suggestions.js';
import { generateIntelligenceData } from './intelligence-service.js';
import { createPeriodicReviewReport } from './periodic-review-service.js';
import { handleCategorizeRequest } from './categorize-route.js';
import { handlePlanningConversationPreview } from './planning-conversation.js';
import { createCashFlowProjection } from './cash-flow-service.js';
import type { IntelligenceAnomalyOptions } from './intelligence-service.js';



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
  identityKey: z.string().regex(/^[0-9a-f]{16}$/),
  evidenceFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  type: z.enum(['expense-change', 'income-change', 'budget-overspend', 'pending-categorization', 'commitment-upcoming', 'recurring-candidate-upcoming', 'goal-at-risk', 'goal-progress', 'financial-anomaly']),
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
  reviewStatus: z.enum(['new', 'reviewed', 'expected', 'dismissed', 'snoozed']),
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
const AnomalyKindSchema = z.enum(['transaction-outlier', 'total-expense-change', 'category-change', 'payee-change', 'possible-duplicate', 'income-change', 'refund-change', 'frequency-change']);
const IntelligenceAnomalyOptionsSchema = z.object({
  referenceWindows: z.coerce.number().int().min(3).max(24).default(6),
  minimumAbsoluteChangeMinor: z.coerce.number().int().min(1).max(1_000_000_000).default(5_000),
  minimumRelativeChangePercent: z.coerce.number().finite().min(1).max(1_000).default(30),
  enabledAnomalyKinds: z.preprocess(
    (value) => typeof value === 'string' ? [value] : value,
    z.array(AnomalyKindSchema).max(8).refine((kinds) => new Set(kinds).size === kinds.length, 'Anomaly kinds must be unique.')
      .default(['transaction-outlier', 'total-expense-change', 'category-change', 'payee-change', 'possible-duplicate', 'income-change', 'refund-change', 'frequency-change']),
  ),
}).strict();
type IntelligenceAnomalyOptions = z.infer<typeof IntelligenceAnomalyOptionsSchema>;
const IntelligenceFindingsQuerySchema = IntelligenceDatesSchema.extend(IntelligenceAnomalyOptionsSchema.shape).strict();
const OptionalTimeZoneSchema = z.string().trim().min(1).max(100).optional().refine((value) => {
  if (!value) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be a valid IANA time zone.');
const PeriodicReviewStartSchema = z.object({
  periodType: z.enum(['weekly', 'monthly']),
  anchorDate: z.string().refine(isIsoDate, 'anchorDate must be a valid YYYY-MM-DD date.'),
  timeZone: OptionalTimeZoneSchema,
}).strict();
const PeriodicReviewItemUpdateSchema = z.object({
  findingId: z.string().trim().min(1).max(200),
  status: z.enum(['reviewed', 'postponed']),
  postponedUntil: z.string().refine(isIsoDate, 'postponedUntil must be a valid YYYY-MM-DD date.').optional(),
  timeZone: OptionalTimeZoneSchema,
}).strict().superRefine((value, context) => {
  if (value.status === 'postponed' && !value.postponedUntil) {
    context.addIssue({ code: 'custom', path: ['postponedUntil'], message: 'Choose an expiry date to postpone a review item.' });
  }
  if (value.status !== 'postponed' && value.postponedUntil !== undefined) {
    context.addIssue({ code: 'custom', path: ['postponedUntil'], message: 'Only postponed items may include an expiry date.' });
  }
});
const IntelligenceReviewRequestSchema = IntelligenceDatesSchema.extend(IntelligenceAnomalyOptionsSchema.shape).extend({
  findingId: z.string().trim().min(1).max(200),
  status: z.enum(['reviewed', 'expected', 'dismissed', 'snoozed']),
  snoozedUntil: z.string().refine(isIsoDate, 'snoozedUntil must be a valid YYYY-MM-DD date.').optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'snoozed' && !value.snoozedUntil) {
    context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Choose an expiry date to postpone a finding.' });
  }
  if (value.status !== 'snoozed' && value.snoozedUntil !== undefined) {
    context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Only snoozed findings may have an expiry date.' });
  }
});
const IntelligenceExplainRequestSchema = IntelligenceDatesSchema.extend(IntelligenceAnomalyOptionsSchema.shape).extend({
  findingId: z.string().trim().min(1).max(200),
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
const PlanningMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must use YYYY-MM.');
const PlanningStatusRequestSchema = z.object({ status: z.enum(['active', 'paused']) }).strict();
const SafeMinorAmountSchema = z.number().int().refine(Number.isSafeInteger, 'Amounts must be safe integers in minor currency units.');
const PlanningScenarioRequestSchema = z.object({
  monthlyContributionMinor: SafeMinorAmountSchema.nonnegative(),
  monthlyIncomeMinor: SafeMinorAmountSchema,
  monthlyExpenseMinor: SafeMinorAmountSchema.nonnegative(),
}).strict();

const BudgetImprovementPreferencesRequestSchema = z.object({
  goal: z.enum(['increase_monthly_margin', 'reduce_variable_spending', 'reach_savings_goal', 'free_cash_flow']),
  categories: z.array(z.object({
    categoryId: z.string().trim().min(1).max(128),
    classification: z.enum(['unclassified', 'essential', 'protected', 'flexible', 'reviewable']),
  }).strict()).max(500),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.categories.forEach((item, index) => {
    if (ids.has(item.categoryId)) context.addIssue({ code: 'custom', path: ['categories', index, 'categoryId'], message: 'Category preferences must be unique.' });
    ids.add(item.categoryId);
  });
});
const BudgetImprovementSimulationRequestSchema = z.object({
  periodMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]).default(6),
  reductions: z.array(z.object({
    categoryId: z.string().trim().min(1).max(128),
    reductionPercent: z.number().int().min(1).max(100),
  }).strict()).max(100),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.reductions.forEach((item, index) => {
    if (ids.has(item.categoryId)) context.addIssue({ code: 'custom', path: ['reductions', index, 'categoryId'], message: 'A category can only appear once in a combined scenario.' });
    ids.add(item.categoryId);
  });
});
const BudgetImprovementScenarioRequestSchema = BudgetImprovementSimulationRequestSchema.extend({
  name: z.string().trim().min(1).max(80),
}).strict();
const BudgetImprovementDecisionRequestSchema = z.object({
  proposalId: z.string().trim().min(1).max(256),
  status: z.enum(['accepted', 'rejected', 'postponed']),
  periodMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]).default(6),
}).strict();
const BudgetAlertRulesRequestSchema = z.object({
  rules: z.array(z.object({
    id: z.string().uuid().optional(),
    categoryId: z.string().trim().min(1).max(128),
    metric: z.enum(['percent_used', 'remaining_minor', 'overspend_minor', 'overspend_percent']),
    threshold: SafeMinorAmountSchema.nonnegative().max(1_000_000_000_000),
    enabled: z.boolean().default(true),
  }).strict().superRefine((rule, context) => {
    if ((rule.metric === 'percent_used' || rule.metric === 'overspend_percent') && (rule.threshold < 1 || rule.threshold > 500)) {
      context.addIssue({ code: 'custom', path: ['threshold'], message: 'Percentage threshold must be between 1 and 500.' });
    }
    if (rule.metric === 'overspend_minor' && rule.threshold < 1) {
      context.addIssue({ code: 'custom', path: ['threshold'], message: 'Overspend threshold must be greater than zero.' });
    }
  })).max(500),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  value.rules.forEach((rule, index) => {
    const key = rule.categoryId + ':' + rule.metric;
    if (keys.has(key)) context.addIssue({ code: 'custom', path: ['rules', index], message: 'Only one active rule per category and metric is supported.' });
    keys.add(key);
  });
});
const BudgetAlertEventDecisionSchema = z.object({
  ruleId: z.string().uuid(),
  categoryId: z.string().trim().min(1).max(128),
  month: PlanningMonthSchema,
  status: z.enum(['dismissed', 'snoozed']),
  snoozedUntil: z.string().refine(isIsoDate).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'snoozed' && !value.snoozedUntil) context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Choose an expiry date when postponing an alert.' });
  if (value.status === 'dismissed' && value.snoozedUntil) context.addIssue({ code: 'custom', path: ['snoozedUntil'], message: 'Dismissed alerts cannot include a snooze expiry.' });
});
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
const WebResearchRequestSchema = z.object({
  consent: z.literal(true),
  query: z.string().trim().min(2).max(500),
  mode: z.enum(['general', 'tax']).default('general'),
  domains: z.array(z.enum(OFFICIAL_SOURCE_DOMAINS)).max(OFFICIAL_SOURCE_DOMAINS.length).default([]),
  jurisdiction: z.string().trim().min(1).max(120).optional(),
  autonomousCommunity: z.string().trim().min(1).max(120).optional(),
  municipality: z.string().trim().min(1).max(120).optional(),
  taxpayerType: z.enum(['individual', 'self_employed', 'company', 'other']).optional(),
  eventDate: z.string().refine(isIsoDate, 'eventDate must be a valid YYYY-MM-DD date.').optional(),
  matter: z.string().trim().min(1).max(120).optional(),
  taxYear: z.string().regex(/^\d{4}$/).optional(),
  filingYear: z.string().regex(/^\d{4}$/).optional(),
  referenceDate: z.string().refine(isIsoDate, 'referenceDate must be a valid YYYY-MM-DD date.').optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.domains).size !== value.domains.length) {
    context.addIssue({ code: 'custom', path: ['domains'], message: 'Official source domains must be unique.' });
  }
  if (value.mode === 'tax') {
    for (const field of ['jurisdiction', 'matter', 'taxYear', 'filingYear', 'referenceDate'] as const) {
      if (!value[field]) context.addIssue({ code: 'custom', path: [field], message: 'Tax research requires an explicit jurisdiction, subject, tax year, filing year and reference date.' });
    }
  }
});

const MAX_REPORT_DAYS = 366 * 5;
export interface AppDependencies {
  readonly repository: BudgetRepository;
  readonly config: AppConfig;
  readonly logger?: FastifyServerOptions['logger'];
  /** Test seam; production defaults to the configured SearXNG provider. */
  readonly webSearchProvider?: WebSearchProvider;
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
  if (error instanceof BudgetRepositoryError) {
    if (error.code === 'INVALID_INPUT') return { statusCode: 400, body: { error: { code: error.code, message: error.message } } };
    if (error.code === 'NOT_CONFIGURED') return { statusCode: 503, body: { error: { code: error.code, message: 'The local Actual Budget connection is not configured.' } } };
    if (error.code === 'CLOSED') return { statusCode: 503, body: { error: { code: error.code, message: 'The local Actual Budget connection is closed.' } } };
  }
  if (error instanceof RangeError || (error instanceof Error && error.name === 'InvalidPeriodError')) {
    return { statusCode: 400, body: { error: { code: 'INVALID_PERIOD', message: error.message } } };
  }
  return { statusCode: 502, body: { error: { code: 'UPSTREAM_FAILURE', message: 'The local finance service could not complete this request.' } } };
}


function currencyFractionDigits(currency: string): number {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}
function majorToMinor(amount: number, currency: string, label: string): number {
  if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000_000) {
    throw new RangeError(label + ' supera el límite permitido para una simulación.');
  }
  const scale = Math.pow(10, currencyFractionDigits(currency));
  const scaled = amount * scale;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.00001) {
    throw new RangeError(label + ' contiene más decimales de los permitidos por ' + currency + '.');
  }
  return rounded;
}

function assertPeriod(startDate: string, endDate: string): void {
  validatePeriod({ startDate, endDate });
  if (!isWithinMaximumPeriod(startDate, endDate)) throw new RangeError('The requested period cannot exceed five years.');
}

/** Returns a civil YYYY-MM-DD date in the same IANA zone used by the browser review. */
function civilDateInTimeZone(timeZone: string, instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = (type: 'year' | 'month' | 'day') => parts.find((entry) => entry.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new RangeError('Could not determine the current civil date in the selected time zone.');
  return year + '-' + month + '-' + day;
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

  const webSearchProvider = dependencies.webSearchProvider ?? new SearXNGSearchProvider({
    baseURL: config.webSearchBaseURL,
    timeoutMs: config.webSearchTimeoutMs,
    maxResults: config.webSearchMaxResults,
    maxQueryChars: config.webSearchMaxQueryChars,
    maxResponseBytes: config.webSearchMaxResponseBytes,
  });
  const webSearchRequestTimes: number[] = [];
  const allowWebSearchRequest = (): boolean => {
    const now = Date.now();
    while (webSearchRequestTimes.length > 0 && webSearchRequestTimes[0]! <= now - 60_000) webSearchRequestTimes.shift();
    if (webSearchRequestTimes.length >= 6) return false;
    webSearchRequestTimes.push(now);
    return true;
  };

  await app.register(helmet, {
    contentSecurityPolicy: false,
    // The local runtime uses HTTP loopback; do not persist browser HSTS state.
    strictTransportSecurity: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  app.addHook('onRequest', async (request, reply) => {
    const boundary = validateRequestBoundary({
      method: request.method,
      headers: request.headers,
      rawHeaders: request.raw.rawHeaders,
      allowedOrigins: config.allowedOrigins,
      apiPort: request.raw.socket.localPort || config.port,
      environment: config.environment,
    });
    if (!boundary.allowed) {
      return reply.code(boundary.statusCode).send({
        error: { code: boundary.code, message: boundary.message },
      });
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
  app.get('/api/v1/assistant/web-search/status', async () => ({
    enabled: config.aiEnabled && config.webSearchEnabled,
    provider: 'SearXNG',
    explicitConsentRequired: true,
    toolCallingRequired: true,
    maximumResults: config.webSearchMaxResults,
  }));

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

  app.post('/api/v1/assistant/web-search', async (request, reply) => {
    try {
      const query = WebResearchRequestSchema.parse(request.body);
      return await handleAssistantWebSearch(query, request, reply, {
        config, localAi, webSearchProvider, allowWebSearchRequest, sanitizedErrorResponse,
      });
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.get('/api/v1/accounts', async (_request, reply) => {
    try {
      const [accounts, preferences, wealth] = await Promise.all([repository.listAccounts(), currencyPreferences(), readWealthData(config.actualDataDir)]);
      const accountClassifications = new Map(wealth.accountClassifications.map((item) => [item.accountId, item.classification]));
      const today = new Date().toISOString().slice(0, 10);
      return { data: accounts.map((account) => {
        const nativeCurrencyCode = normalizeCurrencyCode(account.currencyCode);
        const currencyCode = accountNativeCurrency(account, preferences);
        const conversion = account.currentBalanceMinor === null || currencyCode === null
          ? null
          : convertAmountMinor(account.currentBalanceMinor, currencyCode, preferences.displayCurrency, today, preferences.exchangeRates);
        return {
          ...account, classification: accountClassifications.get(account.id) ?? null,
          nativeCurrencyCode, currencyCode, displayCurrency: preferences.displayCurrency,
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
  await registerPreferencesRoutes(app, { repository, config, currencyPreferences, accountScopePreference, sanitizedErrorResponse });

  app.get('/api/v1/transactions', async (request, reply) => {
    try {
      const query = TransactionQuerySchema.parse(request.query);
      assertPeriod(query.startDate, query.endDate);
      const [allAccounts, preferences, preference, categories] = await Promise.all([
        repository.listAccounts(), currencyPreferences(), accountScopePreference(), repository.listCategories(),
      ]);
      const scope = resolveAccountScope(allAccounts, preference, query.accountId);
      const allAccountsById = new Map(allAccounts.map((account) => [account.id, account]));
      const scopedAccounts = scope.accounts.map((account) => allAccountsById.get(account.id))
        .filter((account): account is NonNullable<typeof account> => account !== undefined);
      const result = await queryTransactions(query, scopedAccounts, categories, preferences, repository);
      return { ...result, accountScope: scope.metadata };
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
      return await handleTransactionUpdate(request.params, request.body, reply, {
        repository, openAccountTransactions, assertPeriod,
      });
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
      if (typeof repository.importTransactions !== 'function') {
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
      const records: ImportRecord[] = parsed.records.map((record) => ({
        date: record.date,
        amount: record.amount,
        payee_name: record.payee_name,
        imported_id: record.imported_id,
        ...(record.imported_payee === undefined ? {} : { imported_payee: record.imported_payee }),
        ...(record.category === undefined ? {} : { category: record.category }),
        ...(record.notes === undefined ? {} : { notes: record.notes }),
      }));
      const result = await repository.importTransactions(parsed.accountId, records, { dryRun });
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
      if (typeof repository.importTransactions !== 'function' || typeof repository.listTransferPayees !== 'function') {
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

      const transferPayees = await repository.listTransferPayees();
      const transferPayee = transferPayees.find((payee) => payee.accountId === destination.id && payee.name.trim().length > 0);
      if (!transferPayee) {
        return reply.code(422).send({
          error: { code: 'TRANSFER_PAYEE_NOT_FOUND', message: 'Actual no ha devuelto un beneficiario de transferencia verificable para la cuenta destino. No se ha escrito ningún cambio.' },
        });
      }

      const record: ImportRecord = {
        date: parsed.date,
        amount: -parsed.amountMinor,
        payee_name: transferPayee.name,
        imported_payee: transferPayee.name,
        imported_id: parsed.importedId,
        ...(parsed.notes?.trim() ? { notes: parsed.notes.trim() } : {}),
      };
      const result = await repository.importTransactions(source.id, [record], { dryRun });
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
      if (typeof repository.getBudgetMonth !== 'function') {
        return reply.code(503).send({ error: { code: 'BUDGET_QUERY_NOT_SUPPORTED', message: 'The configured local adapter does not support budget queries.' } });
      }
      const allocationSourceAvailable = typeof repository.getBudgetAllocations === 'function';
      const [budget, categories, allocations] = await Promise.all([
        repository.getBudgetMonth(params.month),
        repository.listCategories(),
        allocationSourceAvailable ? repository.getBudgetAllocations!(params.month) : Promise.resolve(null),
      ]);
      const categoryRows = buildBudgetCategoryRows(
        budget, categories, allocations, allocationSourceAvailable, query.includeHidden === 'true',
      );
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
      if (typeof repository.setBudgetAmount !== 'function') {
        return reply.code(503).send({ error: { code: 'BUDGET_WRITE_NOT_SUPPORTED', message: 'The configured local adapter does not support budget updates.' } });
      }
      const categories = await repository.listCategories();
      const category = categories.find((item) => item.id === params.categoryId);
      if (!category || category.isIncome) {
        return reply.code(400).send({ error: { code: 'INVALID_CATEGORY', message: 'Choose an expense category from the configured budget.' } });
      }
      await repository.setBudgetAmount(params.month, params.categoryId, body.amountMinor);
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
        repository.listAccounts(), repository.listCategories(), currencyPreferences(), accountScopePreference(),
      ]);
      const scope = resolveAccountScope(accounts, preference, query.accountId);
      const rawTransactions = await transactionsForAccounts(scope.accounts, evidenceStart, query.endDate, preferences);
      const converted = convertTransactionsForAnalysis(rawTransactions, preferences);
      const result = await buildCategorySuggestions(converted.transactions, categories, {
        startDate: query.startDate, endDate: query.endDate,
      }, {
        localAi,
        aiEnabled: config.aiEnabled,
        aiCategoryClassificationEnabled: config.aiCategoryClassificationEnabled,
        includePayee: config.aiCategoryClassificationIncludePayee,
        modelConfigured: Boolean(config.ollamaModel),
        log: (fields, message) => app.log.info(fields, message),
      });
      return {
        ...result,
        accountScope: scope.metadata,
        notes: [
          'Las reglas deterministas se ejecutan primero; las coincidencias con evidencia histórica suficiente no invocan IA. No se aprende ni almacena ninguna regla.',
          'La IA local es opcional y solo se consulta como fallback en una única tanda limitada. Una propuesta de IA requiere baja incertidumbre cualitativa; no es una probabilidad calibrada.',
          config.aiCategoryClassificationIncludePayee
            ? 'Si la clasificación híbrida está activada, el contexto local incluye únicamente las etiquetas normalizadas de beneficiarios pendientes y el catálogo de categorías (IDs y nombres). No se envían notas, cuentas, importes, fechas, historial ni lotes completos.'
            : 'El envío de nombres de beneficiarios está desactivado. Las reglas deterministas siguen disponibles y no se llama al modelo para clasificación.',
          'Las transferencias, ingresos, reembolsos evidentes y categorías de ingreso quedan fuera de la clasificación de IA.',
          'Nada se modifica en Actual Budget sin revisión, previsualización y confirmación explícita.',
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

  async function intelligenceData(
    startDate: string,
    endDate: string,
    anomalyOptions: IntelligenceAnomalyOptions,
    asOfDateOverride?: string,
  ) {
    return generateIntelligenceData(startDate, endDate, anomalyOptions, asOfDateOverride, {
      repository,
      config,
      currencyPreferences,
      accountScopePreference,
      transactionsForAccounts,
      convertTransactionsForAnalysis,
      assertPeriod,
      validateFinding: (finding) => FinancialFindingContractSchema.parse(finding) as FinancialFinding,
    });
  }

  app.get('/api/v1/intelligence/findings', async (request, reply) => {
    try {
      const query = IntelligenceFindingsQuerySchema.parse(request.query);
      const result = await intelligenceData(query.startDate, query.endDate, query);
      const feedback = result.findings.filter((finding) =>
        finding.reviewStatus === 'reviewed' || finding.reviewStatus === 'expected' || finding.reviewStatus === 'dismissed');
      const dismissedCount = feedback.filter((finding) => finding.reviewStatus === 'dismissed').length;
      const usefulCount = feedback.filter((finding) => finding.reviewStatus === 'reviewed').length;
      const expectedCount = feedback.filter((finding) => finding.reviewStatus === 'expected').length;
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
            expectedCount,
            dismissedCount,
            dismissalRatePercent: feedback.length > 0 ? dismissedCount / feedback.length * 100 : null,
            note: 'Los hallazgos esperados son feedback explícito, no confirman por sí solos la precisión del detector. La tasa de descarte no equivale a la tasa real de falsos positivos.',
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
      const result = await intelligenceData(parsed.startDate, parsed.endDate, parsed);
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
      const result = await intelligenceData(parsed.startDate, parsed.endDate, parsed);
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


  app.get('/api/v1/reviews/periodic', async (_request, reply) => {
    try {
      const state = await readPeriodicReviewState(config.actualDataDir);
      return { data: state };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/reviews/periodic', async (request, reply) => {
    try {
      const parsed = PeriodicReviewStartSchema.parse(request.body);
      const result = await createPeriodicReviewReport(parsed, {
        config,
        repository,
        currencyPreferences,
        accountScopePreference,
        transactionsForAccounts,
        assertPeriod,
        defaultAnomalyOptions: IntelligenceAnomalyOptionsSchema.parse({}),
        generateIntelligenceData: intelligenceData,
      });
      return reply.code(201).send({ data: result });
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.patch('/api/v1/reviews/periodic/:reviewId/items', async (request, reply) => {
    try {
      const params = z.object({ reviewId: z.string().uuid() }).strict().parse(request.params);
      const parsed = PeriodicReviewItemUpdateSchema.parse(request.body);
      const today = civilDateInTimeZone(parsed.timeZone ?? 'UTC');
      if (parsed.status === 'postponed') {
        if (!parsed.postponedUntil || parsed.postponedUntil < today ||
            parsed.postponedUntil > addIntelligenceDays(today, 90)) {
          return reply.code(400).send({ error: { code: 'INVALID_POSTPONE_WINDOW', message: 'El aplazamiento debe vencer entre hoy y los próximos 90 días.' } });
        }
      }
      const updated = await updatePeriodicReviewItem(
        config.actualDataDir, params.reviewId, parsed.findingId, parsed.status,
        parsed.status === 'postponed' ? parsed.postponedUntil : undefined,
      );
      if (!updated) return reply.code(404).send({ error: { code: 'REVIEW_ITEM_NOT_FOUND', message: 'La revisión o el hallazgo ya no existe.' } });
      return { data: updated };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/insights/categorize', async (request, reply) => {
    return handleCategorizeRequest(request.body, reply, {
      repository, openAccountTransactions, assertPeriod, sanitizedErrorResponse,
    });
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


  app.post('/api/v1/planning/conversation/preview', async (request, reply) => {
    return handlePlanningConversationPreview(request, reply, {
      config, repository, localAi, currencyPreferences, accountScopePreference,
      transactionsForAccounts, convertTransactionsForAnalysis,
      planningScopeMatches, toPlanningCommitment, majorToMinor,
      currencyFractionDigits, shiftPlanningMonth, validateGoalWindow,
      sanitizedErrorResponse,
    });
  });

  app.post('/api/v1/cash-flow/project', async (request, reply) => {
    try {
      const result = await createCashFlowProjection(request.body, {
        config,
        repository,
        currencyPreferences,
        accountScopePreference,
        transactionsForAccounts,
        convertTransactionsForAnalysis,
        planningScopeMatches,
        accountNativeCurrency,
      });
      if ('statusCode' in result) return reply.code(result.statusCode).send(result.body);
      return result;
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  async function loadBudgetImprovementContext(periodMonths: 3 | 6 | 12) {
    const asOfDate = civilDateInTimeZone('UTC');
    const endMonth = shiftPlanningMonth(asOfDate.slice(0, 7), -1);
    const startMonth = shiftPlanningMonth(endMonth, -(periodMonths - 1));
    const startDate = startMonth + '-01';
    const endDate = planningMonthPeriod(endMonth).endDate;
    const [accounts, categories, preferences, accountPreference, actionState, planningData] = await Promise.all([
      repository.listAccounts(), repository.listCategories(), currencyPreferences(), accountScopePreference(),
      readFinancialActionState(config.actualDataDir), readPlanningData(config.actualDataDir),
    ]);
    const scope = resolveAccountScope(accounts, accountPreference);
    const accountScopeSignature = createHash('sha256').update(JSON.stringify({
      mode: scope.metadata.mode, accountIds: [...scope.metadata.accountIds].sort(),
    })).digest('hex');
    const rawTransactions = await transactionsForAccounts(scope.accounts, startDate, endDate, preferences);
    const converted = convertTransactionsForAnalysis(rawTransactions, preferences);
    const entries = normalizeTransactions(converted.transactions);
    const summary = calculateSummary(entries, categories, {
      startDate, endDate, currency: preferences.displayCurrency, exchangeRates: preferences.exchangeRates,
    });
    const monthsByCategory = new Map<string, Set<string>>();
    const expenseByCategoryMonth = new Map<string, Map<string, number>>();
    const incomeCategoryIds = new Set(categories.filter((category) => category.isIncome).map((category) => category.id));
    for (const entry of entries) {
      if (entry.isTransfer || !entry.categoryId || incomeCategoryIds.has(entry.categoryId)) continue;
      const entryMonth = entry.date.slice(0, 7);
      if (entry.amountMinor < 0) {
        const months = monthsByCategory.get(entry.categoryId) ?? new Set<string>();
        months.add(entryMonth);
        monthsByCategory.set(entry.categoryId, months);
      }
      const monthAmounts = expenseByCategoryMonth.get(entry.categoryId) ?? new Map<string, number>();
      // Positive movements in expense categories are refunds; net them against
      // the month's outflows before producing trend evidence.
      monthAmounts.set(entryMonth, (monthAmounts.get(entryMonth) ?? 0) - entry.amountMinor);
      expenseByCategoryMonth.set(entry.categoryId, monthAmounts);
    }
    const budgetWarnings: string[] = [];
    const budgetRows = new Map<string, { budgetedMinor: number | null; spentMinor: number | null; availableMinor: number | null }>();
    if (typeof repository.getBudgetMonth === 'function') {
      try {
        const allocationsAvailable = typeof repository.getBudgetAllocations === 'function';
        const [budgetMonth, allocations] = await Promise.all([
          repository.getBudgetMonth(endMonth),
          allocationsAvailable ? repository.getBudgetAllocations!(endMonth) : Promise.resolve(null),
        ]);
        const allocationByCategory = new Map((allocations ?? []).map((item) => [item.categoryId, item.amountMinor]));
        for (const group of budgetMonth.categoryGroups) {
          for (const row of group.categories ?? []) {
            budgetRows.set(row.id, {
              budgetedMinor: allocationsAvailable ? (allocationByCategory.get(row.id) ?? null) : (row.budgeted ?? null),
              spentMinor: row.spent === undefined || row.spent === null ? null : Math.abs(row.spent),
              availableMinor: row.balance ?? null,
            });
          }
        }
      } catch {
        budgetWarnings.push('No se pudo recuperar el presupuesto asignado del último mes completo; las propuestas se basan solo en el historial de movimientos.');
      }
    } else {
      budgetWarnings.push('El adaptador no expone asignaciones mensuales; las propuestas no pueden contrastarse con límites presupuestarios explícitos.');
    }
    const referenceMonths = Array.from({ length: periodMonths - 1 }, (_, index) => shiftPlanningMonth(startMonth, index));
    const observations = summary.expensesByCategory
      .filter((item) => item.categoryId !== null && item.amountMinor > 0)
      .map((item) => {
        const categoryId = item.categoryId as string;
        const monthAmounts = expenseByCategoryMonth.get(categoryId) ?? new Map<string, number>();
        const priorTotal = referenceMonths.reduce((sum, month) => sum + (monthAmounts.get(month) ?? 0), 0);
        const budget = budgetRows.get(categoryId);
        return {
          categoryId, categoryName: item.categoryName, expenseMinor: item.amountMinor,
          transactionCount: item.transactionCount,
          monthsWithActivity: monthsByCategory.get(categoryId)?.size ?? 0,
          latestMonthExpenseMinor: monthAmounts.get(endMonth) ?? 0,
          priorMonthsAverageExpenseMinor: Math.round(priorTotal / Math.max(1, periodMonths - 1)),
          budgetedMinor: budget?.budgetedMinor ?? null,
          budgetSpentMinor: budget?.spentMinor ?? null,
          budgetAvailableMinor: budget?.availableMinor ?? null,
        };
      });
    const categoryBreakdown = categories.filter((category) => !category.isIncome).map((category) => {
      const observation = observations.find((item) => item.categoryId === category.id);
      const budget = budgetRows.get(category.id);
      return {
        categoryId: category.id, categoryName: category.name,
        observedExpenseMinor: observation?.expenseMinor ?? 0,
        observedMonthlyExpenseMinor: observation ? Math.round(observation.expenseMinor / periodMonths) : 0,
        transactionCount: observation?.transactionCount ?? 0,
        monthsWithActivity: observation?.monthsWithActivity ?? 0,
        latestMonthExpenseMinor: observation?.latestMonthExpenseMinor ?? 0,
        priorMonthsAverageExpenseMinor: observation?.priorMonthsAverageExpenseMinor ?? 0,
        budgetedMinor: budget?.budgetedMinor ?? null,
        budgetSpentMinor: budget?.spentMinor ?? null,
        budgetAvailableMinor: budget?.availableMinor ?? null,
      };
    }).filter((item) => item.observedExpenseMinor > 0 || item.budgetedMinor !== null);
    const recurringCandidates = detectRecurringCandidates(converted.transactions, {
      startDate, endDate, minOccurrences: 3, intervalWindowDays: [20, 400],
    }).map((candidate) => ({
      payee: candidate.payee, occurrenceCount: candidate.occurrenceCount,
      estimatedIntervalDays: candidate.estimatedIntervalDays, estimatedFrequency: candidate.estimatedFrequency,
      meanAbsoluteAmountMinor: candidate.meanAbsoluteAmountMinor, amountDeviationPercent: candidate.amountDeviationPercent,
      lastObservedDate: candidate.lastDate, signals: candidate.signals, warnings: candidate.warnings,
    }));
    const activeCommitments = planningData.commitments.filter((item) =>
      item.status === 'active' && planningScopeMatches(item.scope, accountPreference),
    ).map((item) => {
      const conversion = item.currency === preferences.displayCurrency
        ? { amountMinor: item.amountMinor }
        : convertAmountMinor(item.amountMinor, item.currency, preferences.displayCurrency, asOfDate, preferences.exchangeRates);
      return {
        id: item.id, title: item.title, date: item.date, direction: item.direction, frequency: item.frequency,
        amountMinor: conversion.amountMinor, sourceCurrency: item.currency,
        currency: conversion.amountMinor === null ? item.currency : preferences.displayCurrency,
        conversionAvailable: conversion.amountMinor !== null && conversion.amountMinor > 0,
      };
    });
    if (activeCommitments.some((item) => !item.conversionAvailable)) {
      budgetWarnings.push('Hay compromisos activos cuyo importe no se puede convertir a la divisa de análisis; se muestran en su divisa original y no se suman a los escenarios.');
    }
    const rawEntryCount = normalizeTransactions(rawTransactions).length;
    const unconvertedTransactionCount = Math.max(0, rawEntryCount - entries.length);
    const baseline = {
      currency: preferences.displayCurrency, startDate, endDate, periodMonths,
      monthlyIncomeMinor: Math.round(summary.incomeMinor / periodMonths),
      monthlyExpenseMinor: Math.round(summary.expenseMinor / periodMonths),
      monthlySavingsMinor: Math.round(summary.savingsMinor / periodMonths),
      savingsRatePercent: summary.savingsRatePercent,
      transactionCount: summary.transactionCount,
      unconvertedTransactionCount,
      observations,
    };
    const storedPreferences = actionState.budgetImprovements.categories;
    const corePreferences: BudgetImprovementCategoryPreference[] = storedPreferences
      .filter((item) => item.classification !== 'unclassified')
      .map((item) => ({ categoryId: item.categoryId, classification: item.classification as BudgetCategoryClassification }));
    const proposals = buildBudgetImprovementProposals(baseline, corePreferences, actionState.budgetImprovements.goal);
    const compatibleCommitments = planningData.commitments.filter((item) =>
      item.status === 'active' && item.currency === preferences.displayCurrency && planningScopeMatches(item.scope, accountPreference),
    ).map(toPlanningCommitment);
    const savingsGoals = planningData.goals.map((goal) => {
      const scopeMatches = planningScopeMatches(goal.scope, accountPreference);
      const currencyMatches = goal.currency === preferences.displayCurrency;
      const goalWarnings: string[] = [];
      if (!scopeMatches) goalWarnings.push('El ámbito guardado del objetivo ha cambiado; revísalo desde Objetivos antes de usarlo para esta simulación.');
      if (!currencyMatches) goalWarnings.push('La divisa guardada del objetivo no coincide con la divisa de análisis; no se convierten importes automáticamente.');
      if (goal.status === 'paused') goalWarnings.push('El objetivo está pausado; reanúdalo desde Objetivos antes de incluirlo en una proyección.');
      if (goal.targetDate <= asOfDate) goalWarnings.push('La fecha objetivo ya ha pasado; actualiza el objetivo para proyectarlo.');
      const projection = goal.status === 'active' && scopeMatches && currencyMatches && goal.targetDate > asOfDate
        ? projectSavingsGoal({
            asOfDate, targetDate: goal.targetDate, targetAmountMinor: goal.targetAmountMinor,
            initialAmountMinor: goal.initialAmountMinor, monthlyContributionMinor: goal.monthlyContributionMinor,
            currency: preferences.displayCurrency,
            monthlyIncomeMinor: goal.monthlyIncomeMinor ?? baseline.monthlyIncomeMinor,
            monthlyExpenseMinor: goal.monthlyExpenseMinor ?? baseline.monthlyExpenseMinor,
            commitments: compatibleCommitments,
          })
        : null;
      return {
        id: goal.id, name: goal.name, targetDate: goal.targetDate,
        targetAmountMinor: goal.targetAmountMinor, initialAmountMinor: goal.initialAmountMinor,
        monthlyContributionMinor: goal.monthlyContributionMinor,
        monthlyIncomeMinor: goal.monthlyIncomeMinor ?? baseline.monthlyIncomeMinor,
        monthlyExpenseMinor: goal.monthlyExpenseMinor ?? baseline.monthlyExpenseMinor,
        currency: goal.currency, status: goal.status, scopeMatches, currencyMatches, projection, warnings: goalWarnings,
      };
    });
    const savingsGoalContextStatus = savingsGoals.some((goal) => goal.projection !== null)
      ? 'ready'
      : savingsGoals.length > 0 ? 'review_required' : 'not_configured';
    const savingsGoalContextWarnings = savingsGoals.flatMap((goal) => goal.warnings.map((warning) => goal.name + ': ' + warning));
    const targetSavingsGoal = savingsGoals
      .filter((goal) => goal.status === 'active' && goal.projection !== null && goal.projection.requiredMonthlyContributionMinor !== null)
      .sort((left, right) => {
        const leftGap = Math.max(0, left.projection!.requiredMonthlyContributionMinor! - left.monthlyContributionMinor);
        const rightGap = Math.max(0, right.projection!.requiredMonthlyContributionMinor! - right.monthlyContributionMinor);
        return rightGap - leftGap || left.targetDate.localeCompare(right.targetDate);
      })[0] ?? null;
    const targetRequiredMonthlyContributionMinor = targetSavingsGoal?.projection?.requiredMonthlyContributionMinor ?? null;
    const targetSavingsGapMinor = targetSavingsGoal && targetRequiredMonthlyContributionMinor !== null
      ? Math.max(0, targetRequiredMonthlyContributionMinor - targetSavingsGoal.monthlyContributionMinor)
      : null;
    const prioritizedProposals = proposals
      .map((proposal) => {
        let priorityTier = 0;
        let priorityValue = proposal.estimatedMonthlySavingsMinor;
        let priorityReason = 'Ordenada por el margen mensual hipotético que podría liberar, calculado sobre el gasto observado.';
        let goalImpact: {
          goalId: string; goalName: string; monthlyContributionGapMinor: number;
          estimatedGapCoveredMinor: number; estimatedGapRemainingMinor: number;
        } | null = null;
        if (actionState.budgetImprovements.goal === 'reduce_variable_spending') {
          const latest = proposal.evidence.latestMonthExpenseMinor ?? 0;
          const previous = proposal.evidence.priorMonthsAverageExpenseMinor ?? 0;
          const increase = Math.max(0, latest - previous);
          priorityTier = increase > 0 ? 1 : 0;
          priorityValue = increase;
          priorityReason = priorityTier
            ? 'Prioridad por tendencia: el último mes completo superó la media de referencia. Revisa primero esta variación antes de fijar un recorte.'
            : 'No hay un aumento reciente cuantificado; se mantiene como alternativa secundaria basada en el presupuesto y el historial.';
        } else if (actionState.budgetImprovements.goal === 'reach_savings_goal') {
          if (targetSavingsGoal && targetSavingsGapMinor !== null) {
            const covered = Math.min(
              targetSavingsGapMinor, proposal.estimatedMonthlySavingsMinor,
              Math.max(0, targetSavingsGoal.monthlyExpenseMinor),
            );
            goalImpact = {
              goalId: targetSavingsGoal.id, goalName: targetSavingsGoal.name,
              monthlyContributionGapMinor: targetSavingsGapMinor,
              estimatedGapCoveredMinor: covered,
              estimatedGapRemainingMinor: Math.max(0, targetSavingsGapMinor - covered),
            };
            priorityTier = targetSavingsGapMinor > 0 ? 1 : 0;
            priorityValue = covered;
            priorityReason = targetSavingsGapMinor > 0
              ? 'Prioridad vinculada a «' + targetSavingsGoal.name + '»: se ordena por la parte de la brecha de aportación mensual que esta propuesta podría cubrir si se destina íntegramente al objetivo.'
              : 'El plan actual ya cubre la aportación mensual requerida para «' + targetSavingsGoal.name + '»; se ordena por ahorro potencial adicional.';
          } else {
            priorityReason = 'No hay un objetivo activo compatible con la divisa, el ámbito y una fecha proyectable; se ordena por ahorro mensual potencial sin atribuir impacto a una meta.';
          }
        } else if (actionState.budgetImprovements.goal === 'free_cash_flow') {
          priorityTier = proposal.evidence.latestMonthExpenseMinor === null ? 0 : 1;
          priorityValue = proposal.evidence.latestMonthExpenseMinor ?? proposal.estimatedMonthlySavingsMinor;
          priorityReason = 'Prioridad por liquidez inmediata: se ordena por el gasto neto del último mes completo, además de mostrar el ahorro mensual potencial; los compromisos activos siguen siendo independientes.';
        } else {
          priorityReason = 'Prioridad por margen: se ordena por el ahorro mensual hipotético derivado del gasto observado, sin asumir cambios automáticos.';
        }
        return { proposal, priorityTier, priorityValue, priorityReason, goalImpact };
      })
      .sort((left, right) => right.priorityTier - left.priorityTier ||
        right.priorityValue - left.priorityValue ||
        right.proposal.estimatedMonthlySavingsMinor - left.proposal.estimatedMonthlySavingsMinor ||
        left.proposal.categoryName.localeCompare(right.proposal.categoryName))
      .map(({ proposal, priorityReason, goalImpact }, index) => ({
        ...proposal, priorityRank: index + 1, priorityReason, goalImpact,
      }));
    const scenarios = actionState.budgetImprovements.scenarios.map((scenario) => {
      if (scenario.currency !== baseline.currency) {
        return { ...scenario, comparisonStatus: 'different_currency' as const, comparison: null };
      }
      if (scenario.startDate !== baseline.startDate || scenario.endDate !== baseline.endDate) {
        return { ...scenario, comparisonStatus: 'different_period' as const, comparison: null };
      }
      if (!scenario.accountScopeSignature || scenario.accountScopeSignature !== accountScopeSignature) {
        return { ...scenario, comparisonStatus: 'different_scope' as const, comparison: null };
      }
      try {
        const comparison = simulateBudgetImprovement(baseline, corePreferences, scenario.reductions);
        return {
          ...scenario, comparisonStatus: 'comparable' as const,
          comparison: {
            baselineMonthlySavingsMinor: baseline.monthlySavingsMinor,
            estimatedMonthlySavingsMinor: comparison.estimatedMonthlySavingsMinor,
            projectedMonthlySavingsMinor: comparison.projectedMonthlySavingsMinor,
            estimatedAnnualSavingsMinor: comparison.estimatedAnnualSavingsMinor,
            projectedAnnualSavingsMinor: comparison.projectedAnnualSavingsMinor,
            assumptions: comparison.assumptions, warnings: comparison.warnings,
          },
        };
      } catch {
        return { ...scenario, comparisonStatus: 'preferences_changed' as const, comparison: null };
      }
    });
    const categoryChoices = categories.filter((category) => !category.isIncome).map((category) => ({
      categoryId: category.id,
      categoryName: category.name,
      classification: storedPreferences.find((item) => item.categoryId === category.id)?.classification ?? 'unclassified',
    }));
    return {
      asOfDate, currency: preferences.displayCurrency, accountScope: scope.metadata, accountScopeSignature, baseline,
      categoryBreakdown, recurringCandidates, commitments: compatibleCommitments,
      proposals: prioritizedProposals, corePreferences, categoryChoices, savingsGoals, savingsGoalContextStatus, savingsGoalContextWarnings,
      goal: actionState.budgetImprovements.goal,
      decisions: actionState.budgetImprovements.decisions,
      scenarios,
      warnings: [...summary.warnings, ...converted.warnings, ...budgetWarnings, 'Se usan ' + periodMonths + ' meses naturales completos, hasta ' + endDate + '; el mes en curso se excluye para evitar extrapolar un periodo parcial.', 'La comparación de tendencia usa el último mes completo frente a la media de los meses anteriores; un patrón recurrente detectado es un candidato, no una obligación.'],
    };
  }

  app.get('/api/v1/budget-improvements', async (request, reply) => {
    try {
      const query = z.object({ periodMonths: z.coerce.number().int().pipe(z.union([z.literal(3), z.literal(6), z.literal(12)])).default(6) }).strict().parse(request.query);
      const context = await loadBudgetImprovementContext(query.periodMonths);
      return { data: context };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.put('/api/v1/budget-improvements/preferences', async (request, reply) => {
    try {
      const parsed = BudgetImprovementPreferencesRequestSchema.parse(request.body);
      const categories = await repository.listCategories();
      const validIds = new Set(categories.filter((category) => !category.isIncome).map((category) => category.id));
      if (parsed.categories.some((item) => !validIds.has(item.categoryId))) {
        return reply.code(400).send({ error: { code: 'INVALID_CATEGORY', message: 'Choose only expense categories from the configured Actual budget.' } });
      }
      const saved = await updateFinancialActionState(config.actualDataDir, (current) => ({
        state: {
          ...current,
          budgetImprovements: { ...current.budgetImprovements, goal: parsed.goal, categories: parsed.categories },
        },
        result: parsed,
      }));
      return { data: saved };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/budget-improvements/simulate', async (request, reply) => {
    try {
      const parsed = BudgetImprovementSimulationRequestSchema.parse(request.body);
      const context = await loadBudgetImprovementContext(parsed.periodMonths);
      const simulation = simulateBudgetImprovement(context.baseline, context.corePreferences, parsed.reductions);
      const goalImpacts = context.savingsGoals
        .filter((goal) => goal.status === 'active' && goal.projection !== null && goal.scopeMatches && goal.currencyMatches)
        .map((goal) => {
          // Treat simulated savings as both a reduction in the goal's monthly
          // expense assumption and an equal additional recurring contribution.
          // This lets projectSavingsGoal recalculate available cash after
          // commitments instead of pretending the new contribution was free.
          const estimatedMonthlySavingsAllocatedMinor = Math.min(
            simulation.estimatedMonthlySavingsMinor, Math.max(0, goal.monthlyExpenseMinor),
          );
          const scenarioMonthlyContributionMinor = goal.monthlyContributionMinor + estimatedMonthlySavingsAllocatedMinor;
          const scenarioMonthlyExpenseMinor = Math.max(0, goal.monthlyExpenseMinor - estimatedMonthlySavingsAllocatedMinor);
          if (!Number.isSafeInteger(scenarioMonthlyContributionMinor) || !Number.isSafeInteger(scenarioMonthlyExpenseMinor)) {
            throw new RangeError('Scenario monthly contribution or expense exceeds the supported integer range.');
          }
          const scenarioProjection = projectSavingsGoal({
            asOfDate: context.asOfDate,
            targetDate: goal.targetDate,
            targetAmountMinor: goal.targetAmountMinor,
            initialAmountMinor: goal.initialAmountMinor,
            monthlyContributionMinor: scenarioMonthlyContributionMinor,
            currency: goal.currency,
            monthlyIncomeMinor: goal.monthlyIncomeMinor,
            monthlyExpenseMinor: scenarioMonthlyExpenseMinor,
            commitments: context.commitments,
          });
          const currentRequired = goal.projection!.requiredMonthlyContributionMinor;
          const gapBefore = currentRequired === null ? null : Math.max(0, currentRequired - goal.monthlyContributionMinor);
          const gapAfter = currentRequired === null ? null : Math.max(0, currentRequired - scenarioMonthlyContributionMinor);
          return {
            goalId: goal.id, goalName: goal.name, targetDate: goal.targetDate, currency: goal.currency,
            baselineMonthlyContributionMinor: goal.monthlyContributionMinor,
            scenarioMonthlyContributionMinor,
            estimatedMonthlySavingsAllocatedMinor,
            requiredMonthlyContributionMinor: currentRequired,
            monthlyContributionGapBeforeMinor: gapBefore,
            monthlyContributionGapAfterMinor: gapAfter,
            baselineProjectedBalanceMinor: goal.projection!.projectedBalanceMinor,
            scenarioProjectedBalanceMinor: scenarioProjection.projectedBalanceMinor,
            projectedBalanceIncreaseMinor: scenarioProjection.projectedBalanceMinor - goal.projection!.projectedBalanceMinor,
            baselineProjectedProgressPercent: goal.projection!.projectedProgressPercent,
            scenarioProjectedProgressPercent: scenarioProjection.projectedProgressPercent,
            baselineEstimatedCompletionDate: goal.projection!.estimatedCompletionDate,
            scenarioEstimatedCompletionDate: scenarioProjection.estimatedCompletionDate,
            baselineAchievableUnderCashFlow: goal.projection!.achievableUnderCashFlow,
            scenarioAchievableUnderCashFlow: scenarioProjection.achievableUnderCashFlow,
            assumptions: [
              ...scenarioProjection.assumptions,
              'El ahorro simulado reduce el gasto mensual supuesto y se destina íntegramente a incrementar la aportación mensual de este objetivo; el usuario no ha reservado ni transferido dinero.',
            ],
            warnings: [
              ...scenarioProjection.warnings,
              ...(estimatedMonthlySavingsAllocatedMinor < simulation.estimatedMonthlySavingsMinor
                ? ['El ahorro simulado supera el gasto mensual configurado para este objetivo; el impacto se limita al gasto disponible y no asigna el excedente.']
                : []),
            ],
          };
        });
      return {
        data: {
          baseline: context.baseline, simulation, goalImpacts, goal: context.goal,
          accountScope: context.accountScope, warnings: context.warnings,
          comparison: {
            baselineMonthlySavingsMinor: context.baseline.monthlySavingsMinor,
            scenarioMonthlySavingsMinor: simulation.projectedMonthlySavingsMinor,
            improvementMonthlyMinor: simulation.estimatedMonthlySavingsMinor,
            referenceStartDate: context.baseline.startDate,
            referenceEndDate: context.baseline.endDate,
          },
        },
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.post('/api/v1/budget-improvements/scenarios', async (request, reply) => {
    try {
      const parsed = BudgetImprovementScenarioRequestSchema.parse(request.body);
      const context = await loadBudgetImprovementContext(parsed.periodMonths);
      const simulation = simulateBudgetImprovement(context.baseline, context.corePreferences, parsed.reductions);
      const scenario = {
        id: randomUUID(), name: parsed.name, startDate: context.baseline.startDate, endDate: context.baseline.endDate,
        currency: context.currency, accountScopeSignature: context.accountScopeSignature, reductions: parsed.reductions,
        estimatedMonthlySavingsMinor: simulation.estimatedMonthlySavingsMinor,
        estimatedAnnualSavingsMinor: simulation.estimatedAnnualSavingsMinor, createdAt: new Date().toISOString(),
      };
      const saved = await updateFinancialActionState(config.actualDataDir, (current) => ({
        state: {
          ...current,
          budgetImprovements: { ...current.budgetImprovements, scenarios: [scenario, ...current.budgetImprovements.scenarios].slice(0, 100) },
        },
        result: scenario,
      }));
      return reply.code(201).send({ data: saved });
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.patch('/api/v1/budget-improvements/decisions', async (request, reply) => {
    try {
      const parsed = BudgetImprovementDecisionRequestSchema.parse(request.body);
      const context = await loadBudgetImprovementContext(parsed.periodMonths);
      if (!context.proposals.some((proposal) => proposal.id === parsed.proposalId)) {
        return reply.code(409).send({ error: { code: 'STALE_PROPOSAL', message: 'The proposal no longer matches the current evidence. Refresh the analysis before recording a decision.' } });
      }
      const decision = { proposalId: parsed.proposalId, status: parsed.status, updatedAt: new Date().toISOString() };
      const saved = await updateFinancialActionState(config.actualDataDir, (current) => ({
        state: {
          ...current,
          budgetImprovements: {
            ...current.budgetImprovements,
            decisions: [decision, ...current.budgetImprovements.decisions.filter((item) => item.proposalId !== parsed.proposalId)].slice(0, 2_000),
          },
        },
        result: decision,
      }));
      return { data: saved };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.delete('/api/v1/budget-improvements/scenarios/:id', async (request, reply) => {
    try {
      const params = z.object({ id: z.string().uuid() }).strict().parse(request.params);
      const deleted = await updateFinancialActionState(config.actualDataDir, (current) => ({
        state: {
          ...current,
          budgetImprovements: {
            ...current.budgetImprovements,
            scenarios: current.budgetImprovements.scenarios.filter((scenario) => scenario.id !== params.id),
          },
        },
        result: current.budgetImprovements.scenarios.some((scenario) => scenario.id === params.id),
      }));
      return { data: { deleted } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.get('/api/v1/budget-alerts', async (request, reply) => {
    try {
      const query = z.object({ month: PlanningMonthSchema.optional() }).strict().parse(request.query);
      const asOfDate = civilDateInTimeZone('UTC');
      const month = query.month ?? asOfDate.slice(0, 7);
      if (typeof repository.getBudgetMonth !== 'function') {
        return reply.code(503).send({ error: { code: 'BUDGET_QUERY_NOT_SUPPORTED', message: 'The configured local adapter does not support budget queries.' } });
      }
      const allocationSourceAvailable = typeof repository.getBudgetAllocations === 'function';
      const [budget, categories, allocations, actionState] = await Promise.all([
        repository.getBudgetMonth(month), repository.listCategories(),
        allocationSourceAvailable ? repository.getBudgetAllocations!(month) : Promise.resolve(null),
        readFinancialActionState(config.actualDataDir),
      ]);
      const categoriesById = new Map(categories.map((category) => [category.id, category]));
      const allocationsByCategory = new Map((allocations ?? []).map((allocation) => [allocation.categoryId, allocation.amountMinor]));
      const budgetCategories: BudgetAlertCategory[] = budget.categoryGroups.flatMap((group) =>
        (group.categories ?? []).map((category) => {
          const metadata = categoriesById.get(category.id);
          const explicitAllocation = allocationsByCategory.get(category.id);
          const budgetedMinor = allocationSourceAvailable
            ? (explicitAllocation ?? 0)
            : category.budgeted === undefined || category.budgeted === null ? null : category.budgeted;
          const state: BudgetAlertCategory['state'] = allocationSourceAvailable
            ? explicitAllocation === undefined ? 'unbudgeted' : explicitAllocation === 0 ? 'zero' : 'budgeted'
            : category.budgeted === undefined ? 'unbudgeted' : category.budgeted === null ? 'unknown' : category.budgeted === 0 ? 'zero' : 'budgeted';
          return {
            categoryId: category.id,
            categoryName: metadata?.name ?? category.name,
            budgetedMinor,
            spentMinor: category.spent === undefined || category.spent === null ? null : Math.abs(category.spent),
            availableMinor: category.balance ?? null,
            state,
            hidden: category.hidden ?? group.hidden ?? false,
          };
        }),
      ).filter((item) => !item.hidden);
      const rules = actionState.budgetAlerts.rules;
      const crossingAlerts = evaluateBudgetAlertRules(rules, budgetCategories, month);
      const alerts = crossingAlerts.flatMap((alert) => {
        const eventId = createHash('sha256').update([alert.ruleId, alert.categoryId, month].join('|')).digest('hex').slice(0, 32);
        const decision = actionState.budgetAlerts.events.find((event) => event.id === eventId);
        if (decision?.status === 'dismissed') return [];
        if (decision?.status === 'snoozed' && decision.snoozedUntil && decision.snoozedUntil >= asOfDate) return [];
        return [{ ...alert, eventId, status: 'active' as const, currency: config.budgetCurrency }];
      });
      return {
        data: {
          month, evaluatedAt: new Date().toISOString(), currency: config.budgetCurrency, rules, alerts,
          categories: budgetCategories.filter((item) => !item.hidden),
          warnings: [
            'El presupuesto mensual de Actual se expone por categoría y no por cuenta; las alertas usan el mismo ámbito presupuestario global que la pantalla Presupuestos, sin inferir un reparto por cuentas.',
            ...(allocationSourceAvailable ? [] : ['El adaptador no distingue de forma fiable una asignación explícita de cero de una asignación ausente; las reglas omiten esos estados desconocidos.']),
            ...(budgetCategories.some((item) => item.state === 'unbudgeted' || item.state === 'unknown') ? ['Las categorías sin presupuesto explícito o con importe desconocido no generan alertas de consumo.'] : []),
          ],
        },
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.put('/api/v1/budget-alerts/rules', async (request, reply) => {
    try {
      const parsed = BudgetAlertRulesRequestSchema.parse(request.body);
      const categories = await repository.listCategories();
      const expenseIds = new Set(categories.filter((category) => !category.isIncome).map((category) => category.id));
      if (parsed.rules.some((rule) => !expenseIds.has(rule.categoryId))) {
        return reply.code(400).send({ error: { code: 'INVALID_CATEGORY', message: 'Alert rules must target existing expense categories.' } });
      }
      const rules: BudgetAlertRule[] = parsed.rules.map((rule) => ({
        id: rule.id ?? randomUUID(), categoryId: rule.categoryId, metric: rule.metric,
        threshold: rule.threshold, enabled: rule.enabled,
      }));
      const saved = await updateFinancialActionState(config.actualDataDir, (current) => ({
        state: {
          ...current,
          budgetAlerts: {
            rules,
            events: current.budgetAlerts.events.filter((event) => {
              const previous = current.budgetAlerts.rules.find((rule) => rule.id === event.ruleId);
              const replacement = rules.find((rule) => rule.id === event.ruleId);
              return Boolean(previous && replacement && previous.categoryId === replacement.categoryId && previous.metric === replacement.metric && previous.threshold === replacement.threshold && previous.enabled === replacement.enabled);
            }),
          },
        },
        result: rules,
      }));
      return { data: saved };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

  app.patch('/api/v1/budget-alerts/events/:eventId', async (request, reply) => {
    try {
      const params = z.object({ eventId: z.string().regex(/^[a-f0-9]{32}$/) }).strict().parse(request.params);
      const parsed = BudgetAlertEventDecisionSchema.parse(request.body);
      const expectedId = createHash('sha256').update([parsed.ruleId, parsed.categoryId, parsed.month].join('|')).digest('hex').slice(0, 32);
      if (expectedId !== params.eventId) return reply.code(400).send({ error: { code: 'INVALID_ALERT_EVENT', message: 'Alert event identity does not match its rule, category and period.' } });
      const today = civilDateInTimeZone('UTC');
      if (parsed.status === 'snoozed' && (!parsed.snoozedUntil || parsed.snoozedUntil <= today || parsed.snoozedUntil > addCivilDays(today, 90))) {
        return reply.code(400).send({ error: { code: 'INVALID_SNOOZE', message: 'Snooze expiry must be between tomorrow and 90 days from today.' } });
      }
      const saved = await updateFinancialActionState(config.actualDataDir, (current) => {
        if (!current.budgetAlerts.rules.some((rule) => rule.id === parsed.ruleId)) {
          throw new Error('The alert rule no longer exists.');
        }
        const event = {
          id: params.eventId, ruleId: parsed.ruleId, categoryId: parsed.categoryId,
          month: parsed.month, status: parsed.status,
          ...(parsed.snoozedUntil === undefined ? {} : { snoozedUntil: parsed.snoozedUntil }),
          updatedAt: new Date().toISOString(),
        };
        return {
          state: {
            ...current,
            budgetAlerts: {
              ...current.budgetAlerts,
              events: [event, ...current.budgetAlerts.events.filter((item) => item.id !== params.eventId)].slice(0, 2_000),
            },
          },
          result: event,
        };
      });
      return { data: saved };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });

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

  await registerPortfolioRoutes(app, { config, repository });

  return app;
}
