import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { isIsoDate } from '@personal-budget/finance-core';
import type {
  BudgetAccount,
  BudgetRepository,
  BudgetTransaction,
  TransactionStructureUpdate,
} from '@personal-budget/finance-core';

export const TransactionUpdateRequestSchema = z.object({
  accountId: z.string().trim().min(1).max(128),
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
  syncTransferDate: z.boolean().optional().default(false),
  changes: z.object({
    date: z.string().refine(isIsoDate, 'date must be a valid YYYY-MM-DD date.').optional(),
    amount: z.number().int().refine(Number.isSafeInteger, 'amount must be a safe integer.').refine((amount) => amount !== 0, 'amount cannot be zero.').optional(),
    imported_payee: z.string().max(500).transform((value) => value.trim()).optional(),
    category: z.string().trim().min(1).max(128).nullable().optional(),
    notes: z.string().max(2_000).optional(),
    cleared: z.boolean().optional(),
  }).strict().refine((fields) => Object.keys(fields).length > 0, 'At least one supported field must change.'),
}).strict();

type UpdateRequest = z.infer<typeof TransactionUpdateRequestSchema>;
type AccountTransactions = {
  readonly accounts: readonly { readonly id: string; readonly name: string; readonly closed: boolean; readonly currencyCode?: string | null }[];
  readonly transactions: readonly BudgetTransaction[];
};
type SafeUpdate = NonNullable<BudgetRepository['updateTransactionSafely']>;

interface TargetTransaction {
  readonly transaction: BudgetTransaction;
  readonly splitParent?: BudgetTransaction;
  readonly splitChild?: BudgetTransaction;
}

function invalidRequest(message: string, code: string) {
  return { error: { code, message } };
}

function findTargetTransaction(
  transactions: readonly BudgetTransaction[],
  transactionId: string,
  accountId: string,
): TargetTransaction | undefined {
  const splitParent = transactions.find((item) =>
    item.account === accountId && item.is_parent === true &&
    item.subtransactions?.some((child) => child.id === transactionId &&
      (child.account ?? item.account) === accountId),
  );
  const splitChild = splitParent?.subtransactions?.find((child) => child.id === transactionId);
  const topLevel = transactions.find((item) => item.id === transactionId && item.account === accountId);
  const transaction = topLevel ?? (splitParent && splitChild ? {
    ...splitChild,
    account: splitChild.account || splitParent.account,
    date: splitChild.date || splitParent.date,
  } : undefined);
  return transaction ? {
    transaction,
    ...(splitParent ? { splitParent } : {}),
    ...(splitChild ? { splitChild } : {}),
  } : undefined;
}

function categoryMatchesAmount(
  categoryId: string | null | undefined,
  amount: number,
  categories: Awaited<ReturnType<BudgetRepository['listCategories']>>,
): boolean {
  if (!categoryId) return true;
  const category = categories.find((item) => item.id === categoryId);
  return Boolean(category && ((amount > 0) === category.isIncome));
}

function createSafeWriter(repository: BudgetRepository): SafeUpdate {
  if (!repository.updateTransactionSafely) throw new Error('Safe transaction update is unavailable.');
  return repository.updateTransactionSafely.bind(repository);
}

async function findTransferCounterpart(
  transaction: BudgetTransaction,
  loaded: AccountTransactions,
  repository: BudgetRepository,
): Promise<BudgetTransaction | undefined> {
  let counterpart = loaded.transactions.find((item) =>
    item.id === transaction.transfer_id && item.transfer_id === transaction.id &&
    item.account !== transaction.account,
  );
  if (counterpart) return counterpart;
  for (const account of loaded.accounts) {
    if (account.closed || account.id === transaction.account) continue;
    const candidates = await repository.listTransactions(account.id, '0001-01-01', '9999-12-31');
    counterpart = candidates.find((item) =>
      item.id === transaction.transfer_id && item.transfer_id === transaction.id &&
      item.account !== transaction.account,
    );
    if (counterpart) return counterpart;
  }
  return undefined;
}

async function persistTransferCounterpart(
  reply: FastifyReply,
  transaction: BudgetTransaction,
  counterpart: BudgetTransaction,
  parsed: UpdateRequest,
  nextAmount: number,
  write: SafeUpdate,
) {
  const pairFields: TransactionStructureUpdate = {
    ...(parsed.changes.date === undefined || !parsed.syncTransferDate ? {} : { date: parsed.changes.date }),
    ...(parsed.changes.amount === undefined ? {} : { amount: -nextAmount }),
    ...(parsed.changes.notes === undefined ? {} : { notes: parsed.changes.notes }),
  };
  if (Object.keys(pairFields).length > 0) {
    const result = await write(counterpart.id, counterpart.account, counterpart.date, pairFields);
    if (!result.persisted || !result.verified) {
      return reply.code(207).send({ data: {
        transactionId: transaction.id,
        counterpartTransactionId: counterpart.id,
        updatedFields: Object.keys(parsed.changes),
        updatedTransactionIds: [transaction.id],
        failedTransactionId: counterpart.id,
        persisted: true,
        verified: false,
        partial: true,
      } });
    }
  }
  return { data: {
    transactionId: transaction.id,
    counterpartTransactionId: counterpart.id,
    updatedFields: Object.keys(parsed.changes),
    updatedTransactionIds: Object.keys(pairFields).length > 0 ? [transaction.id, counterpart.id] : [transaction.id],
    persisted: true,
    verified: true,
    partial: false,
  } };
}

async function updateTransfer(
  reply: FastifyReply,
  transaction: BudgetTransaction,
  parsed: UpdateRequest,
  loaded: AccountTransactions,
  repository: BudgetRepository,
  write: SafeUpdate,
) {
  if (parsed.changes.category !== undefined || parsed.changes.imported_payee !== undefined) {
    return reply.code(409).send(invalidRequest(
      'For linked transfers, only date, amount, notes and cleared status may be edited.',
      'TRANSFER_FIELDS_RESTRICTED',
    ));
  }
  const counterpart = await findTransferCounterpart(transaction, loaded, repository);
  if (!counterpart || !loaded.accounts.some((account) => account.id === counterpart.account && !account.closed)) {
    return reply.code(409).send(invalidRequest(
      'The matching transfer leg is outside the active account scope or could not be verified. No changes were written.',
      'TRANSFER_COUNTERPART_NOT_AVAILABLE',
    ));
  }
  if (transaction.amount === 0 || counterpart.amount !== -transaction.amount) {
    return reply.code(409).send(invalidRequest(
      'The transfer pair is inconsistent. Review it in Actual Budget before editing.',
      'TRANSFER_PAIR_INCONSISTENT',
    ));
  }
  const nextAmount = parsed.changes.amount ?? transaction.amount;
  if (Math.sign(nextAmount) !== Math.sign(transaction.amount)) {
    return reply.code(400).send(invalidRequest(
      'Changing the direction of a linked transfer is not supported.',
      'TRANSFER_DIRECTION_CHANGE_NOT_ALLOWED',
    ));
  }
  const primaryFields: TransactionStructureUpdate = {
    ...(parsed.changes.date === undefined ? {} : { date: parsed.changes.date }),
    ...(parsed.changes.amount === undefined ? {} : { amount: nextAmount }),
    ...(parsed.changes.notes === undefined ? {} : { notes: parsed.changes.notes }),
    ...(parsed.changes.cleared === undefined ? {} : { cleared: parsed.changes.cleared }),
  };
  const primaryResult = await write(transaction.id, transaction.account, transaction.date, primaryFields);
  if (!primaryResult.persisted || !primaryResult.verified) {
    return reply.code(503).send(invalidRequest(
      'Actual Budget did not confirm the transfer update. Reopen the movement and verify both legs before retrying.',
      'TRANSACTION_PERSISTENCE_UNVERIFIED',
    ));
  }
  return persistTransferCounterpart(reply, transaction, counterpart, parsed, nextAmount, write);
}

function hasSafeSplitStructure(children: readonly BudgetTransaction[], parentAmount: number): boolean {
  if (children.length === 0 || children.some((child) => !child.id)) return false;
  if (new Set(children.map((child) => child.id)).size !== children.length) return false;
  const total = children.reduce((sum, child) => sum + child.amount, 0);
  return Number.isSafeInteger(total) && total === parentAmount;
}

function buildUpdatedChildren(
  children: readonly BudgetTransaction[],
  parent: BudgetTransaction,
  targetChild: BudgetTransaction,
  parsed: UpdateRequest,
  nextAmount: number,
  nextCategory: string | null,
  nextDate: string,
): BudgetTransaction[] {
  return children.map((child) => {
    const target = child.id === targetChild.id;
    return {
      ...child,
      account: child.account || parent.account,
      date: parsed.changes.date === undefined ? (child.date || parent.date) : nextDate,
      parent_id: parent.id,
      is_child: true,
      is_parent: false,
      ...(target && parsed.changes.amount !== undefined ? { amount: nextAmount } : {}),
      ...(target && parsed.changes.category !== undefined ? { category: nextCategory } : {}),
      ...(target && parsed.changes.notes !== undefined ? { notes: parsed.changes.notes } : {}),
    };
  });
}

async function updateSplitChild(
  reply: FastifyReply,
  parent: BudgetTransaction,
  child: BudgetTransaction,
  parsed: UpdateRequest,
  categories: Awaited<ReturnType<BudgetRepository['listCategories']>>,
  write: SafeUpdate,
) {
  const originalChildren = parent.subtransactions ?? [];
  if (!hasSafeSplitStructure(originalChildren, parent.amount)) {
    return reply.code(409).send(invalidRequest(
      'The split structure has missing or duplicate child IDs and cannot be safely edited.',
      'SPLIT_STRUCTURE_UNSAFE',
    ));
  }
  const nextChildAmount = parsed.changes.amount ?? child.amount;
  if (Math.sign(nextChildAmount) !== Math.sign(child.amount)) {
    return reply.code(400).send(invalidRequest(
      'A split part cannot change from expense to income or from income to expense in this editor.',
      'SPLIT_PART_DIRECTION_CHANGE_NOT_ALLOWED',
    ));
  }
  const nextCategory = Object.hasOwn(parsed.changes, 'category')
    ? parsed.changes.category ?? null : child.category ?? null;
  if (!categoryMatchesAmount(nextCategory, nextChildAmount, categories)) {
    return reply.code(400).send(invalidRequest(
      'The category must match the income or expense direction of this split part.',
      'CATEGORY_AMOUNT_MISMATCH',
    ));
  }
  if (parsed.changes.imported_payee !== undefined && parsed.changes.imported_payee.length > 500) {
    return reply.code(400).send(invalidRequest('The concept is too long.', 'INVALID_PAYEE'));
  }
  const nextDate = parsed.changes.date ?? parent.date;
  const updatedChildren = buildUpdatedChildren(
    originalChildren, parent, child, parsed, nextChildAmount, nextCategory, nextDate,
  );
  const nextTotal = updatedChildren.reduce((sum, item) => sum + item.amount, 0);
  if (!Number.isSafeInteger(nextTotal) || nextTotal === 0) {
    return reply.code(400).send(invalidRequest(
      'The resulting split total must be a safe, non-zero amount.',
      'INVALID_SPLIT_TOTAL',
    ));
  }
  const parentFields: TransactionStructureUpdate = {
    is_parent: true,
    subtransactions: updatedChildren,
    amount: nextTotal,
    ...(parsed.changes.date === undefined ? {} : { date: nextDate }),
    ...(parsed.changes.imported_payee === undefined ? {} : { imported_payee: parsed.changes.imported_payee }),
    ...(parsed.changes.cleared === undefined ? {} : { cleared: parsed.changes.cleared }),
  };
  const result = await write(parent.id, parent.account, parent.date, parentFields);
  if (!result.persisted || !result.verified) {
    return reply.code(503).send(invalidRequest(
      'Actual Budget did not confirm the split update. Reopen the movement and inspect the parent and all parts before retrying.',
      'TRANSACTION_PERSISTENCE_UNVERIFIED',
    ));
  }
  return { data: {
    transactionId: child.id,
    parentTransactionId: parent.id,
    updatedFields: Object.keys(parsed.changes),
    parentAmount: nextTotal,
    persisted: true,
    verified: true,
  } };
}

async function updateSimpleTransaction(
  reply: FastifyReply,
  transaction: BudgetTransaction,
  parsed: UpdateRequest,
  categories: Awaited<ReturnType<BudgetRepository['listCategories']>>,
  write: SafeUpdate,
  transactionId: string,
) {
  if (transaction.is_child || transaction.parent_id || transaction.is_parent || (transaction.subtransactions?.length ?? 0) > 0) {
    return reply.code(409).send(invalidRequest(
      'This split row cannot be resolved to a complete, verifiable parent structure.',
      'SPLIT_EDIT_NOT_SUPPORTED',
    ));
  }
  if (parsed.changes.category !== undefined || parsed.changes.amount !== undefined) {
    const categoryId = Object.hasOwn(parsed.changes, 'category')
      ? parsed.changes.category ?? null : transaction.category ?? null;
    const amount = parsed.changes.amount ?? transaction.amount;
    if (!categoryMatchesAmount(categoryId, amount, categories)) {
      const exists = categories.some((item) => item.id === categoryId);
      return reply.code(400).send(invalidRequest(
        exists
          ? 'Income movements require an income category and expense movements require an expense category.'
          : 'Choose a category from the configured budget.',
        exists ? 'CATEGORY_AMOUNT_MISMATCH' : 'INVALID_CATEGORY',
      ));
    }
  }
  const update: TransactionStructureUpdate = {
    ...(parsed.changes.date === undefined ? {} : { date: parsed.changes.date }),
    ...(parsed.changes.amount === undefined ? {} : { amount: parsed.changes.amount }),
    ...(parsed.changes.imported_payee === undefined ? {} : { imported_payee: parsed.changes.imported_payee }),
    ...(parsed.changes.category === undefined ? {} : { category: parsed.changes.category }),
    ...(parsed.changes.notes === undefined ? {} : { notes: parsed.changes.notes }),
    ...(parsed.changes.cleared === undefined ? {} : { cleared: parsed.changes.cleared }),
  };
  const result = await write(transaction.id, transaction.account, transaction.date, update);
  if (!result.persisted || !result.verified) {
    return reply.code(503).send(invalidRequest(
      'Actual Budget did not confirm the edit. Reopen the movement and verify its stored values before retrying.',
      'TRANSACTION_PERSISTENCE_UNVERIFIED',
    ));
  }
  return { data: {
    transactionId,
    updatedFields: Object.keys(parsed.changes),
    persisted: true,
    verified: true,
  } };
}

export async function handleTransactionUpdate(
  requestParams: unknown,
  requestBody: unknown,
  reply: FastifyReply,
  dependencies: {
    readonly repository: BudgetRepository;
    readonly openAccountTransactions: (accountId: string | undefined, startDate: string, endDate: string) => Promise<AccountTransactions>;
    readonly assertPeriod: (startDate: string, endDate: string) => void;
  },
) {
  const { repository, openAccountTransactions, assertPeriod } = dependencies;
  const params = z.object({ transactionId: z.string().trim().min(1).max(128) }).strict().parse(requestParams);
  const parsed = TransactionUpdateRequestSchema.parse(requestBody);
  assertPeriod(parsed.startDate, parsed.endDate);
  if (!repository.updateTransactionSafely) {
    return reply.code(503).send(invalidRequest(
      'The configured local adapter cannot verify transaction writes; no changes were written.',
      'TRANSACTION_SAFE_UPDATE_NOT_SUPPORTED',
    ));
  }
  const loaded = await openAccountTransactions(undefined, parsed.startDate, parsed.endDate);
  if (!loaded.accounts.some((account) => account.id === parsed.accountId && !account.closed)) {
    return reply.code(400).send(invalidRequest(
      'Choose an open account from the configured account scope.',
      'INVALID_ACCOUNT',
    ));
  }
  const target = findTargetTransaction(loaded.transactions, params.transactionId, parsed.accountId);
  if (!target) {
    return reply.code(404).send(invalidRequest(
      'The transaction does not belong to the selected account and date range.',
      'INVALID_TRANSACTION',
    ));
  }
  const { transaction, splitParent, splitChild } = target;
  const write = createSafeWriter(repository);
  const categories = await repository.listCategories();
  if (transaction.transfer_id) {
    return updateTransfer(reply, transaction, parsed, loaded, repository, write);
  }
  if (splitParent && splitChild) {
    return updateSplitChild(reply, splitParent, splitChild, parsed, categories, write);
  }
  return updateSimpleTransaction(reply, transaction, parsed, categories, write, params.transactionId);
}
