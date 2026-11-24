import {
  estimatePlanningCashFlow,
  expandCommitmentOccurrences,
  createFinancialFinding,
  projectSavingsGoal,
} from '@personal-budget/finance-core';
import type { detectRecurringCandidates } from '@personal-budget/finance-core';
import type {
  BudgetCategory,
  BudgetRepository,
  BudgetTransaction,
  FinancialFinding,
  FindingPriority,
  PlanningCommitment,
} from '@personal-budget/finance-core';
import type { AccountScopePreference } from './account-scope.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import type { StoredPlanningCommitment, StoredPlanningGoal } from './planning-store.js';

export interface IntelligenceFindingScope {
  readonly mode: AccountScopePreference['mode'];
  readonly accountIds: readonly string[];
  readonly label: string;
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
    id: item.id, title: item.title, amountMinor: item.amountMinor,
    date: item.date, direction: item.direction, frequency: item.frequency,
    currency: item.currency, status: item.status,
    ...(item.notes === undefined ? {} : { notes: item.notes }),
  };
}

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

export function buildCommitmentFindings(
  commitments: readonly StoredPlanningCommitment[],
  accountPreference: AccountScopePreference,
  displayCurrency: string,
  asOfDate: string,
  calculatedAt: string,
  findingScope: IntelligenceFindingScope,
): FinancialFinding[] {
  const eligible = commitments
    .filter((item) => item.status === 'active' && item.currency === displayCurrency &&
      planningScopeMatches(item.scope, accountPreference))
    .map(toPlanningCommitment);
  return expandCommitmentOccurrences(eligible, asOfDate, addIntelligenceDays(asOfDate, 30))
    .map((item) => {
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
    });
}

export function buildRecurringFindings(
  candidates: readonly ReturnType<typeof detectRecurringCandidates>[number][],
  warnings: readonly string[],
  asOfDate: string,
  calculatedAt: string,
  displayCurrency: string,
  findingScope: IntelligenceFindingScope,
): FinancialFinding[] {
  const lookaheadEnd = addIntelligenceDays(asOfDate, 30);
  return candidates.flatMap((candidate) => {
    if (candidate.estimatedIntervalDays === null || candidate.estimatedIntervalDays <= 0) return [];
    const nextDate = addIntelligenceDays(candidate.lastDate, Math.round(candidate.estimatedIntervalDays));
    if (nextDate < asOfDate || nextDate > lookaheadEnd) return [];
    const daysUntil = Math.max(0, Math.floor((
      Date.parse(nextDate + 'T00:00:00.000Z') - Date.parse(asOfDate + 'T00:00:00.000Z')) / 86_400_000));
    const priority = dueDatePriority(daysUntil, candidate.meanAbsoluteAmountMinor);
    return [createFinancialFinding({
      entityKey: candidate.payee + '|' + nextDate,
      type: 'recurring-candidate-upcoming',
      title: 'Posible pago recurrente próximo: ' + (candidate.payeeVariants[0] ?? candidate.payee),
      explanation: 'El historial muestra un patrón de pagos compatible con una posible recurrencia próxima. El patrón es estadístico y no confirma una suscripción ni garantiza el siguiente cargo.',
      period: { startDate: nextDate, endDate: nextDate },
      accountScope: findingScope,
      currency: displayCurrency,
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
      limitations: ['Es un candidato estadístico, no una suscripción confirmada.', ...candidate.warnings, ...warnings],
      calculatedAt,
      navigationTarget: '/planning',
    })];
  });
}

export function buildGoalFindings(
  goals: readonly StoredPlanningGoal[],
  commitments: readonly StoredPlanningCommitment[],
  historyTransactions: readonly BudgetTransaction[],
  categories: readonly BudgetCategory[],
  preferences: CurrencyPreferences,
  accountPreference: AccountScopePreference,
  findingScope: IntelligenceFindingScope,
  asOfDate: string,
  calculatedAt: string,
  historyStartDate: string,
): FinancialFinding[] {
  if (goals.length === 0) return [];
  const estimate = estimatePlanningCashFlow(historyTransactions, categories, {
    currency: preferences.displayCurrency, startDate: historyStartDate, endDate: asOfDate,
  });
  const eligibleCommitments = commitments
    .filter((item) => item.status === 'active' && item.currency === preferences.displayCurrency &&
      planningScopeMatches(item.scope, accountPreference))
    .map(toPlanningCommitment);
  return goals
    .filter((goal) => goal.status === 'active' && goal.currency === preferences.displayCurrency &&
      planningScopeMatches(goal.scope, accountPreference) && goal.targetDate > asOfDate)
    .map((goal) => {
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
        limitations: [
          ...projection.assumptions, ...projection.warnings,
          'El resultado depende del historial disponible y de las aportaciones configuradas; no es una garantía.',
        ],
        calculatedAt,
        navigationTarget: '/goals',
      });
    });
}

function isFullCompletedMonth(startDate: string, endDate: string, asOfDate: string): boolean {
  const sameMonth = startDate.slice(0, 7) === endDate.slice(0, 7);
  const month = startDate.slice(0, 7);
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return sameMonth && startDate === month + '-01' && endDate === lastDay && endDate < asOfDate;
}

type BudgetMonth = Awaited<ReturnType<NonNullable<BudgetRepository['getBudgetMonth']>>>;
type BudgetCategoryGroup = BudgetMonth['categoryGroups'][number];
type BudgetCategoryRow = NonNullable<BudgetCategoryGroup['categories']>[number];

function budgetOverspendMetrics(
  category: BudgetCategoryRow,
  group: BudgetCategoryGroup,
  categories: readonly BudgetCategory[],
): {
  readonly categoryName: string;
  readonly budgetedMinor: number;
  readonly spentMinor: number;
  readonly overByMinor: number;
  readonly percentUsed: number;
} | null {
  const metadata = categories.find((item) => item.id === category.id);
  const income = group.is_income ?? metadata?.isIncome ?? false;
  if (income || category.hidden || group.hidden) return null;
  const budgetedMinor = category.budgeted;
  const spent = category.spent;
  if (budgetedMinor === undefined || budgetedMinor === null ||
      spent === undefined || spent === null ||
      !Number.isSafeInteger(budgetedMinor) || !Number.isSafeInteger(spent) ||
      budgetedMinor <= 0) return null;
  const spentMinor = Math.abs(spent);
  const overByMinor = spentMinor - budgetedMinor;
  if (overByMinor <= 0) return null;
  return {
    categoryName: metadata?.name ?? category.name,
    budgetedMinor, spentMinor, overByMinor,
    percentUsed: (spentMinor / budgetedMinor) * 100,
  };
}

function budgetOverspendPriority(metrics: {
  readonly overByMinor: number;
  readonly percentUsed: number;
}): { readonly priority: FindingPriority; readonly reason: string } {
  if (metrics.overByMinor >= 100_000 || metrics.percentUsed >= 150) {
    return {
      priority: 'high',
      reason: 'Exceso ≥ 100000 unidades menores o gasto ≥ 150 % de la asignación (regla v1).',
    };
  }
  if (metrics.overByMinor >= 25_000 || metrics.percentUsed >= 110) {
    return {
      priority: 'medium',
      reason: 'Exceso ≥ 25000 unidades menores o gasto ≥ 110 % de la asignación (regla v1).',
    };
  }
  return {
    priority: 'low',
    reason: 'La categoría supera la asignación, sin alcanzar los umbrales de prioridad superiores (regla v1).',
  };
}

function buildBudgetFinding(
  category: BudgetCategoryRow,
  group: BudgetCategoryGroup,
  categories: readonly BudgetCategory[],
  calculatedAt: string,
  findingScope: IntelligenceFindingScope,
  displayCurrency: string,
  month: string,
): FinancialFinding | null {
  const metrics = budgetOverspendMetrics(category, group, categories);
  if (!metrics) return null;
  const priority = budgetOverspendPriority(metrics);
  return createFinancialFinding({
    entityKey: category.id,
    type: 'budget-overspend',
    title: 'Categoría por encima del presupuesto: ' + metrics.categoryName,
    explanation: 'El gasto registrado en esta categoría supera la asignación del mes. Comprueba la asignación y los movimientos antes de hacer cambios.',
    period: planningMonthPeriod(month),
    accountScope: findingScope,
    currency: displayCurrency,
    confidence: 'observed',
    priority: priority.priority,
    priorityReason: priority.reason,
    impactMinor: metrics.overByMinor,
    metrics: {
      categoryId: category.id,
      budgetedMinor: metrics.budgetedMinor,
      spentMinor: metrics.spentMinor,
      overByMinor: metrics.overByMinor,
      percentUsed: metrics.percentUsed,
    },
    evidence: [
      { label: 'Presupuesto asignado', value: metrics.budgetedMinor, source: 'Actual Budget getBudgetMonth', rule: 'Asignación positiva conocida para el mes.' },
      { label: 'Gasto registrado', value: metrics.spentMinor, source: 'Actual Budget getBudgetMonth', rule: 'Valor absoluto del gasto acumulado informado por Actual.' },
      { label: 'Exceso', value: metrics.overByMinor, source: 'finance-core', rule: 'Gasto registrado menos asignación.' },
      { label: 'Porcentaje utilizado', value: Number(metrics.percentUsed.toFixed(2)), source: 'finance-core', rule: 'Gasto registrado dividido por asignación por 100.' },
    ],
    limitations: [
      'El presupuesto corresponde al mes completo en Actual Budget.',
      'Solo se compara cuando la vista incluye todas las cuentas y coincide la divisa del presupuesto con la divisa de análisis.',
    ],
    calculatedAt,
    navigationTarget: '/budgets',
  });
}

export async function buildBudgetOverspendFindings(input: {
  readonly repository: BudgetRepository;
  readonly startDate: string;
  readonly endDate: string;
  readonly asOfDate: string;
  readonly calculatedAt: string;
  readonly categories: readonly BudgetCategory[];
  readonly accountPreference: AccountScopePreference;
  readonly findingScope: IntelligenceFindingScope;
  readonly preferences: CurrencyPreferences;
  readonly budgetCurrency: string;
}): Promise<{ readonly findings: FinancialFinding[]; readonly warnings: string[] }> {
  if (input.startDate.slice(0, 7) !== input.endDate.slice(0, 7) ||
      typeof input.repository.getBudgetMonth !== 'function') return { findings: [], warnings: [] };
  if (!isFullCompletedMonth(input.startDate, input.endDate, input.asOfDate)) {
    return { findings: [], warnings: ['Desviaciones de presupuesto no incluidas: el intervalo no cubre un mes natural completo ya cerrado.'] };
  }
  if (input.accountPreference.mode !== 'all' || input.preferences.displayCurrency !== input.budgetCurrency) {
    return { findings: [], warnings: ['Desviaciones de presupuesto no incluidas: el presupuesto de Actual es global y/o su divisa no coincide con la divisa de análisis seleccionada.'] };
  }
  const month = input.startDate.slice(0, 7);
  try {
    const budget = await input.repository.getBudgetMonth(month);
    const findings: FinancialFinding[] = [];
    for (const group of budget.categoryGroups) {
      for (const category of group.categories ?? []) {
        const finding = buildBudgetFinding(
          category, group, input.categories, input.calculatedAt, input.findingScope,
          input.preferences.displayCurrency, month,
        );
        if (finding) findings.push(finding);
      }
    }
    return { findings, warnings: [] };
  } catch {
    return { findings: [], warnings: ['Desviaciones de presupuesto omitidas: el presupuesto mensual no devolvió datos verificables.'] };
  }
}
