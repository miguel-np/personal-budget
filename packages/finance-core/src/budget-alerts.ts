export type BudgetAlertMetric = 'percent_used' | 'remaining_minor' | 'overspend_minor';
export interface BudgetAlertRule {
  readonly id: string;
  readonly categoryId: string;
  readonly metric: BudgetAlertMetric;
  readonly threshold: number;
  readonly enabled: boolean;
}
export interface BudgetAlertCategory {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly budgetedMinor: number | null;
  readonly spentMinor: number | null;
  readonly availableMinor: number | null;
  readonly state: 'budgeted' | 'zero' | 'unbudgeted' | 'unknown';
  readonly hidden?: boolean;
}
export interface BudgetAlertCandidate {
  readonly ruleId: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly metric: BudgetAlertMetric;
  readonly threshold: number;
  readonly observedValue: number;
  readonly month: string;
  readonly message: string;
}
function validMinor(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value);
}
/** Evaluate monthly thresholds using the exact budget values returned by Actual. */
export function evaluateBudgetAlertRules(
  rules: readonly BudgetAlertRule[],
  categories: readonly BudgetAlertCategory[],
  month: string,
): readonly BudgetAlertCandidate[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError('month must use YYYY-MM.');
  const categoryById = new Map(categories.map((category) => [category.categoryId, category]));
  const results: BudgetAlertCandidate[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!Number.isSafeInteger(rule.threshold) || rule.threshold < 0) throw new RangeError('Alert threshold must be a non-negative safe integer.');
    if (!['percent_used', 'remaining_minor', 'overspend_minor'].includes(rule.metric)) throw new RangeError('Alert metric is invalid.');
    const category = categoryById.get(rule.categoryId);
    if (!category || category.hidden || category.state === 'unbudgeted' || category.state === 'unknown' ||
        !validMinor(category.budgetedMinor) || !validMinor(category.spentMinor)) continue;
    let observedValue: number | null = null;
    let triggered = false;
    if (rule.metric === 'percent_used') {
      if (category.budgetedMinor > 0) {
        observedValue = Math.round(category.spentMinor / category.budgetedMinor * 100);
        triggered = observedValue >= rule.threshold;
      }
    } else if (rule.metric === 'remaining_minor') {
      observedValue = category.budgetedMinor - category.spentMinor;
      triggered = observedValue <= rule.threshold;
    } else {
      observedValue = Math.max(0, category.spentMinor - category.budgetedMinor);
      triggered = observedValue >= rule.threshold;
    }
    if (!triggered || observedValue === null) continue;
    const message = rule.metric === 'percent_used'
      ? 'Has consumido el ' + observedValue + ' % del presupuesto de ' + category.categoryName + '.'
      : rule.metric === 'remaining_minor'
        ? 'Quedan ' + observedValue + ' unidades menores en el presupuesto de ' + category.categoryName + '.'
        : 'El gasto supera el presupuesto de ' + category.categoryName + ' en ' + observedValue + ' unidades menores.';
    results.push({
      ruleId: rule.id, categoryId: category.categoryId, categoryName: category.categoryName,
      metric: rule.metric, threshold: rule.threshold, observedValue, month, message,
    });
  }
  return results.sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.ruleId.localeCompare(b.ruleId));
}
