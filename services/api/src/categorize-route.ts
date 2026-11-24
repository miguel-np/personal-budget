import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { isIsoDate } from '@personal-budget/finance-core';
import type { BudgetRepository, BudgetTransaction } from '@personal-budget/finance-core';

export const CategorizeRequestSchema = z.object({
  startDate: z.string().refine(isIsoDate, 'startDate must be a valid YYYY-MM-DD date.'),
  endDate: z.string().refine(isIsoDate, 'endDate must be a valid YYYY-MM-DD date.'),
  commit: z.boolean().default(false),
  transactions: z.array(z.object({
    transactionId: z.string().trim().min(1).max(128),
    categoryId: z.string().trim().min(1).max(128),
    expectedCategoryId: z.string().trim().min(1).max(128).nullable().optional(),
  }).strict()).min(1).max(200).superRefine((changes, context) => {
    const seen = new Set<string>();
    changes.forEach((change, index) => {
      if (seen.has(change.transactionId)) context.addIssue({ code: 'custom', path: [index, 'transactionId'], message: 'Transaction ids must be unique.' });
      seen.add(change.transactionId);
    });
  }),
}).strict().superRefine((value, context) => {
  if (!value.commit) return;
  value.transactions.forEach((change, index) => {
    if (change.expectedCategoryId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['transactions', index, 'expectedCategoryId'],
        message: 'A confirmed category batch must include its preview baseline.',
      });
    }
  });
});

type CategorizeRequest = z.infer<typeof CategorizeRequestSchema>;
type OpenTransactions = {
  readonly transactions: readonly BudgetTransaction[];
};
type SanitizedError = {
  readonly statusCode: number;
  readonly body: { readonly error: { readonly code: string; readonly message: string } };
};

interface Dependencies {
  readonly repository: BudgetRepository;
  readonly openAccountTransactions: (
    accountId: string | undefined, startDate: string, endDate: string,
  ) => Promise<OpenTransactions>;
  readonly assertPeriod: (startDate: string, endDate: string) => void;
  readonly sanitizedErrorResponse: (error: unknown) => SanitizedError;
}

interface ValidationFailure {
  readonly statusCode: number;
  readonly error: { readonly code: string; readonly message: string; readonly transactionId?: string };
}

function validateTargetTransactions(
  changes: CategorizeRequest['transactions'],
  commit: boolean,
  transactionById: ReadonlyMap<string, BudgetTransaction>,
): ValidationFailure | null {
  for (const change of changes) {
    const transaction = transactionById.get(change.transactionId);
    if (!transaction) {
      return {
        statusCode: 400,
        error: { code: 'INVALID_TRANSACTION', message: 'One or more transaction ids do not belong to an open account in the period.' },
      };
    }
    if (commit && change.expectedCategoryId !== (transaction.category ?? null)) {
      return {
        statusCode: 409,
        error: {
          code: 'TRANSACTION_CHANGED_SINCE_PREVIEW',
          message: 'One or more selected transactions or categories changed after preview. Review the current movements and preview the batch again; no changes were written.',
          transactionId: change.transactionId,
        },
      };
    }
    if (transaction.amount >= 0) {
      return {
        statusCode: 400,
        error: { code: 'CATEGORY_AMOUNT_MISMATCH', message: 'Bulk categorization is limited to ordinary expense movements.' },
      };
    }
    if (transaction.transfer_id) {
      return {
        statusCode: 409,
        error: { code: 'TRANSFER_EDIT_NOT_SUPPORTED', message: 'Transfer transactions are protected from bulk category changes.' },
      };
    }
    if (transaction.is_parent || (transaction.subtransactions?.length ?? 0) > 0) {
      return {
        statusCode: 409,
        error: { code: 'SPLIT_EDIT_NOT_SUPPORTED', message: 'Split transactions are protected from bulk category changes.' },
      };
    }
  }
  return null;
}

async function validateExpenseCategories(
  changes: CategorizeRequest['transactions'],
  repository: BudgetRepository,
): Promise<ValidationFailure | null> {
  const categories = await repository.listCategories();
  const expenseCategories = new Set(categories.filter((category) => !category.isIncome).map((category) => category.id));
  return changes.some((change) => !expenseCategories.has(change.categoryId))
    ? {
      statusCode: 400,
      error: { code: 'INVALID_CATEGORY', message: 'Choose an expense category from the configured budget.' },
    }
    : null;
}

function createPreview(
  changes: CategorizeRequest['transactions'],
  transactionById: ReadonlyMap<string, BudgetTransaction>,
) {
  const baseline = changes.map((change) => ({
    transactionId: change.transactionId,
    expectedCategoryId: transactionById.get(change.transactionId)!.category ?? null,
  }));
  return { data: { preview: true, requested: changes.length, changes: changes.length, baseline } };
}

async function buildVerifiedChanges(
  changes: CategorizeRequest['transactions'],
  transactionById: ReadonlyMap<string, BudgetTransaction>,
) {
  return changes.map((change) => {
    const transaction = transactionById.get(change.transactionId);
    if (!transaction) throw new Error('Transaction disappeared during category batch validation.');
    return {
      ...change,
      accountId: transaction.account,
      date: transaction.date,
      expectedCategoryId: change.expectedCategoryId ?? null,
    };
  });
}

function partialBatchResponse(
  changes: CategorizeRequest['transactions'],
  outcome: NonNullable<BudgetRepository['updateTransactionCategoriesBatch']> extends (...args: never[]) => Promise<infer T> ? T : never,
) {
  const applied = outcome.updatedTransactionIds.length;
  if (outcome.conflictTransactionId && applied === 0) {
    return {
      statusCode: 409,
      body: { error: {
        code: 'TRANSACTION_CHANGED_SINCE_PREVIEW',
        message: 'The transaction or category no longer matches the preview. Review the current movements and preview the batch again; no changes were written by this attempt.',
        transactionId: outcome.conflictTransactionId,
      } },
    };
  }
  const appliedIds = new Set(outcome.updatedTransactionIds);
  const pendingTransactionIds = changes.map((change) => change.transactionId)
    .filter((transactionId) => !appliedIds.has(transactionId));
  return {
    statusCode: 207,
    body: { data: {
      preview: false,
      requested: outcome.requested,
      applied,
      changes: applied,
      appliedTransactionIds: outcome.updatedTransactionIds,
      pendingTransactionIds,
      ...(outcome.failedTransactionId ? { failedTransactionId: outcome.failedTransactionId } : {}),
      ...(outcome.conflictTransactionId ? { conflictTransactionId: outcome.conflictTransactionId } : {}),
      persisted: outcome.persisted,
      partial: true,
      message: outcome.conflictTransactionId
        ? 'The transaction or category no longer matches the preview at the indicated transaction id. Earlier listed updates are verified; only the remaining selections are pending and must be previewed again.'
        : outcome.updatedTransactionIds.length > 0
          ? 'Some changes were verified and synced. The batch stopped at the indicated transaction id; inspect that movement in Actual before retrying. No automatic undo was attempted.'
          : 'No change was confirmed as persisted. Inspect the indicated movement in Actual before retrying; no automatic undo was attempted.',
    } },
  };
}

export async function handleCategorizeRequest(
  requestBody: unknown,
  reply: FastifyReply,
  dependencies: Dependencies,
) {
  try {
    const parsed = CategorizeRequestSchema.parse(requestBody);
    dependencies.assertPeriod(parsed.startDate, parsed.endDate);
    const { transactions } = await dependencies.openAccountTransactions(
      undefined, parsed.startDate, parsed.endDate,
    );
    const transactionById = new Map(transactions
      .filter((transaction) => !transaction.is_child && !transaction.parent_id)
      .map((transaction) => [transaction.id, transaction]));
    const transactionFailure = validateTargetTransactions(parsed.transactions, parsed.commit, transactionById);
    if (transactionFailure) return reply.code(transactionFailure.statusCode).send({ error: transactionFailure.error });
    const categoryFailure = await validateExpenseCategories(parsed.transactions, dependencies.repository);
    if (categoryFailure) return reply.code(categoryFailure.statusCode).send({ error: categoryFailure.error });
    if (!parsed.commit) return createPreview(parsed.transactions, transactionById);
    if (typeof dependencies.repository.updateTransactionCategoriesBatch !== 'function') {
      return reply.code(503).send({ error: {
        code: 'TRANSACTION_BATCH_UPDATE_NOT_SUPPORTED',
        message: 'The configured adapter cannot verify category batch outcomes; no transaction was changed.',
      } });
    }
    const verifiedChanges = await buildVerifiedChanges(parsed.transactions, transactionById);
    const outcome = await dependencies.repository.updateTransactionCategoriesBatch(verifiedChanges);
    const complete = outcome.updatedTransactionIds.length === outcome.requested && outcome.persisted;
    if (!complete) {
      const partial = partialBatchResponse(parsed.transactions, outcome);
      return reply.code(partial.statusCode).send(partial.body);
    }
    return { data: {
      preview: false,
      requested: outcome.requested,
      applied: outcome.updatedTransactionIds.length,
      changes: outcome.updatedTransactionIds.length,
      appliedTransactionIds: outcome.updatedTransactionIds,
      persisted: true,
      partial: false,
    } };
  } catch (error) {
    const normalized = dependencies.sanitizedErrorResponse(error);
    return reply.code(normalized.statusCode).send(normalized.body);
  }
}
