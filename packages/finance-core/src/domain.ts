export interface BudgetAccount {
  readonly id: string;
  readonly name: string;
  readonly closed: boolean;
  readonly offBudget: boolean;
  readonly currentBalanceMinor: number | null;
}

export interface BudgetCategory {
  readonly id: string;
  readonly name: string;
  readonly groupId: string;
  readonly isIncome: boolean;
}

/** Transaction shape used at the Actual Budget boundary; amounts are integer minor units. */
export interface BudgetTransaction {
  readonly id: string;
  readonly account: string;
  readonly date: string;
  readonly amount: number;
  readonly category?: string | null;
  readonly transfer_id?: string | null;
  readonly payee_id?: string | null;
  readonly notes?: string | null;
  readonly cleared?: boolean;
  readonly is_parent?: boolean;
  readonly is_child?: boolean;
  readonly parent_id?: string | null;
  readonly subtransactions?: readonly BudgetTransaction[];
}

export interface LedgerEntry {
  readonly id: string;
  readonly accountId: string;
  readonly date: string;
  readonly amountMinor: number;
  readonly categoryId: string | null;
  readonly transferId: string | null;
  readonly isTransfer: boolean;
}

export interface Period {
  readonly startDate: string;
  readonly endDate: string;
}

export interface CategoryTotal {
  readonly categoryId: string | null;
  readonly categoryName: string;
  /** Signed net outflow; refunds can make this negative. */
  readonly amountMinor: number;
  readonly transactionCount: number;
}

export interface FinancialSummary {
  readonly currency: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly savingsMinor: number;
  readonly savingsRatePercent: number | null;
  readonly uncategorizedOutflowMinor: number;
  readonly unclassifiedInflowMinor: number;
  readonly excludedTransferCount: number;
  readonly transactionCount: number;
  readonly expensesByCategory: readonly CategoryTotal[];
  readonly incomeByCategory: readonly CategoryTotal[];
  readonly warnings: readonly string[];
}

export interface BudgetRepository {
  readonly isConfigured: boolean;
  listAccounts(): Promise<readonly BudgetAccount[]>;
  listCategories(): Promise<readonly BudgetCategory[]>;
  listTransactions(accountId: string, startDate: string, endDate: string): Promise<readonly BudgetTransaction[]>;
}
