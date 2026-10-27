import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface AcceptanceSubtransaction {
  readonly id: string;
  readonly account: string;
  readonly date: string;
  readonly amount: number;
  readonly parent_id?: string | null;
  readonly is_child?: boolean;
  readonly is_parent?: boolean;
  readonly category?: string | null;
  readonly notes?: string | null;
}
interface AcceptanceTransaction {
  readonly id: string;
  readonly date: string;
  readonly amount: number;
  readonly account?: string;
  readonly transfer_id?: string | null;
  readonly imported_id?: string | null;
  readonly notes?: string | null;
  readonly cleared?: boolean;
  readonly is_parent?: boolean;
  readonly subtransactions?: readonly AcceptanceSubtransaction[];
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
  addTransactions(accountId: string, transactions: readonly Record<string, unknown>[], runTransfers?: boolean, learnCategories?: boolean): Promise<readonly string[]>;
  importTransactions(accountId: string, transactions: readonly Record<string, unknown>[], options?: {
    readonly dryRun?: boolean;
    readonly defaultCleared?: boolean;
    readonly reimportDeleted?: boolean;
    readonly payeeNameNormalization?: 'title-case' | 'original';
  }): Promise<{ readonly errors: readonly unknown[]; readonly added: readonly string[]; readonly updated: readonly string[] }>;
  getBudgets(): Promise<readonly ActualBudgetListing[]>;
  downloadBudget(syncId: string): Promise<void>;
  getAccounts(): Promise<readonly { readonly id: string; readonly name: string }[]>;
  getCategories(): Promise<readonly { readonly id: string; readonly name: string }[]>;
  getPayees(): Promise<readonly { readonly id: string; readonly name: string; readonly transfer_acct?: string | null }[]>;
  getTransactions(accountId: string, startDate: string, endDate: string): Promise<readonly AcceptanceTransaction[]>;
  updateTransaction(transactionId: string, fields: Readonly<Record<string, unknown>>): Promise<unknown>;
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
const transactionCache = join(acceptanceDir, 'transaction-edit-cache');
const transactionVerifyCache = join(acceptanceDir, 'transaction-edit-verify-cache');
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

async function verifyLinkedTransactionEditing(): Promise<void> {
  const expected = JSON.parse(await readFile(fixturePath, 'utf8')) as AcceptanceFixture;
  await rm(transactionCache, { recursive: true, force: true });
  await mkdir(transactionCache, { recursive: true, mode: 0o700 });
  await api.init({ dataDir: transactionCache, serverURL, ...(serverPassword ? { password: serverPassword } : {}) });
  let sourceId = '';
  let counterpartId = '';
  let counterpartAccountId = '';
  let splitParentId = '';
  let splitChildIds: string[] = [];
  const sharedNotes = 'Nota compartida verificada';
  try {
    await api.downloadBudget(expected.syncId);
    await api.sync();
    const accounts = await api.getAccounts();
    const sourceAccount = accounts.find((candidate) => candidate.id === expected.accountId);
    if (!sourceAccount) throw new Error('Synthetic source account could not be downloaded for linked-edit acceptance.');

    counterpartAccountId = await api.createAccount({ name: 'Cuenta sintética contraparte ' + randomUUID().slice(0, 8), offbudget: false });
    await api.sync();
    const transferPayee = (await api.getPayees()).find((payee) => payee.transfer_acct === counterpartAccountId);
    if (!transferPayee) throw new Error('Actual did not expose a transfer payee for the synthetic counterpart account.');

    const transferImportId = 'synthetic-linked-transfer-' + randomUUID();
    const importedTransfer = await api.importTransactions(sourceAccount.id, [{
      date: '2026-09-01',
      amount: -4_200,
      payee_name: transferPayee.name,
      imported_id: transferImportId,
      notes: 'Nota inicial sintética',
      cleared: false,
    }], { dryRun: false, defaultCleared: false, reimportDeleted: false, payeeNameNormalization: 'original' });
    if (importedTransfer.errors.length > 0) throw new Error('Actual rejected the synthetic transfer import.');
    await api.sync();

    const transferPair = async (): Promise<{ source: AcceptanceTransaction; counterpart: AcceptanceTransaction }> => {
      const [sourceRows, counterpartRows] = await Promise.all([
        api.getTransactions(sourceAccount.id, '2026-09-01', '2026-09-30'),
        api.getTransactions(counterpartAccountId, '2026-09-01', '2026-09-30'),
      ]);
      const source = sourceRows.find((item) => item.imported_id === transferImportId);
      if (!source?.id) throw new Error('Actual did not persist the imported synthetic transfer source.');
      sourceId = source.id;
      if (!source.transfer_id) throw new Error('Actual did not link the imported synthetic transfer to the counterpart account.');
      counterpartId = source.transfer_id;
      const counterpart = counterpartRows.find((item) => item.id === counterpartId && item.transfer_id === sourceId);
      if (!counterpart) throw new Error('The synthetic transfer counterpart is missing or not linked reciprocally.');
      return { source, counterpart };
    };

    let pair = await transferPair();
    if (pair.source.amount !== -4_200 || pair.counterpart.amount !== 4_200) {
      throw new Error('Actual did not create a balanced synthetic transfer pair.');
    }
    await api.updateTransaction(sourceId, { amount: -5_100, notes: sharedNotes });
    await api.sync();
    await api.updateTransaction(counterpartId, { amount: 5_100, notes: sharedNotes });
    await api.sync();
    pair = await transferPair();
    if (pair.source.amount !== -5_100 || pair.counterpart.amount !== 5_100 ||
        pair.source.notes !== sharedNotes || pair.counterpart.notes !== sharedNotes) {
      throw new Error('Actual did not persist the explicit amount/note updates on both synthetic transfer legs.');
    }

    const counterpartOriginalDate = pair.counterpart.date;
    const independentDate = '2026-09-05';
    await api.updateTransaction(sourceId, { date: independentDate });
    await api.sync();
    pair = await transferPair();
    if (pair.source.date !== independentDate || pair.counterpart.date !== counterpartOriginalDate) {
      throw new Error('Changing one synthetic transfer date unexpectedly changed the counterpart date.');
    }
    await api.updateTransaction(counterpartId, { date: independentDate });
    await api.sync();
    pair = await transferPair();
    if (pair.source.date !== independentDate || pair.counterpart.date !== independentDate) {
      throw new Error('Explicit synthetic transfer date synchronization was not persisted on both sides.');
    }

    await api.updateTransaction(sourceId, { cleared: true });
    await api.sync();
    pair = await transferPair();
    if (!pair.source.cleared || Boolean(pair.counterpart.cleared)) {
      throw new Error('Synthetic transfer reconciliation status was not kept independent per account.');
    }

    splitParentId = randomUUID();
    splitChildIds = [randomUUID(), randomUUID()];
    await api.addTransactions(sourceAccount.id, [{
      id: splitParentId,
      date: '2026-09-10',
      amount: -7_000,
      payee_name: 'Compra dividida sintética',
      is_parent: true,
      subtransactions: [
        { id: splitChildIds[0], account: sourceAccount.id, date: '2026-09-10', amount: -3_000, parent_id: splitParentId, is_child: true, is_parent: false, notes: 'Parte sintética A' },
        { id: splitChildIds[1], account: sourceAccount.id, date: '2026-09-10', amount: -4_000, parent_id: splitParentId, is_child: true, is_parent: false, notes: 'Parte sintética B' },
      ],
    }]);
    await api.sync();

    const splitParent = async (): Promise<AcceptanceTransaction> => {
      const rows = await api.getTransactions(sourceAccount.id, '2026-09-10', '2026-09-10');
      const saved = rows.find((item) => item.id === splitParentId && item.is_parent === true);
      if (!saved?.subtransactions || saved.subtransactions.length !== 2) {
        throw new Error('Actual did not persist the complete synthetic split structure.');
      }
      return saved;
    };
    let split = await splitParent();
    if (split.amount !== -7_000 ||
        JSON.stringify(split.subtransactions?.map((item) => item.id).sort()) !== JSON.stringify([...splitChildIds].sort()) ||
        split.subtransactions?.reduce((sum, item) => sum + item.amount, 0) !== split.amount) {
      throw new Error('The synthetic split baseline has missing IDs or a parent/child total mismatch.');
    }
    const changedChildren = split.subtransactions.map((child) => ({
      ...child,
      account: child.account || sourceAccount.id,
      date: child.date || split.date,
      parent_id: splitParentId,
      is_child: true,
      is_parent: false,
      ...(child.id === splitChildIds[0] ? { amount: -3_500, notes: 'Parte sintética A revisada' } : {}),
    }));
    await api.updateTransaction(splitParentId, {
      is_parent: true,
      amount: -7_500,
      subtransactions: changedChildren,
    });
    await api.sync();
    split = await splitParent();
    if (split.amount !== -7_500 ||
        JSON.stringify(split.subtransactions?.map((item) => item.id).sort()) !== JSON.stringify([...splitChildIds].sort()) ||
        split.subtransactions?.reduce((sum, item) => sum + item.amount, 0) !== split.amount ||
        split.subtransactions?.find((item) => item.id === splitChildIds[0])?.amount !== -3_500 ||
        split.subtransactions?.find((item) => item.id === splitChildIds[0])?.notes !== 'Parte sintética A revisada') {
      throw new Error('Actual did not persist the split edit without losing child IDs or parent/child balance.');
    }
    process.stdout.write('LINKED_TRANSACTION_EDIT_OK: synthetic transfer fields, independent/synchronized dates, independent reconciliation, and split IDs/totals are verified in Actual.\n');
  } finally {
    await api.shutdown().catch(() => undefined);
  }

  // Re-download in a fresh client cache to prove the linked edits were synced to the server,
  // not just visible in the first in-memory Actual session.
  await rm(transactionVerifyCache, { recursive: true, force: true });
  await mkdir(transactionVerifyCache, { recursive: true, mode: 0o700 });
  await api.init({ dataDir: transactionVerifyCache, serverURL, ...(serverPassword ? { password: serverPassword } : {}) });
  try {
    await api.downloadBudget(expected.syncId);
    await api.sync();
    const sourceRows = await api.getTransactions(expected.accountId, '2026-09-01', '2026-09-30');
    const counterpartRows = await api.getTransactions(counterpartAccountId, '2026-09-01', '2026-09-30');
    const source = sourceRows.find((item) => item.id === sourceId);
    const counterpart = counterpartRows.find((item) => item.id === counterpartId);
    const splitRows = await api.getTransactions(expected.accountId, '2026-09-10', '2026-09-10');
    const split = splitRows.find((item) => item.id === splitParentId);
    const persistedChildIds = split?.subtransactions?.map((item) => item.id).sort() ?? [];
    const persistedTargetChild = split?.subtransactions?.find((item) => item.id === splitChildIds[0]);
    if (!source || source.amount !== -5_100 || source.date !== '2026-09-05' || source.notes !== sharedNotes || !source.cleared ||
        !counterpart || counterpart.amount !== 5_100 || counterpart.date !== '2026-09-05' || counterpart.notes !== sharedNotes || Boolean(counterpart.cleared) ||
        !split || split.amount !== -7_500 ||
        JSON.stringify(persistedChildIds) !== JSON.stringify([...splitChildIds].sort()) ||
        split.subtransactions?.reduce((sum, item) => sum + item.amount, 0) !== split.amount ||
        persistedTargetChild?.amount !== -3_500 || persistedTargetChild.notes !== 'Parte sintética A revisada') {
      throw new Error('A fresh Actual client could not verify linked edits after server synchronization.');
    }
    process.stdout.write('LINKED_TRANSACTION_SYNC_OK: updated transfer and split persisted after a fresh budget download.\n');
  } finally {
    await api.shutdown().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'seed') return seed();
  if (action === 'verify') return verify();
  if (action === 'transactions') return verifyLinkedTransactionEditing();
  throw new Error('Choose seed, verify, or transactions.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Synthetic update acceptance failed.';
    process.stderr.write('Synthetic Actual update acceptance failed: ' + message + '\n');
    process.exitCode = 1;
  });
}
