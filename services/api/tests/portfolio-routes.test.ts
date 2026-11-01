import { createHash, randomUUID } from 'node:crypto';
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
    const staleAsset = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Inmueble sin valoración reciente', kind: 'real_estate', currency: 'EUR', includeInNetWorth: true },
    });
    const staleAssetId = staleAsset.json().data.id as string;
    const old = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + staleAssetId + '/valuations',
      payload: { valuedAt: '2025-01-01', amountMinor: 1_000, currency: 'EUR', source: 'manual' },
    });
    expect(old.statusCode).toBe(201);
    const stale = await app.inject({ method: 'GET', url: '/api/v1/wealth/summary' });
    expect(stale.json().data.status).toBe('incomplete');
    expect(stale.json().data.netWorthMinor).toBeNull();
    expect(stale.json().data.coverage.staleAssetIds).toContain(staleAssetId);
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

  it('validates asset creation and rejects unknown or duplicate Actual links', async () => {
    const { app } = await createTestApp();
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/wealth/assets', payload: { name: 'Sin tipo' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_WEALTH_INPUT');
    const unknown = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Cuenta inexistente', kind: 'cash_external', currency: 'EUR', actualAccountId: 'no-existe', includeInNetWorth: false },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('UNKNOWN_ACTUAL_ACCOUNT');
    const linked = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Cuenta Actual representada', kind: 'cash_external', currency: 'EUR', actualAccountId: 'actual-account-001', includeInNetWorth: false },
    });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().data.includeInNetWorth).toBe(false);
    const linkedId = linked.json().data.id as string;
    const again = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Segundo vínculo', kind: 'cash_external', currency: 'EUR', actualAccountId: 'actual-account-001', includeInNetWorth: false },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('WEALTH_CONFLICT');
    const other = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Otro externo', kind: 'other_asset', currency: 'EUR', includeInNetWorth: true },
    });
    const otherId = other.json().data.id as string;
    const conflictLink = await app.inject({
      method: 'PATCH', url: '/api/v1/wealth/assets/' + otherId,
      payload: { actualAccountId: 'actual-account-001', includeInNetWorth: false },
    });
    expect(conflictLink.statusCode).toBe(409);
    expect(conflictLink.json().error.code).toBe('WEALTH_CONFLICT');
    const unlinked = await app.inject({
      method: 'PATCH', url: '/api/v1/wealth/assets/' + linkedId,
      payload: { actualAccountId: null },
    });
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json().data.actualAccountId).toBeUndefined();
  });

  it('patches, archives and deletes external assets with confirmations', async () => {
    const { app } = await createTestApp();
    const created = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Depósito', kind: 'cash_external', currency: 'EUR', includeInNetWorth: true },
    });
    const id = created.json().data.id as string;
    const missing = await app.inject({ method: 'PATCH', url: '/api/v1/wealth/assets/' + randomUUID(), payload: { name: 'Otro' } });
    expect(missing.statusCode).toBe(404);
    const badPatch = await app.inject({ method: 'PATCH', url: '/api/v1/wealth/assets/' + id, payload: { kind: 'tulipanes' } });
    expect(badPatch.statusCode).toBe(400);
    const unknownLink = await app.inject({
      method: 'PATCH', url: '/api/v1/wealth/assets/' + id,
      payload: { actualAccountId: 'no-existe', includeInNetWorth: false },
    });
    expect(unknownLink.statusCode).toBe(400);
    expect(unknownLink.json().error.code).toBe('UNKNOWN_ACTUAL_ACCOUNT');
    const duplicateLink = await app.inject({
      method: 'PATCH', url: '/api/v1/wealth/assets/' + id,
      payload: { actualAccountId: 'actual-account-001', includeInNetWorth: true },
    });
    expect(duplicateLink.statusCode).toBe(400);
    expect(duplicateLink.json().error.code).toBe('DUPLICATE_ASSET');
    const renamed = await app.inject({
      method: 'PATCH', url: '/api/v1/wealth/assets/' + id,
      payload: { name: 'Renombrado', description: 'Con detalle', owner: 'Yo' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.name).toBe('Renombrado');
    const archived = await app.inject({ method: 'PATCH', url: '/api/v1/wealth/assets/' + id + '/status', payload: { status: 'archived' } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.status).toBe('archived');
    const badStatus = await app.inject({ method: 'PATCH', url: '/api/v1/wealth/assets/' + id + '/status', payload: { status: 'deleted' } });
    expect(badStatus.statusCode).toBe(400);
    const missingStatus = await app.inject({ method: 'PATCH', url: '/api/v1/wealth/assets/' + randomUUID() + '/status', payload: { status: 'active' } });
    expect(missingStatus.statusCode).toBe(404);
    const noConfirm = await app.inject({ method: 'DELETE', url: '/api/v1/wealth/assets/' + id, payload: {} });
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json().error.code).toBe('CONFIRMATION_REQUIRED');
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/wealth/assets/' + id, payload: { confirm: true } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.deleted).toBe(true);
    const missingDelete = await app.inject({ method: 'DELETE', url: '/api/v1/wealth/assets/' + id, payload: { confirm: true } });
    expect(missingDelete.statusCode).toBe(404);
  });

  it('validates valuation snapshots and rejects future, mismatched and foreign-currency values', async () => {
    const { app } = await createTestApp();
    const created = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Cartera', kind: 'investment_portfolio', currency: 'EUR', includeInNetWorth: true },
    });
    const id = created.json().data.id as string;
    const missing = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + randomUUID() + '/valuations',
      payload: { valuedAt: '2026-11-01', amountMinor: 100, currency: 'EUR' },
    });
    expect(missing.statusCode).toBe(404);
    const future = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + id + '/valuations',
      payload: { valuedAt: '2999-01-01', amountMinor: 100, currency: 'EUR' },
    });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.code).toBe('FUTURE_VALUATION');
    const wrongCurrency = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + id + '/valuations',
      payload: { valuedAt: '2026-11-01', amountMinor: 100, currency: 'USD' },
    });
    expect(wrongCurrency.statusCode).toBe(409);
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + id + '/valuations',
      payload: { valuedAt: '2026-11-01', currency: 'EUR' },
    });
    expect(invalid.statusCode).toBe(400);
    const mismatch = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + id + '/valuations',
      payload: { valuedAt: '2026-11-01', quantity: '2', unitPriceMinor: 100, amountMinor: 999, currency: 'EUR' },
    });
    expect(mismatch.statusCode).toBe(400);
    const noted = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + id + '/valuations',
      payload: { valuedAt: '2026-11-01', amountMinor: 500, currency: 'EUR', source: 'statement', notes: 'Extracto' },
    });
    expect(noted.statusCode).toBe(201);
    expect(noted.json().data.notes).toBe('Extracto');
  });

  it('updates wealth settings and per-account classifications', async () => {
    const { app } = await createTestApp();
    const invalid = await app.inject({ method: 'PUT', url: '/api/v1/wealth/settings', payload: { staleAfterDays: 10 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_WEALTH_SETTINGS');
    const settings = await app.inject({ method: 'PUT', url: '/api/v1/wealth/settings', payload: { staleAfterDays: 120, includeOffBudgetAccounts: false } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().data.staleAfterDays).toBe(120);
    const liability = await app.inject({
      method: 'PUT', url: '/api/v1/wealth/accounts/actual-account-001/classification',
      payload: { classification: 'liability' },
    });
    expect(liability.statusCode).toBe(200);
    expect(liability.json().data.classification).toBe('liability');
    const cleared = await app.inject({
      method: 'PUT', url: '/api/v1/wealth/accounts/actual-account-001/classification',
      payload: { classification: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data).toBeNull();
    const unknown = await app.inject({
      method: 'PUT', url: '/api/v1/wealth/accounts/no-existe/classification',
      payload: { classification: 'asset' },
    });
    expect(unknown.statusCode).toBe(404);
    const invalidBody = await app.inject({
      method: 'PUT', url: '/api/v1/wealth/accounts/actual-account-001/classification',
      payload: { classification: 'car' },
    });
    expect(invalidBody.statusCode).toBe(400);
  });

  it('reports liabilities, liquidity and excluded duplicates in the consolidated summary', async () => {
    const { app } = await createTestApp();
    await app.inject({ method: 'PUT', url: '/api/v1/wealth/accounts/actual-account-001/classification', payload: { classification: 'liability' } });
    const loan = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Préstamo externo', kind: 'loan', currency: 'EUR', includeInNetWorth: true },
    });
    const loanId = loan.json().data.id as string;
    await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + loanId + '/valuations',
      payload: { valuedAt: '2026-11-01', amountMinor: 20_000, currency: 'EUR', source: 'manual' },
    });
    const cash = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Efectivo', kind: 'cash_external', currency: 'EUR', includeInNetWorth: true },
    });
    const cashId = cash.json().data.id as string;
    await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + cashId + '/valuations',
      payload: { valuedAt: '2026-11-01', amountMinor: 3_000, currency: 'EUR', source: 'manual' },
    });
    const optOut = await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets',
      payload: { name: 'Fuera del cómputo', kind: 'other_asset', currency: 'EUR', includeInNetWorth: false },
    });
    const optOutId = optOut.json().data.id as string;
    await app.inject({
      method: 'POST', url: '/api/v1/wealth/assets/' + optOutId + '/valuations',
      payload: { valuedAt: '2026-11-01', amountMinor: 9_000, currency: 'EUR', source: 'manual' },
    });
    const summary = await app.inject({ method: 'GET', url: '/api/v1/wealth/summary' });
    expect(summary.statusCode).toBe(200);
    const data = summary.json().data;
    expect(data.status).toBe('available');
    expect(data.actual.liabilitiesMinor).toBe(100_000);
    expect(data.actual.assetsMinor).toBe(0);
    expect(data.external.assetsMinor).toBe(3_000);
    expect(data.external.liabilitiesMinor).toBe(20_000);
    expect(data.liquidity.cashLikeExternalMinor).toBe(3_000);
    expect(data.coverage.excludedDuplicateOrOptOutIds).toContain(optOutId);
    expect(data.netWorthMinor).toBe(-117_000);
  });

  it('honors the off-budget setting and warns about unclassified or unconvertible accounts', async () => {
    const repository = createRepository({
      listAccounts: async () => [
        { id: 'offbudget-1', name: 'Fuera de presupuesto', currencyCode: 'EUR', closed: false, offBudget: true, currentBalanceMinor: 50_000 },
        { id: 'unknown-1', name: 'Saldo desconocido', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: null },
        { id: 'nonative-1', name: 'Sin divisa nativa', currencyCode: null, closed: false, offBudget: false, currentBalanceMinor: 5_000 },
      ],
    });
    const { app } = await createTestApp(repository);
    const first = await app.inject({ method: 'GET', url: '/api/v1/wealth/summary' });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.status).toBe('incomplete');
    expect(first.json().data.coverage.includedActualAccounts).toBe(3);
    expect(first.json().data.warnings.join(' ')).toContain('sin clasificación');
    await app.inject({ method: 'PUT', url: '/api/v1/wealth/accounts/offbudget-1/classification', payload: { classification: 'asset' } });
    await app.inject({ method: 'PUT', url: '/api/v1/wealth/accounts/unknown-1/classification', payload: { classification: 'asset' } });
    await app.inject({ method: 'PUT', url: '/api/v1/wealth/accounts/nonative-1/classification', payload: { classification: 'asset' } });
    const second = await app.inject({ method: 'GET', url: '/api/v1/wealth/summary' });
    expect(second.json().data.coverage.includedActualAccounts).toBe(3);
    expect(second.json().data.coverage.unconvertibleAccountIds).toEqual(expect.arrayContaining(['unknown-1', 'nonative-1']));
    expect(second.json().data.warnings.join(' ')).toContain('saldo o conversión no disponible');
    await app.inject({ method: 'PUT', url: '/api/v1/wealth/settings', payload: { staleAfterDays: 90, includeOffBudgetAccounts: false } });
    const third = await app.inject({ method: 'GET', url: '/api/v1/wealth/summary' });
    expect(third.json().data.coverage.includedActualAccounts).toBe(2);
    const empty = await createTestApp(createRepository({ listAccounts: async () => [] }));
    const emptySummary = await empty.app.inject({ method: 'GET', url: '/api/v1/wealth/summary' });
    expect(emptySummary.statusCode).toBe(200);
    expect(emptySummary.json().data.warnings.join(' ')).toContain('No hay cuentas');
  });

  it('enforces document metadata, content types and format detection at the API boundary', async () => {
    const { app } = await createTestApp();
    const missingHeader = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('%PDF-1.4 ok', 'ascii'),
    });
    expect(missingHeader.statusCode).toBe(400);
    expect(missingHeader.json().error.code).toBe('DOCUMENT_METADATA_REQUIRED');
    const badJson = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { 'content-type': 'application/octet-stream', 'x-document-metadata': '{no json' },
      payload: Buffer.from('%PDF-1.4 ok', 'ascii'),
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error.code).toBe('INVALID_DOCUMENT_METADATA');
    const badSchema = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { 'content-type': 'application/octet-stream', 'x-document-metadata': JSON.stringify({}) },
      payload: Buffer.from('%PDF-1.4 ok', 'ascii'),
    });
    expect(badSchema.statusCode).toBe(400);
    const wrongContentType = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { 'content-type': 'application/json', 'x-document-metadata': JSON.stringify({ displayName: 'PDF como JSON' }) },
      payload: { bytes: 'no' },
    });
    expect(wrongContentType.statusCode).toBe(415);
    expect(wrongContentType.json().error.code).toBe('DOCUMENT_CONTENT_TYPE_REQUIRED');
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
    const jpegUpload = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { 'content-type': 'application/octet-stream', 'x-document-metadata': JSON.stringify({ displayName: 'Foto' }) },
      payload: jpg,
    });
    expect(jpegUpload.statusCode).toBe(201);
    expect(jpegUpload.json().data.mediaType).toBe('image/jpeg');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
    const pngUpload = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { 'content-type': 'application/octet-stream', 'x-document-metadata': JSON.stringify({ displayName: 'Captura' }) },
      payload: png,
    });
    expect(pngUpload.statusCode).toBe(201);
    expect(pngUpload.json().data.mediaType).toBe('image/png');
  });

  it('filters, updates, archives, downloads and deletes documents with verified integrity', async () => {
    const { app } = await createTestApp();
    const bytes = Buffer.from('%PDF-1.4\\nreal content\\n%%EOF', 'ascii');
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: {
        'content-type': 'application/octet-stream',
        'x-document-metadata': JSON.stringify({ displayName: 'Factura', tags: ['a'], classification: 'invoice_received' }),
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const id = upload.json().data.id as string;
    await app.inject({
      method: 'PUT', url: '/api/v1/documents/' + id + '/links',
      payload: [{ transactionId: 'actual-transaction-001', accountId: 'actual-account-001', transactionDate: '2026-11-01' }],
    });
    const byTransaction = await app.inject({ method: 'GET', url: '/api/v1/documents?transactionId=actual-transaction-001' });
    expect(byTransaction.json().data).toHaveLength(1);
    const archived = await app.inject({ method: 'PATCH', url: '/api/v1/documents/' + id + '/archive', payload: { archived: true } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.archivedAt).toBeTruthy();
    const hiddenByDefault = await app.inject({ method: 'GET', url: '/api/v1/documents' });
    expect(hiddenByDefault.json().data).toHaveLength(0);
    const withArchived = await app.inject({ method: 'GET', url: '/api/v1/documents?includeArchived=true' });
    expect(withArchived.json().data).toHaveLength(1);
    const updated = await app.inject({ method: 'PATCH', url: '/api/v1/documents/' + id, payload: { reviewStatus: 'reviewed', notes: 'Revisado' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.reviewStatus).toBe('reviewed');
    const missingPatch = await app.inject({ method: 'PATCH', url: '/api/v1/documents/' + randomUUID(), payload: { notes: 'x' } });
    expect(missingPatch.statusCode).toBe(404);
    const badArchive = await app.inject({ method: 'PATCH', url: '/api/v1/documents/' + id + '/archive', payload: { archived: 'yes' } });
    expect(badArchive.statusCode).toBe(400);
    const missingArchive = await app.inject({ method: 'PATCH', url: '/api/v1/documents/' + randomUUID() + '/archive', payload: { archived: true } });
    expect(missingArchive.statusCode).toBe(404);
    const badLinks = await app.inject({ method: 'PUT', url: '/api/v1/documents/' + id + '/links', payload: [{ transactionId: '' }] });
    expect(badLinks.statusCode).toBe(400);
    const missingLinks = await app.inject({ method: 'PUT', url: '/api/v1/documents/' + randomUUID() + '/links', payload: [] });
    expect(missingLinks.statusCode).toBe(404);
    const missingFile = await app.inject({ method: 'GET', url: '/api/v1/documents/' + randomUUID() + '/file' });
    expect(missingFile.statusCode).toBe(404);
    const invalidFileId = await app.inject({ method: 'GET', url: '/api/v1/documents/not-a-uuid/file' });
    expect(invalidFileId.statusCode).toBe(500);
    const noConfirm = await app.inject({ method: 'DELETE', url: '/api/v1/documents/' + id, payload: {} });
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json().error.code).toBe('CONFIRMATION_REQUIRED');
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/documents/' + id, payload: { confirm: true } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.deleted).toBe(true);
    const missingDelete = await app.inject({ method: 'DELETE', url: '/api/v1/documents/' + id, payload: { confirm: true } });
    expect(missingDelete.statusCode).toBe(404);
  });

  it('exports preference and document datasets with manifest provenance and budget fallbacks', async () => {
    const { app } = await createTestApp();
    const bytes = Buffer.from('%PDF-1.4\\nsynthetic\\n%%EOF', 'ascii');
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { 'content-type': 'application/octet-stream', 'x-document-metadata': JSON.stringify({ displayName: 'Justificante' }) },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const withFiles = await app.inject({ method: 'GET', url: '/api/v1/portable-export?datasets=preferences,documents&includeDocumentFiles=true' });
    expect(withFiles.statusCode).toBe(200);
    expect(withFiles.json().data.documents.files[0].base64).toBe(bytes.toString('base64'));
    const withoutFiles = await app.inject({ method: 'GET', url: '/api/v1/portable-export?datasets=preferences,documents' });
    expect(withoutFiles.statusCode).toBe(200);
    expect(withoutFiles.json().data.documents.files).toBeUndefined();
    expect(withoutFiles.json().manifest.map((item: { id: string }) => item.id)).toContain('preferences');
    const noBudgetAdapter = await app.inject({ method: 'GET', url: '/api/v1/portable-export?datasets=budgets&budgetMonths=2026-11' });
    expect(noBudgetAdapter.statusCode).toBe(200);
    expect(noBudgetAdapter.json().manifest.find((item: { id: string }) => item.id === 'budgets').included).toBe(false);
    const invalidMonth = await app.inject({ method: 'GET', url: '/api/v1/portable-export?datasets=planning,wealth,budgets&budgetMonths=11-2026' });
    expect(invalidMonth.statusCode).toBe(400);
    expect(invalidMonth.json().error.code).toBe('INVALID_PORTABLE_EXPORT_SELECTION');
    const unknownDataset = await app.inject({ method: 'GET', url: '/api/v1/portable-export?datasets=secrets' });
    expect(unknownDataset.statusCode).toBe(400);
  });

  it('degrades export context when Actual account listing is unavailable', async () => {
    const repository = createRepository({ listAccounts: async () => { throw new Error('Actual caído'); } });
    const { app } = await createTestApp(repository);
    const response = await app.inject({ method: 'GET', url: '/api/v1/portable-export?datasets=planning' });
    expect(response.statusCode).toBe(200);
    expect(response.json().context.accountScope.accountCount).toBeNull();
    expect(response.json().warnings.join(' ')).toContain('no está disponible para verificar');
  });
});
