import { describe, expect, it } from 'vitest';
import { date, exact, monthRange, parse, period } from '../tool-definitions.mjs';
import { isLoopbackApiUrl, isValidMcpTimeout } from '../runtime-config.mjs';

const startDate = '2026-01-01';
const endDate = '2026-01-31';
const candidateId = 'rc_0123456789abcdef01234567';

describe('MCP argument validation boundaries', () => {
  it('rejects malformed dates and accepts real calendar dates', () => {
    expect(date(undefined)).toBe(false);
    expect(date(20260101)).toBe(false);
    expect(date('2026/01/01')).toBe(false);
    expect(date('2026-02-30')).toBe(false);
    expect(date('2026-02-28')).toBe(true);
  });

  it('rejects invalid, reversed and excessively long periods', () => {
    expect(() => period('not-a-date', endDate)).toThrow('Dates must use valid');
    expect(() => period(endDate, startDate)).toThrow('Period must be ordered');
    expect(() => period('2020-01-01', '2026-01-02')).toThrow('at most five years');
    expect(() => period('2021-01-01', '2026-01-01')).not.toThrow();
  });

  it('rejects non-object, array and unexpected argument shapes', () => {
    expect(() => exact(null, [])).toThrow('unsupported fields');
    expect(() => exact([], [])).toThrow('unsupported fields');
    expect(() => exact({ unexpected: true }, [])).toThrow('unsupported fields');
    expect(() => exact({}, [])).not.toThrow();
  });

  it('validates month strings before deriving calendar boundaries', () => {
    expect(() => monthRange(202601)).toThrow('month is invalid');
    expect(() => monthRange('2026-13')).toThrow('month must use YYYY-MM');
    expect(monthRange('2026-02')).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
  });

  it('enforces the supported yearly range and integer type', () => {
    expect(() => parse('get_yearly_overview', { year: 1999 })).toThrow('year must be an integer');
    expect(() => parse('get_yearly_overview', { year: 2101 })).toThrow('year must be an integer');
    expect(() => parse('get_yearly_overview', { year: 2026.5 })).toThrow('year must be an integer');
    expect(parse('get_yearly_overview', { year: 2000 })).toEqual({ year: 2000 });
    expect(parse('get_yearly_overview', { year: 2100 })).toEqual({ year: 2100 });
  });

  it('bounds recurring-candidate result limits and applies the default', () => {
    const base = { startDate, endDate };
    expect(() => parse('get_recurring_candidates', { ...base, limit: 0 })).toThrow('limit must be from 1 to 50');
    expect(() => parse('get_recurring_candidates', { ...base, limit: 51 })).toThrow('limit must be from 1 to 50');
    expect(() => parse('get_recurring_candidates', { ...base, limit: 1.5 })).toThrow('limit must be from 1 to 50');
    expect(parse('get_recurring_candidates', base)).toMatchObject({ limit: 20 });
    expect(parse('get_recurring_candidates', { ...base, limit: 1 })).toMatchObject({ limit: 1 });
  });

  it('rejects non-finite and out-of-range hypothetical reductions', () => {
    const base = { startDate, endDate, categoryName: 'Comida' };
    expect(() => parse('simulate_budget_change', { ...base, reductionPercent: '10' })).toThrow('reductionPercent must be from 0 to 100');
    expect(() => parse('simulate_budget_change', { ...base, reductionPercent: Number.NaN })).toThrow('reductionPercent must be from 0 to 100');
    expect(() => parse('simulate_budget_change', { ...base, reductionPercent: -1 })).toThrow('reductionPercent must be from 0 to 100');
    expect(() => parse('simulate_budget_change', { ...base, reductionPercent: 101 })).toThrow('reductionPercent must be from 0 to 100');
    expect(parse('simulate_budget_change', { ...base, reductionPercent: 0 })).toMatchObject({ reductionPercent: 0 });
    expect(parse('simulate_budget_change', { ...base, reductionPercent: 100 })).toMatchObject({ reductionPercent: 100 });
  });

  it('accepts omitted budget-alert month but validates an explicit one', () => {
    expect(parse('get_budget_alerts', {})).toEqual({});
    expect(parse('get_budget_alerts', { month: '2026-02' })).toEqual({ month: '2026-02' });
    expect(() => parse('get_budget_alerts', { month: '2026-00' })).toThrow('month must use YYYY-MM');
  });

  it('validates improvement windows and uses the default window', () => {
    expect(parse('get_budget_improvement_context', {})).toEqual({ periodMonths: 6 });
    expect(parse('get_budget_improvement_context', { periodMonths: 3 })).toEqual({ periodMonths: 3 });
    expect(() => parse('get_budget_improvement_context', { periodMonths: 4 })).toThrow('periodMonths must be 3, 6 or 12');
  });

  it('validates cash-flow horizons, reserve values and recurring candidate identifiers', () => {
    expect(parse('project_cash_flow', {})).toEqual({ horizonDays: 30, recurringCandidateIds: [] });
    expect(parse('project_cash_flow', { horizonDays: 7, reserveMinor: 0, recurringCandidateIds: [candidateId] }))
      .toMatchObject({ horizonDays: 7, reserveMinor: 0, recurringCandidateIds: [candidateId] });
    expect(() => parse('project_cash_flow', { horizonDays: 14 })).toThrow('horizonDays must be 7, 30 or 90');
    expect(() => parse('project_cash_flow', { reserveMinor: -1 })).toThrow('reserveMinor must be a non-negative safe integer');
    expect(() => parse('project_cash_flow', { reserveMinor: '100' })).toThrow('reserveMinor must be a non-negative safe integer');
    expect(() => parse('project_cash_flow', { recurringCandidateIds: 'invalid' })).toThrow('recurringCandidateIds are invalid');
    expect(() => parse('project_cash_flow', { recurringCandidateIds: Array.from({ length: 51 }, () => candidateId) }))
      .toThrow('recurringCandidateIds are invalid');
    expect(() => parse('project_cash_flow', { recurringCandidateIds: [123] })).toThrow('recurringCandidateIds are invalid');
    expect(() => parse('project_cash_flow', { recurringCandidateIds: ['not-a-candidate-id'] }))
      .toThrow('recurringCandidateIds are invalid');
  });

  it('rejects unknown tool parsers', () => {
    expect(() => parse('execute_arbitrary_command', {})).toThrow('Unknown tool');
  });
});

describe('MCP runtime validators', () => {
  it('rejects non-loopback schemes, credentials and malformed URLs', () => {
    expect(isLoopbackApiUrl('ftp://localhost:3000')).toBe(false);
    expect(isLoopbackApiUrl('http://user:pass@localhost:3000')).toBe(false);
    expect(isLoopbackApiUrl('not a URL')).toBe(false);
  });

  it('accepts only bounded integer timeout values', () => {
    expect(isValidMcpTimeout(100)).toBe(true);
    expect(isValidMcpTimeout(30000)).toBe(true);
    expect(isValidMcpTimeout(99)).toBe(false);
    expect(isValidMcpTimeout(30001)).toBe(false);
    expect(isValidMcpTimeout(5000.5)).toBe(false);
  });
});
