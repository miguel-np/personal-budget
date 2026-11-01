import * as ActualApiNamespace from '@actual-app/api';
import type { BudgetAllocation } from '@personal-budget/finance-core';
import type { ActualApiContract } from './actual-api-contract.js';

type BudgetAllocationRow = { readonly category: string; readonly amount: number };
type BudgetQueryResult = { readonly data?: readonly BudgetAllocationRow[] };

/**
 * Builds the official SDK-backed contract for the adapter.
 *
 * The optional getBudgetAllocations capability is implemented with Actual's AQL
 * query language and lives here, inside the adapter package, so no consumer
 * outside this boundary needs to know the provider's query dialect or the SDK
 * namespace. The injected namespace keeps the factory testable.
 */
export function createActualApiContract(
  namespace: typeof ActualApiNamespace = ActualApiNamespace,
): ActualApiContract {
  const api = Object.create(namespace) as ActualApiContract;
  api.getBudgetAllocations = async (month: string): Promise<readonly BudgetAllocation[]> => {
    const monthId = Number(month.replace('-', ''));
    const [zeroBudgetRaw, trackingBudgetRaw] = await Promise.all([
      namespace.aqlQuery(namespace.q('zero_budgets').filter({ month: monthId }).select(['category', 'amount'])),
      namespace.aqlQuery(namespace.q('reflect_budgets').filter({ month: monthId }).select(['category', 'amount'])),
    ]);
    const rows = [
      ...((zeroBudgetRaw as BudgetQueryResult).data ?? []),
      ...((trackingBudgetRaw as BudgetQueryResult).data ?? []),
    ];
    return rows.map((row) => ({ categoryId: row.category, amountMinor: row.amount }));
  };
  return api;
}
