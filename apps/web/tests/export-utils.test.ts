import { describe, expect, it } from 'vitest';
import { escapeCsvCell, serializeCsv } from '../src/export-utils.js';

describe('local export CSV helpers', () => {
  it('uses UTF-8 BOM, semicolon delimiter, quoted cells and CRLF for Spanish spreadsheets', () => {
    const csv = serializeCsv(['fecha', 'concepto'], [['2026-10-01', 'Café; "Madrid"']], [1]);
    expect(csv).toBe('\uFEFF"fecha";"concepto"\r\n"2026-10-01";"Café; ""Madrid"""\r\n');
  });

  it('neutralizes formula-like text after whitespace and control characters', () => {
    expect(escapeCsvCell('=1+1', true)).toBe('"\'=1+1"');
    expect(escapeCsvCell(' \t@SUM(A1:A2)', true)).toBe('"\' \t@SUM(A1:A2)"');
    expect(escapeCsvCell('-125', true)).toBe('"\'-125"');
    expect(escapeCsvCell('-125', false)).toBe('"-125"');
  });

  it('does not alter numerical columns when formula protection is only applied to text columns', () => {
    const csv = serializeCsv(['concepto', 'importe_minor'], [['=HYPERLINK("x")', -125]], [0]);
    expect(csv).toContain('"\'=HYPERLINK(""x"")";"-125"');
  });

  it('rejects rows with a different number of columns', () => {
    expect(() => serializeCsv(['fecha', 'importe'], [['2026-10-01']])).toThrow(
      'No se puede exportar un CSV con filas de distinta longitud.',
    );
  });
});
