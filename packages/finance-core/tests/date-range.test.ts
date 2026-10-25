import { describe, expect, it } from 'vitest';
import { isIsoDate, InvalidPeriodError, monthlyPeriod, validatePeriod, yearlyPeriod } from '../src/date-range.js';

describe('date helpers', () => {
  it('accepts valid dates and rejects impossible dates', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-1-01')).toBe(false);
  });
  it('returns boundaries for leap and common years', () => {
    expect(monthlyPeriod(2024, 2)).toEqual({ startDate: '2024-02-01', endDate: '2024-02-29' });
    expect(monthlyPeriod(2026, 2)).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
    expect(monthlyPeriod(2026, 12)).toEqual({ startDate: '2026-12-01', endDate: '2026-12-31' });
    expect(yearlyPeriod(2026)).toEqual({ startDate: '2026-01-01', endDate: '2026-12-31' });
  });
  it('rejects reversed or invalid periods', () => {
    expect(() => validatePeriod({ startDate: '2026-11-01', endDate: '2026-10-01' })).toThrow(InvalidPeriodError);
    expect(() => validatePeriod({ startDate: '2026-02-29', endDate: '2026-03-01' })).toThrow(InvalidPeriodError);
    expect(() => monthlyPeriod(2026, 13)).toThrow(InvalidPeriodError);
    expect(() => yearlyPeriod(1800)).toThrow(InvalidPeriodError);
  });
});
