import {
  buildFinancialAnomalyFindings,
  buildPeriodChangeFindings,
  buildUncategorizedFinding,
  calculateSummary,
  createFinancialFinding,
  detectRecurringCandidates,
  estimatePlanningCashFlow,
  expandCommitmentOccurrences,
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
  FindingPriority,
  PlanningCommitment,
} from '@personal-budget/finance-core';
import type { AppConfig } from './config.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import type { AccountScopePreference, AccountScopeMetadata } from './account-scope.js';
import type { StoredPlanningCommitment } from './planning-store.js';
import { readPlanningData } from './planning-store.js';
import { effectiveFindingReview, readFindingReviewState } from './intelligence-store.js';

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
  readonly scope: ReturnType<typeof resolveScope>;
  readonly findingScope: {
    readonly mode: AccountScopePreference['mode'];
    readonly accountIds: readonly string[];
    readonly label: string;
  };
}

function resolveScope(accounts: readonly BudgetAccount[], preference: AccountScopePreference) {
  const openAccounts = accounts.filter((account) => !account.closed);
  const byId = new Map(openAccounts.map((account) => [account.id, account]));
  const scoped = preference.mode === 'all'
    ? openAccounts
    : preference.accountIds.map((id) => byId.get(id)).filter((item): item is BudgetAccount => item !== undefined);
  const accountIds = scoped.map((account) => account.id);
  const accountNames = scoped.map((account) => account.name);
  const label = preference.mode === 'all'
    ? 'Todas las cuentas abiertas (' + scoped.length + ')'
    : scoped.length === 0 ? 'Ninguna cuenta seleccionada'
      : 'Cuentas seleccionadas: ' + accountNames.join(', ');
  return {
    accounts: scoped,
    metadata: { mode: preference.mode, accountIds, accountNames, label } satisfies AccountScopeMetadata,
  };
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

function dueDatePriority(daysUntil: number, amountMinor: number): { priority: FindingPriority; reason: string } {
  if (daysUntil <= 3 || amountMinor >= 100_000) {
    return { priority: 'high', reason: 'Vence en 3 días o menos, o importe ≥ 100000 unidades menores (regla v1).' };
  }
  if (daysUntil <= 7 || amountMinor >= 25_000) {
    return { priority: 'medium', reason: 'Vence en 7 días o menos, o importe ≥ 25000 unidades menores (regla v1).' };
  }
  return { priority: 'low', reason: 'Vence dentro de los próximos 30 días sin alcanzar los umbrales de prioridad superiores (regla v1).' };
}

async function loadContext(dependencies: IntelligenceDependencies): Promise<IntelligenceContext> {
  const [accounts, categories, preferences, accountPreference, stored] = await Promise.all([
    dependencies.repository.listAccounts(),
    dependencies.repository.listCategories(),
    dependencies.currencyPreferences(),
    dependencies.accountScopePreference(),
    readPlanningData(dependencies.config.actualDataDir),
  ]);
  const scope = resolveScope(accounts, accountPreference);
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

function commitmentFinding(
  item: ReturnType<typeof expandCommitmentOccurrences>[number],
  asOfDate: string,
  calculatedAt: string,
  findingScope: IntelligenceContext['findingScope'],
): FinancialFinding {
  const daysUntil = Math.max(0, Math.floor((
    Date.parse(item.occurrenceDate + 'T00:00:00.000Z') -
    Date.parse(asOfDate + 'T00:00:00.000Z')) / 86_400_000));
  const priority = dueDatePriority(daysUntil, item.amountMinor);
  return createFinancialFinding({
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
    limitations: [
      'La planificación manual no confirma el movimiento bancario.',
      'Solo se consideran compromisos activos de la divisa y el ámbito de cuentas actuales.',
    ],
    calculatedAt,
    navigationTarget: '/planning',
  });
}

function buildCommitmentFindings(
  asOfDate: string,
  calculatedAt: string,
  context: IntelligenceContext,
): FinancialFinding[] {
  const lookaheadEnd = addIntelligenceDays(asOfDate, 30);
  const commitments = context.stored.commitments
    .filter((item) => item.status === 'active' && item.currency === context.preferences.displayCurrency &&
      planningScopeMatches(item.scope, context.accountPreference))
    .map(toPlanningCommitment);
  return expandCommitmentOccurrences(commitments, asOfDate, lookaheadEnd)
    .map((item) => commitmentFinding(item, asOfDate, calculatedAt, context.findingScope));
}

function recurringFinding(
  candidate: ReturnType<typeof detectRecurringCandidates>[number],
  nextDate: string,
  asOfDate: string,
  calculatedAt: string,
  context: IntelligenceContext,
  warnings: readonly string[],
): FinancialFinding {
  const daysUntil = Math.max(0, Math.floor((
    Date.parse(nextDate + 'T00:00:00.000Z') - Date.parse(asOfDate + 'T00:00:00.000Z')) / 86_400_000));
  const priority = dueDatePriority(daysUntil, candidate.meanAbsoluteAmountMinor);
  return createFinancialFinding({
    entityKey: candidate.payee + '|' + nextDate,
    type: 'recurring-candidate-upcoming',
    title: 'Posible pago recurrente próximo: ' + (candidate.payeeVariants[0] ?? candidate.payee),
    explanation: 'El historial muestra un patrón de pagos compatible con una posible recurrencia próxima. El patrón es estadístico y no confirma una suscripción ni garantiza el siguiente cargo.',
    period: { startDate: nextDate, endDate: nextDate },
    accountScope: context.findingScope,
    currency: context.preferences.displayCurrency,
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
      { label: 'Intervalo estimado (días)', value: candidate.estimatedIntervalDays!, source: 'finance-core.detectRecurringCandidates', rule: 'Estimación a partir de las fechas históricas observadas.' },
      { label: 'Importe absoluto medio', value: candidate.meanAbsoluteAmountMinor, source: 'finance-core.detectRecurringCandidates', rule: 'Media de importes absolutos observados; puede variar por reembolsos o cambios de precio.' },
    ],
    limitations: ['Es un candidato estadístico, no una suscripción confirmada.', ...candidate.warnings, ...warnings],
    calculatedAt,
    navigationTarget: '/planning',
  });
}

async function buildRecurringFindings(
  asOfDate: string,
  calculatedAt: string,
  context: IntelligenceContext,
  dependencies: IntelligenceDependencies,
): Promise<{ findings: FinancialFinding[]; warnings: string[] }> {
  const historyStartDate = monthsBefore(asOfDate, 12);
  const historyTransactions = await dependencies.transactionsForAccounts(
    context.scope.accounts, historyStartDate, asOfDate, context.preferences,
  );
  const converted = dependencies.convertTransactionsForAnalysis(historyTransactions, context.preferences);
  const candidates = detectRecurringCandidates(converted.transactions, {
    startDate: historyStartDate, endDate: asOfDate,
  });
  const lookaheadEnd = addIntelligenceDays(asOfDate, 30);
  const findings = candidates.flatMap((candidate) => {
    if (candidate.estimatedIntervalDays === null || candidate.estimatedIntervalDays <= 0) return [];
    const nextDate = addIntelligenceDays(candidate.lastDate, Math.round(candidate.estimatedIntervalDays));
    if (nextDate < asOfDate || nextDate > lookaheadEnd) return [];
    return [recurringFinding(candidate, nextDate, asOfDate, calculatedAt, context, converted.warnings)];
  });
  return { findings, warnings: [...converted.warnings] };
}

function goalFinding(
  goal: Awaited<ReturnType<typeof readPlanningData>>['goals'][number],
  asOfDate: string,
  calculatedAt: string,
  context: IntelligenceContext,
  estimate: ReturnType<typeof estimatePlanningCashFlow>,
  commitments: readonly PlanningCommitment[],
): FinancialFinding {
  const projection = projectSavingsGoal({
    asOfDate, targetDate: goal.targetDate, targetAmountMinor: goal.targetAmountMinor,
    initialAmountMinor: goal.initialAmountMinor, monthlyContributionMinor: goal.monthlyContributionMinor,
    currency: context.preferences.displayCurrency,
    monthlyIncomeMinor: goal.monthlyIncomeMinor ?? estimate.monthlyIncomeMinor,
    monthlyExpenseMinor: goal.monthlyExpenseMinor ?? estimate.monthlyExpenseMinor,
    commitments,
  });
  const onTrack = projection.projectedBalanceMinor >= goal.targetAmountMinor;
  const gapMinor = Math.max(0, goal.targetAmountMinor - projection.projectedBalanceMinor);
  const priority: FindingPriority = !onTrack && gapMinor >= 100_000
    ? 'high' : !onTrack && gapMinor >= 25_000 ? 'medium' : 'low';
  const priorityReason = onTrack
    ? 'La proyección con los supuestos actuales alcanza el objetivo; prioridad informativa baja.'
    : gapMinor >= 100_000 ? 'Brecha proyectada ≥ 100000 unidades menores (regla v1).'
      : gapMinor >= 25_000 ? 'Brecha proyectada ≥ 25000 unidades menores (regla v1).'
        : 'Brecha estimada inferior a los umbrales de prioridad media (regla v1).';
  return createFinancialFinding({
    entityKey: goal.id,
    type: onTrack ? 'goal-progress' : 'goal-at-risk',
    title: onTrack ? 'Proyección del objetivo: ' + goal.name : 'El objetivo podría no alcanzarse a tiempo: ' + goal.name,
    explanation: onTrack
      ? 'La proyección determinista alcanza el importe objetivo con los ingresos, gastos, compromisos y aportaciones configurados. Es una estimación condicional, no una predicción garantizada.'
      : 'La proyección determinista no alcanza el importe objetivo con las aportaciones configuradas. Comprueba los supuestos y la capacidad de contribución; el flujo disponible podría permitir alcanzar la meta con un plan diferente.',
    period: { startDate: asOfDate, endDate: goal.targetDate },
    accountScope: context.findingScope,
    currency: context.preferences.displayCurrency,
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
    limitations: [
      ...projection.assumptions, ...projection.warnings,
      'El resultado depende del historial disponible y de las aportaciones configuradas; no es una garantía.',
    ],
    calculatedAt,
    navigationTarget: '/goals',
  });
}

async function buildGoalFindings(
  asOfDate: string,
  calculatedAt: string,
  context: IntelligenceContext,
  historyTransactions: readonly BudgetTransaction[],
): Promise<FinancialFinding[]> {
  if (context.stored.goals.length === 0) return [];
  const estimate = estimatePlanningCashFlow(historyTransactions, context.categories, {
    currency: context.preferences.displayCurrency,
    startDate: monthsBefore(asOfDate, 12),
    endDate: asOfDate,
  });
  const commitments = context.stored.commitments
    .filter((item) => item.status === 'active' && item.currency === context.preferences.displayCurrency &&
      planningScopeMatches(item.scope, context.accountPreference))
    .map(toPlanningCommitment);
  return context.stored.goals
    .filter((goal) => goal.status === 'active' && goal.currency === context.preferences.displayCurrency &&
      planningScopeMatches(goal.scope, context.accountPreference) && goal.targetDate > asOfDate)
    .map((goal) => goalFinding(goal, asOfDate, calculatedAt, context, estimate, commitments));
}

function isFullCompletedMonth(startDate: string, endDate: string, asOfDate: string): boolean {
  const sameCalendarMonth = startDate.slice(0, 7) === endDate.slice(0, 7);
  const month = startDate.slice(0, 7);
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return sameCalendarMonth && startDate === month + '-01' && endDate === lastDay && endDate < asOfDate;
}

function budgetOverspendFinding(
  category: Awaited<ReturnType<NonNullable<BudgetRepository['getBudgetMonth']>>>['categoryGroups'][number]['categories'][number],
  group: Awaited<ReturnType<NonNullable<BudgetRepository['getBudgetMonth']>>>['categoryGroups'][number],
  categories: readonly BudgetCategory[],
  calculatedAt: string,
  context: IntelligenceContext,
  month: string,
): FinancialFinding | null {
  const metadata = categories.find((item) => item.id === category.id);
  if (group.is_income ?? metadata?.isIncome ?? false) return null;
  if (category.hidden || group.hidden) return null;
  if (category.budgeted === undefined || category.budgeted === null ||
      category.spent === undefined || category.spent === null ||
      !Number.isSafeInteger(category.budgeted) || !Number.isSafeInteger(category.spent) ||
      category.budgeted <= 0) return null;
  const budgetedMinor = category.budgeted;
  const spentMinor = Math.abs(category.spent);
  const overByMinor = spentMinor - budgetedMinor;
  if (overByMinor <= 0) return null;
  const percentUsed = (spentMinor / budgetedMinor) * 100;
  const priority: FindingPriority = overByMinor >= 100_000 || percentUsed >= 150
    ? 'high' : overByMinor >= 25_000 || percentUsed >= 110 ? 'medium' : 'low';
  const priorityReason = priority === 'high'
    ? 'Exceso ≥ 100000 unidades menores o gasto ≥ 150 % de la asignación (regla v1).'
    : priority === 'medium' ? 'Exceso ≥ 25000 unidades menores o gasto ≥ 110 % de la asignación (regla v1).'
      : 'La categoría supera la asignación, sin alcanzar los umbrales de prioridad superiores (regla v1).';
  return createFinancialFinding({
    entityKey: category.id,
    type: 'budget-overspend',
    title: 'Categoría por encima del presupuesto: ' + (metadata?.name ?? category.name),
    explanation: 'El gasto registrado en esta categoría supera la asignación del mes. Comprueba la asignación y los movimientos antes de hacer cambios.',
    period: planningMonthPeriod(month),
    accountScope: context.findingScope,
    currency: context.preferences.displayCurrency,
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
    limitations: [
      'El presupuesto corresponde al mes completo en Actual Budget.',
      'Solo se compara cuando la vista incluye todas las cuentas y coincide la divisa del presupuesto con la divisa de análisis.',
    ],
    calculatedAt,
    navigationTarget: '/budgets',
  });
}

function mapBudgetOverspendFindings(
  budget: Awaited<ReturnType<NonNullable<BudgetRepository['getBudgetMonth']>>>,
  categories: readonly BudgetCategory[],
  calculatedAt: string,
  context: IntelligenceContext,
  month: string,
): FinancialFinding[] {
  const findings: FinancialFinding[] = [];
  for (const group of budget.categoryGroups) {
    for (const category of group.categories ?? []) {
      const finding = budgetOverspendFinding(category, group, categories, calculatedAt, context, month);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

async function buildBudgetOverspendFindings(
  startDate: string,
  endDate: string,
  asOfDate: string,
  calculatedAt: string,
  context: IntelligenceContext,
  dependencies: IntelligenceDependencies,
): Promise<{ findings: FinancialFinding[]; warnings: string[] }> {
  if (startDate.slice(0, 7) !== endDate.slice(0, 7) ||
      typeof dependencies.repository.getBudgetMonth !== 'function') return { findings: [], warnings: [] };
  if (!isFullCompletedMonth(startDate, endDate, asOfDate)) {
    return { findings: [], warnings: ['Desviaciones de presupuesto no incluidas: el intervalo no cubre un mes natural completo ya cerrado.'] };
  }
  if (context.accountPreference.mode !== 'all' ||
      context.preferences.displayCurrency !== dependencies.config.budgetCurrency) {
    return { findings: [], warnings: ['Desviaciones de presupuesto no incluidas: el presupuesto de Actual es global y/o su divisa no coincide con la divisa de análisis seleccionada.'] };
  }
  const month = startDate.slice(0, 7);
  try {
    const budget = await dependencies.repository.getBudgetMonth(month);
    return { findings: mapBudgetOverspendFindings(budget, context.categories, calculatedAt, context, month), warnings: [] };
  } catch {
    return { findings: [], warnings: ['Desviaciones de presupuesto omitidas: el presupuesto mensual no devolvió datos verificables.'] };
  }
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
  const findings = [...primary.findings, ...buildCommitmentFindings(asOfDate, calculatedAt, context)];
  const recurring = await buildRecurringFindings(asOfDate, calculatedAt, context, dependencies);
  findings.push(...recurring.findings);
  const historyStartDate = monthsBefore(asOfDate, 12);
  const historyTransactions = await dependencies.transactionsForAccounts(
    context.scope.accounts, historyStartDate, asOfDate, context.preferences,
  );
  findings.push(...await buildGoalFindings(asOfDate, calculatedAt, context, historyTransactions));
  const budget = await buildBudgetOverspendFindings(
    startDate, endDate, asOfDate, calculatedAt, context, dependencies,
  );
  findings.push(...budget.findings);
  return finalizeFindings(
    findings,
    [...primary.warnings, ...recurring.warnings, ...budget.warnings],
    asOfDate, current.summary, context, calculatedAt, dependencies.validateFinding,
  );
}
