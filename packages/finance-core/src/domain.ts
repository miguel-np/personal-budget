import type { ExchangeRateUsage } from './currency.js';

export interface BudgetAccount {
  readonly id: string;
  readonly name: string;
  /** ISO currency code supplied by Actual when available; null means unknown. */
  readonly currencyCode?: string | null;
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
  /** Native transaction currency when the upstream API exposes it. */
  readonly currencyCode?: string | null;
  /** Compatibility with the raw snake_case Actual API shape. */
  readonly currency_code?: string | null;
  readonly date: string;
  readonly amount: number;
  readonly category?: string | null;
  readonly transfer_id?: string | null;
  readonly payee_id?: string | null;
  readonly payee_name?: string | null;
  readonly imported_payee?: string | null;
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
  /** null means the native currency could not be identified. */
  readonly currencyCode?: string | null;
  readonly date: string;
  readonly amountMinor: number;
  readonly categoryId: string | null;
  readonly transferId: string | null;
  readonly isTransfer: boolean;
  /** Normalized beneficiary label, when the source transaction carries one. */
  readonly payeeLabel?: string | null;
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
  readonly unconvertedTransactionCount: number;
  readonly exchangeRatesUsed: readonly ExchangeRateUsage[];
}

/** Fields the official Actual API adapter allows us to edit without changing transfer/split structure. */
export interface TransactionUpdate {
  readonly date?: string;
  /** Integer minor currency units; zero is not a valid transaction amount. */
  readonly amount?: number;
  readonly imported_payee?: string;
  readonly category?: string | null;
  readonly notes?: string;
  readonly cleared?: boolean;
}

/** Full parent update required by Actual when changing one child of a split transaction. */
export interface TransactionStructureUpdate extends TransactionUpdate {
  readonly is_parent?: boolean;
  readonly subtransactions?: readonly BudgetTransaction[];
}

/** Result of a write that was read back from Actual and synced. */
export interface TransactionWriteResult {
  readonly persisted: boolean;
  readonly verified: boolean;
}

export interface TransactionCategoryBatchChange {
  readonly transactionId: string;
  readonly categoryId: string;
  /** Read-back verification scope; required so a write can be persisted before the next update. */
  readonly accountId: string;
  readonly date: string;
}

/** Explicit outcome of a non-atomic batch. A false persisted flag means sync could not be verified. */
export interface TransactionCategoryBatchResult {
  readonly requested: number;
  readonly updatedTransactionIds: readonly string[];
  readonly failedTransactionId?: string;
  readonly persisted: boolean;
}

export interface BudgetRepository {
  readonly isConfigured: boolean;
  listAccounts(): Promise<readonly BudgetAccount[]>;
  listCategories(): Promise<readonly BudgetCategory[]>;
  listTransactions(accountId: string, startDate: string, endDate: string): Promise<readonly BudgetTransaction[]>;
  /** Update only fields supported by the official adapter; structure/account/transfer linkage is not editable here. */
  updateTransaction?(transactionId: string, fields: TransactionUpdate): Promise<void>;
  /** Read-after-write verified update; beforeDate identifies the original read window. */
  updateTransactionSafely?(
    transactionId: string,
    accountId: string,
    beforeDate: string,
    fields: TransactionStructureUpdate,
  ): Promise<TransactionWriteResult>;
  /** Category-only batch using one serialized adapter operation and an explicit partial outcome. */
  updateTransactionCategoriesBatch?(changes: readonly TransactionCategoryBatchChange[]): Promise<TransactionCategoryBatchResult>;
  /** Backwards-compatible single category update for repositories without batch support. */
  updateTransactionCategory?(transactionId: string, categoryId: string): Promise<void>;
}
