import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvMoney, parseDate } from '../src/csv-import.js';

describe('CSV parsing helpers', () => {
  it('handles UTF-8 BOM, CRLF, quoted delimiters and escaped quotes', () => {
    const source = '\uFEFFDate;Description;Notes\r\n2026-10-01;"Café; Madrid";"dijo ""hola"""\r\n';
    expect(parseCsv(source, ';')).toEqual([
      ['Date', 'Description', 'Notes'],
      ['2026-10-01', 'Café; Madrid', 'dijo "hola"'],
    ]);
  });

  it('keeps line breaks inside quoted fields', () => {
    const source = 'Date,Description\r\n2026-10-01,"línea uno\nlínea dos"\r\n';
    expect(parseCsv(source, ',')).toEqual([
      ['Date', 'Description'],
      ['2026-10-01', 'línea uno\nlínea dos'],
    ]);
  });

  it('rejects unmatched quotes and input exceeding the row limit', () => {
    expect(() => parseCsv('Date;Description\n2026-10-01;"sin cerrar', ';'))
      .toThrow('El CSV contiene un campo entre comillas sin cerrar.');
    const oversized = ['Date', ...Array.from({ length: 2_001 }, (_, index) => String(index))].join('\n');
    expect(() => parseCsv(oversized, ';')).toThrow('El CSV supera el límite de 2.000 filas de datos.');
  });

  it('normalizes decimal separators, thousands separators and parenthesized negatives', () => {
    expect(parseCsvMoney('-12,34', ',')).toBe(-1_234);
    expect(parseCsvMoney('1.234,56', ',')).toBe(123_456);
    expect(parseCsvMoney('1,234.56', '.')).toBe(123_456);
    expect(parseCsvMoney('(1.234,56)', ',')).toBe(-123_456);
    expect(parseCsvMoney('importe-no-valido', ',')).toBeNull();
  });

  it('validates ISO, day-first and month-first dates including leap days', () => {
    expect(parseDate('2024-02-29', 'iso')).toBe('2024-02-29');
    expect(parseDate('29/02/2024', 'dmy')).toBe('2024-02-29');
    expect(parseDate('02/29/2024', 'mdy')).toBe('2024-02-29');
    expect(parseDate('29/02/2023', 'dmy')).toBeNull();
    expect(parseDate('31/04/2026', 'dmy')).toBeNull();
    expect(parseDate('2026-2-01', 'iso')).toBeNull();
  });
});
