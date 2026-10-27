import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BudgetAccount, BudgetCategory, BudgetRepository, BudgetTransaction, TransactionCategoryBatchChange, TransactionCategoryBatchResult, TransactionUpdate } from '@personal-budget/finance-core';
import { isIsoDate, validatePeriod } from '@personal-budget/finance-core';
import { z } from 'zod';
import type { ActualAdapterConfig, ActualApiContract, ActualBudgetAllocation, ActualBudgetMonthRecord, ActualImportRecord, ActualImportResult } from './actual-api-contract.js';
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
const TransactionUpdateSchema = z.object({
  date: z.string().refine(isIsoDate, 'date must be a valid YYYY-MM-DD date').optional(),
  amount: z.number().int().refine(Number.isSafeInteger, 'amount must be a safe integer').refine((value) => value !== 0, 'amount cannot be zero').optional(),
  imported_payee: z.string().max(500).transform((value) => value.trim()).optional(),
  category: IdentifierSchema.nullable().optional(),
  notes: z.string().max(2_000).optional(),
  cleared: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one supported transaction field is required');

const CategoryBatchSchema = z.array(z.object({
  transactionId: IdentifierSchema,
  categoryId: IdentifierSchema,
}).strict()).min(1).max(200).superRefine((changes, context) => {
  const seen = new Set<string>();
  for (const [index, change] of changes.entries()) {
    if (seen.has(change.transactionId)) context.addIssue({ code: 'custom', path: [index, 'transactionId'], message: 'Transaction ids must be unique within a batch.' });
    seen.add(change.transactionId);
  }
});
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
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new ActualAdapterError('INVALID_INPUT', 'Budget month must use YYYY-MM.');
    }
    if (!this.api.getBudgetMonth) {
      throw new ActualAdapterError('UPSTREAM_FAILURE', 'The configured Actual API client does not support budget queries.');
    }
    return this.enqueue(async () => this.api.getBudgetMonth!(month));
  }

  public async getBudgetAllocations(month: string): Promise<readonly ActualBudgetAllocation[]> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new ActualAdapterError('INVALID_INPUT', 'Budget month must use YYYY-MM.');
    }
    if (!this.api.getBudgetAllocations) {
      throw new ActualAdapterError('UPSTREAM_FAILURE', 'The configured Actual API client does not support explicit budget allocation lookup.');
    }
    return this.enqueue(async () => this.api.getBudgetAllocations!(month));
  }

  public async setBudgetAmount(month: string, categoryId: string, amount: number): Promise<void> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
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

  public async updateTransaction(transactionId: string, fields: TransactionUpdate): Promise<void> {
    const parsedTransactionId = IdentifierSchema.safeParse(transactionId);
    const parsedFields = TransactionUpdateSchema.safeParse(fields);
    if (!parsedTransactionId.success || !parsedFields.success) {
      throw new ActualAdapterError('INVALID_INPUT', 'Transaction id or supported update fields are invalid.');
    }
    if (!this.api.updateTransaction) {
      throw new ActualAdapterError('UPSTREAM_FAILURE', 'The configured Actual API client does not support transaction updates.');
    }
    await this.enqueue(async () => {
      const update: TransactionUpdate = {
        ...(parsedFields.data.date === undefined ? {} : { date: parsedFields.data.date }),
        ...(parsedFields.data.amount === undefined ? {} : { amount: parsedFields.data.amount }),
        ...(parsedFields.data.imported_payee === undefined ? {} : { imported_payee: parsedFields.data.imported_payee }),
        ...(parsedFields.data.category === undefined ? {} : { category: parsedFields.data.category }),
        ...(parsedFields.data.notes === undefined ? {} : { notes: parsedFields.data.notes }),
        ...(parsedFields.data.cleared === undefined ? {} : { cleared: parsedFields.data.cleared }),
      };
      await this.api.updateTransaction!(parsedTransactionId.data, update);
      await this.api.sync();
    });
  }

  public async updateTransactionCategory(transactionId: string, categoryId: string): Promise<void> {
    const parsedTransactionId = IdentifierSchema.safeParse(transactionId);
    const parsedCategoryId = IdentifierSchema.safeParse(categoryId);
    if (!parsedTransactionId.success || !parsedCategoryId.success) {
      throw new ActualAdapterError('INVALID_INPUT', 'Transaction or category id is invalid.');
    }
    await this.updateTransaction(parsedTransactionId.data, { category: parsedCategoryId.data });
  }

  /**
   * The official client does not promise database-level atomicity. Validate the complete batch
   * before queueing any writes, perform the updates in one serialized session, then sync once.
   * Partial results are reported explicitly; no compensating write is claimed as an undo.
   */
  public async updateTransactionCategoriesBatch(changes: readonly TransactionCategoryBatchChange[]): Promise<TransactionCategoryBatchResult> {
    const parsed = CategoryBatchSchema.safeParse(changes);
    if (!parsed.success) throw new ActualAdapterError('INVALID_INPUT', 'Category batch is invalid or contains duplicate transaction ids.');
    if (!this.api.updateTransaction) {
      throw new ActualAdapterError('UPSTREAM_FAILURE', 'The configured Actual API client does not support transaction updates.');
    }
    return this.enqueue(async () => {
      const updatedTransactionIds: string[] = [];
      let currentTransactionId: string | undefined;
      try {
        for (const change of parsed.data) {
          currentTransactionId = change.transactionId;
          await this.api.updateTransaction!(change.transactionId, { category: change.categoryId });
          updatedTransactionIds.push(change.transactionId);
          currentTransactionId = undefined;
        }
      } catch {
        let persisted = false;
        try { await this.api.sync(); persisted = true; } catch { /* Report unverified persistence instead of claiming rollback. */ }
        return {
          requested: parsed.data.length,
          updatedTransactionIds,
          ...(currentTransactionId ? { failedTransactionId: currentTransactionId } : {}),
          persisted,
        };
      }
      try {
        await this.api.sync();
        return { requested: parsed.data.length, updatedTransactionIds, persisted: true };
      } catch {
        return { requested: parsed.data.length, updatedTransactionIds, persisted: false };
      }
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
      await mkdir(this.dataDir, { recursive: true });
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
