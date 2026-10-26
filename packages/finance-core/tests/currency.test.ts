import { describe, expect, it } from 'vitest';
import { convertAmountMinor } from '../src/currency.js';
import type { ExchangeRate } from '../src/currency.js';

const rates: readonly ExchangeRate[] = [
  { fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.9', effectiveDate: '2026-10-01', source: 'manual' },
  { fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.92', effectiveDate: '2026-10-20', source: 'manual correction' },
];

describe('currency conversion', () => {
  it('keeps the same-currency amount unchanged without requiring an exchange rate', () => {
    expect(convertAmountMinor(123456, 'EUR', 'EUR', '2026-10-25', [])).toMatchObject({
      amountMinor: 123456, fromCurrency: 'EUR', toCurrency: 'EUR', rate: '1', source: 'identity',
    });
  });

  it('chooses the most recent rate effective on the transaction civil date', () => {
    expect(convertAmountMinor(10000, 'USD', 'EUR', '2026-10-25', rates)).toMatchObject({
      amountMinor: 9200, rate: '0.92', effectiveDate: '2026-10-20', source: 'manual correction',
    });
    expect(convertAmountMinor(10000, 'USD', 'EUR', '2026-10-10', rates).amountMinor).toBe(9000);
  });

  it('supports inverse rates and preserves negative expense signs', () => {
    expect(convertAmountMinor(-10000, 'EUR', 'USD', '2026-10-25', rates)).toMatchObject({
      amountMinor: -10870, inverseRate: true, rate: '0.92', effectiveDate: '2026-10-20',
    });
  });

  it('does not invent a rate or assume a currency for unknown source data', () => {
    expect(convertAmountMinor(1234, null, 'EUR', '2026-10-25', rates)).toMatchObject({
      amountMinor: null, fromCurrency: null, warning: expect.stringMatching(/desconocida/i),
    });
    expect(convertAmountMinor(1234, 'GBP', 'EUR', '2026-10-25', rates)).toMatchObject({
      amountMinor: null, warning: expect.stringMatching(/Falta un tipo de cambio/i),
    });
  });

  it('rejects unsafe amounts, malformed dates, and invalid targets', () => {
    expect(() => convertAmountMinor(Number.MAX_SAFE_INTEGER + 1, 'EUR', 'EUR', '2026-10-25', [])).toThrow(/safe integer/i);
    expect(() => convertAmountMinor(100, 'EUR', 'eur', '2026-10-25', [])).not.toThrow();
    expect(() => convertAmountMinor(100, 'EUR', 'bad', '2026-10-25', [])).toThrow(/Target currency/i);
    expect(() => convertAmountMinor(100, 'EUR', 'USD', 'not-a-date', rates)).toThrow(/Conversion date/i);
  });
});
