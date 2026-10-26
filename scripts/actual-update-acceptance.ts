import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface AcceptanceTransaction {
  readonly id: string;
  readonly date: string;
  readonly amount: number;
}
interface AcceptanceCategory {
  readonly id: string;
  readonly name: string;
}
interface AcceptanceFixture {
  readonly syncId: string;
  readonly accountId: string;
  readonly transactionIds: readonly string[];
  readonly transactions: readonly AcceptanceTransaction[];
  readonly categories: readonly AcceptanceCategory[];
  readonly transactionBalanceMinor: number;
}
interface ActualBudgetListing {
  readonly name?: string;
  readonly groupId?: string;
  readonly cloudFileId?: string;
}
interface ActualApiClient {
  init(options: { readonly dataDir: string; readonly serverURL: string; readonly password?: string }): Promise<void>;
  shutdown(): Promise<void>;
  runImport(name: string, callback: () => Promise<void>): Promise<void>;
  createAccount(account: { readonly name: string; readonly offbudget?: boolean }): Promise<string>;
  addTransactions(accountId: string, transactions: readonly Record<string, unknown>[]): Promise<unknown>;
  getBudgets(): Promise<readonly ActualBudgetListing[]>;
  downloadBudget(syncId: string): Promise<void>;
  getAccounts(): Promise<readonly { readonly id: string; readonly name: string }[]>;
  getCategories(): Promise<readonly { readonly id: string; readonly name: string }[]>;
  getTransactions(accountId: string, startDate: string, endDate: string): Promise<readonly { readonly id: string; readonly date: string; readonly amount: number }[]>;
  sync(): Promise<void>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiPackageDirectory = resolve(process.env.ACTUAL_API_PACKAGE_DIR ?? root);
const apiRequire = createRequire(join(apiPackageDirectory, '__actual_api_loader.cjs'));
const ActualApiNamespace = await import(pathToFileURL(apiRequire.resolve('@actual-app/api')).href);
const api = ActualApiNamespace as unknown as ActualApiClient;
const acceptanceDir = join(root, '.local', 'update-acceptance');
const fixturePath = join(acceptanceDir, 'expected-inventory.json');
const seedCache = join(acceptanceDir, 'seed-cache');
const verifyCache = join(acceptanceDir, 'verify-cache');
const serverURL = process.env.ACTUAL_SERVER_URL ?? 'http://127.0.0.1:5006';
const serverPassword = process.env.ACTUAL_SERVER_PASSWORD;
const budgetName = 'Personal Budget Synthetic Update Acceptance';
const accountName = 'Cuenta sintética de actualización';
const sourceTransactions = [
  { date: '2026-01-05', amount: 150_000, payee: 'Ingreso sintético' },
  { date: '2026-01-08', amount: -3_200, payee: 'Gasto sintético A' },
  { date: '2026-01-11', amount: -7_800, payee: 'Gasto sintético B' },
] as const;

async function seed(): Promise<void> {
  await mkdir(acceptanceDir, { recursive: true, mode: 0o700 });
  await rm(seedCache, { recursive: true, force: true });
  await mkdir(seedCache, { recursive: true, mode: 0o700 });
  let accountId = '';
  let transactionIds: readonly string[] = [];
  let seededTransactions: readonly AcceptanceTransaction[] = [];
  await api.init({ dataDir: seedCache, serverURL, ...(serverPassword ? { password: serverPassword } : {}) });
  try {
    await api.runImport(budgetName, async () => {
      accountId = await api.createAccount({ name: accountName, offbudget: false });
      await api.addTransactions(accountId, sourceTransactions.map((transaction) => ({
        date: transaction.date,
        amount: transaction.amount,
        payee: transaction.payee,
      })));
      seededTransactions = await api.getTransactions(accountId, '2026-01-01', '2026-01-31');
      transactionIds = seededTransactions.map((transaction) => transaction.id);
    });
    await api.sync();
    const seededCategories = await api.getCategories();
    const budgets = await api.getBudgets();
    const listing = budgets.find((budget) => budget.name === budgetName &&
      (typeof budget.groupId === 'string' || typeof budget.cloudFileId === 'string'));
    const syncId = listing?.groupId ?? listing?.cloudFileId;
    if (!syncId || !accountId || transactionIds.length !== sourceTransactions.length) {
      throw new Error('Synthetic update budget was created but its remote Sync ID or expected inventory could not be resolved.');
    }
    const expected: AcceptanceFixture = {
      syncId, accountId, transactionIds,
      // Capture the actual persisted representation. Actual may normalize fields during import;
      // the acceptance target is preservation across the version transition, not import behavior.
      transactions: seededTransactions.map((transaction) => ({
        id: transaction.id, date: transaction.date, amount: transaction.amount,
      })),
      categories: seededCategories.map((category) => ({ id: category.id, name: category.name })).sort((a, b) => a.id.localeCompare(b.id)),
      transactionBalanceMinor: seededTransactions.reduce((sum, transaction) => sum + transaction.amount, 0),
    };
    await writeFile(fixturePath, JSON.stringify(expected, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write('Synthetic acceptance budget seeded: 1 account, ' + transactionIds.length + ' transactions.\n');
  } finally {
    await api.shutdown().catch(() => undefined);
  }
}

async function verify(): Promise<void> {
  const expected = JSON.parse(await readFile(fixturePath, 'utf8')) as AcceptanceFixture;
  await rm(verifyCache, { recursive: true, force: true });
  // @actual-app/api expects its local data directory to exist before init.
  // Keep verification isolated from the seed cache so each check downloads a fresh copy.
  await mkdir(verifyCache, { recursive: true, mode: 0o700 });
  await api.init({ dataDir: verifyCache, serverURL, ...(serverPassword ? { password: serverPassword } : {}) });
  try {
    await api.downloadBudget(expected.syncId);
    await api.sync();
    const accounts = await api.getAccounts();
    const account = accounts.find((candidate) => candidate.name === accountName);
    if (!account) throw new Error('The synthetic account is missing after the server update or data restore.');
    if (account.id !== expected.accountId) throw new Error('The synthetic account ID changed during update or recovery.');
    const categories = (await api.getCategories()).map((category) => ({ id: category.id, name: category.name })).sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(categories) !== JSON.stringify(expected.categories)) {
      throw new Error('Synthetic category IDs or names changed after update/recovery; expected ' +
        expected.categories.length + ', got ' + categories.length + '.');
    }
    const actual = await api.getTransactions(account.id, '2026-01-01', '2026-01-31');
    const expectedIds = [...expected.transactionIds].sort();
    const actualIds = actual.map((transaction) => transaction.id).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      throw new Error('Synthetic transaction IDs differ after update or recovery; expected ' + expectedIds.length + ', got ' + actualIds.length + '.');
    }
    for (const item of expected.transactions) {
      const found = actual.find((transaction) => transaction.id === item.id);
      if (!found || found.date !== item.date || found.amount !== item.amount) {
        throw new Error('A synthetic transaction changed during update/recovery: ' + item.id +
          '; expected date=' + item.date + ', amount=' + item.amount +
          '; actual date=' + (found?.date ?? 'missing') + ', amount=' + (found?.amount ?? 'missing') + '.');
      }
    }
    const actualBalance = actual.reduce((sum, transaction) => sum + transaction.amount, 0);
    if (actualBalance !== expected.transactionBalanceMinor) {
      throw new Error('The synthetic transaction-derived balance changed during update/recovery.');
    }
    process.stdout.write('SYNTHETIC_INVENTORY_OK: account ID, ' + categories.length +
      ' categories, ' + actual.length + ' transaction IDs/dates/amounts, and transaction-derived balance are identical.\\n');
  } finally {
    await api.shutdown().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'seed') return seed();
  if (action === 'verify') return verify();
  throw new Error('Choose seed or verify.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Synthetic update acceptance failed.';
    process.stderr.write('Synthetic Actual update acceptance failed: ' + message + '\n');
    process.exitCode = 1;
  });
}
