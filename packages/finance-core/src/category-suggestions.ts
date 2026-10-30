import type { BudgetCategory, BudgetTransaction } from './domain.js';
import { validatePeriod } from './date-range.js';
import { normalizeTransactions } from './ledger.js';

export interface CategorySuggestionOptions {
  readonly startDate: string;
  readonly endDate: string;
}

export interface CategorySuggestion {
  readonly transactionId: string;
  readonly date: string;
  readonly payeeLabel: string;
  readonly amountMinor: number;
  readonly suggestedCategoryId: string;
  readonly suggestedCategoryName: string;
  readonly evidenceCount: number;
  readonly lastEvidenceDate: string;
  readonly confidence: 'rule_based';
}

interface CategoryEvidence {
  count: number;
  lastDate: string;
}

/**
 * Suggests categories for uncategorized expenses using deterministic rules:
 * a payee's historical categorized transactions vote for a category. Pure and
 * local; nothing is learned or stored without an explicit user action.
 */
export function suggestCategories(
  transactions: readonly BudgetTransaction[],
  categories: readonly BudgetCategory[],
  options: CategorySuggestionOptions,
): readonly CategorySuggestion[] {
  validatePeriod(options);

  const expenseCategories = new Map(categories
    .filter((category) => !category.isIncome)
    .map((category) => [category.id, category]));

  const entries = normalizeTransactions(transactions);
  const uncategorized = entries.filter((entry) =>
    !entry.isTransfer
    && entry.amountMinor < 0
    && entry.categoryId === null
    && entry.payeeLabel
    && entry.date >= options.startDate
    && entry.date <= options.endDate);

  const evidenceByPayee = new Map<string, Map<string, CategoryEvidence>>();
  for (const entry of entries) {
    if (entry.isTransfer || !entry.payeeLabel || !entry.categoryId) continue;
    const category = expenseCategories.get(entry.categoryId);
    if (!category) continue;
    const byCategory = evidenceByPayee.get(entry.payeeLabel) ?? new Map<string, CategoryEvidence>();
    const current = byCategory.get(category.id);
    byCategory.set(category.id, {
      count: (current?.count ?? 0) + 1,
      lastDate: current === undefined || entry.date > current.lastDate ? entry.date : current.lastDate,
    });
    evidenceByPayee.set(entry.payeeLabel, byCategory);
  }

  const suggestions: CategorySuggestion[] = [];
  for (const entry of uncategorized) {
    const byCategory = evidenceByPayee.get(entry.payeeLabel!);
    if (!byCategory || byCategory.size === 0) continue;
    const ranked = [...byCategory.entries()].sort((left, right) =>
      right[1].count - left[1].count || right[1].lastDate.localeCompare(left[1].lastDate));
    const [categoryId, evidence] = ranked[0]!;
    const runnerUp = ranked[1]?.[1];
    // When the strongest candidates have exactly the same evidence and recency,
    // abstain rather than turning an arbitrary sort order into a recommendation.
    if (runnerUp && runnerUp.count === evidence.count && runnerUp.lastDate === evidence.lastDate) continue;
    const category = expenseCategories.get(categoryId);
    if (!category) continue;
    suggestions.push({
      transactionId: entry.id,
      date: entry.date,
      payeeLabel: entry.payeeLabel!,
      amountMinor: entry.amountMinor,
      suggestedCategoryId: category.id,
      suggestedCategoryName: category.name,
      evidenceCount: evidence.count,
      lastEvidenceDate: evidence.lastDate,
      confidence: 'rule_based',
    });
  }

  return suggestions.sort((left, right) => left.date.localeCompare(right.date) || left.payeeLabel.localeCompare(right.payeeLabel, 'es'));
}
