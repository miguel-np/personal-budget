import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { isIsoDate, normalizeCurrencyCode } from '@personal-budget/finance-core';
import type { ExchangeRate } from '@personal-budget/finance-core';

const CurrencyCode = z.string().trim().transform((value) => value.toUpperCase()).refine((value) => /^[A-Z]{3}$/.test(value), 'Currency must be a three-letter ISO code.');
const Rate = z.object({
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rate: z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,12})?$/).refine((value) => Number(value) > 0, 'Rate must be positive.'),
  effectiveDate: z.string().refine(isIsoDate, 'Rate date must use YYYY-MM-DD.'),
  source: z.string().trim().min(1).max(100),
}).strict().refine((rate) => rate.fromCurrency !== rate.toCurrency, 'Source and target currency must differ.');

export const CurrencyPreferencesSchema = z.object({
  displayCurrency: CurrencyCode,
  accountCurrencyOverrides: z.record(z.string().trim().min(1).max(128), CurrencyCode).default({}),
  exchangeRates: z.array(Rate).max(500).default([]),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const rate of value.exchangeRates) {
    const key = [rate.fromCurrency, rate.toCurrency, rate.effectiveDate].join('|');
    if (seen.has(key)) context.addIssue({ code: 'custom', message: 'Only one rate per currency pair and effective date is allowed.' });
    seen.add(key);
  }
});

export interface CurrencyPreferences {
  readonly displayCurrency: string;
  readonly accountCurrencyOverrides: Readonly<Record<string, string>>;
  readonly exchangeRates: readonly ExchangeRate[];
}

export function defaultCurrencyPreferences(currency: string): CurrencyPreferences {
  const normalized = normalizeCurrencyCode(currency);
  if (!normalized) throw new Error('Default display currency must be a valid ISO currency code.');
  return { displayCurrency: normalized, accountCurrencyOverrides: {}, exchangeRates: [] };
}

export async function readCurrencyPreferences(dataDirectory: string, defaultCurrency: string): Promise<CurrencyPreferences> {
  const path = resolve(dataDirectory, 'currency-preferences.json');
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return defaultCurrencyPreferences(defaultCurrency);
    throw error;
  }
  const parsed = CurrencyPreferencesSchema.parse(JSON.parse(contents) as unknown);
  return {
    displayCurrency: parsed.displayCurrency,
    accountCurrencyOverrides: parsed.accountCurrencyOverrides,
    exchangeRates: parsed.exchangeRates as readonly ExchangeRate[],
  };
}

export async function writeCurrencyPreferences(dataDirectory: string, preferences: CurrencyPreferences): Promise<void> {
  const parsed = CurrencyPreferencesSchema.parse(preferences);
  const path = resolve(dataDirectory, 'currency-preferences.json');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, JSON.stringify(parsed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
