import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { conformanceFixture, runRepositoryConformance } from '@personal-budget/finance-core';
import type { BudgetTransaction } from '@personal-budget/finance-core';
import { ActualBudgetAdapter } from '../src/actual-budget-adapter.js';
import type { ActualApiContract } from '../src/actual-api-contract.js';

/**
 * Runs the shared provider conformance suite against the real
 * ActualBudgetAdapter over a synthetic SDK contract, proving that the adapter
 * satisfies the domain boundary without touching the official client.
 */
const rows: BudgetTransaction[] = conformanceFixture.transactions.map((row) => structuredClone(row) as BudgetTransaction);

function createApi(): ActualApiContract {
  return {
    init: vi.fn(async () => undefined),
    downloadBudget: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    getAccounts: vi.fn(async () => conformanceFixture.accounts.map((account) => ({
      id: account.id, name: account.name, closed: account.closed, offbudget: account.offBudget,
      balance_current: account.currentBalanceMinor, currency: account.currencyCode,
    }))),
    getCategories: vi.fn(async () => conformanceFixture.categories.map((category) => ({
      id: category.id, name: category.name, group_id: category.groupId, is_income: category.isIncome,
    }))),
    getTransactions: vi.fn(async (accountId: string, startDate: string, endDate: string) =>
      rows.filter((row) => row.account === accountId && row.date >= startDate && row.date <= endDate)),
    updateTransaction: vi.fn(async (id: string, fields: Record<string, unknown>) => {
      const existing = rows.find((row) => row.id === id);
      if (existing) Object.assign(existing, fields);
    }),
    importTransactions: vi.fn(async (accountId: string, records: readonly { readonly date: string; readonly amount: number; readonly imported_payee?: string }[], options?: { readonly dryRun?: boolean }) => {
      const dryRun = options?.dryRun ?? true;
      if (dryRun) return { errors: [], added: [], updated: [] };
      const added: string[] = [];
      for (const record of records) {
        const id = 'imported-' + record.date + '-' + rows.length;
        rows.push({ id, account: accountId, currencyCode: null, date: record.date, amount: record.amount, imported_payee: record.imported_payee ?? null });
        added.push(id);
      }
      return { errors: [], added, updated: [] };
    }),
    getBudgetMonth: vi.fn(async (month: string) => ({
      month,
      totalBudgeted: 12_000, totalSpent: -3_500, totalBalance: 8_500,
      categoryGroups: [{ id: 'expenses', name: 'Gastos', is_income: false, categories: [
        { id: 'food', name: 'Alimentación', budgeted: 12_000, spent: -3_500, balance: 8_500 },
      ] }],
    })),
  };
}

const config = { serverURL: 'http://127.0.0.1:5006', dataDir: resolve(tmpdir(), 'personal-budget-conformance-tests'), budgetId: 'budget-uuid' };

runRepositoryConformance({ describe, it, expect }, {
  repositoryName: 'ActualBudgetAdapter over a synthetic SDK contract',
  createRepository: async () => new ActualBudgetAdapter(config, createApi()),
});
