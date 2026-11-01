export type BudgetAlertMetric = 'percent_used' | 'remaining_minor' | 'overspend_minor' | 'overspend_percent';
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
    if (!['percent_used', 'remaining_minor', 'overspend_minor', 'overspend_percent'].includes(rule.metric)) throw new RangeError('Alert metric is invalid.');
    if (rule.metric === 'percent_used' && (rule.threshold < 1 || rule.threshold > 500)) throw new RangeError('Consumption percentage threshold must be between 1 and 500.');
    if ((rule.metric === 'percent_used' || rule.metric === 'overspend_percent') && (rule.threshold < 1 || rule.threshold > 500)) throw new RangeError('Percentage threshold must be between 1 and 500.');
    if (rule.metric === 'overspend_minor' && rule.threshold < 1) throw new RangeError('Overspend threshold must be greater than zero.');
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
    } else if (rule.metric === 'overspend_minor') {
      observedValue = Math.max(0, category.spentMinor - category.budgetedMinor);
      triggered = observedValue >= rule.threshold;
    } else if (category.budgetedMinor > 0) {
      observedValue = Math.round(Math.max(0, category.spentMinor - category.budgetedMinor) / category.budgetedMinor * 100);
      triggered = observedValue >= rule.threshold;
    }
    if (!triggered || observedValue === null) continue;
    const message = rule.metric === 'percent_used'
      ? 'Has consumido el ' + observedValue + ' % del presupuesto de ' + category.categoryName + '.'
      : rule.metric === 'overspend_percent'
        ? 'El gasto supera el presupuesto de ' + category.categoryName + ' en un ' + observedValue + ' %.'
        : rule.metric === 'remaining_minor'
          ? 'El importe restante del presupuesto de ' + category.categoryName + ' es ' + observedValue + ' unidades menores.'
          : 'El gasto supera el presupuesto de ' + category.categoryName + ' en ' + observedValue + ' unidades menores.';
    results.push({
      ruleId: rule.id, categoryId: category.categoryId, categoryName: category.categoryName,
      metric: rule.metric, threshold: rule.threshold, observedValue, month, message,
    });
  }
  return results.sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.ruleId.localeCompare(b.ruleId));
}
