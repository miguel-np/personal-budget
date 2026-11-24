import {
  convertAmountMinor,
  normalizeCurrencyCode,
} from '@personal-budget/finance-core';
import type {
  BudgetAccount,
  BudgetCategory,
  BudgetRepository,
  BudgetTransaction,
} from '@personal-budget/finance-core';
import type { CurrencyPreferences } from './currency-preferences.js';

export interface TransactionQueryInput {
  readonly accountId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly search?: string | undefined;
  readonly uncategorized?: 'true' | 'false' | undefined;
  readonly startDate: string;
  readonly endDate: string;
  readonly limit: number;
  readonly offset: number;
  readonly sortBy: 'date' | 'amount' | 'description';
  readonly order: 'asc' | 'desc';
}

export type PresentedTransaction = BudgetTransaction & {
  readonly payee_name?: string | null;
  readonly imported_payee?: string | null;
  readonly is_split_child?: boolean;
  readonly parent_transaction_id?: string;
  readonly is_split_editable?: boolean;
};

export class TransactionQueryTooBroadError extends Error {
  public constructor() {
    super('The transaction query exceeded the bounded scan budget.');
    this.name = 'TransactionQueryTooBroadError';
  }
}

const MAX_TRANSACTION_SCAN = 100_000;

function* transactionDateRanges(startDate: string, endDate: string): Generator<{ startDate: string; endDate: string }> {
  let cursor = startDate;
  while (cursor <= endDate) {
    const boundary = new Date(cursor + 'T00:00:00.000Z');
    boundary.setUTCDate(1);
    boundary.setUTCMonth(boundary.getUTCMonth() + 1);
    boundary.setUTCDate(0);
    const monthEnd = boundary.toISOString().slice(0, 10);
    const rangeEnd = monthEnd < endDate ? monthEnd : endDate;
    yield { startDate: cursor, endDate: rangeEnd };
    const next = new Date(rangeEnd + 'T00:00:00.000Z');
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
}

function descriptionOf(transaction: PresentedTransaction): string {
  return transaction.payee_name || transaction.imported_payee ||
    transaction.notes || transaction.payee_id || '';
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createTransactionComparator(query: TransactionQueryInput) {
  return (left: PresentedTransaction, right: PresentedTransaction): number => {
    let comparison = 0;
    if (query.sortBy === 'amount') {
      comparison = left.amount < right.amount ? -1 : left.amount > right.amount ? 1 : 0;
    } else if (query.sortBy === 'description') {
      comparison = descriptionOf(left).localeCompare(descriptionOf(right), 'es');
    } else {
      comparison = compareText(left.date, right.date);
    }
    if (comparison !== 0) return query.order === 'asc' ? comparison : -comparison;
    if (query.sortBy !== 'date') {
      comparison = compareText(left.date, right.date);
      if (comparison !== 0) return query.order === 'asc' ? comparison : -comparison;
    }
    comparison = compareText(left.id, right.id);
    return comparison !== 0 ? comparison : compareText(left.account, right.account);
  };
}

function createTransactionFilter(
  query: TransactionQueryInput,
  accounts: readonly BudgetAccount[],
  categories: readonly BudgetCategory[],
) {
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const queryText = query.search?.toLocaleLowerCase('es') ?? '';
  return (transaction: PresentedTransaction): boolean => {
    if (query.categoryId && transaction.category !== query.categoryId) return false;
    if (query.uncategorized === 'true' && transaction.category) return false;
    if (query.uncategorized === 'false' && !transaction.category) return false;
    if (!queryText) return true;
    const description = descriptionOf(transaction);
    const accountName = accountsById.get(transaction.account)?.name ?? '';
    const categoryName = categoriesById.get(transaction.category ?? '')?.name ?? '';
    return [description, accountName, categoryName, transaction.notes ?? '']
      .some((value) => value.toLocaleLowerCase('es').includes(queryText));
  };
}

class BoundedTransactionCollector {
  private readonly selected: PresentedTransaction[] = [];
  private total = 0;
  private scanned = 0;

  public constructor(
    private readonly maximumSelected: number,
    private readonly matches: (transaction: PresentedTransaction) => boolean,
    private readonly compare: (left: PresentedTransaction, right: PresentedTransaction) => number,
  ) {}

  public add(transaction: PresentedTransaction): void {
    this.scanned += 1;
    if (this.scanned > MAX_TRANSACTION_SCAN) throw new TransactionQueryTooBroadError();
    if (!this.matches(transaction)) return;
    this.total += 1;
    if (this.selected.length < this.maximumSelected) {
      this.selected.push(transaction);
      this.siftUp(this.selected.length - 1);
      return;
    }
    if (this.selected.length > 0 && this.compare(transaction, this.selected[0]!) < 0) {
      this.selected[0] = transaction;
      this.siftDown(0);
    }
  }

  public page(offset: number, limit: number): { readonly total: number; readonly items: readonly PresentedTransaction[] } {
    this.selected.sort(this.compare);
    return { total: this.total, items: this.selected.slice(offset, offset + limit) };
  }

  private siftUp(index: number): void {
    let child = index;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (this.compare(this.selected[child]!, this.selected[parent]!) <= 0) break;
      [this.selected[parent], this.selected[child]] = [this.selected[child]!, this.selected[parent]!];
      child = parent;
    }
  }

  private siftDown(index: number): void {
    let parent = index;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let worst = parent;
      if (left < this.selected.length && this.compare(this.selected[left]!, this.selected[worst]!) > 0) worst = left;
      if (right < this.selected.length && this.compare(this.selected[right]!, this.selected[worst]!) > 0) worst = right;
      if (worst === parent) return;
      [this.selected[parent], this.selected[worst]] = [this.selected[worst]!, this.selected[parent]!];
      parent = worst;
    }
  }
}

function* expandTransactions(
  source: BudgetTransaction,
  accountId: string,
  nativeCurrency: string | null,
): Generator<PresentedTransaction> {
  const transaction = source as PresentedTransaction;
  if (transaction.is_child === true || transaction.parent_id) return;
  const parentCurrency = normalizeCurrencyCode(transaction.currencyCode) ??
    normalizeCurrencyCode(transaction.currency_code) ?? nativeCurrency;
  if (!transaction.subtransactions?.length) {
    yield { ...transaction, currencyCode: parentCurrency };
    return;
  }
  for (let index = 0; index < transaction.subtransactions.length; index += 1) {
    const child = transaction.subtransactions[index]! as PresentedTransaction;
    const payeeId = child.payee_id ?? transaction.payee_id;
    const payeeName = child.payee_name ?? transaction.payee_name;
    const importedPayee = child.imported_payee ?? transaction.imported_payee;
    yield {
      ...child,
      id: child.id || transaction.id + ':split:' + index,
      account: child.account || transaction.account || accountId,
      date: child.date || transaction.date,
      currencyCode: normalizeCurrencyCode(child.currencyCode) ??
        normalizeCurrencyCode(child.currency_code) ?? parentCurrency,
      ...(payeeId === undefined ? {} : { payee_id: payeeId }),
      ...(payeeName === undefined ? {} : { payee_name: payeeName }),
      ...(importedPayee === undefined ? {} : { imported_payee: importedPayee }),
      is_child: false,
      parent_id: null,
      is_split_child: true,
      parent_transaction_id: transaction.id,
      is_split_editable: Boolean(child.id),
    };
  }
}

async function collectAccountTransactions(
  account: BudgetAccount,
  preferences: CurrencyPreferences,
  query: TransactionQueryInput,
  repository: Pick<BudgetRepository, 'listTransactions'>,
  collector: BoundedTransactionCollector,
): Promise<void> {
  const nativeCurrency = normalizeCurrencyCode(account.currencyCode) ??
    normalizeCurrencyCode(preferences.accountCurrencyOverrides[account.id]);
  for (const range of transactionDateRanges(query.startDate, query.endDate)) {
    const transactions = await repository.listTransactions(account.id, range.startDate, range.endDate);
    for (const transaction of transactions) {
      for (const candidate of expandTransactions(transaction, account.id, nativeCurrency)) collector.add(candidate);
    }
  }
}

function presentTransactions(
  transactions: readonly PresentedTransaction[],
  preferences: CurrencyPreferences,
) {
  return transactions.map((transaction) => {
    const sourceCurrency = normalizeCurrencyCode(transaction.currencyCode) ??
      normalizeCurrencyCode(transaction.currency_code);
    const conversion = convertAmountMinor(
      transaction.amount, sourceCurrency, preferences.displayCurrency,
      transaction.date, preferences.exchangeRates,
    );
    return {
      ...transaction,
      currencyCode: sourceCurrency,
      displayCurrency: preferences.displayCurrency,
      displayAmountMinor: conversion.amountMinor,
      conversion: {
        fromCurrency: conversion.fromCurrency, toCurrency: conversion.toCurrency,
        rate: conversion.rate, effectiveDate: conversion.effectiveDate,
        source: conversion.source, inverseRate: conversion.inverseRate,
        ...(conversion.warning ? { warning: conversion.warning } : {}),
      },
    };
  });
}

export async function queryTransactions(
  query: TransactionQueryInput,
  accounts: readonly BudgetAccount[],
  categories: readonly BudgetCategory[],
  preferences: CurrencyPreferences,
  repository: Pick<BudgetRepository, 'listTransactions'>,
) {
  const compare = createTransactionComparator(query);
  const matches = createTransactionFilter(query, accounts, categories);
  const collector = new BoundedTransactionCollector(query.offset + query.limit, matches, compare);
  for (const account of accounts) {
    await collectAccountTransactions(account, preferences, query, repository, collector);
  }
  const page = collector.page(query.offset, query.limit);
  return {
    data: presentTransactions(page.items, preferences),
    pagination: {
      total: page.total, limit: query.limit, offset: query.offset,
      sortBy: query.sortBy, order: query.order,
    },
  };
}
