import { describe, expect, it } from 'vitest';
import { formatAccountBalance } from '../src/finance-format.js';

describe('formatAccountBalance', () => {
  it('never represents a missing native balance as zero', () => {
    expect(formatAccountBalance(null, null, 'EUR', null)).toBe('Saldo desconocido');
  });

  it('uses the converted amount when conversion is available', () => {
    expect(formatAccountBalance(10_000, 9_200, 'EUR', 'USD')).toContain('92');
  });

  it('labels an unconverted native amount with its source currency', () => {
    expect(formatAccountBalance(10_000, null, 'EUR', 'USD')).toMatch(/US|USD/);
  });

  it('labels an amount with an unknown source currency explicitly', () => {
    expect(formatAccountBalance(10_000, null, 'EUR', null)).toContain('divisa desconocida');
  });
});
