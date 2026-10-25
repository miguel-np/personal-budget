import { resolve } from 'node:path';
import type { BudgetAccount, BudgetCategory, BudgetRepository, BudgetTransaction } from '@personal-budget/finance-core';
import { isIsoDate, validatePeriod } from '@personal-budget/finance-core';
import { z } from 'zod';
import type { ActualAdapterConfig, ActualApiContract, ActualBudgetMonthRecord, ActualImportRecord, ActualImportResult } from './actual-api-contract.js';
import { mapActualAccount, mapActualCategory } from './actual-api-contract.js';

export class ActualAdapterError extends Error {
  public readonly code: 'NOT_CONFIGURED' | 'CLOSED' | 'UPSTREAM_FAILURE' | 'INVALID_INPUT';

  public constructor(code: ActualAdapterError['code'], message: string) {
    super(message);
    this.name = 'ActualAdapterError';
    this.code = code;
  }
}

const IdentifierSchema = z.string().trim().min(1).max(128);
const ImportRecordSchema = z.object({
  date: z.string().refine(isIsoDate, 'date must be a valid YYYY-MM-DD date'),
  amount: z.number().int().safe(),
  payee_name: z.string().trim().max(500).optional(),
  imported_payee: z.string().trim().max(500).optional(),
  category: IdentifierSchema.optional(),
  notes: z.string().max(2_000).optional(),
  imported_id: z.string().trim().max(500).optional(),
  cleared: z.boolean().optional(),
}).strict();

function omitUndefinedImportFields(
  record: z.infer<typeof ImportRecordSchema>,
): ActualImportRecord {
  return {
    date: record.date,
    amount: record.amount,
    ...(record.payee_name === undefined ? {} : { payee_name: record.payee_name }),
    ...(record.imported_payee === undefined ? {} : { imported_payee: record.imported_payee }),
    ...(record.category === undefined ? {} : { category: record.category }),
    ...(record.notes === undefined ? {} : { notes: record.notes }),
    ...(record.imported_id === undefined ? {} : { imported_id: record.imported_id }),
    ...(record.cleared === undefined ? {} : { cleared: record.cleared }),
  };
}

/**
 * Serializes operations because the official Actual API owns one active budget
 * session. Raw upstream failures are intentionally replaced with safe errors.
 */
export class ActualBudgetAdapter implements BudgetRepository {
  private readonly dataDir: string;
  private operationQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private closing = false;
  private closed = false;

  public constructor(private readonly config: ActualAdapterConfig, private readonly api: ActualApiContract) {
    this.dataDir = resolve(config.dataDir);
  }

  public get isConfigured(): boolean {
    return Boolean(this.config.serverURL && this.config.budgetId?.trim());
  }

  public async listAccounts(): Promise<readonly BudgetAccount[]> {
    return this.enqueue(async () => (await this.api.getAccounts()).map(mapActualAccount));
  }

  public async listCategories(): Promise<readonly BudgetCategory[]> {
    return this.enqueue(async () => (await this.api.getCategories()).map(mapActualCategory));
  }

  public async getBudgetMonth(month: string): Promise<ActualBudgetMonthRecord> {
    if (!/^\\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new ActualAdapterError('INVALID_INPUT', 'Budget month must use YYYY-MM.');
    }
    if (!this.api.getBudgetMonth) {
      throw new ActualAdapterError('UPSTREAM_FAILURE', 'The configured Actual API client does not support budget queries.');
    }
    return this.enqueue(async () => this.api.getBudgetMonth!(month));
  }

  public async setBudgetAmount(month: string, categoryId: string, amount: number): Promise<void> {
    if (!/^\\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new ActualAdapterError('INVALID_INPUT', 'Budget month must use YYYY-MM.');
    }
    const parsedCategoryId = IdentifierSchema.safeParse(categoryId);
    if (!parsedCategoryId.success || !Number.isSafeInteger(amount) || amount < 0) {
      throw new ActualAdapterError('INVALID_INPUT', 'Budget category or amount is invalid.');
    }
    if (!this.api.setBudgetAmount) {
      throw new ActualAdapterError('UPSTREAM_FAILURE', 'The configured Actual API client does not support budget updates.');
    }
    await this.enqueue(async () => {
      await this.api.setBudgetAmount!(month, parsedCategoryId.data, amount);
      await this.api.sync();
    });
  }

  public async listTransactions(accountId: string, startDate: string, endDate: string): Promise<readonly BudgetTransaction[]> {
    const parsedAccountId = IdentifierSchema.safeParse(accountId);
    if (!parsedAccountId.success) throw new ActualAdapterError('INVALID_INPUT', 'accountId is invalid.');
    try {
      validatePeriod({ startDate, endDate });
    } catch {
      throw new ActualAdapterError('INVALID_INPUT', 'Date range is invalid.');
    }
    return this.enqueue(async () => this.api.getTransactions(parsedAccountId.data, startDate, endDate));
  }

  /** Dry-run is the default; persistence requires an explicit caller choice. */
  public async importTransactions(
    accountId: string,
    records: readonly ActualImportRecord[],
    options: { readonly dryRun?: boolean } = {},
  ): Promise<ActualImportResult> {
    const parsedAccountId = IdentifierSchema.safeParse(accountId);
    if (!parsedAccountId.success) throw new ActualAdapterError('INVALID_INPUT', 'accountId is invalid.');
    const parsedRecords = z.array(ImportRecordSchema).max(10_000).safeParse(records);
    if (!parsedRecords.success) throw new ActualAdapterError('INVALID_INPUT', 'One or more import records are invalid.');

    return this.enqueue(async () => {
      const dryRun = options.dryRun ?? true;
      const normalizedRecords = parsedRecords.data.map(omitUndefinedImportFields);
      const result = await this.api.importTransactions(parsedAccountId.data, normalizedRecords, {
        dryRun,
        reimportDeleted: false,
        defaultCleared: false,
        payeeNameNormalization: 'original',
      });
      if (!dryRun) await this.api.sync();
      return result;
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.operationQueue;
    if (this.initialized) {
      try {
        await this.api.shutdown();
      } catch {
        this.closed = true;
        throw new ActualAdapterError('UPSTREAM_FAILURE', 'Actual Budget session could not shut down cleanly.');
      }
    }
    this.closed = true;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(async () => {
      if (this.closing || this.closed) throw new ActualAdapterError('CLOSED', 'Actual Budget adapter is closed.');
      await this.ensureInitialized();
      try {
        await this.api.sync();
        return await operation();
      } catch {
        throw new ActualAdapterError('UPSTREAM_FAILURE', 'Actual Budget operation failed.');
      }
    });
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.isConfigured) {
      throw new ActualAdapterError('NOT_CONFIGURED', 'Set ACTUAL_SERVER_URL and ACTUAL_BUDGET_ID before reading financial data.');
    }
    try {
      await this.api.init({
        dataDir: this.dataDir,
        serverURL: this.config.serverURL,
        ...(this.config.password === undefined ? {} : { password: this.config.password }),
      });
      await this.api.downloadBudget(this.config.budgetId as string);
      this.initialized = true;
    } catch {
      try { await this.api.shutdown(); } catch { /* Best-effort cleanup. */ }
      throw new ActualAdapterError('UPSTREAM_FAILURE', 'Could not initialize the local Actual Budget session. Check server and budget configuration.');
    }
  }
}
