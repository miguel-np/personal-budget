import type { Period } from './domain.js';

export class InvalidPeriodError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidPeriodError';
  }
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validatePeriod(period: Period): Period {
  if (!isIsoDate(period.startDate) || !isIsoDate(period.endDate)) {
    throw new InvalidPeriodError('Dates must be valid ISO calendar dates (YYYY-MM-DD).');
  }
  if (period.startDate > period.endDate) {
    throw new InvalidPeriodError('startDate must be on or before endDate.');
  }
  return period;
}

export function monthlyPeriod(year: number, month: number): Period {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new InvalidPeriodError('year must be an integer between 1900 and 9999.');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new InvalidPeriodError('month must be an integer between 1 and 12.');
  }
  const startDate = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-01';
  const nextMonthUtc = new Date(Date.UTC(year, month, 1));
  nextMonthUtc.setUTCDate(0);
  return { startDate, endDate: nextMonthUtc.toISOString().slice(0, 10) };
}

export function yearlyPeriod(year: number): Period {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new InvalidPeriodError('year must be an integer between 1900 and 9999.');
  }
  const dateYear = String(year).padStart(4, '0');
  return { startDate: dateYear + '-01-01', endDate: dateYear + '-12-31' };
}
