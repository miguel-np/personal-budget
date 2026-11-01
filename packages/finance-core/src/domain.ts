import type { ExchangeRateUsage } from './currency.js';

/**
 * Provider-independent repository error taxonomy. Every adapter must surface its
 * failures through this class (or a subclass) so the API layer can map errors to
 * HTTP responses without knowing which provider is connected.
 */
export type BudgetRepositoryErrorCode = 'NOT_CONFIGURED' | 'CLOSED' | 'UPSTREAM_FAILURE' | 'INVALID_INPUT';

export class BudgetRepositoryError extends Error {
  public readonly code: BudgetRepositoryErrorCode;

  public constructor(code: BudgetRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'BudgetRepositoryError';
    this.code = code;
  }
}

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
  /** Cleared/reconciled state when the Actual source provides it. */
  readonly cleared?: boolean;
  /** Normalized beneficiary label, when the source transaction carries one. */
  readonly payeeLabel?: string | null;
  /** Shared parent identity for transaction splits; falls back to the transaction ID. */
  readonly transactionGroupId?: string;
  /** True for a split line, which must not be treated as an independent charge. */
  readonly isSplitLine?: boolean;
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
  /** Category at the preview boundary; null means uncategorized. */
  readonly expectedCategoryId: string | null;
}

/** Explicit outcome of a non-atomic batch. A false persisted flag means sync could not be verified. */
export interface TransactionCategoryBatchResult {
  readonly requested: number;
  readonly updatedTransactionIds: readonly string[];
  readonly failedTransactionId?: string;
  /** Set when an optimistic concurrency check detects a different category than the preview. */
  readonly conflictTransactionId?: string;
  readonly persisted: boolean;
}

/** Monthly budget category values exposed by the repository, in integer minor units. */
export interface BudgetMonthCategory {
  readonly id: string;
  readonly name: string;
  readonly hidden?: boolean;
  readonly budgeted?: number | null;
  readonly spent?: number | null;
  readonly balance?: number | null;
  readonly carryover?: boolean | null;
}

export interface BudgetMonthGroup {
  readonly id: string;
  readonly name: string;
  readonly is_income?: boolean;
  readonly hidden?: boolean;
  readonly categories?: readonly BudgetMonthCategory[];
}

export interface BudgetMonthRecord {
  readonly month: string;
  readonly categoryGroups: readonly BudgetMonthGroup[];
  readonly totalBudgeted?: number;
  readonly totalSpent?: number;
  readonly totalBalance?: number;
  readonly totalIncome?: number;
  readonly incomeAvailable?: number;
  readonly toBudget?: number;
}

/** Explicit per-category budget allocation, in integer minor units. */
export interface BudgetAllocation {
  readonly categoryId: string;
  readonly amountMinor: number;
}

/** Provider-independent import record accepted by importTransactions. */
export interface ImportRecord {
  readonly date: string;
  readonly amount: number;
  readonly payee_name?: string;
  readonly imported_payee?: string;
  readonly category?: string;
  readonly notes?: string;
  readonly imported_id?: string;
  readonly cleared?: boolean;
}

export interface ImportResult {
  readonly errors: readonly unknown[];
  readonly added: readonly string[];
  readonly updated: readonly string[];
}

/**
 * Read/write boundary every financial provider must implement.
 *
 * Mandatory operations (always required):
 * - isConfigured, listAccounts, listCategories, listTransactions.
 *
 * Optional capabilities (adapters implement them only when the provider really
 * supports them; consumers must probe with typeof checks and must not simulate
 * the capability with fake data):
 * - updateTransaction / updateTransactionSafely: safe editing with read-after-write
 *   verification. updateTransactionSafely returns { persisted, verified } and must
 *   never report a silent success when persistence could not be confirmed.
 * - updateTransactionCategoriesBatch: non-atomic category batch. Providers that
 *   cannot guarantee atomicity must preflight every change and surface conflicts
 *   and partial failures explicitly through TransactionCategoryBatchResult.
 * - updateTransactionCategory: single-category fallback for repositories without
 *   batch support.
 * - getBudgetMonth / getBudgetAllocations / setBudgetAmount: monthly budget reads
 *   and writes when the provider exposes them.
 * - listTransferPayees / importTransactions: transfer payee discovery and imports
 *   when the provider supports them.
 *
 * Provider lifecycle (session init, close/shutdown and resource release) is part
 * of the concrete adapter contract, not of this read/write boundary.
 *
 * Error semantics: every failure the consumer should distinguish must be thrown as
 * a BudgetRepositoryError. INVALID_INPUT is for callers that violate a contract
 * precondition; NOT_CONFIGURED and CLOSED are lifecycle states; UPSTREAM_FAILURE
 * is for provider outages or missing provider capabilities. Unexpected native
 * errors are rethrown as UPSTREAM_FAILURE, never silently converted to success.
 *
 * Persistence/sync guarantees: write methods must sync with the provider after
 * applying changes (see the adapter's documented sync semantics) and, where a
 * verified result is returned, must only report verified=true after the new state
 * is observable through a subsequent read. Amounts are always integer minor
 * currency units; dates are civil YYYY-MM-DD strings.
 *
 * This abstraction eases a future provider substitution but does not imply that
 * switching providers is possible without a data migration: the source of truth
 * and its backup/restore lifecycle remain provider-specific.
 */
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
  /** Budget month reads (totals and category groups); optional when the provider has no monthly budgets. */
  getBudgetMonth?(month: string): Promise<BudgetMonthRecord>;
  /** Explicit per-category budget allocations for a month; optional when the provider cannot expose them. */
  getBudgetAllocations?(month: string): Promise<readonly BudgetAllocation[]>;
  /** Persists a non-negative budget allocation in integer minor units. */
  setBudgetAmount?(month: string, categoryId: string, amountMinor: number): Promise<void>;
  /** Transfer payees usable for manual transfer creation; optional when the provider exposes another path. */
  listTransferPayees?(): Promise<readonly { readonly name: string; readonly accountId: string }[]>;
  /** Imports records in integer minor units; dry-run is the default unless the caller opts in. */
  importTransactions?(
    accountId: string,
    records: readonly ImportRecord[],
    options?: { readonly dryRun?: boolean },
  ): Promise<ImportResult>;
}
