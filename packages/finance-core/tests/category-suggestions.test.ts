import { describe, expect, it } from 'vitest';
import type { BudgetCategory, BudgetTransaction } from '../src/domain.js';
import { suggestCategories } from '../src/category-suggestions.js';

const categories: readonly BudgetCategory[] = [
  { id: 'salary', name: 'Salario', groupId: 'income', isIncome: true },
  { id: 'food', name: 'Alimentación', groupId: 'spend', isIncome: false },
  { id: 'home', name: 'Hogar', groupId: 'spend', isIncome: false },
];

function expense(id: string, date: string, amount: number, payee: string, category: string | null = null, overrides: Partial<BudgetTransaction> = {}): BudgetTransaction {
  return { id, account: 'account-1', date, amount, payee_name: payee, category, transfer_id: null, ...overrides };
}

const october = { startDate: '2026-10-01', endDate: '2026-10-31' };

describe('suggestCategories', () => {
  it('suggests the dominant historical category of a payee', () => {
    const transactions = [
      expense('h1', '2026-08-03', -4200, 'Supermercado', 'food'),
      expense('h2', '2026-09-05', -3100, 'Supermercado', 'food'),
      expense('u1', '2026-10-07', -3890, 'Supermercado'),
      expense('u2', '2026-10-12', -1200, 'Desconocido'),
    ];
    const suggestions = suggestCategories(transactions, categories, october);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      transactionId: 'u1',
      suggestedCategoryId: 'food',
      suggestedCategoryName: 'Alimentación',
      evidenceCount: 2,
      confidence: 'rule_based',
    });
  });

  it('breaks category ties with the most recent evidence', () => {
    const transactions = [
      expense('h1', '2026-06-01', -1000, 'Mercado', 'food'),
      expense('h2', '2026-07-01', -1000, 'Mercado', 'home'),
      expense('h3', '2026-09-01', -1000, 'Mercado', 'home'),
      expense('u1', '2026-10-02', -1100, 'Mercado'),
    ];
    const suggestions = suggestCategories(transactions, categories, october);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.suggestedCategoryId).toBe('home');
  });

  it('never suggests income categories', () => {
    const transactions = [
      expense('h1', '2026-09-01', -1000, 'Empresa', 'salary'),
      expense('u1', '2026-10-02', -1000, 'Empresa'),
    ];
    expect(suggestCategories(transactions, categories, october)).toHaveLength(0);
  });

  it('ignores positive uncategorized amounts and transactions without payee', () => {
    const transactions = [
      expense('h1', '2026-09-01', -1000, 'Tienda', 'food'),
      expense('u1', '2026-10-02', 5000, 'Tienda'),
      expense('u2', '2026-10-03', -900, ''),
      expense('u3', '2026-10-04', -900, 'Tienda', null, { transfer_id: 'transfer-pair' }),
    ];
    expect(suggestCategories(transactions, categories, october)).toHaveLength(0);
  });

  it('only suggests for uncategorized rows inside the requested period', () => {
    const transactions = [
      expense('h1', '2026-10-05', -1000, 'Mercado', 'food'),
      expense('u1', '2026-11-02', -1100, 'Mercado'),
    ];
    expect(suggestCategories(transactions, categories, october)).toHaveLength(0);
    expect(suggestCategories(transactions, categories, { startDate: '2026-11-01', endDate: '2026-11-30' })).toHaveLength(1);
  });

  it('uses split children through normalized entries', () => {
    const parent: BudgetTransaction = {
      ...expense('parent', '2026-10-03', -1000, '', null, { is_parent: true }),
      subtransactions: [expense('split-a', '2026-10-03', -700, 'Mercado')],
    };
    const transactions = [
      expense('h1', '2026-09-01', -900, 'Mercado', 'food'),
      parent,
    ];
    const suggestions = suggestCategories(transactions, categories, october);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.transactionId).toBe('split-a');
  });
});
