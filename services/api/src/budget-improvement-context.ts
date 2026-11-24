import { createHash } from 'node:crypto';
import {
  buildBudgetImprovementProposals,
  calculateSummary,
  convertAmountMinor,
  detectRecurringCandidates,
  normalizeTransactions,
  projectSavingsGoal,
  simulateBudgetImprovement,
} from '@personal-budget/finance-core';
import type {
  BudgetAccount,
  BudgetCategory,
  BudgetRepository,
  BudgetTransaction,
  BudgetImprovementCategoryPreference,
  BudgetCategoryClassification,
  PlanningCommitment,
} from '@personal-budget/finance-core';
import type { AppConfig } from './config.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import type { AccountScopePreference } from './account-scope.js';
import { resolveAccountScope } from './account-scope.js';
import type { StoredPlanningCommitment, StoredPlanningGoal } from './planning-store.js';
import { readPlanningData } from './planning-store.js';
import { readFinancialActionState } from './financial-actions-store.js';

type FinancialActionState = Awaited<ReturnType<typeof readFinancialActionState>>;
type Summary = ReturnType<typeof calculateSummary>;
type BudgetRows = ReadonlyMap<string, {
  readonly budgetedMinor: number | null;
  readonly spentMinor: number | null;
  readonly availableMinor: number | null;
}>;
type Proposal = ReturnType<typeof buildBudgetImprovementProposals>[number];

interface Dependencies {
  readonly config: Pick<AppConfig, 'actualDataDir'>;
  readonly repository: BudgetRepository;
  readonly currencyPreferences: () => Promise<CurrencyPreferences>;
  readonly accountScopePreference: () => Promise<AccountScopePreference>;
  readonly transactionsForAccounts: (
    accounts: readonly BudgetAccount[], startDate: string, endDate: string, preferences: CurrencyPreferences,
  ) => Promise<readonly BudgetTransaction[]>;
  readonly convertTransactionsForAnalysis: (
    transactions: readonly BudgetTransaction[], preferences: CurrencyPreferences,
  ) => { readonly transactions: readonly BudgetTransaction[]; readonly warnings: readonly string[] };
  readonly civilDateInTimeZone: (timeZone: string) => string;
  readonly shiftPlanningMonth: (month: string, offset: number) => string;
  readonly planningMonthPeriod: (month: string) => { readonly startDate: string; readonly endDate: string };
  readonly planningScopeMatches: (saved: AccountScopePreference, current: AccountScopePreference) => boolean;
  readonly toPlanningCommitment: (item: StoredPlanningCommitment) => PlanningCommitment;
}

interface MonthlyExpenseMaps {
  readonly monthsByCategory: ReadonlyMap<string, ReadonlySet<string>>;
  readonly expenseByCategoryMonth: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

interface CategoryObservation {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly expenseMinor: number;
  readonly transactionCount: number;
  readonly monthsWithActivity: number;
  readonly latestMonthExpenseMinor: number;
  readonly priorMonthsAverageExpenseMinor: number;
  readonly budgetedMinor: number | null;
  readonly budgetSpentMinor: number | null;
  readonly budgetAvailableMinor: number | null;
}


function createAccountScopeSignature(
  mode: AccountScopePreference['mode'],
  accountIds: readonly string[],
): string {
  return createHash('sha256').update(JSON.stringify({
    mode, accountIds: [...accountIds].sort(),
  })).digest('hex');
}

function collectMonthlyExpenses(
  entries: ReturnType<typeof normalizeTransactions>,
  categories: readonly BudgetCategory[],
): MonthlyExpenseMaps {
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
    // Positive movements in expense categories are refunds; net them against monthly outflows.
    monthAmounts.set(entryMonth, (monthAmounts.get(entryMonth) ?? 0) - entry.amountMinor);
    expenseByCategoryMonth.set(entry.categoryId, monthAmounts);
  }
  return { monthsByCategory, expenseByCategoryMonth };
}

async function loadBudgetRows(
  repository: BudgetRepository,
  month: string,
): Promise<{ readonly rows: BudgetRows; readonly warnings: string[] }> {
  const rows = new Map<string, { budgetedMinor: number | null; spentMinor: number | null; availableMinor: number | null }>();
  const warnings: string[] = [];
  if (typeof repository.getBudgetMonth !== 'function') {
    warnings.push('El adaptador no expone asignaciones mensuales; las propuestas no pueden contrastarse con límites presupuestarios explícitos.');
    return { rows, warnings };
  }
  try {
    const allocationsAvailable = typeof repository.getBudgetAllocations === 'function';
    const [budgetMonth, allocations] = await Promise.all([
      repository.getBudgetMonth(month),
      allocationsAvailable ? repository.getBudgetAllocations!(month) : Promise.resolve(null),
    ]);
    const allocationByCategory = new Map((allocations ?? []).map((item) => [item.categoryId, item.amountMinor]));
    for (const group of budgetMonth.categoryGroups) {
      for (const row of group.categories ?? []) {
        rows.set(row.id, {
          budgetedMinor: allocationsAvailable ? (allocationByCategory.get(row.id) ?? null) : (row.budgeted ?? null),
          spentMinor: row.spent === undefined || row.spent === null ? null : Math.abs(row.spent),
          availableMinor: row.balance ?? null,
        });
      }
    }
  } catch {
    warnings.push('No se pudo recuperar el presupuesto asignado del último mes completo; las propuestas se basan solo en el historial de movimientos.');
  }
  return { rows, warnings };
}

function buildCategoryObservations(
  summary: Summary,
  monthlyMaps: MonthlyExpenseMaps,
  budgetRows: BudgetRows,
  periodMonths: number,
  endMonth: string,
  referenceMonths: readonly string[],
): CategoryObservation[] {
  return summary.expensesByCategory
    .filter((item) => item.categoryId !== null && item.amountMinor > 0)
    .map((item) => {
      const categoryId = item.categoryId as string;
      const monthAmounts = monthlyMaps.expenseByCategoryMonth.get(categoryId) ?? new Map<string, number>();
      const priorTotal = referenceMonths.reduce((sum, month) => sum + (monthAmounts.get(month) ?? 0), 0);
      const budget = budgetRows.get(categoryId);
      return {
        categoryId,
        categoryName: item.categoryName,
        expenseMinor: item.amountMinor,
        transactionCount: item.transactionCount,
        monthsWithActivity: monthlyMaps.monthsByCategory.get(categoryId)?.size ?? 0,
        latestMonthExpenseMinor: monthAmounts.get(endMonth) ?? 0,
        priorMonthsAverageExpenseMinor: Math.round(priorTotal / Math.max(1, periodMonths - 1)),
        budgetedMinor: budget?.budgetedMinor ?? null,
        budgetSpentMinor: budget?.spentMinor ?? null,
        budgetAvailableMinor: budget?.availableMinor ?? null,
      };
    });
}

function buildCategoryBreakdown(
  categories: readonly BudgetCategory[],
  observations: readonly CategoryObservation[],
  budgetRows: BudgetRows,
  periodMonths: number,
) {
  return categories.filter((category) => !category.isIncome).map((category) => {
    const observation = observations.find((item) => item.categoryId === category.id);
    const budget = budgetRows.get(category.id);
    return {
      categoryId: category.id,
      categoryName: category.name,
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
}

function mapRecurringCandidates(
  transactions: readonly BudgetTransaction[],
  startDate: string,
  endDate: string,
) {
  return detectRecurringCandidates(transactions, {
    startDate, endDate, minOccurrences: 3, intervalWindowDays: [20, 400],
  }).map((candidate) => ({
    payee: candidate.payee,
    occurrenceCount: candidate.occurrenceCount,
    estimatedIntervalDays: candidate.estimatedIntervalDays,
    estimatedFrequency: candidate.estimatedFrequency,
    meanAbsoluteAmountMinor: candidate.meanAbsoluteAmountMinor,
    amountDeviationPercent: candidate.amountDeviationPercent,
    lastObservedDate: candidate.lastDate,
    signals: candidate.signals,
    warnings: candidate.warnings,
  }));
}

function convertActiveCommitments(
  commitments: readonly StoredPlanningCommitment[],
  preferences: CurrencyPreferences,
  asOfDate: string,
  scopeMatches: (saved: AccountScopePreference, current: AccountScopePreference) => boolean,
  accountPreference: AccountScopePreference,
) {
  return commitments.filter((item) =>
    item.status === 'active' && scopeMatches(item.scope, accountPreference),
  ).map((item) => {
    const conversion = item.currency === preferences.displayCurrency
      ? { amountMinor: item.amountMinor }
      : convertAmountMinor(item.amountMinor, item.currency, preferences.displayCurrency, asOfDate, preferences.exchangeRates);
    return {
      id: item.id,
      title: item.title,
      date: item.date,
      direction: item.direction,
      frequency: item.frequency,
      amountMinor: conversion.amountMinor,
      sourceCurrency: item.currency,
      currency: conversion.amountMinor === null ? item.currency : preferences.displayCurrency,
      conversionAvailable: conversion.amountMinor !== null && conversion.amountMinor > 0,
    };
  });
}

function buildBaseline(
  summary: Summary,
  entries: ReturnType<typeof normalizeTransactions>,
  rawTransactions: readonly BudgetTransaction[],
  observations: readonly CategoryObservation[],
  startDate: string,
  endDate: string,
  periodMonths: number,
  currency: string,
) {
  const rawEntryCount = normalizeTransactions(rawTransactions).length;
  return {
    currency,
    startDate,
    endDate,
    periodMonths,
    monthlyIncomeMinor: Math.round(summary.incomeMinor / periodMonths),
    monthlyExpenseMinor: Math.round(summary.expenseMinor / periodMonths),
    monthlySavingsMinor: Math.round(summary.savingsMinor / periodMonths),
    savingsRatePercent: summary.savingsRatePercent,
    transactionCount: summary.transactionCount,
    unconvertedTransactionCount: Math.max(0, rawEntryCount - entries.length),
    observations,
  };
}

function mapCorePreferences(actionState: FinancialActionState): BudgetImprovementCategoryPreference[] {
  return actionState.budgetImprovements.categories
    .filter((item) => item.classification !== 'unclassified')
    .map((item) => ({
      categoryId: item.categoryId,
      classification: item.classification as BudgetCategoryClassification,
    }));
}

function projectSavingsGoals(
  goals: readonly StoredPlanningGoal[],
  baseline: ReturnType<typeof buildBaseline>,
  asOfDate: string,
  preferences: CurrencyPreferences,
  accountPreference: AccountScopePreference,
  planningScopeMatches: Dependencies['planningScopeMatches'],
  commitments: readonly PlanningCommitment[],
) {
  return goals.map((goal) => {
    const scopeMatches = planningScopeMatches(goal.scope, accountPreference);
    const currencyMatches = goal.currency === preferences.displayCurrency;
    const warnings: string[] = [];
    if (!scopeMatches) warnings.push('El ámbito guardado del objetivo ha cambiado; revísalo desde Objetivos antes de usarlo para esta simulación.');
    if (!currencyMatches) warnings.push('La divisa guardada del objetivo no coincide con la divisa de análisis; no se convierten importes automáticamente.');
    if (goal.status === 'paused') warnings.push('El objetivo está pausado; reanúdalo desde Objetivos antes de incluirlo en una proyección.');
    if (goal.targetDate <= asOfDate) warnings.push('La fecha objetivo ya ha pasado; actualiza el objetivo para proyectarlo.');
    const projection = goal.status === 'active' && scopeMatches && currencyMatches && goal.targetDate > asOfDate
      ? projectSavingsGoal({
        asOfDate,
        targetDate: goal.targetDate,
        targetAmountMinor: goal.targetAmountMinor,
        initialAmountMinor: goal.initialAmountMinor,
        monthlyContributionMinor: goal.monthlyContributionMinor,
        currency: preferences.displayCurrency,
        monthlyIncomeMinor: goal.monthlyIncomeMinor ?? baseline.monthlyIncomeMinor,
        monthlyExpenseMinor: goal.monthlyExpenseMinor ?? baseline.monthlyExpenseMinor,
        commitments,
      })
      : null;
    return {
      id: goal.id,
      name: goal.name,
      targetDate: goal.targetDate,
      targetAmountMinor: goal.targetAmountMinor,
      initialAmountMinor: goal.initialAmountMinor,
      monthlyContributionMinor: goal.monthlyContributionMinor,
      monthlyIncomeMinor: goal.monthlyIncomeMinor ?? baseline.monthlyIncomeMinor,
      monthlyExpenseMinor: goal.monthlyExpenseMinor ?? baseline.monthlyExpenseMinor,
      currency: goal.currency,
      status: goal.status,
      scopeMatches,
      currencyMatches,
      projection,
      warnings,
    };
  });
}

function selectTargetSavingsGoal(savingsGoals: ReturnType<typeof projectSavingsGoals>) {
  const target = savingsGoals
    .filter((goal) => goal.status === 'active' && goal.projection !== null &&
      goal.projection.requiredMonthlyContributionMinor !== null)
    .sort((left, right) => {
      const leftGap = Math.max(0, left.projection!.requiredMonthlyContributionMinor! - left.monthlyContributionMinor);
      const rightGap = Math.max(0, right.projection!.requiredMonthlyContributionMinor! - right.monthlyContributionMinor);
      return rightGap - leftGap || left.targetDate.localeCompare(right.targetDate);
    })[0] ?? null;
  const required = target?.projection?.requiredMonthlyContributionMinor ?? null;
  return {
    targetSavingsGoal: target,
    targetRequiredMonthlyContributionMinor: required,
    targetSavingsGapMinor: target && required !== null
      ? Math.max(0, required - target.monthlyContributionMinor)
      : null,
  };
}

function prioritizeProposals(
  proposals: readonly Proposal[],
  goal: FinancialActionState['budgetImprovements']['goal'],
  target: ReturnType<typeof selectTargetSavingsGoal>,
) {
  return proposals.map((proposal) => {
    let priorityTier = 0;
    let priorityValue = proposal.estimatedMonthlySavingsMinor;
    let priorityReason = 'Ordenada por el margen mensual hipotético que podría liberar, calculado sobre el gasto observado.';
    let goalImpact: {
      goalId: string; goalName: string; monthlyContributionGapMinor: number;
      estimatedGapCoveredMinor: number; estimatedGapRemainingMinor: number;
    } | null = null;
    if (goal === 'reduce_variable_spending') {
      const latest = proposal.evidence.latestMonthExpenseMinor ?? 0;
      const previous = proposal.evidence.priorMonthsAverageExpenseMinor ?? 0;
      const increase = Math.max(0, latest - previous);
      priorityTier = increase > 0 ? 1 : 0;
      priorityValue = increase;
      priorityReason = priorityTier
        ? 'Prioridad por tendencia: el último mes completo superó la media de referencia. Revisa primero esta variación antes de fijar un recorte.'
        : 'No hay un aumento reciente cuantificado; se mantiene como alternativa secundaria basada en el presupuesto y el historial.';
    } else if (goal === 'reach_savings_goal') {
      const targetSavingsGoal = target.targetSavingsGoal as (typeof target.targetSavingsGoal & {
        readonly id: string; readonly name: string; readonly monthlyExpenseMinor: number;
      }) | null;
      if (targetSavingsGoal && target.targetSavingsGapMinor !== null) {
        const covered = Math.min(
          target.targetSavingsGapMinor,
          proposal.estimatedMonthlySavingsMinor,
          Math.max(0, targetSavingsGoal.monthlyExpenseMinor),
        );
        goalImpact = {
          goalId: targetSavingsGoal.id,
          goalName: targetSavingsGoal.name,
          monthlyContributionGapMinor: target.targetSavingsGapMinor,
          estimatedGapCoveredMinor: covered,
          estimatedGapRemainingMinor: Math.max(0, target.targetSavingsGapMinor - covered),
        };
        priorityTier = target.targetSavingsGapMinor > 0 ? 1 : 0;
        priorityValue = covered;
        priorityReason = target.targetSavingsGapMinor > 0
          ? 'Prioridad vinculada a «' + targetSavingsGoal.name + '»: se ordena por la parte de la brecha de aportación mensual que esta propuesta podría cubrir si se destina íntegramente al objetivo.'
          : 'El plan actual ya cubre la aportación mensual requerida para «' + targetSavingsGoal.name + '»; se ordena por ahorro potencial adicional.';
      } else {
        priorityReason = 'No hay un objetivo activo compatible con la divisa, el ámbito y una fecha proyectable; se ordena por ahorro mensual potencial sin atribuir impacto a una meta.';
      }
    } else if (goal === 'free_cash_flow') {
      priorityTier = proposal.evidence.latestMonthExpenseMinor === null ? 0 : 1;
      priorityValue = proposal.evidence.latestMonthExpenseMinor ?? proposal.estimatedMonthlySavingsMinor;
      priorityReason = 'Prioridad por liquidez inmediata: se ordena por el gasto neto del último mes completo, además de mostrar el ahorro mensual potencial; los compromisos activos siguen siendo independientes.';
    } else {
      priorityReason = 'Prioridad por margen: se ordena por el ahorro mensual hipotético derivado del gasto observado, sin asumir cambios automáticos.';
    }
    return { proposal, priorityTier, priorityValue, priorityReason, goalImpact };
  }).sort((left, right) =>
    right.priorityTier - left.priorityTier ||
    right.priorityValue - left.priorityValue ||
    right.proposal.estimatedMonthlySavingsMinor - left.proposal.estimatedMonthlySavingsMinor ||
    left.proposal.categoryName.localeCompare(right.proposal.categoryName),
  ).map(({ proposal, priorityReason, goalImpact }, index) => ({
    ...proposal, priorityRank: index + 1, priorityReason, goalImpact,
  }));
}

function compareSavedScenarios(
  scenarios: FinancialActionState['budgetImprovements']['scenarios'],
  baseline: ReturnType<typeof buildBaseline>,
  preferences: BudgetImprovementCategoryPreference[],
  currentAccountScopeSignature: string,
) {
  return scenarios.map((scenario) => {
    if (scenario.currency !== baseline.currency) {
      return { ...scenario, comparisonStatus: 'different_currency' as const, comparison: null };
    }
    if (scenario.startDate !== baseline.startDate || scenario.endDate !== baseline.endDate) {
      return { ...scenario, comparisonStatus: 'different_period' as const, comparison: null };
    }
    if (!scenario.accountScopeSignature || scenario.accountScopeSignature !== currentAccountScopeSignature) {
      return { ...scenario, comparisonStatus: 'different_scope' as const, comparison: null };
    }
    try {
      const comparison = simulateBudgetImprovement(baseline, preferences, scenario.reductions);
      return {
        ...scenario,
        comparisonStatus: 'comparable' as const,
        comparison: {
          baselineMonthlySavingsMinor: baseline.monthlySavingsMinor,
          estimatedMonthlySavingsMinor: comparison.estimatedMonthlySavingsMinor,
          projectedMonthlySavingsMinor: comparison.projectedMonthlySavingsMinor,
          estimatedAnnualSavingsMinor: comparison.estimatedAnnualSavingsMinor,
          projectedAnnualSavingsMinor: comparison.projectedAnnualSavingsMinor,
          assumptions: comparison.assumptions,
          warnings: comparison.warnings,
        },
      };
    } catch {
      return { ...scenario, comparisonStatus: 'preferences_changed' as const, comparison: null };
    }
  });
}

export async function loadBudgetImprovementContext(
  periodMonths: 3 | 6 | 12,
  dependencies: Dependencies,
) {
  const asOfDate = dependencies.civilDateInTimeZone('UTC');
  const endMonth = dependencies.shiftPlanningMonth(asOfDate.slice(0, 7), -1);
  const startMonth = dependencies.shiftPlanningMonth(endMonth, -(periodMonths - 1));
  const startDate = startMonth + '-01';
  const endDate = dependencies.planningMonthPeriod(endMonth).endDate;
  const [accounts, categories, preferences, accountPreference, actionState, planningData] = await Promise.all([
    dependencies.repository.listAccounts(),
    dependencies.repository.listCategories(),
    dependencies.currencyPreferences(),
    dependencies.accountScopePreference(),
    readFinancialActionState(dependencies.config.actualDataDir),
    readPlanningData(dependencies.config.actualDataDir),
  ]);
  const scope = resolveAccountScope(accounts, accountPreference);
  const accountScopeSignature = createAccountScopeSignature(scope.metadata.mode, scope.metadata.accountIds);
  const rawTransactions = await dependencies.transactionsForAccounts(scope.accounts, startDate, endDate, preferences);
  const converted = dependencies.convertTransactionsForAnalysis(rawTransactions, preferences);
  const entries = normalizeTransactions(converted.transactions);
  const summary = calculateSummary(entries, categories, {
    startDate, endDate, currency: preferences.displayCurrency, exchangeRates: preferences.exchangeRates,
  });
  const monthlyMaps = collectMonthlyExpenses(entries, categories);
  const budget = await loadBudgetRows(dependencies.repository, endMonth);
  const referenceMonths = Array.from(
    { length: periodMonths - 1 }, (_, index) => dependencies.shiftPlanningMonth(startMonth, index),
  );
  const observations = buildCategoryObservations(
    summary, monthlyMaps, budget.rows, periodMonths, endMonth, referenceMonths,
  );
  const categoryBreakdown = buildCategoryBreakdown(categories, observations, budget.rows, periodMonths);
  const recurringCandidates = mapRecurringCandidates(converted.transactions, startDate, endDate);
  const activeCommitments = convertActiveCommitments(
    planningData.commitments, preferences, asOfDate, dependencies.planningScopeMatches, accountPreference,
  );
  const budgetWarnings = [...budget.warnings];
  if (activeCommitments.some((item) => !item.conversionAvailable)) {
    budgetWarnings.push('Hay compromisos activos cuyo importe no se puede convertir a la divisa de análisis; se muestran en su divisa original y no se suman a los escenarios.');
  }
  const baseline = buildBaseline(summary, entries, rawTransactions, observations, startDate, endDate, periodMonths, preferences.displayCurrency);
  const corePreferences = mapCorePreferences(actionState);
  const proposals = buildBudgetImprovementProposals(
    baseline, corePreferences, actionState.budgetImprovements.goal,
  );
  const compatibleCommitments = planningData.commitments
    .filter((item) => item.status === 'active' && item.currency === preferences.displayCurrency &&
      dependencies.planningScopeMatches(item.scope, accountPreference))
    .map(dependencies.toPlanningCommitment);
  const savingsGoals = projectSavingsGoals(
    planningData.goals, baseline, asOfDate, preferences, accountPreference,
    dependencies.planningScopeMatches, compatibleCommitments,
  );
  const status = savingsGoals.some((goal) => goal.projection !== null)
    ? 'ready' : savingsGoals.length > 0 ? 'review_required' : 'not_configured';
  const savingsGoalContextWarnings = savingsGoals.flatMap((goal) =>
    goal.warnings.map((warning) => goal.name + ': ' + warning));
  const target = selectTargetSavingsGoal(savingsGoals);
  const prioritizedProposals = prioritizeProposals(proposals, actionState.budgetImprovements.goal, target);
  const scenarios = compareSavedScenarios(
    actionState.budgetImprovements.scenarios, baseline, corePreferences, accountScopeSignature,
  );
  const categoryChoices = categories.filter((category) => !category.isIncome).map((category) => ({
    categoryId: category.id,
    categoryName: category.name,
    classification: actionState.budgetImprovements.categories.find((item) => item.categoryId === category.id)?.classification ?? 'unclassified',
  }));
  const warnings = [
    ...summary.warnings,
    ...converted.warnings,
    ...budgetWarnings,
    'Se usan ' + periodMonths + ' meses naturales completos, hasta ' + endDate + '; el mes en curso se excluye para evitar extrapolar un periodo parcial.',
    'La comparación de tendencia usa el último mes completo frente a la media de los meses anteriores; un patrón recurrente detectado es un candidato, no una obligación.',
  ];
  return {
    asOfDate,
    currency: preferences.displayCurrency,
    accountScope: scope.metadata,
    accountScopeSignature,
    baseline,
    categoryBreakdown,
    recurringCandidates,
    commitments: compatibleCommitments,
    proposals: prioritizedProposals,
    corePreferences,
    categoryChoices,
    savingsGoals,
    savingsGoalContextStatus: status,
    savingsGoalContextWarnings,
    goal: actionState.budgetImprovements.goal,
    decisions: actionState.budgetImprovements.decisions,
    scenarios,
    warnings,
  };
}
