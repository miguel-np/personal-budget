import { describe, expect, it } from 'vitest';
import { buildPrintableDocument, buildXlsxBytes, currencyMinorUnitExponent, escapeHtml, escapeCsvCell, formatMinorAmount, minorUnitsToMajor, serializeCsv, type XlsxSheet } from '../src/export-utils.js';

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


function readStoredZipEntries(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034B50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return entries;
}

describe('local XLSX/PDF export helpers', () => {
  it('uses currency precision instead of assuming two decimals', () => {
    expect(currencyMinorUnitExponent('JPY')).toBe(0);
    expect(currencyMinorUnitExponent('USD')).toBe(2);
    expect(currencyMinorUnitExponent('KWD')).toBe(3);
    expect(minorUnitsToMajor(123, 'JPY')).toBe(123);
    expect(minorUnitsToMajor(123, 'USD')).toBe(1.23);
    expect(minorUnitsToMajor(1234, 'KWD')).toBe(1.234);
    expect(formatMinorAmount(123, 'JPY', 'en-GB')).toContain('123');
    expect(() => minorUnitsToMajor(1.5, 'USD')).toThrow(/entero seguro/);
    expect(() => minorUnitsToMajor(123, '???')).toThrow(/código de divisa válido/);
  });

  it('builds a ZIP/OOXML workbook with typed date and numeric cells', () => {
    const sheet: XlsxSheet = {
      name: 'Movimientos',
      rows: [
        ['Fecha', 'Concepto', 'Importe'],
        [new Date('2026-10-29T00:00:00.000Z'), 'Café y pan', 12.34],
      ],
      widths: [14, 30, 18],
      headerRows: [1],
      filterHeaderRow: 1,
    };
    const bytes = buildXlsxBytes([sheet]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034B50);
    expect(bytes.some((_, index) => index + 4 <= bytes.length &&
      view.getUint32(index, true) === 0x02014B50)).toBe(true);
    const files = readStoredZipEntries(bytes);
    expect(files.has('[Content_Types].xml')).toBe(true);
    expect(files.has('xl/workbook.xml')).toBe(true);
    expect(files.has('xl/styles.xml')).toBe(true);
    const xml = files.get('xl/worksheets/sheet1.xml') ?? '';
    expect(xml).toContain('<autoFilter ref="A1:C2"/>');
    expect(xml).toContain('r="A2" s="2"><v>');
    expect(xml).toContain('r="C2" s="3"><v>12.34</v>');
    expect(xml).toContain('Café y pan');
  });

  it('keeps formula-like input as text and escapes XML payloads', () => {
    const attack = '=HYPERLINK("https://invalid.example","open")';
    const bytes = buildXlsxBytes([{
      name: 'Datos',
      rows: [['Concepto'], [attack], ['<script>alert(1)</script>']],
    }]);
    const xml = readStoredZipEntries(bytes).get('xl/worksheets/sheet1.xml') ?? '';
    expect(xml).toContain('=HYPERLINK(&quot;https://invalid.example&quot;,&quot;open&quot;)');
    expect(xml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(xml).not.toMatch(/<f(?:\s|>)/i);
  });

  it('sanitizes invalid and duplicate worksheet names', () => {
    const bytes = buildXlsxBytes([
      { name: 'Datos/2026', rows: [['A']] },
      { name: 'Datos/2026', rows: [['B']] },
    ]);
    const workbook = readStoredZipEntries(bytes).get('xl/workbook.xml') ?? '';
    expect(workbook).toContain('name="Datos 2026"');
    expect(workbook).toContain('name="Datos 2026 (2)"');
  });

  it('escapes printable title and body values in a self-contained document', () => {
    const title = '<img src=x onerror=alert(1)>';
    const html = buildPrintableDocument(title, '<p>' + escapeHtml('<script>unsafe()</script>') + '</p>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');
    expect(html).toContain('@page{size:A4');
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).not.toContain('https://fonts.googleapis.com');
  });
});
