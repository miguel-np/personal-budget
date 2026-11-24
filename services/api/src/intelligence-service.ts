import {
  buildFinancialAnomalyFindings,
  buildPeriodChangeFindings,
  buildUncategorizedFinding,
  calculateSummary,
  detectRecurringCandidates,
  isIsoDate,
  normalizeTransactions,
  projectSavingsGoal,
  sortFinancialFindings,
} from '@personal-budget/finance-core';
import type {
  BudgetAccount,
  BudgetCategory,
  BudgetRepository,
  BudgetTransaction,
  FinancialFinding,
} from '@personal-budget/finance-core';
import type { AppConfig } from './config.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import { resolveAccountScope } from './account-scope.js';
import type { AccountScopePreference, AccountScopeMetadata, ResolvedAccountScope } from './account-scope.js';
import { readPlanningData } from './planning-store.js';
import { effectiveFindingReview, readFindingReviewState } from './intelligence-store.js';
import { buildBudgetOverspendFindings, buildCommitmentFindings, buildGoalFindings, buildRecurringFindings } from './intelligence-finding-builders.js';

export interface IntelligenceAnomalyOptions {
  readonly referenceWindows: number;
  readonly minimumAbsoluteChangeMinor: number;
  readonly minimumRelativeChangePercent: number;
  readonly enabledAnomalyKinds: readonly (
    | 'transaction-outlier' | 'total-expense-change' | 'category-change' | 'payee-change'
    | 'possible-duplicate' | 'income-change' | 'refund-change' | 'frequency-change'
  )[];
}

type ConvertedTransactions = {
  readonly transactions: readonly BudgetTransaction[];
  readonly warnings: readonly string[];
};

interface IntelligenceDependencies {
  readonly repository: BudgetRepository;
  readonly config: Pick<AppConfig, 'actualDataDir' | 'budgetCurrency'>;
  readonly currencyPreferences: () => Promise<CurrencyPreferences>;
  readonly accountScopePreference: () => Promise<AccountScopePreference>;
  readonly transactionsForAccounts: (
    accounts: readonly BudgetAccount[], startDate: string, endDate: string, preferences: CurrencyPreferences,
  ) => Promise<readonly BudgetTransaction[]>;
  readonly convertTransactionsForAnalysis: (
    transactions: readonly BudgetTransaction[], preferences: CurrencyPreferences,
  ) => ConvertedTransactions;
  readonly assertPeriod: (startDate: string, endDate: string) => void;
  readonly validateFinding: (finding: unknown) => FinancialFinding;
}

interface IntelligenceContext {
  readonly accounts: readonly BudgetAccount[];
  readonly categories: readonly BudgetCategory[];
  readonly preferences: CurrencyPreferences;
  readonly accountPreference: AccountScopePreference;
  readonly stored: Awaited<ReturnType<typeof readPlanningData>>;
  readonly scope: ResolvedAccountScope;
  readonly findingScope: {
    readonly mode: AccountScopePreference['mode'];
    readonly accountIds: readonly string[];
    readonly label: string;
  };
}

function addIntelligenceDays(date: string, offset: number): string {
  const shifted = new Date(date + 'T00:00:00.000Z');
  shifted.setUTCDate(shifted.getUTCDate() + offset);
  return shifted.toISOString().slice(0, 10);
}

function durationDaysBetween(startDate: string, endDate: string): number {
  return Math.floor((Date.parse(endDate + 'T00:00:00.000Z') -
    Date.parse(startDate + 'T00:00:00.000Z')) / 86_400_000) + 1;
}

function monthsBefore(date: string, months: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const shifted = new Date(Date.UTC(year, month - 1 - months, 1));
  return shifted.toISOString().slice(0, 10);
}

function planningMonthPeriod(month: string): { readonly startDate: string; readonly endDate: string } {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { startDate: month + '-01', endDate: lastDay };
}

async function loadContext(dependencies: IntelligenceDependencies): Promise<IntelligenceContext> {
  const [accounts, categories, preferences, accountPreference, stored] = await Promise.all([
    dependencies.repository.listAccounts(),
    dependencies.repository.listCategories(),
    dependencies.currencyPreferences(),
    dependencies.accountScopePreference(),
    readPlanningData(dependencies.config.actualDataDir),
  ]);
  const scope = resolveAccountScope(accounts, accountPreference);
  return {
    accounts, categories, preferences, accountPreference, stored, scope,
    findingScope: {
      mode: accountPreference.mode,
      accountIds: scope.accounts.map((account) => account.id).sort(),
      label: scope.metadata.label,
    },
  };
}

async function buildCurrentSummary(
  startDate: string,
  endDate: string,
  context: IntelligenceContext,
  dependencies: IntelligenceDependencies,
) {
  const transactions = await dependencies.transactionsForAccounts(
    context.scope.accounts, startDate, endDate, context.preferences,
  );
  const summary = calculateSummary(normalizeTransactions(transactions), context.categories, {
    startDate, endDate,
    currency: context.preferences.displayCurrency,
    exchangeRates: context.preferences.exchangeRates,
  });
  const converted = dependencies.convertTransactionsForAnalysis(transactions, context.preferences);
  return { transactions, summary, converted };
}

async function buildAnomalyAndComparisonFindings(
  startDate: string,
  endDate: string,
  asOfDate: string,
  calculatedAt: string,
  anomalyOptions: IntelligenceAnomalyOptions,
  context: IntelligenceContext,
  currentSummary: ReturnType<typeof calculateSummary>,
  convertedCurrent: ConvertedTransactions,
  dependencies: IntelligenceDependencies,
): Promise<{ findings: FinancialFinding[]; warnings: string[] }> {
  const findings: FinancialFinding[] = [];
  const warnings = [...convertedCurrent.warnings];
  const anomalyDurationDays = durationDaysBetween(startDate, endDate);
  const anomalyHistoryDays = Math.min(730, Math.max(90, anomalyDurationDays * anomalyOptions.referenceWindows));
  const anomalyHistoryStartDate = addIntelligenceDays(startDate, -anomalyHistoryDays);
  const anomalyHistoryEndDate = addIntelligenceDays(startDate, -1);
  const rawHistory = await dependencies.transactionsForAccounts(
    context.scope.accounts, anomalyHistoryStartDate, anomalyHistoryEndDate, context.preferences,
  );
  const convertedHistory = dependencies.convertTransactionsForAnalysis(rawHistory, context.preferences);
  warnings.push(...convertedHistory.warnings);
  const anomalyResult = buildFinancialAnomalyFindings([
    ...normalizeTransactions(convertedHistory.transactions),
    ...normalizeTransactions(convertedCurrent.transactions),
  ], {
    period: { startDate, endDate },
    accountScope: context.findingScope,
    currency: context.preferences.displayCurrency,
    calculatedAt,
    categories: context.categories,
    referenceWindows: anomalyOptions.referenceWindows,
    minimumAbsoluteChangeMinor: anomalyOptions.minimumAbsoluteChangeMinor,
    minimumRelativeChangePercent: anomalyOptions.minimumRelativeChangePercent,
    enabledKinds: anomalyOptions.enabledAnomalyKinds,
    historyStartDate: anomalyHistoryStartDate,
    allowPeriodComparisons: endDate < asOfDate &&
      convertedCurrent.warnings.length === 0 && convertedHistory.warnings.length === 0,
    allowTransactionOutliers: convertedCurrent.warnings.length === 0 && convertedHistory.warnings.length === 0,
    sourceWarnings: [...convertedCurrent.warnings, ...convertedHistory.warnings],
  });
  findings.push(...anomalyResult.findings);
  warnings.push(...anomalyResult.limitations);
  if (anomalyHistoryDays === 730 && anomalyDurationDays * anomalyOptions.referenceWindows > 730) {
    warnings.push('El historial de anomalías está limitado a los 730 días anteriores por razones de rendimiento.');
  }
  const comparison = await buildPeriodComparison(
    startDate, endDate, asOfDate, calculatedAt, currentSummary, context, dependencies,
  );
  findings.push(...comparison.findings);
  warnings.push(...comparison.warnings);
  const uncategorized = buildUncategorizedFinding(normalizeTransactions(convertedCurrent.transactions), {
    period: { startDate, endDate },
    accountScope: context.findingScope,
    currency: context.preferences.displayCurrency,
    calculatedAt,
    sourceWarnings: convertedCurrent.warnings,
  });
  if (uncategorized) findings.push(uncategorized);
  return { findings, warnings };
}

async function buildPeriodComparison(
  startDate: string,
  endDate: string,
  asOfDate: string,
  calculatedAt: string,
  currentSummary: ReturnType<typeof calculateSummary>,
  context: IntelligenceContext,
  dependencies: IntelligenceDependencies,
): Promise<{ findings: FinancialFinding[]; warnings: string[] }> {
  if (endDate >= asOfDate) {
    return {
      findings: [],
      warnings: ['Las variaciones entre periodos se omiten porque el periodo seleccionado incluye hoy o fechas futuras y todavía no está completo.'],
    };
  }
  const durationDays = durationDaysBetween(startDate, endDate);
  const previousEndDate = addIntelligenceDays(startDate, -1);
  const previousStartDate = addIntelligenceDays(startDate, -durationDays);
  dependencies.assertPeriod(previousStartDate, previousEndDate);
  const previousTransactions = await dependencies.transactionsForAccounts(
    context.scope.accounts, previousStartDate, previousEndDate, context.preferences,
  );
  const previousSummary = calculateSummary(normalizeTransactions(previousTransactions), context.categories, {
    startDate: previousStartDate, endDate: previousEndDate,
    currency: context.preferences.displayCurrency, exchangeRates: context.preferences.exchangeRates,
  });
  let priorSummary: ReturnType<typeof calculateSummary> | undefined;
  if (durationDays <= 92) {
    const priorEndDate = addIntelligenceDays(previousStartDate, -1);
    const priorStartDate = addIntelligenceDays(previousStartDate, -durationDays);
    dependencies.assertPeriod(priorStartDate, priorEndDate);
    const priorTransactions = await dependencies.transactionsForAccounts(
      context.scope.accounts, priorStartDate, priorEndDate, context.preferences,
    );
    priorSummary = calculateSummary(normalizeTransactions(priorTransactions), context.categories, {
      startDate: priorStartDate, endDate: priorEndDate,
      currency: context.preferences.displayCurrency, exchangeRates: context.preferences.exchangeRates,
    });
  }
  const comparison = buildPeriodChangeFindings(currentSummary, previousSummary, {
    accountScope: context.findingScope,
    calculatedAt,
    ...(priorSummary ? { priorSummary } : {}),
  });
  return { findings: [...comparison.findings], warnings: [...comparison.limitations] };
}

function finalizeFindings(
  findings: readonly FinancialFinding[],
  warnings: string[],
  asOfDate: string,
  currentSummary: ReturnType<typeof calculateSummary>,
  context: IntelligenceContext,
  calculatedAt: string,
  validateFinding: (finding: unknown) => FinancialFinding,
): IntelligenceResult {
  const unique = new Map<string, FinancialFinding>();
  for (const finding of findings) unique.set(finding.id, finding);
  return readFindingReviewState(context.config.actualDataDir).then((state) => {
    const validated = sortFinancialFindings([...unique.values()]).slice(0, 100).map((finding) => {
      const record = state.reviews.find((item) => item.findingId === finding.id);
      const review = effectiveFindingReview(record, finding.fingerprint, asOfDate);
      return validateFinding({
        ...finding,
        reviewStatus: review.status,
        ...(review.snoozedUntil ? { snoozedUntil: review.snoozedUntil } : {}),
      });
    });
    if (findings.length > validated.length) {
      warnings.push('Se muestran los 100 hallazgos con mayor prioridad; el resto queda fuera de esta respuesta para mantener acotado el panel.');
    }
    return {
      findings: validated,
      warnings: [...new Set(warnings)],
      currentSummary,
      accountScope: context.scope.metadata,
      currency: context.preferences.displayCurrency,
      calculatedAt,
      asOfDate,
    };
  });
}

export interface IntelligenceResult {
  readonly findings: readonly FinancialFinding[];
  readonly warnings: readonly string[];
  readonly currentSummary: ReturnType<typeof calculateSummary>;
  readonly accountScope: AccountScopeMetadata;
  readonly currency: string;
  readonly calculatedAt: string;
  readonly asOfDate: string;
}

export async function generateIntelligenceData(
  startDate: string,
  endDate: string,
  anomalyOptions: IntelligenceAnomalyOptions,
  asOfDateOverride: string | undefined,
  dependencies: IntelligenceDependencies,
): Promise<IntelligenceResult> {
  dependencies.assertPeriod(startDate, endDate);
  const calculatedAt = new Date().toISOString();
  const asOfDate = asOfDateOverride ?? calculatedAt.slice(0, 10);
  if (!isIsoDate(asOfDate)) throw new RangeError('asOfDate must be a valid ISO calendar date.');
  const context = await loadContext(dependencies);
  const current = await buildCurrentSummary(startDate, endDate, context, dependencies);
  const primary = await buildAnomalyAndComparisonFindings(
    startDate, endDate, asOfDate, calculatedAt, anomalyOptions, context,
    current.summary, current.converted, dependencies,
  );
  const findings = [...primary.findings, ...buildCommitmentFindings(
    context.stored.commitments, context.accountPreference, context.preferences.displayCurrency,
    asOfDate, calculatedAt, context.findingScope,
  )];
  const historyStartDate = monthsBefore(asOfDate, 12);
  const historyTransactions = await dependencies.transactionsForAccounts(
    context.scope.accounts, historyStartDate, asOfDate, context.preferences,
  );
  const historyConverted = dependencies.convertTransactionsForAnalysis(historyTransactions, context.preferences);
  const recurringCandidates = detectRecurringCandidates(historyConverted.transactions, {
    startDate: historyStartDate, endDate: asOfDate,
  });
  findings.push(...buildRecurringFindings(
    recurringCandidates, historyConverted.warnings, asOfDate, calculatedAt,
    context.preferences.displayCurrency, context.findingScope,
  ));
  findings.push(...buildGoalFindings(
    context.stored.goals, context.stored.commitments, historyTransactions, context.categories,
    context.preferences, context.accountPreference, context.findingScope,
    asOfDate, calculatedAt, historyStartDate,
  ));
  const budget = await buildBudgetOverspendFindings({
    repository: dependencies.repository,
    startDate, endDate, asOfDate, calculatedAt,
    categories: context.categories,
    accountPreference: context.accountPreference,
    findingScope: context.findingScope,
    preferences: context.preferences,
    budgetCurrency: dependencies.config.budgetCurrency,
  });
  findings.push(...budget.findings);
  const combinedWarnings = [
    ...primary.warnings, ...historyConverted.warnings, ...budget.warnings,
  ];

  return finalizeFindings(
    findings,
    combinedWarnings,
    asOfDate, current.summary, context, calculatedAt, dependencies.validateFinding,
  );
}
