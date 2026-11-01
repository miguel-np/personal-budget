import { createHash, randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import { buildFinancialAnomalyFindings, buildPeriodChangeFindings, buildUncategorizedFinding, buildBudgetImprovementProposals, calculateSummary, convertAmountMinor, createFinancialFinding, detectRecurringCandidates, estimatePlanningCashFlow, evaluateBudgetAlertRules, expandCommitmentOccurrences, isIsoDate, normalizeCurrencyCode, normalizeTransactions, projectCashFlow, projectSavings, projectSavingsGoal, simulateBudgetImprovement, sortFinancialFindings, suggestCategories, validatePeriod } from '@personal-budget/finance-core';
import type { BudgetAlertCategory, BudgetAlertRule, BudgetImprovementCategoryPreference, CashFlowEvent, BudgetCategoryClassification, BudgetRepository, BudgetTransaction, CategorySuggestion as CoreCategorySuggestion, FinancialFinding, FindingPriority, ForecastScenario, PlanningCommitment, TransactionCategoryBatchChange, TransactionStructureUpdate } from '@personal-budget/finance-core';
import { ActualAdapterError } from '@personal-budget/actual-adapter';
import type { ActualBudgetMonthRecord, ActualImportRecord, ActualImportResult } from '@personal-budget/actual-adapter';
import { z, ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { LocalAiBusyError, LocalAiCancelledError, LocalAiClient, LocalAiContextBudgetError, LocalAiUnavailableError } from './local-ai.js';
import type { AssistantContext, PlanningIntentDraft } from './local-ai.js';
import { CurrencyPreferencesSchema, defaultCurrencyPreferences, readCurrencyPreferences, writeCurrencyPreferences } from './currency-preferences.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import { AccountScopeError, AccountScopePreferenceSchema, defaultAccountScope, readAccountScope, resolveAccountScope, writeAccountScope } from './account-scope.js';
import { AppPreferencesSchema, defaultAppPreferences, readAppPreferences, writeAppPreferences } from './app-preferences.js';
import type { AccountScopePreference, AccountScopeMetadata } from './account-scope.js';
import { PlanningCommitmentInputSchema, PlanningGoalInputSchema, readPlanningData, resetPlanningData, updatePlanningData, StoredPlanningCommitmentSchema, StoredPlanningGoalSchema } from './planning-store.js';
import type { StoredPlanningCommitment } from './planning-store.js';
import { effectiveFindingReview, readFindingReviewState, updateFindingReviewState } from './intelligence-store.js';
import { createPeriodicReview, readPeriodicReviewState, updatePeriodicReviewItem } from './periodic-review-store.js';
import { readFinancialActionState, updateFinancialActionState } from './financial-actions-store.js';
import { readWealthData } from './wealth-store.js';
import { registerPortfolioRoutes } from './portfolio-routes.js';


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
const CategoryClassificationPayloadSchema = z.object({
  suggestions: z.array(z.object({
    reference: z.string().trim().regex(/^c(?:[1-9]|1[0-2])$/),
    categoryId: z.string().trim().min(1).max(128).nullable(),
    rationale: z.string().trim().min(1).max(240),
    uncertainty: z.enum(['low', 'medium', 'high']),
  }).strict()).min(1).max(12),
}).strict();
type HybridCategorySuggestion = Omit<CoreCategorySuggestion,
  'suggestedCategoryId' | 'suggestedCategoryName' | 'lastEvidenceDate' | 'confidence'> & {
  readonly suggestedCategoryId: string | null;
  readonly suggestedCategoryName: string | null;
  readonly lastEvidenceDate: string | null;
  readonly confidence: 'rule_based' | 'local_ai' | 'none';
  readonly source: 'rule_based' | 'local_ai' | 'none';
  readonly uncertainty: 'low' | 'medium' | 'high' | 'not_assessed';
  readonly rationale: string | null;
};
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

const PlanningConversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(1_600),
}).strict();
const PlanningIntentDraftSchema = z.object({
  intent: z.enum(['goal_plan', 'compare_contributions', 'test_expense']),
  goalId: z.string().uuid().nullable(),
  goalName: z.string().trim().min(1).max(100).nullable(),
  targetAmountMajor: z.number().finite().positive().max(1_000_000_000).nullable(),
  targetDate: z.string().refine(isIsoDate).nullable(),
  initialAmountMajor: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
  monthlyContributionMajor: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
  contributionOptionsMajor: z.array(z.number().finite().nonnegative().max(1_000_000_000)).max(5),
  monthlyIncomeMajor: z.number().finite().min(-1_000_000_000).max(1_000_000_000).nullable(),
  monthlyExpenseMajor: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
  expenseAmountMajor: z.number().finite().positive().max(1_000_000_000).nullable(),
  expenseDate: z.string().refine(isIsoDate).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  clarificationQuestion: z.string().trim().min(1).max(240).nullable(),
}).strict();

const CashFlowRequestSchema = z.object({
  horizonDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
  reserveMinor: SafeMinorAmountSchema.nonnegative().optional(),
  scenario: z.object({
    date: z.string().refine(isIsoDate),
    amountMinor: SafeMinorAmountSchema.positive(),
    direction: z.enum(['income', 'expense']),
    label: z.string().trim().min(1).max(100),
  }).strict().optional(),
  recurringCandidateIds: z.array(z.string().regex(/^rc_[a-f0-9]{24}$/)).max(50).default([]),
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
const MAX_REPORT_DAYS = 366 * 5;
const MAX_TRANSACTION_SCAN = 100_000;

/**
 * The official Actual SDK has no cursor API. Query one calendar month at a time so
 * a multi-year history never has to be materialized as one SDK result. The route
 * stops scanning after MAX_TRANSACTION_SCAN presented rows and does not fetch later
 * months once that budget is exhausted. The SDK's aqlQuery does expose limit/offset,
 * but without cursor or snapshot semantics; that evaluation and the decision to keep
 * monthly windows are recorded in docs/transactions-and-imports.md.
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

  function durationDaysBetween(startDate: string, endDate: string): number {
  return Math.floor((Date.parse(endDate + 'T00:00:00.000Z') - Date.parse(startDate + 'T00:00:00.000Z')) / 86_400_000) + 1;
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
      const ruleSuggestions = suggestCategories(converted.transactions, categories, {
        startDate: query.startDate, endDate: query.endDate,
      });
      const suggestions: HybridCategorySuggestion[] = ruleSuggestions.map((suggestion) => ({
        ...suggestion,
        source: 'rule_based' as const,
        uncertainty: 'not_assessed' as const,
        rationale: null,
      }));
      const rulesById = new Map(ruleSuggestions.map((suggestion) => [suggestion.transactionId, suggestion] as const));
      const expenseCategories = categories.filter((category) => !category.isIncome);
      const expenseCategoryById = new Map(expenseCategories.map((category) => [category.id, category] as const));
      const entries = normalizeTransactions(converted.transactions);
      const fallbackEntries = entries
        .filter((entry) => !entry.isTransfer && entry.amountMinor < 0 && entry.categoryId === null &&
          Boolean(entry.payeeLabel) && entry.date >= query.startDate && entry.date <= query.endDate &&
          !/(refund|reembolso|devoluci[oó]n|chargeback|reintegro)/i.test(entry.payeeLabel ?? ''))
        .filter((entry) => {
          const deterministic = rulesById.get(entry.id);
          // Two or more historical matches are retained as the primary deterministic
          // source. A single vote, a new payee or a tied top vote is fallback territory.
          return !deterministic || deterministic.evidenceCount < 2;
        })
        .sort((left, right) => left.date.localeCompare(right.date) ||
          (left.payeeLabel ?? '').localeCompare(right.payeeLabel ?? '', 'es') || left.id.localeCompare(right.id));
      const MAX_CLASSIFICATION_CANDIDATES = 12;
      const selectedFallbackEntries = fallbackEntries.slice(0, MAX_CLASSIFICATION_CANDIDATES);
      const selectedIds = new Set(selectedFallbackEntries.map((entry) => entry.id));
      const classificationEnabled = config.aiEnabled && config.aiCategoryClassificationEnabled;
      let classificationOutcome: 'disabled' | 'no_candidates' | 'not_configured' | 'payee_sharing_disabled' |
        'completed' | 'abstained' | 'invalid_response' | 'unavailable' | 'context_limited' =
        classificationEnabled ? 'no_candidates' : 'disabled';
      let inferenceDurationMs = 0;
      let batchAttempted = false;

      const noneSuggestion = (entry: (typeof selectedFallbackEntries)[number], rationale: string,
        uncertainty: HybridCategorySuggestion['uncertainty'] = 'high'): HybridCategorySuggestion => ({
        transactionId: entry.id,
        date: entry.date,
        payeeLabel: entry.payeeLabel ?? '',
        amountMinor: entry.amountMinor,
        suggestedCategoryId: null,
        suggestedCategoryName: null,
        evidenceCount: 0,
        lastEvidenceDate: null,
        confidence: 'none',
        source: 'none',
        uncertainty,
        rationale,
      });

      if (classificationEnabled && selectedFallbackEntries.length > 0) {
        if (!config.ollamaModel) {
          classificationOutcome = 'not_configured';
        } else if (!config.aiCategoryClassificationIncludePayee) {
          classificationOutcome = 'payee_sharing_disabled';
        } else if (expenseCategories.length === 0 || expenseCategories.length > 100) {
          classificationOutcome = 'context_limited';
        } else {
          const referenceToEntry = new Map(selectedFallbackEntries.map((entry, index) =>
            ['c' + (index + 1), entry] as const));
          const startedAt = Date.now();
          batchAttempted = true;
          try {
            const raw = await localAi.classifyCategories({
              categories: expenseCategories.map((category) => ({ id: category.id, name: category.name })),
              transactions: selectedFallbackEntries.map((entry, index) => ({
                reference: 'c' + (index + 1),
                payee: entry.payeeLabel ?? '',
              })),
            });
            inferenceDurationMs = Math.max(0, Date.now() - startedAt);
            const payload = CategoryClassificationPayloadSchema.parse(JSON.parse(raw));
            const expectedReferences = new Set(referenceToEntry.keys());
            const receivedReferences = new Set<string>();
            for (const candidate of payload.suggestions) {
              if (!expectedReferences.has(candidate.reference) || receivedReferences.has(candidate.reference)) {
                throw new Error('Invalid category classification references.');
              }
              receivedReferences.add(candidate.reference);
              if (candidate.categoryId !== null && !expenseCategoryById.has(candidate.categoryId)) {
                throw new Error('Invalid category classification category.');
              }
            }
            if (receivedReferences.size !== expectedReferences.size) {
              throw new Error('Incomplete category classification response.');
            }

            const byReference = new Map(payload.suggestions.map((candidate) => [candidate.reference, candidate] as const));
            for (const entry of selectedFallbackEntries) {
              const deterministic = rulesById.get(entry.id);
              if (deterministic && deterministic.evidenceCount < 2) {
                const suggestionIndex = suggestions.findIndex((candidate) => candidate.transactionId === entry.id);
                if (suggestionIndex >= 0) suggestions.splice(suggestionIndex, 1);
              }
              const reference = [...referenceToEntry.entries()].find(([, candidate]) => candidate.id === entry.id)?.[0];
              const candidate = reference ? byReference.get(reference) : undefined;
              if (candidate?.categoryId && candidate.uncertainty === 'low') {
                const category = expenseCategoryById.get(candidate.categoryId)!;
                suggestions.push({
                  transactionId: entry.id,
                  date: entry.date,
                  payeeLabel: entry.payeeLabel ?? '',
                  amountMinor: entry.amountMinor,
                  suggestedCategoryId: category.id,
                  suggestedCategoryName: category.name,
                  evidenceCount: 0,
                  lastEvidenceDate: null,
                  confidence: 'local_ai',
                  source: 'local_ai',
                  uncertainty: 'low',
                  rationale: candidate.rationale,
                });
              } else {
                suggestions.push(noneSuggestion(entry,
                  candidate?.rationale
                    ? 'La IA local no ofrece una clasificación suficientemente clara: ' + candidate.rationale
                    : 'La IA local se abstuvo; elige una categoría manualmente.',
                  candidate?.uncertainty ?? 'high'));
              }
            }
            classificationOutcome = suggestions.some((candidate) => selectedIds.has(candidate.transactionId) && candidate.source === 'local_ai')
              ? 'completed' : 'abstained';
          } catch (error) {
            inferenceDurationMs = Math.max(0, Date.now() - startedAt);
            // Readiness/queue/timeout failures degrade safely; malformed JSON or an
            // unknown category is rejected as a structured-response failure.
            classificationOutcome = error instanceof LocalAiUnavailableError || error instanceof LocalAiBusyError ||
              error instanceof LocalAiCancelledError ? 'unavailable'
              : error instanceof LocalAiContextBudgetError ? 'context_limited' : 'invalid_response';
            const fallbackRationale = classificationOutcome === 'unavailable'
              ? 'La IA local no está disponible; elige una categoría manualmente.'
              : classificationOutcome === 'context_limited'
                ? 'El contexto supera el límite local; elige una categoría manualmente.'
                : 'La respuesta local no fue válida; elige una categoría manualmente.';
            for (const entry of selectedFallbackEntries) {
              if (!rulesById.has(entry.id) && !suggestions.some((candidate) => candidate.transactionId === entry.id)) {
                suggestions.push(noneSuggestion(entry, fallbackRationale, 'not_assessed'));
              }
            }
          }
        }

        if (classificationOutcome === 'not_configured' || classificationOutcome === 'payee_sharing_disabled' ||
          classificationOutcome === 'context_limited') {
          const rationale = classificationOutcome === 'not_configured'
            ? 'Ollama no tiene un modelo configurado; elige una categoría manualmente.'
            : classificationOutcome === 'payee_sharing_disabled'
              ? 'No se ha enviado el beneficiario al modelo por configuración; elige una categoría manualmente.'
              : 'El catálogo de categorías está vacío o supera el límite de contexto; elige una categoría manualmente.';
          for (const entry of selectedFallbackEntries) {
            if (!rulesById.has(entry.id) && !suggestions.some((candidate) => candidate.transactionId === entry.id)) {
              suggestions.push(noneSuggestion(entry, rationale, 'not_assessed'));
            }
          }
        }
      }

      if (classificationEnabled && fallbackEntries.length > selectedFallbackEntries.length &&
        classificationOutcome !== 'disabled') {
        // The bounded batch limit is visible to the caller; deferred rows are not
        // silently presented as AI-classified or changed.
        app.log.info({
          component: 'category-classification',
          event: 'batch_limited',
          deferredCandidates: fallbackEntries.length - selectedFallbackEntries.length,
          maxCandidatesPerRequest: MAX_CLASSIFICATION_CANDIDATES,
        }, 'Category classification batch limit reached.');
      }
      app.log.info({
        component: 'category-classification',
        outcome: classificationOutcome,
        batchesAttempted: batchAttempted ? 1 : 0,
        durationMs: inferenceDurationMs,
        candidatesConsidered: selectedFallbackEntries.length,
        maxCandidatesPerRequest: MAX_CLASSIFICATION_CANDIDATES,
      }, 'Hybrid category classification diagnostics.');

      const sortedSuggestions = suggestions.sort((left, right) =>
        left.date.localeCompare(right.date) || left.payeeLabel.localeCompare(right.payeeLabel, 'es'));
      return {
        data: sortedSuggestions,
        accountScope: scope.metadata,
        classification: {
          enabled: classificationEnabled,
          outcome: classificationOutcome,
          candidatesConsidered: selectedFallbackEntries.length,
          candidatesDeferred: classificationEnabled ? Math.max(0, fallbackEntries.length - selectedFallbackEntries.length) : 0,
          maxCandidatesPerRequest: MAX_CLASSIFICATION_CANDIDATES,
          inferenceDurationMs,
          batchesAttempted: batchAttempted ? 1 : 0,
        },
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

  function dueDatePriority(daysUntil: number, amountMinor: number): { priority: FindingPriority; reason: string } {
    if (daysUntil <= 3 || amountMinor >= 100_000) {
      return { priority: 'high', reason: 'Vence en 3 días o menos, o importe ≥ 100000 unidades menores (regla v1).' };
    }
    if (daysUntil <= 7 || amountMinor >= 25_000) {
      return { priority: 'medium', reason: 'Vence en 7 días o menos, o importe ≥ 25000 unidades menores (regla v1).' };
    }
    return { priority: 'low', reason: 'Vence dentro de los próximos 30 días sin alcanzar los umbrales de prioridad superiores (regla v1).' };
  }

  async function generateIntelligenceData(
    startDate: string,
    endDate: string,
    anomalyOptions: IntelligenceAnomalyOptions = IntelligenceAnomalyOptionsSchema.parse({}),
    asOfDateOverride?: string,
  ): Promise<{
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
    const asOfDate = asOfDateOverride ?? calculatedAt.slice(0, 10);
    if (!isIsoDate(asOfDate)) throw new RangeError('asOfDate must be a valid ISO calendar date.');
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

    const anomalyDurationDays = durationDaysBetween(startDate, endDate);
    const anomalyHistoryDays = Math.min(730, Math.max(90, anomalyDurationDays * anomalyOptions.referenceWindows));
    const anomalyHistoryStartDate = addIntelligenceDays(startDate, -anomalyHistoryDays);
    const anomalyHistoryEndDate = addIntelligenceDays(startDate, -1);
    const rawAnomalyHistory = await transactionsForAccounts(scope.accounts, anomalyHistoryStartDate, anomalyHistoryEndDate, preferences);
    const convertedAnomalyHistory = convertTransactionsForAnalysis(rawAnomalyHistory, preferences);
    warnings.push(...convertedAnomalyHistory.warnings);
    const anomalyResult = buildFinancialAnomalyFindings([
      ...normalizeTransactions(convertedAnomalyHistory.transactions),
      ...normalizeTransactions(convertedCurrent.transactions),
    ], {
      period: { startDate, endDate }, accountScope: findingScope, currency: preferences.displayCurrency,
      calculatedAt, categories, referenceWindows: anomalyOptions.referenceWindows,
      minimumAbsoluteChangeMinor: anomalyOptions.minimumAbsoluteChangeMinor,
      minimumRelativeChangePercent: anomalyOptions.minimumRelativeChangePercent,
      enabledKinds: anomalyOptions.enabledAnomalyKinds, historyStartDate: anomalyHistoryStartDate,
      allowPeriodComparisons: endDate < asOfDate && convertedCurrent.warnings.length === 0 && convertedAnomalyHistory.warnings.length === 0,
      allowTransactionOutliers: convertedCurrent.warnings.length === 0 && convertedAnomalyHistory.warnings.length === 0,
      sourceWarnings: [...convertedCurrent.warnings, ...convertedAnomalyHistory.warnings],
    });
    findings.push(...anomalyResult.findings);
    warnings.push(...anomalyResult.limitations);
    if (anomalyHistoryDays === 730 && anomalyDurationDays * anomalyOptions.referenceWindows > 730) {
      warnings.push('El historial de anomalías está limitado a los 730 días anteriores por razones de rendimiento.');
    }

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
    const sameCalendarMonth = startDate.slice(0, 7) === endDate.slice(0, 7);
    const month = startDate.slice(0, 7);
    const lastCalendarDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const isFullCompletedMonth = sameCalendarMonth &&
      startDate === month + '-01' &&
      endDate === lastCalendarDay &&
      endDate < asOfDate;
    if (sameCalendarMonth && typeof budgetRepository.getBudgetMonth === 'function') {
      if (!isFullCompletedMonth) {
        warnings.push('Desviaciones de presupuesto no incluidas: el intervalo no cubre un mes natural completo ya cerrado.');
      } else if (accountPreference.mode !== 'all' || preferences.displayCurrency !== config.budgetCurrency) {
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
      }) as FinancialFinding;
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
      const query = IntelligenceFindingsQuerySchema.parse(request.query);
      const result = await generateIntelligenceData(query.startDate, query.endDate, query);
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
      const result = await generateIntelligenceData(parsed.startDate, parsed.endDate, parsed);
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
      const result = await generateIntelligenceData(parsed.startDate, parsed.endDate, parsed);
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


  function periodicReviewPeriod(periodType: 'weekly' | 'monthly', anchorDate: string, asOfDate: string): {
    readonly startDate: string;
    readonly endDate: string;
    readonly scheduledEndDate: string;
    readonly complete: boolean;
  } {
    if (anchorDate > asOfDate) throw new RangeError('La fecha de referencia no puede estar en el futuro.');
    let startDate: string;
    let scheduledEndDate: string;
    if (periodType === 'monthly') {
      const year = Number(anchorDate.slice(0, 4));
      const month = Number(anchorDate.slice(5, 7));
      startDate = anchorDate.slice(0, 7) + '-01';
      scheduledEndDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    } else {
      const weekdayFromMonday = (new Date(anchorDate + 'T00:00:00.000Z').getUTCDay() + 6) % 7;
      startDate = addIntelligenceDays(anchorDate, -weekdayFromMonday);
      scheduledEndDate = addIntelligenceDays(startDate, 6);
    }
    const endDate = scheduledEndDate > asOfDate ? asOfDate : scheduledEndDate;
    assertPeriod(startDate, endDate);
    return { startDate, endDate, scheduledEndDate, complete: endDate === scheduledEndDate };
  }

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
      const timeZone = parsed.timeZone ?? 'UTC';
      const asOfDate = civilDateInTimeZone(timeZone);
      const period = periodicReviewPeriod(parsed.periodType, parsed.anchorDate, asOfDate);
      const result = await generateIntelligenceData(period.startDate, period.endDate, undefined, asOfDate);
      const durationDays = Math.floor((Date.parse(period.endDate + 'T00:00:00.000Z') -
        Date.parse(period.startDate + 'T00:00:00.000Z')) / 86_400_000) + 1;
      let previousStartDate: string;
      let previousEndDate: string;
      if (parsed.periodType === 'monthly') {
        const previousMonthLastDate = addIntelligenceDays(period.startDate, -1);
        previousStartDate = previousMonthLastDate.slice(0, 7) + '-01';
        const previousMonthDuration = Math.floor((Date.parse(previousMonthLastDate + 'T00:00:00.000Z') -
          Date.parse(previousStartDate + 'T00:00:00.000Z')) / 86_400_000) + 1;
        previousEndDate = period.complete
          ? previousMonthLastDate
          : addIntelligenceDays(previousStartDate, Math.min(durationDays, previousMonthDuration) - 1);
      } else {
        previousStartDate = addIntelligenceDays(period.startDate, -7);
        previousEndDate = addIntelligenceDays(previousStartDate, durationDays - 1);
      }
      assertPeriod(previousStartDate, previousEndDate);
      const [accounts, categories, preferences, preference] = await Promise.all([
        repository.listAccounts(), repository.listCategories(), currencyPreferences(), accountScopePreference(),
      ]);
      const scope = resolveAccountScope(accounts, preference);
      const previousTransactions = await transactionsForAccounts(scope.accounts, previousStartDate, previousEndDate, preferences);
      const previousSummary = calculateSummary(normalizeTransactions(previousTransactions), categories, {
        startDate: previousStartDate,
        endDate: previousEndDate,
        currency: preferences.displayCurrency,
        exchangeRates: preferences.exchangeRates,
      });
      const previousState = await readPeriodicReviewState(config.actualDataDir);
      const accountScopeFingerprint = createHash('sha256')
        .update([...result.accountScope.accountIds].sort().join('\0'))
        .digest('hex')
        .slice(0, 16);
      const persistedAccountScopeLabel = result.accountScope.mode === 'all'
        ? 'Todas las cuentas abiertas (' + result.accountScope.accountIds.length + ')'
        : 'Ámbito seleccionado (' + result.accountScope.accountIds.length + ' cuentas)';
      const previousRun = previousState.reviews.find((review) =>
        review.periodType === parsed.periodType &&
        review.startDate === period.startDate &&
        review.endDate === period.endDate &&
        review.currency === result.currency &&
        review.accountScope.mode === result.accountScope.mode &&
        review.accountScope.fingerprint === accountScopeFingerprint);
      const previousItems = new Map((previousRun?.items ?? []).map((item) => [item.findingId, item]));
      const items = result.findings
        .filter((finding) => finding.reviewStatus !== 'dismissed' && finding.reviewStatus !== 'expected')
        .map((finding) => {
          const previousItem = previousItems.get(finding.id);
          const reusableDecision = previousItem?.fingerprint === finding.fingerprint &&
            (previousItem.status === 'reviewed' ||
              (previousItem.status === 'postponed' && Boolean(previousItem.postponedUntil) && previousItem.postponedUntil! >= asOfDate));
          if (reusableDecision && previousItem) return {
            findingId: finding.id,
            findingType: finding.type,
            identityKey: finding.identityKey,
            evidenceFingerprint: finding.evidenceFingerprint,
            fingerprint: finding.fingerprint,
            status: previousItem.status,
            ...(previousItem.status === 'postponed' && previousItem.postponedUntil ? { postponedUntil: previousItem.postponedUntil } : {}),
          };
          return {
            findingId: finding.id,
            findingType: finding.type,
            identityKey: finding.identityKey,
            evidenceFingerprint: finding.evidenceFingerprint,
            fingerprint: finding.fingerprint,
            status: finding.reviewStatus === 'reviewed'
              ? 'reviewed' as const
              : finding.reviewStatus === 'snoozed' ? 'postponed' as const : 'pending' as const,
            ...(finding.reviewStatus === 'snoozed' && finding.snoozedUntil ? { postponedUntil: finding.snoozedUntil } : {}),
          };
        });
      const run = await createPeriodicReview(config.actualDataDir, {
        periodType: parsed.periodType,
        startDate: period.startDate,
        endDate: period.endDate,
        currency: result.currency,
        accountScope: {
          mode: result.accountScope.mode,
          label: persistedAccountScopeLabel,
          fingerprint: accountScopeFingerprint,
        },
        items,
      });
      const previousComparableRun = previousState.reviews
        .filter((review) =>
          review.periodType === parsed.periodType &&
          review.currency === result.currency &&
          review.accountScope.mode === result.accountScope.mode &&
          review.accountScope.fingerprint === accountScopeFingerprint &&
          review.endDate < period.startDate)
        .sort((left, right) =>
          right.endDate.localeCompare(left.endDate) || right.generatedAt.localeCompare(left.generatedAt))[0];
      // Match equivalent findings across periods by stable rule/entity/scope identity.
      // A legacy run without these hashes is readable but cannot support a truthful comparison.
      const legacyComparisonUnavailable = Boolean(previousComparableRun?.items.some((item) =>
        !item.identityKey || !item.evidenceFingerprint));
      const previousComparableItems = new Map(
        (previousComparableRun?.items ?? []).map((item) => [item.identityKey ?? item.findingId, item]),
      );
      const currentItemsByIdentity = new Map(items.map((item) => [item.identityKey, item]));
      const reviewComparison = previousComparableRun && !legacyComparisonUnavailable ? {
        previousReview: {
          startDate: previousComparableRun.startDate,
          endDate: previousComparableRun.endDate,
          generatedAt: previousComparableRun.generatedAt,
          status: previousComparableRun.status,
        },
        newFindingCount: items.filter((item) => !previousComparableItems.has(item.identityKey)).length,
        repeatedFindingCount: items.filter((item) => previousComparableItems.has(item.identityKey)).length,
        changedEvidenceCount: items.filter((item) => {
          const previousItem = previousComparableItems.get(item.identityKey);
          return previousItem !== undefined && previousItem.evidenceFingerprint !== item.evidenceFingerprint;
        }).length,
        noLongerPresentCount: (previousComparableRun.items ?? [])
          .filter((item) => !currentItemsByIdentity.has(item.identityKey ?? item.findingId)).length,
      } : null;
      const warnings = [...result.warnings, ...result.currentSummary.warnings, ...previousSummary.warnings];
      if (legacyComparisonUnavailable) {
        warnings.push('La revisión anterior usa un historial v1 sin identidad estable de hallazgos. Se conserva y puede consultarse, pero se omite la comparación histórica para no clasificar hallazgos como nuevos o ausentes sin evidencia suficiente.');
      }
      if (!period.complete) {
        warnings.push('El periodo está incompleto: solo se incluyen movimientos hasta la fecha de corte. Los resultados pueden cambiar al cerrarse el periodo.');
      }
      if (result.currentSummary.unconvertedTransactionCount > 0 || previousSummary.unconvertedTransactionCount > 0) {
        warnings.push('Hay movimientos sin conversión válida. Los importes no convertidos no se consolidan y la comparación puede estar incompleta.');
      }
      const reviewMonth = period.startDate.slice(0, 7);
      const reviewMonthLastDate = new Date(Date.UTC(
        Number(reviewMonth.slice(0, 4)), Number(reviewMonth.slice(5, 7)), 0,
      )).toISOString().slice(0, 10);
      const isFullClosedMonth = parsed.periodType === 'monthly' &&
        period.startDate === reviewMonth + '-01' &&
        period.endDate === reviewMonthLastDate &&
        period.endDate < asOfDate;
      const budgetRepository = repository as BudgetRepository & {
        getBudgetMonth?: (month: string) => Promise<ActualBudgetMonthRecord>;
      };
      const budgetLimitations = warnings.filter((warning) => /desviaciones de presupuesto/i.test(warning));
      let budgetUnavailabilityReason: string | null = null;
      if (!isFullClosedMonth) {
        budgetUnavailabilityReason = 'La comparación presupuestaria requiere un mes natural completo y cerrado.';
      } else if (result.accountScope.mode !== 'all') {
        budgetUnavailabilityReason = 'El presupuesto de Actual es global; el ámbito seleccionado no coincide con el presupuesto completo.';
      } else if (result.currency !== config.budgetCurrency) {
        budgetUnavailabilityReason = 'La divisa de análisis no coincide con la divisa base del presupuesto.';
      } else if (typeof budgetRepository.getBudgetMonth !== 'function') {
        budgetUnavailabilityReason = 'El adaptador de Actual no expone una consulta de presupuesto mensual.';
      } else if (budgetLimitations.length > 0) {
        budgetUnavailabilityReason = budgetLimitations[0]!;
      }
      const budgetAssessment = {
        available: budgetUnavailabilityReason === null,
        reason: budgetUnavailabilityReason,
        overBudgetCategoryCount: result.findings.filter((finding) => finding.type === 'budget-overspend').length,
        scope: 'Categorías con asignación positiva y gasto verificable; no incluye categorías sin asignación comparable.',
      };
      if (budgetUnavailabilityReason) warnings.push('Cumplimiento presupuestario no evaluable: ' + budgetUnavailabilityReason);
      const goalFindings = result.findings.filter((finding) => finding.type === 'goal-progress' || finding.type === 'goal-at-risk');
      const goalAssessment = {
        evaluatedGoalCount: goalFindings.length,
        onTrackCount: goalFindings.filter((finding) => finding.type === 'goal-progress').length,
        atRiskCount: goalFindings.filter((finding) => finding.type === 'goal-at-risk').length,
        projections: goalFindings.map((finding) => ({
          findingId: finding.id,
          title: finding.title,
          type: finding.type,
          projectedProgressPercent: finding.metrics.projectedProgressPercent ?? null,
          targetDate: finding.metrics.targetDate ?? null,
          impactMinor: finding.impactMinor,
          currency: finding.currency,
          confidence: finding.confidence,
        })),
      };
      if (goalFindings.length === 0) {
        warnings.push('No hay objetivos activos y comparables en el ámbito y divisa actuales, o no hay datos suficientes para proyectarlos.');
      }
      return reply.code(201).send({
        data: {
          schemaVersion: 1,
          run,
          period: { periodType: parsed.periodType, ...period },
          timeZone,
          asOfDate,
          calculatedAt: result.calculatedAt,
          currency: result.currency,
          accountScope: result.accountScope,
          summary: result.currentSummary,
          budgetAssessment,
          goalAssessment,
          comparisonToPreviousReview: reviewComparison,
          comparison: {
            period: { startDate: previousStartDate, endDate: previousEndDate },
            summary: previousSummary,
          },
          findings: result.findings,
          warnings: [...new Set(warnings)],
          capabilities: { aiEnabled: config.aiEnabled, deterministicReportAvailable: true },
          notes: [
            'Los importes se calculan con finance-core y las mismas preferencias de divisa y ámbito que los informes.',
            'Los hallazgos son hechos observados, estimaciones o candidatos según la confianza indicada; la prioridad no expresa certeza.',
            'La revisión no modifica movimientos, presupuestos, objetivos ni compromisos. No se ejecutan acciones financieras.',
            'El historial de revisión conserva únicamente fechas, ámbito, divisa, IDs y tipos de hallazgo y estados; no duplica transacciones ni conversaciones.',
          ],
        },
      });
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


  app.post('/api/v1/planning/conversation/preview', async (request, reply) => {
    const requestAbort = new AbortController();
    const abortRequest = () => requestAbort.abort();
    const abortResponse = () => { if (!reply.raw.writableEnded) requestAbort.abort(); };
    request.raw.once('aborted', abortRequest);
    reply.raw.once('close', abortResponse);
    try {
      const body = PlanningConversationRequestSchema.parse(request.body);
      if (!config.aiEnabled) {
        return reply.code(503).send({ error: {
          code: 'AI_DISABLED',
          message: 'El planificador conversacional requiere activar la IA local. Los formularios de planificación siguen disponibles.',
        } });
      }
      const [stored, accounts, categories, preferences, preference] = await Promise.all([
        readPlanningData(config.actualDataDir), repository.listAccounts(), repository.listCategories(),
        currencyPreferences(), accountScopePreference(),
      ]);
      const scope = resolveAccountScope(accounts, preference);
      const asOfDate = new Date().toISOString().slice(0, 10);
      const eligibleGoals = stored.goals.filter((goal) =>
        goal.status === 'active' && goal.currency === preferences.displayCurrency &&
        planningScopeMatches(goal.scope, preference) && goal.targetDate > asOfDate,
      );
      const draftUnknown = await localAi.extractPlanningIntent(body.message, {
        asOfDate,
        currency: preferences.displayCurrency,
        goals: eligibleGoals.map((goal) => ({ id: goal.id, name: goal.name })),
      }, requestAbort.signal);
      const parsedDraft = PlanningIntentDraftSchema.safeParse(draftUnknown);
      if (!parsedDraft.success) {
        return reply.code(422).send({ error: {
          code: 'PLANNING_INTENT_INVALID',
          message: 'La IA local no ha devuelto una intención válida. Utiliza el formulario de planificación o reformula la petición.',
        } });
      }
      const draft = parsedDraft.data as PlanningIntentDraft;
      const clarification = (question: string) => ({
        data: {
          status: 'clarification_required' as const,
          question,
          saved: false,
          message: 'No se ha ejecutado ni guardado ninguna modificación.',
        },
      });
      if (draft.clarificationQuestion) return clarification(draft.clarificationQuestion);
      if (draft.currency && draft.currency !== preferences.displayCurrency) {
        return clarification('La planificación utiliza actualmente ' + preferences.displayCurrency +
          '. ¿Puedes expresar los importes en esa divisa? No convertiré importes futuros sin una tasa explícita y fechada.');
      }

      let selectedGoal = draft.goalId ? stored.goals.find((goal) => goal.id === draft.goalId) : undefined;
      if (draft.goalId && !selectedGoal) {
        return reply.code(409).send({ error: {
          code: 'PLANNING_GOAL_CONTEXT_CHANGED',
          message: 'El objetivo indicado ya no existe o no está disponible. Actualiza la planificación y vuelve a intentarlo.',
        } });
      }
      if (selectedGoal && selectedGoal.status !== 'active') {
        return reply.code(409).send({ error: {
          code: 'PLANNING_GOAL_PAUSED',
          message: 'El objetivo seleccionado está pausado. Reanúdalo desde Objetivos antes de simularlo.',
        } });
      }
      if (selectedGoal && (!planningScopeMatches(selectedGoal.scope, preference) || selectedGoal.currency !== preferences.displayCurrency)) {
        return reply.code(409).send({ error: {
          code: 'PLANNING_CONTEXT_CHANGED',
          message: 'El ámbito de cuentas o la divisa del objetivo han cambiado. Revísalo desde Objetivos antes de simularlo.',
        } });
      }
      if (draft.intent === 'test_expense' && !selectedGoal) {
        if (eligibleGoals.length === 1) selectedGoal = eligibleGoals[0];
        else if (eligibleGoals.length > 1) return clarification('¿Sobre cuál de tus objetivos activos quieres comprobar el impacto de ese gasto?');
        else return clarification('Primero necesito un objetivo de ahorro activo para comprobar si el gasto retrasaría su fecha prevista.');
      }
      if (draft.intent === 'test_expense' && (!draft.expenseAmountMajor || !draft.expenseDate)) {
        return clarification('¿Qué importe tendría el gasto extraordinario y en qué fecha se produciría?');
      }
      if (draft.intent === 'compare_contributions' && draft.contributionOptionsMajor.length < 2) {
        return clarification('Indica al menos dos aportaciones mensuales que quieras comparar, por ejemplo 150 € y 250 €.');
      }

      const targetAmountMinor = selectedGoal?.targetAmountMinor ??
        (draft.targetAmountMajor === null ? null : majorToMinor(draft.targetAmountMajor, preferences.displayCurrency, 'objetivo'));
      const targetDate = selectedGoal?.targetDate ?? draft.targetDate;
      if (targetAmountMinor === null) return clarification('¿Qué cantidad total quieres alcanzar con el objetivo de ahorro?');
      if (!targetDate) return clarification('¿Para qué fecha quieres alcanzar el objetivo? Indica mes y año para evitar ambigüedades.');
      validateGoalWindow(targetDate, asOfDate);
      if (draft.intent === 'test_expense' && draft.expenseDate! <= asOfDate) {
        return clarification('La fecha del gasto debe ser futura. ¿Qué día ocurriría ese gasto?');
      }
      if (draft.intent === 'test_expense' && draft.expenseDate! > targetDate) {
        return clarification('El gasto indicado cae después de la fecha objetivo. ¿Quieres comprobar otro gasto anterior a esa fecha?');
      }
      const initialAmountMinor = selectedGoal?.initialAmountMinor ??
        (draft.initialAmountMajor === null ? 0 : majorToMinor(draft.initialAmountMajor, preferences.displayCurrency, 'ahorro inicial'));
      const goalName = selectedGoal?.name ?? draft.goalName ?? 'Objetivo hipotético';

      const historyStartDate = shiftPlanningMonth(asOfDate.slice(0, 7), -11) + '-01';
      const historyTransactions = await transactionsForAccounts(scope.accounts, historyStartDate, asOfDate, preferences);
      const convertedHistory = convertTransactionsForAnalysis(historyTransactions, preferences);
      const estimate = estimatePlanningCashFlow(convertedHistory.transactions, categories, {
        currency: preferences.displayCurrency,
        startDate: historyStartDate,
        endDate: asOfDate,
      });
      const monthlyIncomeMinor = draft.monthlyIncomeMajor === null
        ? (selectedGoal?.monthlyIncomeMinor ?? estimate.monthlyIncomeMinor)
        : majorToMinor(draft.monthlyIncomeMajor, preferences.displayCurrency, 'ingresos mensuales');
      const monthlyExpenseMinor = draft.monthlyExpenseMajor === null
        ? (selectedGoal?.monthlyExpenseMinor ?? estimate.monthlyExpenseMinor)
        : majorToMinor(draft.monthlyExpenseMajor, preferences.displayCurrency, 'gastos mensuales');
      const recurringCandidates = detectRecurringCandidates(convertedHistory.transactions, {
        startDate: historyStartDate, endDate: asOfDate,
      });
      const commitments = stored.commitments.filter((item) =>
        item.status === 'active' && item.currency === preferences.displayCurrency &&
        planningScopeMatches(item.scope, preference),
      ).map(toPlanningCommitment);
      const baseContributionMinor = selectedGoal?.monthlyContributionMinor ??
        (draft.monthlyContributionMajor === null ? 0 :
          majorToMinor(draft.monthlyContributionMajor, preferences.displayCurrency, 'aportación mensual'));
      const makeProjection = (monthlyContribution: number, activeCommitments: readonly PlanningCommitment[]) =>
        projectSavingsGoal({
          asOfDate,
          targetDate,
          targetAmountMinor,
          initialAmountMinor,
          currency: preferences.displayCurrency,
          monthlyContributionMinor: monthlyContribution,
          monthlyIncomeMinor,
          monthlyExpenseMinor,
          commitments: activeCommitments,
        });
      const scenarios: Array<{ label: string; monthlyContributionMinor: number; projection: ReturnType<typeof projectSavingsGoal> }> = [];

      if (draft.intent === 'compare_contributions') {
        const distinctOptions = [...new Set(draft.contributionOptionsMajor)]
          .map((amount) => majorToMinor(amount, preferences.displayCurrency, 'aportación comparada'))
          .sort((left, right) => left - right);
        if (distinctOptions.length < 2) return clarification('Las aportaciones comparadas deben ser diferentes. ¿Qué dos importes quieres contrastar?');
        for (const amount of distinctOptions) {
          scenarios.push({
            label: 'Aportación mensual de ' + new Intl.NumberFormat('es-ES', {
              style: 'currency', currency: preferences.displayCurrency,
            }).format(amount / Math.pow(10, currencyFractionDigits(preferences.displayCurrency))),
            monthlyContributionMinor: amount,
            projection: makeProjection(amount, commitments),
          });
        }
      } else if (draft.intent === 'test_expense') {
        const expenseAmountMinor = majorToMinor(draft.expenseAmountMajor!, preferences.displayCurrency, 'gasto hipotético');
        const hypotheticalCommitment: PlanningCommitment = {
          id: 'hypothetical:' + randomUUID(),
          title: 'Gasto extraordinario hipotético',
          amountMinor: expenseAmountMinor,
          date: draft.expenseDate!,
          direction: 'expense',
          frequency: 'once',
          currency: preferences.displayCurrency,
          status: 'active',
          source: 'manual',
        };
        scenarios.push({
          label: 'Sin el gasto extraordinario',
          monthlyContributionMinor: baseContributionMinor,
          projection: makeProjection(baseContributionMinor, commitments),
        });
        scenarios.push({
          label: 'Incluyendo el gasto extraordinario',
          monthlyContributionMinor: baseContributionMinor,
          projection: makeProjection(baseContributionMinor, [...commitments, hypotheticalCommitment]),
        });
      } else {
        const initialProjection = makeProjection(baseContributionMinor, commitments);
        if (!selectedGoal && draft.monthlyContributionMajor === null &&
            initialProjection.requiredMonthlyContributionMinor !== null &&
            initialProjection.requiredMonthlyContributionMinor > 0) {
          const requiredContribution = initialProjection.requiredMonthlyContributionMinor;
          scenarios.push({
            label: 'Aportación mensual necesaria estimada',
            monthlyContributionMinor: requiredContribution,
            projection: makeProjection(requiredContribution, commitments),
          });
        } else {
          scenarios.push({
            label: selectedGoal ? 'Objetivo existente · simulación sin guardar' : 'Nuevo objetivo hipotético · sin guardar',
            monthlyContributionMinor: baseContributionMinor,
            projection: initialProjection,
          });
        }
      }

      const warnings = [...new Set([
        ...convertedHistory.warnings,
        ...estimate.warnings,
        ...scenarios.flatMap((scenario) => scenario.projection.warnings),
      ])];
      return {
        data: {
          status: 'ready' as const,
          saved: false,
          label: 'Simulación conversacional · no guardada',
          intent: draft.intent,
          goal: {
            id: selectedGoal?.id ?? null,
            name: goalName,
            targetAmountMinor,
            initialAmountMinor,
            targetDate,
            currency: preferences.displayCurrency,
          },
          scenarios,
          hypotheticalExpense: draft.intent === 'test_expense' ? {
            amountMinor: majorToMinor(draft.expenseAmountMajor!, preferences.displayCurrency, 'gasto hipotético'),
            date: draft.expenseDate!,
            currency: preferences.displayCurrency,
          } : null,
          manualCommitments: commitments.map((item) => ({
            title: item.title, amountMinor: item.amountMinor, date: item.date,
            direction: item.direction, frequency: item.frequency, currency: item.currency,
          })),
          sources: {
            historyStartDate,
            historyEndDate: asOfDate,
            monthsWithData: estimate.monthsWithData,
            transactionCount: estimate.transactionCount,
            monthlyIncomeSource: draft.monthlyIncomeMajor === null && selectedGoal?.monthlyIncomeMinor == null
              ? 'observed_median' : 'user_or_goal_assumption',
            monthlyExpenseSource: draft.monthlyExpenseMajor === null && selectedGoal?.monthlyExpenseMinor == null
              ? 'observed_median' : 'user_or_goal_assumption',
            accountScope: scope.metadata,
            currency: preferences.displayCurrency,
            commitmentsConsidered: commitments.length,
            unconfirmedRecurringCandidatesExcluded: recurringCandidates.length,
          },
          assumptions: [
            ...estimate.assumptions,
            'Los importes propuestos por la IA se consideran entradas del usuario, se validan en el backend y no son cálculos del modelo.',
            'Ingresos y gastos proceden de la mediana mensual observada o de supuestos explícitos del objetivo o de la petición.',
            'Las simulaciones no aplican intereses, inflación ni revalorización y no constituyen una garantía.',
            'Los escenarios y el gasto extraordinario conversacional son efímeros; no crean ni modifican objetivos, compromisos ni movimientos.',
          ],
          warnings,
          notes: convertedHistory.warnings,
        },
      };
    } catch (error) {
      if (error instanceof LocalAiCancelledError) {
        if (request.raw.aborted || reply.raw.destroyed) return;
        return reply.code(499).send({ error: { code: 'AI_CANCELLED', message: 'La consulta de planificación se ha cancelado.' } });
      }
      if (error instanceof LocalAiBusyError) {
        return reply.code(503).header('retry-after', '1').send({ error: { code: 'AI_BUSY', message: 'La IA local está ocupada; vuelve a intentarlo.' } });
      }
      if (error instanceof LocalAiContextBudgetError) {
        return reply.code(413).send({ error: { code: 'AI_CONTEXT_TOO_LARGE', message: 'La petición supera el límite de contexto local permitido.' } });
      }
      if (error instanceof LocalAiUnavailableError) {
        return reply.code(503).send({ error: { code: 'AI_UNAVAILABLE', message: 'Ollama o el modelo local no están disponibles o no han devuelto una extracción válida.' } });
      }
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    } finally {
      request.raw.removeListener('aborted', abortRequest);
      reply.raw.removeListener('close', abortResponse);
    }
  });

  function addCivilDays(date: string, days: number): string {
    const value = new Date(date + 'T00:00:00.000Z');
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function normalizedActionLabel(value: string): string {
    return value.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLocaleLowerCase('es').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  app.post('/api/v1/cash-flow/project', async (request, reply) => {
    try {
      const parsed = CashFlowRequestSchema.parse(request.body);
      const asOfDate = civilDateInTimeZone('UTC');
      const endDate = addCivilDays(asOfDate, parsed.horizonDays);
      const [accounts, preferences, accountPreference, planning] = await Promise.all([
        repository.listAccounts(), currencyPreferences(), accountScopePreference(), readPlanningData(config.actualDataDir),
      ]);
      const scope = resolveAccountScope(accounts, accountPreference);
      const unknownOpeningAccounts: { id: string; name: string }[] = [];
      let openingBalanceMinor = 0;
      let openingKnown = scope.accounts.length > 0;
      const originalAccountsById = new Map(accounts.map((account) => [account.id, account]));
      for (const scopedAccount of scope.accounts) {
        const account = originalAccountsById.get(scopedAccount.id);
        const nativeCurrency = account ? accountNativeCurrency(account, preferences) : null;
        if (!account || account.currentBalanceMinor === null || nativeCurrency === null) {
          openingKnown = false;
          unknownOpeningAccounts.push({ id: scopedAccount.id, name: scopedAccount.name });
          continue;
        }
        const conversion = convertAmountMinor(account.currentBalanceMinor, nativeCurrency, preferences.displayCurrency, asOfDate, preferences.exchangeRates);
        if (conversion.amountMinor === null) {
          openingKnown = false;
          unknownOpeningAccounts.push({ id: scopedAccount.id, name: scopedAccount.name });
          continue;
        }
        openingBalanceMinor += conversion.amountMinor;
        if (!Number.isSafeInteger(openingBalanceMinor)) throw new RangeError('The consolidated opening balance exceeds the supported integer range.');
      }
      const rawFutureTransactions = await transactionsForAccounts(scope.accounts, asOfDate, endDate, preferences);
      const convertedFuture = convertTransactionsForAnalysis(rawFutureTransactions, preferences);
      const ledgerEntries = normalizeTransactions(convertedFuture.transactions);
      const actualEvents: CashFlowEvent[] = ledgerEntries
        .filter((entry) => entry.date > asOfDate && entry.amountMinor !== 0)
        .map((entry) => ({
          id: 'actual:' + entry.id,
          date: entry.date,
          amountMinor: entry.amountMinor,
          source: 'actual_transaction',
          label: entry.payeeLabel ?? 'Movimiento registrado en Actual',
          clearedStatus: entry.cleared === true ? 'cleared' : entry.cleared === false ? 'pending' : 'unknown',
          isTransfer: entry.isTransfer,
        }));
      const actualMatchKeys = new Set(ledgerEntries.filter((entry) => entry.date > asOfDate && entry.amountMinor !== 0).map((entry) =>
        [entry.date, Math.abs(entry.amountMinor), entry.amountMinor < 0 ? 'expense' : 'income'].join('|') + '|' + normalizedActionLabel(entry.payeeLabel ?? ''),
      ));
      const actualAmountKeys = new Set(ledgerEntries.filter((entry) => entry.date > asOfDate && entry.amountMinor !== 0).map((entry) =>
        [entry.date, Math.abs(entry.amountMinor), entry.amountMinor < 0 ? 'expense' : 'income'].join('|'),
      ));
      const scopedActiveCommitments = planning.commitments.filter((item) =>
        item.status === 'active' && planningScopeMatches(item.scope, accountPreference),
      );
      const unconvertedCommitmentTitles: string[] = [];
      const eligibleCommitments = scopedActiveCommitments.flatMap((item) => {
        if (item.currency === preferences.displayCurrency) return [toPlanningCommitment(item)];
        const conversion = convertAmountMinor(item.amountMinor, item.currency, preferences.displayCurrency, asOfDate, preferences.exchangeRates);
        if (conversion.amountMinor === null || conversion.amountMinor <= 0) { unconvertedCommitmentTitles.push(item.title); return []; }
        return [{ ...toPlanningCommitment(item), amountMinor: conversion.amountMinor, currency: preferences.displayCurrency }];
      });
      const manualOccurrences = expandCommitmentOccurrences(eligibleCommitments, asOfDate, endDate);
      const manualEvents: CashFlowEvent[] = [];
      const confirmedRecurringEvents: CashFlowEvent[] = [];
      const duplicateCommitmentIds: string[] = [];
      const possibleDuplicateCommitments: string[] = [];
      for (const occurrence of manualOccurrences) {
        if (occurrence.occurrenceDate <= asOfDate) continue;
        const signedAmount = occurrence.direction === 'expense' ? -occurrence.amountMinor : occurrence.amountMinor;
        const key = [occurrence.occurrenceDate, occurrence.amountMinor, occurrence.direction].join('|');
        const label = normalizedActionLabel(occurrence.title);
        if (actualMatchKeys.has(key + '|' + label)) {
          duplicateCommitmentIds.push(occurrence.id + '@' + occurrence.occurrenceDate);
          continue;
        }
        if (actualAmountKeys.has(key)) possibleDuplicateCommitments.push(occurrence.title + ' · ' + occurrence.occurrenceDate);
        const isRecurring = occurrence.frequency !== 'once';
        const event: CashFlowEvent = {
          id: (isRecurring ? 'confirmed-recurring:' : 'manual:') + occurrence.id + '@' + occurrence.occurrenceDate,
          date: occurrence.occurrenceDate,
          amountMinor: signedAmount,
          source: isRecurring ? 'confirmed_recurring' : 'manual_commitment',
          label: occurrence.title,
        };
        (isRecurring ? confirmedRecurringEvents : manualEvents).push(event);
      }
      const recurringHistoryStartDate = addCivilDays(asOfDate, -800);
      const recurringHistoryRaw = await transactionsForAccounts(scope.accounts, recurringHistoryStartDate, asOfDate, preferences);
      const recurringHistoryConverted = convertTransactionsForAnalysis(recurringHistoryRaw, preferences);
      const recurringHistoryCandidates = detectRecurringCandidates(recurringHistoryConverted.transactions, {
        startDate: recurringHistoryStartDate, endDate: asOfDate, minOccurrences: 3, intervalWindowDays: [20, 400],
      });
      const recurringCandidateEvents: (CashFlowEvent & { candidateId: string })[] = [];
      const recurringCandidates = recurringHistoryCandidates.map((candidate) => {
        const normalizedPayee = normalizedActionLabel(candidate.payee);
        const candidateId = 'rc_' + createHash('sha256').update(normalizedPayee + '|' + candidate.firstDate).digest('hex').slice(0, 24);
        let nextDate = candidate.estimatedIntervalDays === null ? null : addCivilDays(candidate.lastDate, candidate.estimatedIntervalDays);
        if (nextDate !== null) {
          while (nextDate <= asOfDate) nextDate = addCivilDays(nextDate, candidate.estimatedIntervalDays!);
          let date = nextDate;
          let occurrenceIndex = 0;
          while (date <= endDate && occurrenceIndex < 12) {
            const amountMinor = candidate.meanAbsoluteAmountMinor;
            const amountKey = [date, amountMinor, 'expense'].join('|');
            const exactActualMatch = actualMatchKeys.has(amountKey + '|' + normalizedPayee);
            const exactCommitmentMatch = [...manualEvents, ...confirmedRecurringEvents].some((event) =>
              event.date === date && event.amountMinor === -amountMinor && normalizedActionLabel(event.label) === normalizedPayee,
            );
            if (!exactActualMatch && !exactCommitmentMatch) recurringCandidateEvents.push({
              id: 'recurring-candidate:' + candidateId + ':' + date, candidateId, date,
              amountMinor: -amountMinor, source: 'recurring_candidate', label: candidate.payee,
            });
            occurrenceIndex += 1;
            date = addCivilDays(date, candidate.estimatedIntervalDays!);
          }
        }
        return {
          id: candidateId, payee: candidate.payee, occurrenceCount: candidate.occurrenceCount,
          estimatedIntervalDays: candidate.estimatedIntervalDays, estimatedFrequency: candidate.estimatedFrequency,
          meanAbsoluteAmountMinor: candidate.meanAbsoluteAmountMinor, amountDeviationPercent: candidate.amountDeviationPercent,
          nextDate, upcomingEventsCount: recurringCandidateEvents.filter((event) => event.candidateId === candidateId).length,
          signals: candidate.signals, warnings: candidate.warnings,
        };
      });
      const requestedCandidateIds = new Set(parsed.recurringCandidateIds);
      const knownCandidateIds = new Set(recurringCandidates.map((candidate) => candidate.id));
      if ([...requestedCandidateIds].some((id) => !knownCandidateIds.has(id))) {
        return reply.code(400).send({ error: { code: 'UNKNOWN_RECURRING_CANDIDATE', message: 'One or more selected recurring candidates are stale. Refresh the cash-flow projection before selecting them.' } });
      }
      const selectedRecurringCandidateEvents: CashFlowEvent[] = recurringCandidateEvents
        .filter((event) => requestedCandidateIds.has(event.candidateId))
        .map((event) => ({ id: event.id, date: event.date, amountMinor: event.amountMinor, source: event.source, label: event.label }));
      const scenarioEvents: CashFlowEvent[] = parsed.scenario ? [{
        id: 'scenario:unsaved',
        date: parsed.scenario.date,
        amountMinor: parsed.scenario.direction === 'expense' ? -parsed.scenario.amountMinor : parsed.scenario.amountMinor,
        source: 'scenario',
        label: parsed.scenario.label,
      }] : [];
      const projection = projectCashFlow({
        asOfDate,
        startDate: asOfDate,
        endDate,
        openingBalanceMinor: openingKnown ? openingBalanceMinor : null,
        reserveMinor: parsed.reserveMinor ?? null,
        events: [...actualEvents, ...manualEvents, ...confirmedRecurringEvents, ...selectedRecurringCandidateEvents, ...scenarioEvents],
      });
      const warnings = [
        ...projection.warnings,
        ...convertedFuture.warnings,
        ...(unknownOpeningAccounts.length > 0 ? ['Saldo no disponible o sin conversión para: ' + unknownOpeningAccounts.map((account) => account.name).join(', ') + '.'] : []),
        ...(scope.accounts.length === 0 ? ['El ámbito no contiene cuentas; selecciona cuentas antes de estimar saldo.'] : []),
        ...(duplicateCommitmentIds.length > 0 ? [duplicateCommitmentIds.length + ' compromiso(s) manual(es) se han omitido porque coinciden exactamente con un movimiento futuro de Actual.'] : []),
        ...(possibleDuplicateCommitments.length > 0 ? ['Posibles duplicados no confirmados; se han conservado ambos elementos: ' + possibleDuplicateCommitments.join(', ') + '. Revisa la agenda antes de interpretar el saldo.'] : []),
        ...(unconvertedCommitmentTitles.length > 0 ? [unconvertedCommitmentTitles.length + ' compromiso(s) activos no se han convertido a la divisa de análisis por falta de tasa local fechada: ' + unconvertedCommitmentTitles.join(', ') + '.'] : []),
        ...recurringHistoryConverted.warnings,
      ];
      return {
        data: {
          asOfDate, endDate, currency: preferences.displayCurrency, accountScope: scope.metadata,
          openingBalanceMinor: projection.openingBalanceMinor,
          unknownOpeningAccounts,
          actualEvents, manualEvents, confirmedRecurringEvents, recurringCandidates, recurringCandidateEvents, scenarioEvents,
          duplicateCommitmentIds, possibleDuplicateCommitments,
          projection: { ...projection, warnings },
          notes: [
            'Saldo estimado a partir del campo balance_current de Actual; no equivale a saldo bancario disponible, saldo liquidado ni efectivo garantizado.',
            'Las transferencias se incluyen con su signo para proyectar el ámbito seleccionado; las dos patas se compensan si ambas cuentas están dentro del ámbito.',
            'Los candidatos recurrentes se detectan sobre hasta 800 días de historial convertido; solo se proyectan como hipótesis cuando se seleccionan expresamente.',
            'Los compromisos en otra divisa se convierten con la tasa local conocida a la fecha de corte; cuando falta tasa, se excluyen y se advierten, sin tratarlos como cero.',
            ...(parsed.recurringCandidateIds.length > 0 ? ['Se han incorporado como hipótesis los candidatos recurrentes seleccionados; no son obligaciones confirmadas.'] : []),
          ],
        },
      };
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
    const budgetRepository = repository as BudgetRepository & {
      getBudgetMonth?: (value: string) => Promise<{ readonly categoryGroups: readonly { readonly categories?: readonly { readonly id: string; readonly budgeted?: number | null; readonly spent?: number | null; readonly balance?: number | null }[] }[] }>;
      getBudgetAllocations?: (value: string) => Promise<readonly { readonly categoryId: string; readonly amountMinor: number }[]>;
    };
    const budgetWarnings: string[] = [];
    const budgetRows = new Map<string, { budgetedMinor: number | null; spentMinor: number | null; availableMinor: number | null }>();
    if (typeof budgetRepository.getBudgetMonth === 'function') {
      try {
        const allocationsAvailable = typeof budgetRepository.getBudgetAllocations === 'function';
        const [budgetMonth, allocations] = await Promise.all([
          budgetRepository.getBudgetMonth(endMonth),
          allocationsAvailable ? budgetRepository.getBudgetAllocations!(endMonth) : Promise.resolve(null),
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
      const budgetRepository = repository as BudgetRepository & {
        getBudgetMonth?: (value: string) => Promise<ActualBudgetMonthRecord>;
        getBudgetAllocations?: (value: string) => Promise<readonly { readonly categoryId: string; readonly amountMinor: number }[]>;
      };
      if (typeof budgetRepository.getBudgetMonth !== 'function') {
        return reply.code(503).send({ error: { code: 'BUDGET_QUERY_NOT_SUPPORTED', message: 'The configured local adapter does not support budget queries.' } });
      }
      const allocationSourceAvailable = typeof budgetRepository.getBudgetAllocations === 'function';
      const [budget, categories, allocations, actionState] = await Promise.all([
        budgetRepository.getBudgetMonth(month), repository.listCategories(),
        allocationSourceAvailable ? budgetRepository.getBudgetAllocations!(month) : Promise.resolve(null),
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
