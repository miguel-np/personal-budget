import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  WealthDataSchema, calculateQuantityAmountMinor, emptyWealthData, readWealthData, updateWealthData,
} from '../src/wealth-store.js';

const directories: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'personal-budget-wealth-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const baseData = () => ({
  version: 1 as const,
  settings: { staleAfterDays: 90, includeOffBudgetAccounts: true },
  accountClassifications: [],
  assets: [],
});
const asset = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Activo',
  kind: 'cash_external',
  currency: 'EUR',
  status: 'active',
  includeInNetWorth: true,
  valuations: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});
const valuation = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000002',
  valuedAt: '2026-11-01',
  amountMinor: 1_000,
  currency: 'EUR',
  source: 'manual',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

describe('wealth store internals', () => {
  it('provides empty defaults and falls back when state is missing', async () => {
    expect(emptyWealthData()).toEqual({ version: 1, settings: { staleAfterDays: 90, includeOffBudgetAccounts: true }, accountClassifications: [], assets: [] });
    const data = await readWealthData(await directory());
    expect(data).toEqual(emptyWealthData());
  });

  it('applies schema defaults and rejects malformed state', async () => {
    const parsed = WealthDataSchema.parse({ version: 1, settings: {}, accountClassifications: [], assets: [] });
    expect(parsed.settings).toEqual({ staleAfterDays: 90, includeOffBudgetAccounts: true });
    expect(() => WealthDataSchema.parse({ ...baseData(), settings: { staleAfterDays: 7 } })).toThrow(ZodError);
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [asset({ currency: 'eu' })] })).toThrow(ZodError);
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [asset({ valuations: [valuation({ valuedAt: '2026-02-30' })] })] })).toThrow(ZodError);
    const dir = await directory();
    const statePath = join(dir, 'wealth-data.json');
    await mkdir(statePath, { recursive: true });
    await expect(readWealthData(dir)).rejects.toThrow();
  });

  it('rejects duplicate ids, duplicate Actual links and misconfigured valuations', () => {
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [asset(), asset()] })).toThrow(ZodError);
    const linked = asset({ actualAccountId: 'actual-account-001', includeInNetWorth: false });
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [linked, { ...linked, id: '00000000-0000-4000-8000-000000000003' }] })).toThrow(ZodError);
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [asset({ actualAccountId: 'actual-account-001', includeInNetWorth: true })] })).toThrow(ZodError);
    const wrongCurrency = valuation({ currency: 'USD' });
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [asset({ valuations: [wrongCurrency] })] })).toThrow(ZodError);
    const duplicateValuations = [valuation(), { ...valuation(), id: valuation().id }];
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [asset({ valuations: duplicateValuations })] })).toThrow(ZodError);
    const quantityOnly = valuation({ quantity: '2', unitPriceMinor: undefined, amountMinor: 200 });
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [asset({ valuations: [quantityOnly] })] })).toThrow(RangeError);
    const unitPriceOnly = valuation({ unitPriceMinor: 200, amountMinor: 200 });
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [asset({ valuations: [unitPriceOnly] })] })).toThrow(ZodError);
    const wrongAmount = valuation({ quantity: '2', unitPriceMinor: 100, amountMinor: 999 });
    expect(() => WealthDataSchema.parse({ ...baseData(), assets: [asset({ valuations: [wrongAmount] })] })).toThrow(ZodError);
    expect(() => WealthDataSchema.parse({
      ...baseData(),
      accountClassifications: [
        { accountId: 'actual-account-001', classification: 'asset', updatedAt: '2026-11-01T00:00:00.000Z' },
        { accountId: 'actual-account-001', classification: 'liability', updatedAt: '2026-11-01T00:00:00.000Z' },
      ],
    })).toThrow(ZodError);
  });

  it('calculates quantity amounts deterministically with guarded inputs', () => {
    expect(calculateQuantityAmountMinor('1.5', 20_000)).toBe(30_000);
    expect(calculateQuantityAmountMinor('0.001', 1_000)).toBe(1);
    expect(() => calculateQuantityAmountMinor('2', -1)).toThrow(RangeError);
    expect(() => calculateQuantityAmountMinor('dos', 100)).toThrow(RangeError);
    expect(() => calculateQuantityAmountMinor('9999999999999999', 10_000_000_000_000)).toThrow(RangeError);
  });

  it('persists state through the serialized update path', async () => {
    const dir = await directory();
    const created = await updateWealthData(dir, (current) => ({
      data: { ...current, settings: { ...current.settings, includeOffBudgetAccounts: false } },
      result: 'ok',
    }));
    expect(created).toBe('ok');
    const stored = await readWealthData(dir);
    expect(stored.settings.includeOffBudgetAccounts).toBe(false);
  });
});
