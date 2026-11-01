import { describe, expect, it } from 'vitest';
import { BudgetRepositoryError } from '../src/domain.js';
import { validatePeriod } from '../src/date-range.js';
import { conformanceFixture, runRepositoryConformance } from '../src/repository-conformance.js';
import type { BudgetAccount, BudgetCategory, BudgetMonthRecord, BudgetRepository, BudgetTransaction, ImportRecord, ImportResult, TransactionCategoryBatchChange, TransactionCategoryBatchResult, TransactionWriteResult } from '../src/domain.js';

/**
 * Reference implementation of BudgetRepository used to prove the conformance
 * suite is provider-independent and to document the expected read/write
 * semantics with a dependency-free provider.
 */
function createInMemoryRepository(): BudgetRepository {
  const accounts: BudgetAccount[] = conformanceFixture.accounts.map((account) => ({ ...account }));
  const categories: BudgetCategory[] = conformanceFixture.categories.map((category) => ({ ...category }));
  const transactions: BudgetTransaction[] = conformanceFixture.transactions.map((row) => structuredClone(row) as BudgetTransaction);

  const find = (accountId: string, startDate: string, endDate: string): readonly BudgetTransaction[] =>
    transactions.filter((row) => row.account === accountId && row.date >= startDate && row.date <= endDate);

  return {
    isConfigured: true,
    listAccounts: async () => accounts,
    listCategories: async () => categories,
    listTransactions: async (accountId, startDate, endDate) => {
      try {
        validatePeriod({ startDate, endDate });
      } catch {
        throw new BudgetRepositoryError('INVALID_INPUT', 'Date range is invalid.');
      }
      return find(accountId, startDate, endDate);
    },
    updateTransactionSafely: async (transactionId, _accountId, _beforeDate, fields): Promise<TransactionWriteResult> => {
      const existing = transactions.find((row) => row.id === transactionId);
      if (!existing) return { persisted: false, verified: false };
      Object.assign(existing, fields);
      return { persisted: true, verified: true };
    },
    updateTransactionCategoriesBatch: async (changes: readonly TransactionCategoryBatchChange[]): Promise<TransactionCategoryBatchResult> => {
      if (changes.length === 0) throw new BudgetRepositoryError('INVALID_INPUT', 'Category batch is invalid.');
      const ids = new Set<string>();
      for (const change of changes) {
        if (ids.has(change.transactionId)) throw new BudgetRepositoryError('INVALID_INPUT', 'Category batch contains duplicate transaction ids.');
        ids.add(change.transactionId);
      }
      for (const change of changes) {
        const before = transactions.find((row) => row.id === change.transactionId);
        if (!before) return { requested: changes.length, updatedTransactionIds: [], failedTransactionId: change.transactionId, persisted: true };
        if ((before.category ?? null) !== change.expectedCategoryId) {
          return { requested: changes.length, updatedTransactionIds: [], failedTransactionId: change.transactionId, conflictTransactionId: change.transactionId, persisted: true };
        }
      }
      const updatedTransactionIds: string[] = [];
      for (const change of changes) {
        const index = transactions.findIndex((row) => row.id === change.transactionId);
        const before = index >= 0 ? transactions[index] : undefined;
        if (!before) return { requested: changes.length, updatedTransactionIds, failedTransactionId: change.transactionId, persisted: true };
        if ((before.category ?? null) !== change.expectedCategoryId) {
          return { requested: changes.length, updatedTransactionIds, failedTransactionId: change.transactionId, conflictTransactionId: change.transactionId, persisted: true };
        }
        transactions[index] = { ...before, category: change.categoryId };
        updatedTransactionIds.push(change.transactionId);
      }
      return { requested: changes.length, updatedTransactionIds, persisted: true };
    },
    importTransactions: async (accountId, records: readonly ImportRecord[], options): Promise<ImportResult> => {
      const dryRun = options?.dryRun ?? true;
      if (dryRun) return { errors: [], added: [], updated: [] };
      const added: string[] = [];
      for (const record of records) {
        const id = 'imported-' + record.date + '-' + transactions.length;
        transactions.push({ id, account: accountId, currencyCode: null, date: record.date, amount: record.amount, ...(record.payee_name ? { imported_payee: record.payee_name } : {}) });
        added.push(id);
      }
      return { errors: [], added, updated: [] };
    },
    getBudgetMonth: async (month: string): Promise<BudgetMonthRecord> => ({
      month,
      totalBudgeted: 12_000, totalSpent: -3_500, totalBalance: 8_500, totalIncome: 250_000,
      categoryGroups: [{ id: 'expenses', name: 'Gastos', is_income: false, categories: [
        { id: 'food', name: 'Alimentación', budgeted: 12_000, spent: -3_500, balance: 8_500 },
      ] }],
    }),
  };
}

runRepositoryConformance({ describe, it, expect }, { repositoryName: 'in-memory reference provider', createRepository: async () => createInMemoryRepository() });

describe('in-memory reference provider', () => {
  it('rejects empty category batch entries with the domain taxonomy', async () => {
    const repository = createInMemoryRepository();
    await expect(repository.updateTransactionCategoriesBatch?.([]))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('splits preserve child amounts when read back', async () => {
    const repository = createInMemoryRepository();
    const rows = await repository.listTransactions('acct-eur', '2026-10-10', '2026-10-10');
    const parent = rows.find((row) => row.id === 't-5');
    expect(parent?.subtransactions?.map((child) => child.id)).toEqual(['t-5a', 't-5b']);
  });
});
