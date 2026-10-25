import type { BudgetTransaction, LedgerEntry } from './domain.js';
import { isIsoDate } from './date-range.js';

export class InvalidTransactionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionError';
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new InvalidTransactionError(field + ' must not be empty.');
}

function toEntry(
  transaction: BudgetTransaction,
  inherited?: { readonly account?: string; readonly date?: string; readonly transfer_id?: string | null },
): LedgerEntry {
  const accountId = transaction.account || inherited?.account;
  const date = transaction.date || inherited?.date;
  const transferId = transaction.transfer_id ?? inherited?.transfer_id ?? null;

  if (!accountId) throw new InvalidTransactionError('Transaction account is missing.');
  if (!date || !isIsoDate(date)) throw new InvalidTransactionError('Transaction date must use YYYY-MM-DD.');
  assertNonEmpty(transaction.id, 'Transaction id');
  if (!Number.isSafeInteger(transaction.amount)) {
    throw new InvalidTransactionError('Transaction amount must be a safe integer in minor units.');
  }

  const rawPayee = transaction.payee_name ?? transaction.imported_payee ?? '';
  const trimmedPayee = rawPayee.trim();
  const payeeLabel = trimmedPayee.length === 0 ? null : trimmedPayee.toLocaleLowerCase('es').replace(/\s+/g, ' ');

  return {
    id: transaction.id,
    accountId,
    date,
    amountMinor: transaction.amount,
    categoryId: transaction.category ?? null,
    transferId,
    isTransfer: Boolean(transferId),
    payeeLabel,
  };
}

/** Flatten split transactions so the parent total is not counted alongside its children. */
export function normalizeTransactions(transactions: readonly BudgetTransaction[]): readonly LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const transaction of transactions) {
    if (transaction.is_child === true || transaction.parent_id) continue;

    if (transaction.subtransactions && transaction.subtransactions.length > 0) {
      for (const [index, child] of transaction.subtransactions.entries()) {
        entries.push(toEntry(
          { ...child, id: child.id || transaction.id + ':split:' + index },
          {
            account: transaction.account,
            date: transaction.date,
            ...(transaction.transfer_id === undefined ? {} : { transfer_id: transaction.transfer_id }),
          },
        ));
      }
      continue;
    }

    entries.push(toEntry(transaction));
  }
  return entries;
}
