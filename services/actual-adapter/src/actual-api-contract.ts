import type {
  BudgetAccount, BudgetAllocation, BudgetCategory, BudgetMonthRecord,
  BudgetTransaction, ImportRecord, ImportResult, TransactionStructureUpdate,
} from '@personal-budget/finance-core';

/** SDK-facing raw records: these shapes stay inside the adapter boundary. */
export interface ActualAccountRecord {
  readonly id: string;
  readonly name: string;
  readonly closed?: boolean;
  readonly offbudget?: boolean;
  readonly balance_current?: number | null;
  readonly currency?: string | null;
  readonly currency_code?: string | null;
}

export interface ActualPayeeRecord {
  readonly id?: string;
  readonly name: string;
  readonly transfer_acct?: string | null;
}

export interface ActualCategoryRecord {
  readonly id: string;
  readonly name: string;
  readonly group_id: string;
  readonly is_income?: boolean;
}

export interface ActualApiContract {
  init(config: { readonly dataDir: string; readonly serverURL: string; readonly password?: string }): Promise<void>;
  downloadBudget(budgetId: string): Promise<void>;
  sync(): Promise<void>;
  shutdown(): Promise<void>;
  getAccounts(): Promise<readonly ActualAccountRecord[]>;
  getCategories(): Promise<readonly ActualCategoryRecord[]>;
  getPayees?(): Promise<readonly ActualPayeeRecord[]>;
  getBudgetMonth?(month: string): Promise<BudgetMonthRecord>;
  getBudgetAllocations?(month: string): Promise<readonly BudgetAllocation[]>;
  setBudgetAmount?(month: string, categoryId: string, amount: number): Promise<null>;
  updateTransaction?(transactionId: string, fields: TransactionStructureUpdate): Promise<unknown>;
  getTransactions(accountId: string, startDate: string, endDate: string): Promise<readonly BudgetTransaction[]>;
  importTransactions(
    accountId: string,
    transactions: readonly ImportRecord[],
    options?: {
      readonly defaultCleared?: boolean;
      readonly dryRun?: boolean;
      readonly reimportDeleted?: boolean;
      readonly payeeNameNormalization?: 'title-case' | 'original';
    },
  ): Promise<ImportResult>;
}

export interface ActualAdapterConfig {
  readonly serverURL: string;
  readonly password?: string;
  readonly dataDir: string;
  readonly budgetId?: string;
}

export function mapActualAccount(account: ActualAccountRecord): BudgetAccount {
  return {
    id: account.id,
    name: account.name,
    currencyCode: account.currency !== undefined ? account.currency : account.currency_code ?? null,
    closed: account.closed ?? false,
    offBudget: account.offbudget ?? false,
    currentBalanceMinor: account.balance_current ?? null,
  };
}

export function mapActualCategory(category: ActualCategoryRecord): BudgetCategory {
  return {
    id: category.id,
    name: category.name,
    groupId: category.group_id,
    isIncome: category.is_income ?? false,
  };
}
