import type { BudgetAccount, BudgetCategory, BudgetTransaction, TransactionStructureUpdate } from '@personal-budget/finance-core';

export interface ActualBudgetMonthCategory {
  readonly id: string;
  readonly name: string;
  readonly hidden?: boolean;
  readonly budgeted?: number | null;
  readonly spent?: number | null;
  readonly balance?: number | null;
  readonly carryover?: boolean | null;
}
export interface ActualBudgetMonthGroup {
  readonly id: string;
  readonly name: string;
  readonly is_income?: boolean;
  readonly hidden?: boolean;
  readonly categories?: readonly ActualBudgetMonthCategory[];
}
export interface ActualBudgetAllocation {
  readonly categoryId: string;
  readonly amountMinor: number;
}
export interface ActualBudgetMonthRecord {
  readonly month: string;
  readonly categoryGroups: readonly ActualBudgetMonthGroup[];
  readonly totalBudgeted?: number;
  readonly totalSpent?: number;
  readonly totalBalance?: number;
  readonly totalIncome?: number;
  readonly incomeAvailable?: number;
  readonly toBudget?: number;
}

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

export interface ActualImportRecord {
  readonly date: string;
  readonly amount: number;
  readonly payee_name?: string;
  readonly imported_payee?: string;
  readonly category?: string;
  readonly notes?: string;
  readonly imported_id?: string;
  readonly cleared?: boolean;
}

export interface ActualImportResult {
  readonly errors: readonly unknown[];
  readonly added: readonly string[];
  readonly updated: readonly string[];
}

export interface ActualApiContract {
  init(config: { readonly dataDir: string; readonly serverURL: string; readonly password?: string }): Promise<void>;
  downloadBudget(budgetId: string): Promise<void>;
  sync(): Promise<void>;
  shutdown(): Promise<void>;
  getAccounts(): Promise<readonly ActualAccountRecord[]>;
  getCategories(): Promise<readonly ActualCategoryRecord[]>;
  getPayees?(): Promise<readonly ActualPayeeRecord[]>;
  getBudgetMonth?(month: string): Promise<ActualBudgetMonthRecord>;
  getBudgetAllocations?(month: string): Promise<readonly ActualBudgetAllocation[]>;
  setBudgetAmount?(month: string, categoryId: string, amount: number): Promise<null>;
  updateTransaction?(transactionId: string, fields: TransactionStructureUpdate): Promise<unknown>;
  getTransactions(accountId: string, startDate: string, endDate: string): Promise<readonly BudgetTransaction[]>;
  importTransactions(
    accountId: string,
    transactions: readonly ActualImportRecord[],
    options?: {
      readonly defaultCleared?: boolean;
      readonly dryRun?: boolean;
      readonly reimportDeleted?: boolean;
      readonly payeeNameNormalization?: 'title-case' | 'original';
    },
  ): Promise<ActualImportResult>;
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
