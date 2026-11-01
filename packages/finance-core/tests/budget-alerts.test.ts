import { describe, expect, it } from 'vitest';
import { evaluateBudgetAlertRules } from '../src/budget-alerts.js';
const categories = [
  { categoryId: 'food', categoryName: 'Alimentación', budgetedMinor: 20_000, spentMinor: 18_000, availableMinor: 2_000, state: 'budgeted' as const },
  { categoryId: 'zero', categoryName: 'Cero', budgetedMinor: 0, spentMinor: 3_000, availableMinor: -3_000, state: 'zero' as const },
  { categoryId: 'none', categoryName: 'Sin asignar', budgetedMinor: null, spentMinor: 5_000, availableMinor: null, state: 'unbudgeted' as const },
  { categoryId: 'unknown', categoryName: 'Desconocido', budgetedMinor: null, spentMinor: null, availableMinor: null, state: 'unknown' as const },
  { categoryId: 'hidden', categoryName: 'Oculta', budgetedMinor: 1_000, spentMinor: 1_500, availableMinor: -500, state: 'budgeted' as const, hidden: true },
];
describe('budget alert evaluation', () => {
  it('evaluates consumption and remaining thresholds without dividing by zero', () => {
    const alerts = evaluateBudgetAlertRules([
      { id: 'r1', categoryId: 'food', metric: 'percent_used', threshold: 90, enabled: true },
      { id: 'r2', categoryId: 'zero', metric: 'percent_used', threshold: 1, enabled: true },
      { id: 'r3', categoryId: 'food', metric: 'remaining_minor', threshold: 2_000, enabled: true },
    ], categories, '2026-11');
    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.observedValue)).toEqual([90, 2_000]);
  });
  it('detects relative overspend only when the assigned budget is positive', () => {
    const alerts = evaluateBudgetAlertRules([
      { id: 'relative', categoryId: 'food', metric: 'overspend_percent', threshold: 10, enabled: true },
      { id: 'zero', categoryId: 'zero', metric: 'overspend_percent', threshold: 1, enabled: true },
    ], categories, '2026-11');
    expect(alerts).toHaveLength(0);
    const overBudget = [{ ...categories[0]!, spentMinor: 24_000 }];
    const crossed = evaluateBudgetAlertRules([{ id: 'relative', categoryId: 'food', metric: 'overspend_percent', threshold: 10, enabled: true }], overBudget, '2026-11');
    expect(crossed[0]).toMatchObject({ observedValue: 20, metric: 'overspend_percent' });
  });
  it('supports explicit zero allocations for overspend but skips missing/hidden budgets', () => {
    const alerts = evaluateBudgetAlertRules([
      { id: 'zero', categoryId: 'zero', metric: 'overspend_minor', threshold: 1_000, enabled: true },
      { id: 'none', categoryId: 'none', metric: 'overspend_minor', threshold: 1, enabled: true },
      { id: 'hidden', categoryId: 'hidden', metric: 'overspend_minor', threshold: 1, enabled: true },
    ], categories, '2026-11');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.observedValue).toBe(3_000);
  });
  it('does not evaluate disabled rules and rejects invalid thresholds or months', () => {
    expect(evaluateBudgetAlertRules([{ id: 'x', categoryId: 'food', metric: 'percent_used', threshold: 100, enabled: false }], categories, '2026-11')).toEqual([]);
    expect(() => evaluateBudgetAlertRules([{ id: 'x', categoryId: 'food', metric: 'percent_used', threshold: -1, enabled: true }], categories, '2026-11')).toThrow(/threshold/);
    expect(() => evaluateBudgetAlertRules([{ id: 'high', categoryId: 'food', metric: 'percent_used', threshold: 501, enabled: true }], categories, '2026-11')).toThrow(/between 1 and 500/);
    expect(() => evaluateBudgetAlertRules([{ id: 'high-relative', categoryId: 'food', metric: 'overspend_percent', threshold: 501, enabled: true }], categories, '2026-11')).toThrow(/between 1 and 500/);
    expect(() => evaluateBudgetAlertRules([{ id: 'zero', categoryId: 'food', metric: 'overspend_minor', threshold: 0, enabled: true }], categories, '2026-11')).toThrow(/greater than zero/);
    expect(() => evaluateBudgetAlertRules([], categories, '2026-13')).toThrow(/YYYY-MM/);
  });
});
