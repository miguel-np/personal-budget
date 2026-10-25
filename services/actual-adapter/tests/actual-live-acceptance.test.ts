import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ActualApiNamespace from '@actual-app/api';
import { ActualBudgetAdapter } from '../src/actual-budget-adapter.js';
import type { ActualApiContract } from '../src/actual-api-contract.js';

const serverURL = process.env.ACTUAL_SERVER_URL;
const budgetId = process.env.ACTUAL_BUDGET_ID;
const enabled = process.env.PERSONAL_BUDGET_RUN_ACTUAL_ACCEPTANCE === '1' && Boolean(serverURL && budgetId);

describe.skipIf(!enabled)('Actual Budget live acceptance (read-only)', () => {
  const dataDir = process.env.ACTUAL_DATA_DIR ?? './.local/actual-api-acceptance';
  const adapter = new ActualBudgetAdapter({
    serverURL: serverURL ?? 'http://127.0.0.1:5006',
    dataDir,
    ...(budgetId ? { budgetId } : {}),
    ...(process.env.ACTUAL_SERVER_PASSWORD ? { password: process.env.ACTUAL_SERVER_PASSWORD } : {}),
  }, ActualApiNamespace as unknown as ActualApiContract);

  beforeAll(() => {
    expect(serverURL).toBeTruthy();
    expect(budgetId).toBeTruthy();
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('connects to the configured budget and reads its accounts and categories', async () => {
    const [accounts, categories] = await Promise.all([
      adapter.listAccounts(),
      adapter.listCategories(),
    ]);
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.every((account) => Boolean(account.id && account.name))).toBe(true);
    expect(Array.isArray(categories)).toBe(true);

    const firstAccount = accounts.find((account) => !account.closed);
    expect(firstAccount).toBeDefined();
    if (!firstAccount) return;

    const transactions = await adapter.listTransactions(firstAccount.id, '2026-01-01', '2026-12-31');
    expect(Array.isArray(transactions)).toBe(true);
    expect(transactions.every((transaction) => transaction.account === firstAccount.id)).toBe(true);
  });
});
