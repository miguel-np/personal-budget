import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetAccount, BudgetCategory, BudgetRepository, BudgetTransaction } from '@personal-budget/finance-core';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const accounts: readonly BudgetAccount[] = [
  { id: 'account-1', name: 'Cuenta corriente', currencyCode: 'EUR', closed: false, offBudget: false, currentBalanceMinor: 250_000 },
];
const categories: readonly BudgetCategory[] = [
  { id: 'salary', name: 'Salario', groupId: 'income', isIncome: true },
  { id: 'food', name: 'Alimentación', groupId: 'spend', isIncome: false },
];
const today = () => new Date().toISOString().slice(0, 10);
function futureMonth(months: number, day = 15): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1));
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  return date.toISOString().slice(0, 10);
}
const historicalTransactions: readonly BudgetTransaction[] = [
  { id: 'income-1', account: 'account-1', currencyCode: 'EUR', date: '2026-10-01', amount: 200_000, category: 'salary' },
  { id: 'expense-1', account: 'account-1', currencyCode: 'EUR', date: '2026-10-02', amount: -30_000, category: 'food' },
  { id: 'transfer-1', account: 'account-1', currencyCode: 'EUR', date: '2026-10-03', amount: -10_000, transfer_id: 'transfer-counterpart' },
];
const openApps: Array<{ close: () => Promise<void> }> = [];
const temporaryDirectories: string[] = [];

function createRepository(overrides: Partial<BudgetRepository> = {}): BudgetRepository {
  return {
    isConfigured: true,
    listAccounts: vi.fn(async () => accounts),
    listCategories: vi.fn(async () => categories),
    listTransactions: vi.fn(async () => historicalTransactions),
    updateTransaction: vi.fn(async () => undefined),
    updateTransactionSafely: vi.fn(async () => ({ persisted: true, verified: true })),
    updateTransactionCategory: vi.fn(async () => undefined),
    updateTransactionCategoriesBatch: vi.fn(async () => ({ requested: 0, updatedTransactionIds: [], persisted: true })),
    ...overrides,
  };
}
function appConfig(dataDirectory: string): AppConfig {
  return {
    environment: 'test', host: '127.0.0.1', port: 3000, logLevel: 'silent',
    actualServerURL: 'http://127.0.0.1:5006', actualDataDir: dataDirectory,
    ollamaBaseURL: 'http://127.0.0.1:11434', aiEnabled: false, ollamaTimeoutMs: 120_000, aiMaxContextChars: 4_000,
    budgetCurrency: 'EUR', allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
  };
}
async function createTestApp(directory: string, repository: BudgetRepository = createRepository()) {
  const app = await buildApp({ repository, config: appConfig(directory), logger: false });
  openApps.push(app);
  return app;
}
function validGoal(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Fondo de emergencia',
    targetAmountMinor: 1_000_000,
    initialAmountMinor: 100_000,
    monthlyContributionMinor: 50_000,
    targetDate: futureMonth(6),
    monthlyIncomeMinor: null,
    monthlyExpenseMinor: null,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local planning API', () => {
  it('returns an empty local planning model without writing to Actual', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-planning-'));
    temporaryDirectories.push(directory);
    const repository = createRepository();
    const app = await createTestApp(directory, repository);
    const response = await app.inject({ method: 'GET', url: '/api/v1/planning' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      currency: 'EUR', goals: [], commitments: [], calendarItems: [],
      accountScope: { mode: 'all', label: expect.stringContaining('Todas las cuentas abiertas') },
    });
    expect(response.json().data.history.monthlyHistory).toHaveLength(12);
    expect(repository.updateTransaction).not.toHaveBeenCalled();
    expect(repository.updateTransactionSafely).not.toHaveBeenCalled();
    expect(repository.updateTransactionCategory).not.toHaveBeenCalled();
    expect(repository.updateTransactionCategoriesBatch).not.toHaveBeenCalled();
  });

  it('persists a validated goal locally and recalculates it after a new app instance reads the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-planning-'));
    temporaryDirectories.push(directory);
    const repository = createRepository();
    const app = await createTestApp(directory, repository);
    const create = await app.inject({ method: 'POST', url: '/api/v1/planning/goals', payload: validGoal() });
    expect(create.statusCode).toBe(201);
    const id = create.json().data.id as string;
    expect(create.json().data).toMatchObject({ name: 'Fondo de emergencia', currency: 'EUR', status: 'active', scope: { mode: 'all' } });

    const secondApp = await createTestApp(directory, repository);
    const read = await secondApp.inject({ method: 'GET', url: '/api/v1/planning' });
    expect(read.statusCode).toBe(200);
    const saved = read.json().data.goals.find((goal: { id: string }) => goal.id === id);
    expect(saved).toBeDefined();
    expect(saved.projection.isEstimate).toBe(true);
    expect(saved.projection.monthlyProjection).toHaveLength(6);
    expect(saved.projection.assumptions.some((assumption: string) => assumption.includes('no se aplica interés'))).toBe(true);
    expect(repository.updateTransaction).not.toHaveBeenCalled();
    expect(repository.updateTransactionSafely).not.toHaveBeenCalled();
    expect(repository.updateTransactionCategory).not.toHaveBeenCalled();
  });

  it('creates, expands, pauses, resumes and deletes commitments without importing them into Actual', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-planning-'));
    temporaryDirectories.push(directory);
    const repository = createRepository();
    const app = await createTestApp(directory, repository);
    const date = futureMonth(1);
    const create = await app.inject({
      method: 'POST', url: '/api/v1/planning/commitments',
      payload: { title: 'Seguro anual', amountMinor: 45_000, date, direction: 'expense', frequency: 'yearly', notes: 'Manual' },
    });
    expect(create.statusCode).toBe(201);
    const commitmentId = create.json().data.id as string;

    const agenda = await app.inject({ method: 'GET', url: '/api/v1/planning?month=' + date.slice(0, 7) });
    expect(agenda.statusCode).toBe(200);
    expect(agenda.json().data.calendarItems).toContainEqual(expect.objectContaining({
      source: 'manual_commitment', title: 'Seguro anual', date, amountMinor: 45_000, direction: 'expense',
    }));

    const paused = await app.inject({ method: 'PATCH', url: '/api/v1/planning/commitments/' + commitmentId + '/status', payload: { status: 'paused' } });
    expect(paused.statusCode).toBe(200);
    const pausedAgenda = await app.inject({ method: 'GET', url: '/api/v1/planning?month=' + date.slice(0, 7) });
    expect(pausedAgenda.json().data.calendarItems.some((item: { id: string }) => item.id.startsWith(commitmentId + '@'))).toBe(false);

    const resumed = await app.inject({ method: 'PATCH', url: '/api/v1/planning/commitments/' + commitmentId + '/status', payload: { status: 'active' } });
    expect(resumed.statusCode).toBe(200);
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/planning/commitments/' + commitmentId });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.deleted).toBe(true);
    expect(repository.updateTransaction).not.toHaveBeenCalled();
    expect(repository.updateTransactionSafely).not.toHaveBeenCalled();
  });

  it('rejects invalid amounts, dates, unknown fields, and one-off commitments dated in the past', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-planning-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(directory);
    const badAmount = await app.inject({
      method: 'POST', url: '/api/v1/planning/goals', payload: validGoal({ targetAmountMinor: 12.5 }),
    });
    expect(badAmount.statusCode).toBe(400);

    const badDate = await app.inject({
      method: 'POST', url: '/api/v1/planning/goals', payload: validGoal({ targetDate: '2026-02-30' }),
    });
    expect(badDate.statusCode).toBe(400);

    const unknownField = await app.inject({
      method: 'POST', url: '/api/v1/planning/goals', payload: validGoal({ writeToActual: true }),
    });
    expect(unknownField.statusCode).toBe(400);

    const pastCommitment = await app.inject({
      method: 'POST', url: '/api/v1/planning/commitments',
      payload: { title: 'Pago ya vencido', amountMinor: 100, date: '2020-01-01', direction: 'expense', frequency: 'once' },
    });
    expect(pastCommitment.statusCode).toBe(400);
  });

  it('requires explicit confirmation to clear local planning data and leaves unrelated preferences alone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-planning-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(directory);
    const create = await app.inject({ method: 'POST', url: '/api/v1/planning/goals', payload: validGoal() });
    expect(create.statusCode).toBe(201);

    const rejected = await app.inject({ method: 'POST', url: '/api/v1/planning/reset', payload: { confirmation: 'yes' } });
    expect(rejected.statusCode).toBe(400);
    const reset = await app.inject({ method: 'POST', url: '/api/v1/planning/reset', payload: { confirmation: 'DELETE_PLANNING_DATA' } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().data).toEqual({ deleted: true, goals: 0, commitments: 0 });
    const read = await app.inject({ method: 'GET', url: '/api/v1/planning' });
    expect(read.json().data.goals).toEqual([]);
    const appPreferences = await app.inject({ method: 'GET', url: '/api/v1/preferences/app' });
    expect(appPreferences.statusCode).toBe(200);
    expect(appPreferences.json().data).toEqual({ theme: 'system', locale: 'es-ES' });
  });

  it('suspends projections when the saved account scope or analysis currency changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-planning-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(directory);
    const create = await app.inject({ method: 'POST', url: '/api/v1/planning/goals', payload: validGoal() });
    const id = create.json().data.id as string;
    const scopeUpdate = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/accounts',
      payload: { mode: 'selected', accountIds: ['account-1'] },
    });
    expect(scopeUpdate.statusCode).toBe(200);
    const currencyUpdate = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/currency',
      payload: { displayCurrency: 'USD', accountCurrencyOverrides: {}, exchangeRates: [] },
    });
    expect(currencyUpdate.statusCode).toBe(200);

    const read = await app.inject({ method: 'GET', url: '/api/v1/planning' });
    expect(read.statusCode).toBe(200);
    const goal = read.json().data.goals.find((item: { id: string }) => item.id === id);
    expect(goal.scopeMatches).toBe(false);
    expect(goal.currencyMatches).toBe(false);
    expect(goal.projection).toBeNull();
    expect(goal.planningWarnings.join(' ')).toContain('ámbito de cuentas guardado ha cambiado');
    expect(goal.planningWarnings.join(' ')).toContain('divisa de análisis ha cambiado');
  });

  it('shows future-dated Actual transactions separately from manual commitments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-planning-'));
    temporaryDirectories.push(directory);
    const nextDate = futureMonth(1);
    const repository = createRepository({
      listTransactions: vi.fn(async () => [
        ...historicalTransactions,
        { id: 'actual-future-1', account: 'account-1', currencyCode: 'EUR', date: nextDate, amount: -15_000, category: 'food', payee_name: 'Factura real' },
        { id: 'actual-future-transfer', account: 'account-1', currencyCode: 'EUR', date: nextDate, amount: -20_000, transfer_id: 'future-transfer' },
      ]),
    });
    const app = await createTestApp(directory, repository);
    const result = await app.inject({ method: 'GET', url: '/api/v1/planning?month=' + nextDate.slice(0, 7) });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.calendarItems).toContainEqual(expect.objectContaining({
      source: 'actual_transaction', title: 'Factura real', date: nextDate, amountMinor: 15_000, direction: 'expense',
    }));
    expect(result.json().data.calendarItems.some((item: { id: string }) => item.id === 'actual:actual-future-transfer')).toBe(false);
  });

  it('rejects malformed month filters and unknown record identifiers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-budget-planning-'));
    temporaryDirectories.push(directory);
    const app = await createTestApp(directory);
    expect((await app.inject({ method: 'GET', url: '/api/v1/planning?month=2026-13' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/planning/goals/not-a-uuid' })).statusCode).toBe(400);
  });
});
