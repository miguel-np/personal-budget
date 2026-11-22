import type * as ActualApiNamespace from '@actual-app/api';
import { describe, expect, it, vi } from 'vitest';
import { createActualApiContract } from '../src/create-actual-api-contract.js';

describe('Actual API contract factory', () => {
  it('reads only adapter dependencies from the SDK namespace', async () => {
    const originalBudgetAllocations = vi.fn(async () => ({ data: [] }));
    const aqlQuery = vi.fn(async () => ({
      data: [{ category: 'food', amount: 1250 }],
    }));
    const query = vi.fn(() => ({
      filter: vi.fn(() => ({
        select: vi.fn(() => ({})),
      })),
    }));
    const init = vi.fn(async () => undefined);
    const namespace = Object.create(null) as Record<string, unknown>;

    Object.defineProperties(namespace, {
      getBudgetAllocations: { value: originalBudgetAllocations, enumerable: true },
      aqlQuery: { value: aqlQuery, enumerable: true },
      q: { value: query, enumerable: true },
      init: { value: init, enumerable: true },
      internal: { enumerable: true, get() { throw new TypeError('unrelated SDK binding must not be evaluated'); } },
    });

    const contract = createActualApiContract(namespace as unknown as typeof ActualApiNamespace);

    expect(contract.init).toBe(init);
    expect(contract.getBudgetAllocations).not.toBe(originalBudgetAllocations);
    await expect(contract.getBudgetAllocations?.('2026-10')).resolves.toEqual([
      { categoryId: 'food', amountMinor: 1250 },
      { categoryId: 'food', amountMinor: 1250 },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(aqlQuery).toHaveBeenCalledTimes(2);
  });
});
