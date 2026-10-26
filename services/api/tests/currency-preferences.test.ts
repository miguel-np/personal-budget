import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCurrencyPreferences, writeCurrencyPreferences } from '../src/currency-preferences.js';

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('local currency preferences', () => {
  it('defaults to EUR without inventing account currencies or rates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'budget-currency-'));
    tempDirs.push(directory);
    await expect(readCurrencyPreferences(directory, 'EUR')).resolves.toEqual({
      displayCurrency: 'EUR', accountCurrencyOverrides: {}, exchangeRates: [],
    });
  });

  it('persists display currency, explicit account currencies and dated manual rates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'budget-currency-'));
    tempDirs.push(directory);
    const preferences = {
      displayCurrency: 'USD',
      accountCurrencyOverrides: { accountA: 'EUR' },
      exchangeRates: [{ fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.08', effectiveDate: '2026-10-20', source: 'manual' }],
    };
    await writeCurrencyPreferences(directory, preferences);
    expect(await readCurrencyPreferences(directory, 'EUR')).toEqual(preferences);
    expect(await readFile(join(directory, 'currency-preferences.json'), 'utf8')).not.toContain('secret');
  });

  it('rejects malformed rates and duplicate effective dates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'budget-currency-'));
    tempDirs.push(directory);
    await expect(writeCurrencyPreferences(directory, {
      displayCurrency: 'EUR', accountCurrencyOverrides: {},
      exchangeRates: [{ fromCurrency: 'EUR', toCurrency: 'USD', rate: '0', effectiveDate: '2026-10-20', source: 'manual' }],
    })).rejects.toThrow();
    await expect(writeCurrencyPreferences(directory, {
      displayCurrency: 'EUR', accountCurrencyOverrides: {},
      exchangeRates: [
        { fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.08', effectiveDate: '2026-10-20', source: 'manual' },
        { fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.09', effectiveDate: '2026-10-20', source: 'manual correction' },
      ],
    })).rejects.toThrow(/one rate/i);
  });
});
