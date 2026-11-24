import type { BudgetCategory, BudgetRepository } from '@personal-budget/finance-core';

type BudgetMonth = Awaited<ReturnType<NonNullable<BudgetRepository['getBudgetMonth']>>>;
type BudgetAllocations = Awaited<ReturnType<NonNullable<BudgetRepository['getBudgetAllocations']>>>;

export function buildBudgetCategoryRows(
  budget: BudgetMonth,
  categories: readonly BudgetCategory[],
  allocations: BudgetAllocations | null,
  allocationSourceAvailable: boolean,
  includeHidden: boolean,
) {
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const allocationsByCategory = new Map((allocations ?? []).map((allocation) => [allocation.categoryId, allocation.amountMinor]));
  return budget.categoryGroups.flatMap((group) =>
    (group.categories ?? []).map((category) => {
      const metadata = categoriesById.get(category.id);
      const explicitAllocation = allocationsByCategory.get(category.id);
      const budgetedMinor = allocationSourceAvailable
        ? (explicitAllocation ?? 0)
        : category.budgeted === undefined || category.budgeted === null ? null : category.budgeted;
      const spentMinor = category.spent === undefined || category.spent === null
        ? null : Math.abs(category.spent);
      const availableMinor = category.balance === undefined || category.balance === null
        ? null : category.balance;
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
  ).filter((category) => includeHidden || !category.hidden);
}
