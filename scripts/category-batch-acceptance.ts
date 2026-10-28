import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ActualApiNamespace from '@actual-app/api';
import type { BudgetTransaction, TransactionCategoryBatchChange } from '@personal-budget/finance-core';
import { ActualBudgetAdapter } from '../services/actual-adapter/src/actual-budget-adapter.js';
import type { ActualAdapterConfig, ActualApiContract } from '../services/actual-adapter/src/actual-api-contract.js';

interface AcceptanceFixture {
  readonly syncId: string;
  readonly accountId: string;
  readonly transactionIds: readonly string[];
  readonly transactions: readonly { readonly id: string; readonly date: string; readonly amount: number }[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(root, '.local', 'update-acceptance', 'expected-inventory.json');
const dataDir = join(root, '.local', 'category-batch-acceptance');
const serverURL = process.env.ACTUAL_SERVER_URL ?? 'http://127.0.0.1:5006';
const serverPassword = process.env.ACTUAL_SERVER_PASSWORD;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function categoryOf(transaction: BudgetTransaction): string | null {
  return transaction.category ?? null;
}

function byId(transactions: readonly BudgetTransaction[], id: string): BudgetTransaction {
  const transaction = transactions.find((candidate) => candidate.id === id);
  assert(transaction, 'Expected synthetic transaction was not returned by Actual.');
  return transaction;
}

async function main(): Promise<void> {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as AcceptanceFixture;
  assert(fixture.syncId && fixture.accountId && fixture.transactionIds.length >= 3,
    'Synthetic update acceptance fixture is incomplete.');

  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const config: ActualAdapterConfig = {
    serverURL,
    dataDir,
    budgetId: fixture.syncId,
    ...(serverPassword ? { password: serverPassword } : {}),
  };
  const adapter = new ActualBudgetAdapter(config, ActualApiNamespace as unknown as ActualApiContract);
  try {
    const accounts = await adapter.listAccounts();
    assert(accounts.some((account) => account.id === fixture.accountId),
      'Synthetic source account is missing from the live Actual budget.');

    // Create an isolated expense group and destination category. The fixture must not
    // depend on any default categories or automatic category learning in Actual.
    const categoryWriter = ActualApiNamespace as unknown as {
      createCategoryGroup(group: { readonly name: string }): Promise<string>;
      createCategory(category: { readonly name: string; readonly group_id: string }): Promise<string>;
      sync(): Promise<void>;
    };
    const suffix = randomUUID().slice(0, 8);
    const expenseGroupId = await categoryWriter.createCategoryGroup({
      name: 'Synthetic category batch group ' + suffix,
    });
    const targetCategoryId = await categoryWriter.createCategory({
      name: 'Synthetic category batch ' + suffix,
      group_id: expenseGroupId,
    });
    await categoryWriter.sync();
    const target = (await adapter.listCategories()).find((category) => category.id === targetCategoryId);
    assert(target && !target.isIncome, 'Actual did not persist the synthetic expense category.');

    const transactions = await adapter.listTransactions(fixture.accountId, '2026-01-01', '2026-01-31');
    const expenses = fixture.transactions
      .filter((item) => item.amount < 0)
      .map((item) => byId(transactions, item.id));
    assert(expenses.length >= 2, 'At least two synthetic expense transactions are required for batch acceptance.');
    assert(expenses.every((transaction) => categoryOf(transaction) !== targetCategoryId),
      'The new synthetic category must differ from the starting category of every test transaction.');

    const [first, second] = expenses;
    assert(first && second, 'Synthetic batch rows are missing.');
    const staleExpectedCategory = categoryOf(second) === null ? target.id : null;
    assert(staleExpectedCategory !== categoryOf(second), 'Could not construct a guaranteed stale preview baseline.');

    const staleResult = await adapter.updateTransactionCategoriesBatch([
      {
        transactionId: first.id, categoryId: target.id, accountId: fixture.accountId,
        date: first.date, expectedCategoryId: categoryOf(first),
      },
      {
        transactionId: second.id, categoryId: target.id, accountId: fixture.accountId,
        date: second.date, expectedCategoryId: staleExpectedCategory,
      },
    ]);
    assert(staleResult.updatedTransactionIds.length === 0,
      'A stale item in the batch must prevent every write, not partially apply the first item.');
    assert(staleResult.conflictTransactionId === second.id,
      'The stale preflight must identify the conflicting synthetic transaction.');

    const afterPreflight = await adapter.listTransactions(fixture.accountId, '2026-01-01', '2026-01-31');
    assert(categoryOf(byId(afterPreflight, first.id)) === categoryOf(first),
      'Preflight failure unexpectedly changed the first transaction.');
    assert(categoryOf(byId(afterPreflight, second.id)) === categoryOf(second),
      'Preflight failure unexpectedly changed the conflicting transaction.');

    const changes: TransactionCategoryBatchChange[] = expenses.slice(0, 2).map((transaction) => ({
      transactionId: transaction.id,
      categoryId: target.id,
      accountId: fixture.accountId,
      date: transaction.date,
      expectedCategoryId: categoryOf(transaction),
    }));
    const applied = await adapter.updateTransactionCategoriesBatch(changes);
    assert(applied.persisted === true &&
      JSON.stringify(applied.updatedTransactionIds) === JSON.stringify(changes.map((change) => change.transactionId)),
    'Actual did not confirm persistence of every synthetic category change in order.');

    // Retry with the target as the preview baseline: it must act as a verified no-op,
    // not issue duplicate writes after a client loses the original response.
    const retryChanges: TransactionCategoryBatchChange[] = changes.map((change) => ({
      ...change,
      expectedCategoryId: target.id,
    }));
    const retried = await adapter.updateTransactionCategoriesBatch(retryChanges);
    assert(retried.persisted === true &&
      JSON.stringify(retried.updatedTransactionIds) === JSON.stringify(retryChanges.map((change) => change.transactionId)),
    'A repeated category batch did not resolve as an idempotent verified success.');

    process.stdout.write('CATEGORY_BATCH_LIVE_OK: stale preflight made zero writes; successful batch persisted; retry was an idempotent no-op.\n');
  } finally {
    await adapter.close();
  }

  // Validate persisted state from a separate local client cache, not the writer's in-memory view.
  const verifyDir = join(root, '.local', 'category-batch-acceptance-verify');
  await rm(verifyDir, { recursive: true, force: true });
  await mkdir(verifyDir, { recursive: true, mode: 0o700 });
  const verifier = new ActualBudgetAdapter({ ...config, dataDir: verifyDir }, ActualApiNamespace as unknown as ActualApiContract);
  try {
    const rows = await verifier.listTransactions(fixture.accountId, '2026-01-01', '2026-01-31');
    const transactions = fixture.transactions.filter((item) => item.amount < 0).slice(0, 2);
    assert(transactions.length === 2, 'Synthetic acceptance fixture must contain two expenses.');
    const categories = await verifier.listCategories();
    const targetIds = new Set(categories.filter((category) =>
      transactions.every((item) => {
        const current = rows.find((row) => row.id === item.id);
        return current && categoryOf(current) === category.id;
      })).map((category) => category.id));
    assert(targetIds.size === 1,
      'Fresh Actual client could not verify that all synthetic batch changes persisted remotely.');
    process.stdout.write('CATEGORY_BATCH_SYNC_OK: category changes were visible after a fresh budget download.\n');
  } finally {
    await verifier.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Category batch acceptance failed.';
  process.stderr.write('Synthetic category batch acceptance failed: ' + message + '\n');
  process.exitCode = 1;
});
