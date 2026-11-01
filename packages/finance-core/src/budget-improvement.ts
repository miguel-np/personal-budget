export type BudgetCategoryClassification = 'essential' | 'protected' | 'flexible' | 'reviewable';
export type BudgetImprovementGoal = 'increase_monthly_margin' | 'reduce_variable_spending' | 'reach_savings_goal' | 'free_cash_flow';
export interface BudgetImprovementObservation {
  readonly categoryId: string; readonly categoryName: string; readonly expenseMinor: number;
  readonly transactionCount: number; readonly monthsWithActivity: number;
  readonly latestMonthExpenseMinor?: number; readonly priorMonthsAverageExpenseMinor?: number;
  readonly budgetedMinor?: number | null; readonly budgetSpentMinor?: number | null;
}
export interface BudgetImprovementCategoryPreference { readonly categoryId: string; readonly classification: BudgetCategoryClassification; }
export interface BudgetImprovementProposal {
  readonly id: string; readonly categoryId: string; readonly categoryName: string;
  readonly kind: 'review_flexible_spend'; readonly suggestedReductionPercent: number;
  readonly observedMonthlyExpenseMinor: number; readonly estimatedMonthlySavingsMinor: number;
  readonly estimatedAnnualSavingsMinor: number; readonly confidence: 'medium' | 'high';
  readonly explanation: string;
  readonly evidence: {
    readonly signal: 'budget_overrun' | 'recent_increase';
    readonly periodMonths: number;
    readonly transactionCount: number;
    readonly observedExpenseMinor: number;
    readonly budgetedMinor: number | null;
    readonly budgetSpentMinor: number | null;
    readonly latestMonthExpenseMinor: number | null;
    readonly priorMonthsAverageExpenseMinor: number | null;
    readonly rule: string;
  };
  readonly assumptions: readonly string[]; readonly warnings: readonly string[];
}
export interface BudgetImprovementBaseline {
  readonly currency: string; readonly startDate: string; readonly endDate: string; readonly periodMonths: number;
  readonly monthlyIncomeMinor: number; readonly monthlyExpenseMinor: number; readonly monthlySavingsMinor: number;
  readonly savingsRatePercent: number | null; readonly transactionCount: number;
  readonly unconvertedTransactionCount: number; readonly observations: readonly BudgetImprovementObservation[];
}
export interface BudgetImprovementSimulation {
  readonly isEstimate: true; readonly currency: string; readonly baselineMonthlySavingsMinor: number;
  readonly estimatedMonthlySavingsMinor: number; readonly estimatedAnnualSavingsMinor: number;
  readonly projectedMonthlySavingsMinor: number; readonly projectedAnnualSavingsMinor: number;
  readonly selectedCategories: readonly { categoryId: string; categoryName: string; reductionPercent: number; monthlySavingsMinor: number }[];
  readonly assumptions: readonly string[]; readonly warnings: readonly string[];
}
function safeMinor(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(label + ' must be a non-negative safe integer in minor units.');
}
export function buildBudgetImprovementProposals(
  baseline: BudgetImprovementBaseline,
  preferences: readonly BudgetImprovementCategoryPreference[],
  goal: BudgetImprovementGoal = 'increase_monthly_margin',
): readonly BudgetImprovementProposal[] {
  if (!/^[A-Z]{3}$/.test(baseline.currency)) throw new RangeError('currency must be a three-letter uppercase code.');
  if (!Number.isInteger(baseline.periodMonths) || baseline.periodMonths < 3 || baseline.periodMonths > 24) throw new RangeError('periodMonths must be between 3 and 24.');
  const preferenceById = new Map<string, BudgetCategoryClassification>();
  for (const preference of preferences) {
    if (!preference.categoryId || preferenceById.has(preference.categoryId)) throw new RangeError('Category preferences must have unique non-empty IDs.');
    if (!['essential', 'protected', 'flexible', 'reviewable'].includes(preference.classification)) throw new RangeError('Category classification is invalid.');
    preferenceById.set(preference.categoryId, preference.classification);
  }
  const proposals: BudgetImprovementProposal[] = [];
  for (const observation of baseline.observations) {
    const classification = preferenceById.get(observation.categoryId);
    if (classification !== 'flexible' && classification !== 'reviewable') continue;
    safeMinor(observation.expenseMinor, 'observed category expense');
    if (!Number.isSafeInteger(observation.transactionCount) || observation.transactionCount < 0 ||
        !Number.isSafeInteger(observation.monthsWithActivity) || observation.monthsWithActivity < 0) throw new RangeError('Observation counts must be non-negative integers.');
    if (observation.expenseMinor <= 0 || observation.transactionCount < 3 || observation.monthsWithActivity < 2) continue;
    const monthlyExpense = Math.round(observation.expenseMinor / baseline.periodMonths);
    const budgetedMinor = observation.budgetedMinor ?? null;
    const budgetSpentMinor = observation.budgetSpentMinor ?? null;
    const latestMonthExpenseMinor = observation.latestMonthExpenseMinor ?? null;
    const priorMonthsAverageExpenseMinor = observation.priorMonthsAverageExpenseMinor ?? null;
    const hasBudgetOverrun = budgetedMinor !== null && budgetedMinor > 0 &&
      budgetSpentMinor !== null && budgetSpentMinor > budgetedMinor;
    const hasRecentIncrease = latestMonthExpenseMinor !== null && priorMonthsAverageExpenseMinor !== null &&
      latestMonthExpenseMinor > priorMonthsAverageExpenseMinor && latestMonthExpenseMinor > 0;
    if (!hasBudgetOverrun && !hasRecentIncrease) continue;
    const suggestedReductionPercent = hasBudgetOverrun && budgetedMinor !== null && budgetSpentMinor !== null
      ? Math.min(100, Math.ceil(((budgetSpentMinor - budgetedMinor) / budgetSpentMinor) * 100))
      : latestMonthExpenseMinor !== null && priorMonthsAverageExpenseMinor !== null
        ? Math.min(100, Math.ceil(((latestMonthExpenseMinor - priorMonthsAverageExpenseMinor) / latestMonthExpenseMinor) * 100))
        : 0;
    if (suggestedReductionPercent <= 0) continue;
    const monthlySavings = Math.round(monthlyExpense * suggestedReductionPercent / 100);
    const annualSavings = monthlySavings * 12;
    if (monthlySavings <= 0) continue;
    if (!Number.isSafeInteger(annualSavings)) throw new RangeError('Annual proposal savings exceed the safe integer range.');
    const confidence = baseline.periodMonths >= 6 && observation.transactionCount >= 8 && observation.monthsWithActivity >= 4 ? 'high' : 'medium';
    proposals.push({
      id: 'flexible-spend:' + observation.categoryId + ':' + baseline.startDate + ':' + baseline.endDate,
      categoryId: observation.categoryId, categoryName: observation.categoryName, kind: 'review_flexible_spend',
      suggestedReductionPercent, observedMonthlyExpenseMinor: monthlyExpense,
      estimatedMonthlySavingsMinor: monthlySavings, estimatedAnnualSavingsMinor: annualSavings, confidence,
      explanation: (hasBudgetOverrun
        ? 'El gasto del último mes completo superó la asignación presupuestaria. El porcentaje sugerido cuantifica ese exceso; el ahorro estimado se calcula aplicándolo al gasto mensual medio del periodo.'
        : 'El gasto del último mes completo superó la media de los meses anteriores. El porcentaje sugerido cuantifica el aumento; el ahorro estimado se calcula aplicándolo al gasto mensual medio del periodo.') +
        ' Has marcado esta categoría como ' + classification + '. ' +
        (goal === 'reach_savings_goal' ? 'Compara el impacto con tu objetivo de ahorro.'
          : goal === 'free_cash_flow' ? 'Compara el margen de caja que podría liberar.'
            : goal === 'reduce_variable_spending' ? 'Permite evaluar la tendencia del gasto variable.'
              : 'Evalúa si el ajuste mejora tu margen mensual.'),
      evidence: {
        signal: hasBudgetOverrun ? 'budget_overrun' : 'recent_increase',
        periodMonths: baseline.periodMonths, transactionCount: observation.transactionCount,
        observedExpenseMinor: observation.expenseMinor,
        budgetedMinor, budgetSpentMinor, latestMonthExpenseMinor, priorMonthsAverageExpenseMinor,
        rule: hasBudgetOverrun
          ? 'Categoría marcada por el usuario como flexible/revisable y gasto del último mes superior al presupuesto positivo del mismo mes.'
          : 'Categoría marcada por el usuario como flexible/revisable y gasto del último mes superior a la media de los meses de referencia previos.',
      },
      assumptions: [
        'El porcentaje sugerido se deriva del exceso frente al presupuesto positivo del último mes completo o del aumento frente a la media de los meses anteriores; el usuario puede editarlo antes de simular.',
        'El ahorro mensual aplica ese porcentaje al gasto mensual medio de todo el periodo. No equivale necesariamente al exceso presupuestario observado ni garantiza volver exactamente al importe asignado.',
        'La extensión anual mantiene el mismo supuesto durante doce meses; no es un ahorro observado ni garantizado.',
      ],
      warnings: baseline.unconvertedTransactionCount > 0 ? ['Hay movimientos sin conversión válida; la propuesta puede no representar todo el gasto del ámbito.'] : [],
    });
  }
  return proposals.sort((a, b) => b.estimatedAnnualSavingsMinor - a.estimatedAnnualSavingsMinor || a.categoryName.localeCompare(b.categoryName));
}
export function simulateBudgetImprovement(
  baseline: BudgetImprovementBaseline, preferences: readonly BudgetImprovementCategoryPreference[],
  reductions: readonly { readonly categoryId: string; readonly reductionPercent: number }[],
): BudgetImprovementSimulation {
  const categoryPreferences = new Map(preferences.map((item) => [item.categoryId, item.classification]));
  const observations = new Map(baseline.observations.map((item) => [item.categoryId, item]));
  const seen = new Set<string>();
  const selectedCategories = reductions.map((reduction) => {
    if (seen.has(reduction.categoryId)) throw new RangeError('A category can appear only once in a combined scenario; duplicate reductions would double count savings.');
    seen.add(reduction.categoryId);
    if (!Number.isInteger(reduction.reductionPercent) || reduction.reductionPercent < 1 || reduction.reductionPercent > 100) throw new RangeError('reductionPercent must be an integer between 1 and 100.');
    const classification = categoryPreferences.get(reduction.categoryId);
    if (classification !== 'flexible' && classification !== 'reviewable') throw new RangeError('Only categories explicitly marked flexible or reviewable can be reduced in a scenario.');
    const observation = observations.get(reduction.categoryId);
    if (!observation || observation.transactionCount < 3 || observation.monthsWithActivity < 2) throw new RangeError('The selected category has insufficient observed history for a simulation.');
    const monthlyExpense = Math.round(observation.expenseMinor / baseline.periodMonths);
    return { categoryId: observation.categoryId, categoryName: observation.categoryName, reductionPercent: reduction.reductionPercent, monthlySavingsMinor: Math.round(monthlyExpense * reduction.reductionPercent / 100) };
  });
  const estimatedMonthlySavingsMinor = selectedCategories.reduce((sum, item) => {
    const value = sum + item.monthlySavingsMinor; safeMinor(value, 'combined monthly savings'); return value;
  }, 0);
  const estimatedAnnualSavingsMinor = estimatedMonthlySavingsMinor * 12;
  const projectedMonthlySavingsMinor = baseline.monthlySavingsMinor + estimatedMonthlySavingsMinor;
  const projectedAnnualSavingsMinor = projectedMonthlySavingsMinor * 12;
  if (!Number.isSafeInteger(estimatedAnnualSavingsMinor) || !Number.isSafeInteger(projectedMonthlySavingsMinor) || !Number.isSafeInteger(projectedAnnualSavingsMinor)) {
    throw new RangeError('Projected savings exceed the safe integer range.');
  }
  return {
    isEstimate: true, currency: baseline.currency, baselineMonthlySavingsMinor: baseline.monthlySavingsMinor,
    estimatedMonthlySavingsMinor, estimatedAnnualSavingsMinor,
    projectedMonthlySavingsMinor, projectedAnnualSavingsMinor, selectedCategories,
    assumptions: [
      'Cada reducción se aplica al promedio mensual observado de la categoría durante el periodo completo.',
      'Las combinaciones incluyen como máximo una propuesta por categoría para evitar doble contabilización.',
      'No se supone que una categoría esencial o protegida pueda reducirse; requiere clasificación explícita del usuario.',
      'El escenario no modifica Actual Budget, presupuestos, movimientos, objetivos ni compromisos.',
    ],
    warnings: baseline.unconvertedTransactionCount > 0 ? ['Hay movimientos sin conversión válida; los importes consolidados son parciales.'] : [],
  };
}
