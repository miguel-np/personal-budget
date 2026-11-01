import type {
  BudgetAccount, BudgetCategory, BudgetMonthRecord, BudgetRepository, BudgetTransaction,
  ImportRecord, ImportResult, TransactionCategoryBatchResult, TransactionWriteResult,
} from './domain.js';

/** Minimal structural test-runner contract so the suite stays framework-free. */
export interface ConformanceTestRunner {
  readonly describe: (name: string, fn: () => void) => void;
  readonly it: (name: string, fn: () => Promise<void> | void) => void;
  readonly expect: (actual: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: unknown): void;
    toHaveLength(expected: number): void;
    readonly not: { toContain(value: unknown): void };
    readonly rejects: { toMatchObject(expected: unknown): Promise<void> };
  };
}

export interface RepositoryConformanceOptions {
  /** Human-readable provider name used in the suite title. */
  readonly repositoryName: string;
  /** Builds a fresh repository instance serving conformanceFixture. */
  readonly createRepository: () => Promise<BudgetRepository>;
}

/**
 * Shared synthetic dataset every conforming provider must serve. Amounts are
 * integer minor units; dates are civil YYYY-MM-DD strings. The dataset includes
 * income/expense rows, a linked transfer pair across accounts and a split parent
 * with children, so readers, writers and adapters exercise the same edge cases.
 */
export const conformanceFixture = {
  accounts: [
    { id: 'acct-eur', name: 'Cuenta principal', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 123_456 },
    { id: 'acct-savings', name: 'Ahorro', currencyCode: 'EUR', closed: false, offBudget: true, currentBalanceMinor: 50_000 },
    { id: 'acct-closed', name: 'Cuenta cerrada', currencyCode: 'EUR', closed: true, offBudget: false, currentBalanceMinor: 0 },
  ] as const satisfies readonly BudgetAccount[],
  categories: [
    { id: 'salary', name: 'Salario', groupId: 'income', isIncome: true },
    { id: 'food', name: 'Alimentación', groupId: 'expenses', isIncome: false },
  ] as const satisfies readonly BudgetCategory[],
  transactions: [
    { id: 't-1', account: 'acct-eur', currencyCode: 'EUR', date: '2026-10-01', amount: 250_000, category: 'salary' },
    { id: 't-2', account: 'acct-eur', currencyCode: 'EUR', date: '2026-10-02', amount: -1_234, category: 'food' },
    { id: 't-3', account: 'acct-eur', currencyCode: 'EUR', date: '2026-10-05', amount: -5_000, transfer_id: 't-4' },
    { id: 't-4', account: 'acct-savings', currencyCode: 'EUR', date: '2026-10-05', amount: 5_000, transfer_id: 't-3' },
    {
      id: 't-5', account: 'acct-eur', currencyCode: 'EUR', date: '2026-10-10', amount: -9_999, is_parent: true, category: 'food',
      subtransactions: [
        { id: 't-5a', account: 'acct-eur', currencyCode: 'EUR', date: '2026-10-10', amount: -4_000, category: 'food' },
        { id: 't-5b', account: 'acct-eur', currencyCode: 'EUR', date: '2026-10-10', amount: -5_999, category: 'food' },
      ],
    },
  ] as const satisfies readonly BudgetTransaction[],
} as const;

/**
 * Reusable provider conformance suite. Any adapter (current or future) can be
 * validated by serving conformanceFixture and calling runRepositoryConformance
 * with its test framework's describe/it/expect. The suite only exercises
 * capabilities the repository actually declares; it never requires an optional
 * method to exist and never simulates provider capabilities.
 */
export function runRepositoryConformance(runner: ConformanceTestRunner, options: RepositoryConformanceOptions): void {
  const { describe, it, expect } = runner;
  const createRepository = async (): Promise<BudgetRepository> => options.createRepository();

  describe('provider conformance: ' + options.repositoryName, () => {
    it('exposes accounts with explicit closure, off-budget and minor-unit balances', async () => {
      const repository = await createRepository();
      expect(repository.isConfigured).toBe(true);
      const accounts = await repository.listAccounts();
      expect(accounts).toHaveLength(conformanceFixture.accounts.length);
      for (const expected of conformanceFixture.accounts) {
        const account = accounts.find((item) => item.id === expected.id);
        expect(Boolean(account)).toBe(true);
        expect(account).toEqual(expected);
        expect(Number.isSafeInteger(account?.currentBalanceMinor ?? 0)).toBe(true);
      }
      expect(accounts.find((account) => account.id === 'acct-closed')?.closed).toBe(true);
    });

    it('lists categories with income semantics', async () => {
      const repository = await createRepository();
      const categories = await repository.listCategories();
      expect(categories.map((item) => item.id).sort()).toEqual(['food', 'salary']);
      expect(categories.find((item) => item.id === 'salary')?.isIncome).toBe(true);
      expect(categories.find((item) => item.id === 'food')?.isIncome).toBe(false);
    });

    it('returns transactions in deterministic order with civil dates and integer minor units', async () => {
      const repository = await createRepository();
      const rows = await repository.listTransactions('acct-eur', '2026-10-01', '2026-10-31');
      expect(rows.map((row) => row.id)).toEqual(['t-1', 't-2', 't-3', 't-5']);
      for (const row of rows) {
        expect(/^\d{4}-\d{2}-\d{2}$/.test(String(row.date))).toBe(true);
        expect(Number.isSafeInteger(row.amount)).toBe(true);
        if (row.currencyCode !== undefined && row.currencyCode !== null) {
          expect(/^[A-Z]{3}$/.test(String(row.currencyCode))).toBe(true);
        }
      }
    });

    it('preserves transfer pairing and split structure', async () => {
      const repository = await createRepository();
      const rows = await repository.listTransactions('acct-eur', '2026-10-05', '2026-10-05');
      expect(rows.find((row) => row.id === 't-3')?.transfer_id).toBe('t-4');
      const savingsRows = await repository.listTransactions('acct-savings', '2026-10-05', '2026-10-05');
      expect(savingsRows.find((row) => row.id === 't-4')?.transfer_id).toBe('t-3');
      const all = await repository.listTransactions('acct-eur', '2026-10-10', '2026-10-10');
      const parent = all.find((row) => row.id === 't-5');
      expect(parent?.is_parent).toBe(true);
      expect(parent?.subtransactions).toHaveLength(2);
      const children = parent?.subtransactions ?? [];
      expect(children.reduce((sum, child) => sum + child.amount, 0)).toBe(parent?.amount);
      for (const child of children) expect(Number.isSafeInteger(child.amount)).toBe(true);
    });

    it('rejects invalid date ranges with the domain error taxonomy instead of returning empty data', async () => {
      const repository = await createRepository();
      await expect(repository.listTransactions('acct-eur', '2026-02-30', '2026-03-02'))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(repository.listTransactions('acct-eur', '2026-10-31', '2026-10-01'))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('surfaces partial batch conflicts explicitly without claiming success', async () => {
      const repository = await createRepository();
      if (typeof repository.updateTransactionCategoriesBatch !== 'function') return;
      const outcome = await repository.updateTransactionCategoriesBatch([{
        transactionId: 't-2', accountId: 'acct-eur', date: '2026-10-02',
        categoryId: 'salary', expectedCategoryId: 'salary',
      }]);
      expect(outcome.updatedTransactionIds).not.toContain('t-2');
      expect(outcome.conflictTransactionId).toBe('t-2');
      expect(outcome.persisted).toBe(true);
      const rows = await repository.listTransactions('acct-eur', '2026-10-02', '2026-10-02');
      expect(rows.find((row) => row.id === 't-2')?.category).toBe('food');
    });

    it('never reports verified persistence that cannot be confirmed', async () => {
      const repository = await createRepository();
      if (typeof repository.updateTransactionSafely !== 'function') return;
      const outcome = await repository.updateTransactionSafely('missing-tx', 'acct-eur', '2026-10-02', { category: 'food' });
      expect(outcome.verified).toBe(false);
      expect(outcome.persisted).toBe(false);
    });

    it('keeps imports dry by default and persists only on explicit opt-in', async () => {
      const repository = await createRepository();
      if (typeof repository.importTransactions !== 'function') return;
      const record: ImportRecord = { date: '2026-10-15', amount: -777, payee_name: 'Conformance probe' };
      const preview = await repository.importTransactions('acct-eur', [record]);
      expect(preview.added).toEqual([]);
      let rows = await repository.listTransactions('acct-eur', '2026-10-15', '2026-10-15');
      expect(rows.some((row) => row.amount === -777)).toBe(false);
      const persisted = await repository.importTransactions('acct-eur', [record], { dryRun: false });
      expect(persisted.added).toHaveLength(1);
      rows = await repository.listTransactions('acct-eur', '2026-10-15', '2026-10-15');
      expect(rows.some((row) => row.amount === -777)).toBe(true);
    });

    it('serves monthly budget records in integer minor units when the capability exists', async () => {
      const repository = await createRepository();
      if (typeof repository.getBudgetMonth !== 'function') return;
      const month = await repository.getBudgetMonth('2026-10');
      expect(month.month).toBe('2026-10');
      for (const group of month.categoryGroups) {
        for (const category of group.categories ?? []) {
          if (category.budgeted !== null && category.budgeted !== undefined) expect(Number.isSafeInteger(category.budgeted)).toBe(true);
          if (category.spent !== null && category.spent !== undefined) expect(Number.isSafeInteger(category.spent)).toBe(true);
        }
      }
    });
  });
}

/** Re-export the shared shapes for scenario authors. */
export type {
  BudgetMonthRecord, BudgetRepository, BudgetTransaction, ImportRecord, ImportResult,
  TransactionCategoryBatchResult, TransactionWriteResult,
};
