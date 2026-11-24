import type { BudgetCategory, BudgetRepository } from '@personal-budget/finance-core';

type BudgetMonth = Awaited<ReturnType<NonNullable<BudgetRepository['getBudgetMonth']>>>;
type BudgetAllocations = Awaited<ReturnType<NonNullable<BudgetRepository['getBudgetAllocations']>>>;

interface CategoryGroup {
  readonly id: string;
  readonly name: string;
  readonly is_income?: boolean | null;
  readonly hidden?: boolean | null;
}

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly hidden?: boolean | null;
  readonly budgeted?: number | null;
  readonly spent?: number | null;
  readonly balance?: number | null;
  readonly carryover?: boolean | null;
}

function budgetState(
  category: CategoryRow,
  explicitAllocation: number | undefined,
  allocationSourceAvailable: boolean,
): { readonly budgetedMinor: number | null; readonly state: string } {
  if (allocationSourceAvailable) {
    return {
      budgetedMinor: explicitAllocation ?? 0,
      state: explicitAllocation === undefined ? 'unbudgeted'
        : explicitAllocation === 0 ? 'zero' : 'budgeted',
    };
  }
  if (category.budgeted === undefined) return { budgetedMinor: null, state: 'unbudgeted' };
  if (category.budgeted === null) return { budgetedMinor: null, state: 'unknown' };
  return {
    budgetedMinor: category.budgeted,
    state: category.budgeted === 0 ? 'zero' : 'budgeted',
  };
}

function presentBudgetCategory(
  group: CategoryGroup,
  category: CategoryRow,
  metadata: BudgetCategory | undefined,
  explicitAllocation: number | undefined,
  allocationSourceAvailable: boolean,
) {
  const budget = budgetState(category, explicitAllocation, allocationSourceAvailable);
  const spentMinor = category.spent === undefined || category.spent === null
    ? null : Math.abs(category.spent);
  const availableMinor = category.balance === undefined || category.balance === null
    ? null : category.balance;
  return {
    categoryId: category.id,
    categoryName: metadata?.name ?? category.name,
    groupId: group.id,
    groupName: group.name,
    isIncome: group.is_income ?? metadata?.isIncome ?? false,
    hidden: category.hidden ?? group.hidden ?? false,
    budgetedMinor: budget.budgetedMinor,
    spentMinor,
    availableMinor,
    percentUsed: budget.budgetedMinor === null || budget.budgetedMinor === 0 || spentMinor === null
      ? null : (spentMinor / budget.budgetedMinor) * 100,
    carryover: category.carryover ?? null,
    state: budget.state,
  };
}

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
    (group.categories ?? []).map((category) => presentBudgetCategory(
      group, category, categoriesById.get(category.id),
      allocationsByCategory.get(category.id), allocationSourceAvailable,
    )),
  ).filter((category) => includeHidden || !category.hidden);
}
