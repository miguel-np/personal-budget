import * as ActualApiNamespace from '@actual-app/api';
import type { BudgetAllocation } from '@personal-budget/finance-core';
import type { ActualApiContract } from './actual-api-contract.js';

type BudgetAllocationRow = { readonly category: string; readonly amount: number };
type BudgetQueryResult = { readonly data?: readonly BudgetAllocationRow[] };

/**
 * Builds the official SDK-backed contract for the adapter.
 *
 * Only SDK methods used by the adapter are read. Avoid enumerating the module
 * namespace: SDK namespace exports are live read-only bindings, and evaluating
 * unrelated getters is unnecessary and can make startup depend on SDK internals.
 */
export function createActualApiContract(
  namespace: typeof ActualApiNamespace = ActualApiNamespace,
): ActualApiContract {
  const api = {
    init: namespace.init,
    downloadBudget: namespace.downloadBudget,
    sync: namespace.sync,
    shutdown: namespace.shutdown,
    getAccounts: namespace.getAccounts,
    getCategories: namespace.getCategories,
    getTransactions: namespace.getTransactions,
    importTransactions: namespace.importTransactions,
    ...(namespace.getPayees ? { getPayees: namespace.getPayees } : {}),
    ...(namespace.getBudgetMonth ? { getBudgetMonth: namespace.getBudgetMonth } : {}),
    ...(namespace.setBudgetAmount ? { setBudgetAmount: namespace.setBudgetAmount } : {}),
    ...(namespace.updateTransaction ? { updateTransaction: namespace.updateTransaction } : {}),
    getBudgetAllocations: async (month: string): Promise<readonly BudgetAllocation[]> => {
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
    },
  } as unknown as ActualApiContract;
  return api;
}
