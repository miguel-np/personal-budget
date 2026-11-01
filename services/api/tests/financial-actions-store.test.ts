import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyFinancialActionState, readFinancialActionState, updateFinancialActionState } from '../src/financial-actions-store.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe('financial action state', () => {
  it('defaults safely and atomically stores settings without movement data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'financial-actions-')); dirs.push(dir);
    expect(await readFinancialActionState(dir)).toEqual(emptyFinancialActionState());
    await updateFinancialActionState(dir, (current) => ({
      state: { ...current, budgetAlerts: { rules: [{ id: '00000000-0000-4000-8000-000000000001', categoryId: 'food', metric: 'percent_used', threshold: 90, enabled: true }], events: [] } },
      result: true,
    }));
    const saved = await readFinancialActionState(dir);
    expect(saved.budgetAlerts.rules).toHaveLength(1);
    expect(await readFile(join(dir, 'financial-actions.json'), 'utf8')).not.toContain('transaction');
  });
  it('serializes concurrent writes and rejects duplicate category preferences', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'financial-actions-')); dirs.push(dir);
    await Promise.all(Array.from({ length: 10 }, (_, index) => updateFinancialActionState(dir, (current) => ({
      state: { ...current, budgetImprovements: { ...current.budgetImprovements, categories: [...current.budgetImprovements.categories, { categoryId: 'category-' + index, classification: 'flexible' }] } },
      result: index,
    }))));
    expect((await readFinancialActionState(dir)).budgetImprovements.categories).toHaveLength(10);
    await expect(updateFinancialActionState(dir, (current) => ({
      state: { ...current, budgetImprovements: { ...current.budgetImprovements, categories: [{ categoryId: 'x', classification: 'essential' }, { categoryId: 'x', classification: 'flexible' }] } },
      result: undefined,
    }))).rejects.toThrow(/unique/);
  });
});
