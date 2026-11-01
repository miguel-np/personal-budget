import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BudgetAccount, BudgetCategory, BudgetRepository, BudgetTransaction } from '@personal-budget/finance-core';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { readDocumentIndex } from '../src/documents-store.js';

const accounts: readonly BudgetAccount[] = [{
  id: 'actual-account-001', name: 'Cuenta corriente', currencyCode: 'EUR',
  closed: false, offBudget: false, currentBalanceMinor: 100_000,
}];
const categories: readonly BudgetCategory[] = [{
  id: 'food', name: 'Alimentación', groupId: 'living', isIncome: false,
}];
const transactions: readonly BudgetTransaction[] = [{
  id: 'actual-transaction-001', account: 'actual-account-001', currencyCode: 'EUR',
  date: '2026-11-01', amount: -2_500, category: 'food',
}];
const config: AppConfig = {
  environment: 'test', host: '127.0.0.1', port: 3000, logLevel: 'silent',
  actualServerURL: 'http://127.0.0.1:5006', actualDataDir: './.local/test-api',
  ollamaBaseURL: 'http://127.0.0.1:11434', aiEnabled: false,
  aiCategoryClassificationEnabled: false, aiCategoryClassificationIncludePayee: true,
  ollamaTimeoutMs: 120_000, aiMaxContextChars: 4_000, budgetCurrency: 'EUR',
  allowedOrigins: ['http://127.0.0.1:5173'],
};
const directories: string[] = [];
const apps: Array<{ close: () => Promise<void> }> = [];
function createRepository(overrides: Partial<BudgetRepository> = {}): BudgetRepository {
  return {
    isConfigured: true,
    listAccounts: async () => accounts,
    listCategories: async () => categories,
    listTransactions: async (accountId, start, end) => transactions.filter((item) =>
      item.account === accountId && item.date >= start && item.date <= end),
    ...overrides,
  };
}
async function createTestApp(repository: BudgetRepository = createRepository()) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-budget-portfolio-'));
  directories.push(directory);
  const app = await buildApp({ repository, config: { ...config, actualDataDir: directory }, logger: false });
  apps.push(app);
  return { app, directory };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('wealth, local evidence and portable export contracts', () => {
  it('persists external assets and immutable dated valuations without mutating Actual', async () => {
    const repository = createRepository();
    const { app } = await createTestApp(repository);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Cartera externa', kind: 'investment_portfolio', currency: 'EUR', includeInNetWorth: true },
    });
    expect(created.statusCode).toBe(201);
    const assetId = created.json().data.id as string;
    const first = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + assetId + '/valuations',
      payload: { valuedAt: '2026-11-01', amountMinor: 25_000, currency: 'EUR', source: 'manual' },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + assetId + '/valuations',
      payload: { valuedAt: '2026-11-01', quantity: '1.5', unitPriceMinor: 20_000, currency: 'EUR', source: 'statement' },
    });
    expect(second.statusCode).toBe(201);
    const wealth = await app.inject({ method: 'GET', url: '/api/v1/wealth' });
    expect(wealth.json().data.assets[0].valuations).toHaveLength(2);
    expect(wealth.json().data.assets[0].valuations[1].amountMinor).toBe(30_000);
    expect(repository.listTransactions).toBeDefined();
  });

  it('rejects duplicate representation and only consolidates explicit, recent classifications', async () => {
    const { app } = await createTestApp();
    const duplicate = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Saldo de cuenta duplicado', kind: 'cash_external', currency: 'EUR', actualAccountId: 'actual-account-001', includeInNetWorth: true },
    });
    expect(duplicate.statusCode).toBe(400);
    const account = await app.inject({
      method: 'PUT', url: '/api/v1/wealth/accounts/actual-account-001/classification',
      payload: { classification: 'asset' },
    });
    expect(account.statusCode).toBe(200);
    const external = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Depósito externo', kind: 'cash_external', currency: 'EUR', includeInNetWorth: true },
    });
    const assetId = external.json().data.id as string;
    await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + assetId + '/valuations',
      payload: { valuedAt: '2026-11-01', amountMinor: 5_000, currency: 'EUR', source: 'manual' },
    });
    const summary = await app.inject({ method: 'GET', url: '/api/v1/wealth/summary' });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().data.status).toBe('available');
    expect(summary.json().data.netWorthMinor).toBe(105_000);
    expect(summary.json().data.actual.assetsMinor).toBe(100_000);
    expect(summary.json().data.external.assetsMinor).toBe(5_000);
    const old = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + assetId + '/valuations',
      payload: { valuedAt: '2025-01-01', amountMinor: 1_000, currency: 'EUR', source: 'manual' },
    });
    expect(old.statusCode).toBe(201);
    const stale = await app.inject({ method: 'GET', url: '/api/v1/wealth/summary' });
    expect(stale.json().data.status).toBe('incomplete');
    expect(stale.json().data.netWorthMinor).toBeNull();
    expect(stale.json().data.coverage.staleAssetIds).toContain(assetId);
  });

  it('stores supported files privately, verifies signatures and links only real Actual movements', async () => {
    const { app, directory } = await createTestApp();
    const bytes = Buffer.from('%PDF-1.4\\nsynthetic receipt\\n%%EOF', 'ascii');
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: {
        'content-type': 'application/octet-stream',
        'x-document-metadata': JSON.stringify({ displayName: 'Factura de prueba', classification: 'invoice_received', documentDate: '2026-11-01' }),
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const document = upload.json().data;
    expect(document.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const documentFile = join(directory, 'documents', document.fileName);
    expect((await stat(documentFile)).mode & 0o777).toBe(0o600);
    expect((await readFile(documentFile)).equals(bytes)).toBe(true);
    const link = await app.inject({
      method: 'PUT', url: '/api/v1/documents/' + document.id + '/links',
      payload: [{ transactionId: 'actual-transaction-001', accountId: 'actual-account-001', transactionDate: '2026-11-01' }],
    });
    expect(link.statusCode).toBe(200);
    expect(link.json().data.links).toHaveLength(1);
    const missing = await app.inject({
      method: 'PUT', url: '/api/v1/documents/' + document.id + '/links',
      payload: [{ transactionId: 'does-not-exist', accountId: 'actual-account-001', transactionDate: '2026-11-01' }],
    });
    expect(missing.statusCode).toBe(409);
    const index = await readDocumentIndex(directory);
    expect(index.documents[0]?.links).toHaveLength(1);
    const downloaded = await app.inject({ method: 'GET', url: '/api/v1/documents/' + document.id + '/file' });
    expect(downloaded.headers['content-disposition']).toContain('attachment');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(downloaded.rawPayload).equals(bytes)).toBe(true);
  });

  it('rejects spoofed file types and preserves review metadata when archived', async () => {
    const { app } = await createTestApp();
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { 'content-type': 'application/octet-stream', 'x-document-metadata': JSON.stringify({ displayName: 'Spoofed image' }) },
      payload: Buffer.from('not a real pdf'),
    });
    expect(invalid.statusCode).toBe(415);
    const bytes = Buffer.from('%PDF-1.4\\nminimal\\n%%EOF', 'ascii');
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { 'content-type': 'application/octet-stream', 'x-document-metadata': JSON.stringify({ displayName: 'Recibo' }) },
      payload: bytes,
    });
    const id = upload.json().data.id as string;
    const archived = await app.inject({ method: 'PATCH', url: '/api/v1/documents/' + id + '/archive', payload: { archived: true } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.archivedAt).toBeTruthy();
  });

  it('exports selected local data and requested Actual budget months with provenance, not secrets', async () => {
    const budgetRepository = Object.assign(createRepository(), {
      getBudgetMonth: async (month: string) => ({
        month, totalBudgeted: 12_000, totalSpent: -4_000, totalBalance: 8_000,
        categoryGroups: [{ id: 'living', name: 'Vida diaria', is_income: false, categories: [
          { id: 'food', name: 'Alimentación', budgeted: 12_000, spent: -4_000, balance: 8_000 },
        ] }],
      }),
      getBudgetAllocations: async () => [{ categoryId: 'food', amountMinor: 12_000 }],
    });
    const { app } = await createTestApp(budgetRepository);
    const response = await app.inject({ method: 'GET', url: '/api/v1/portable-export?datasets=planning,wealth,budgets&budgetMonths=2026-11' });
    expect(response.statusCode).toBe(200);
    const exported = response.json();
    expect(exported.format).toBe('personal-budget-portable-export');
    expect(exported.context.currency).toBe('EUR');
    expect(exported.manifest.find((item: { id: string }) => item.id === 'budgets')).toMatchObject({ included: true, source: 'actual-budget-api', recordCount: 1 });
    expect(exported.data.budgets.months[0].month).toBe('2026-11');
    expect(JSON.stringify(exported)).not.toContain('backup-key');
    expect(exported.exclusions.join(' ')).toContain('not a restorable backup');
  });
});
