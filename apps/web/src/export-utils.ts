/**
 * Helpers for user-initiated local exports. CSV uses UTF-8 with BOM, semicolons,
 * doubled quotes and CRLF records for common Spanish spreadsheet setups.
 */
export function escapeCsvCell(value: unknown, protectFormula = false): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Spreadsheet applications may evaluate formulas after leading whitespace/control characters.
  if (protectFormula && /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function serializeCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  formulaSafeColumns: readonly number[] = [],
): string {
  if (rows.some((row) => row.length !== headers.length)) {
    throw new Error('No se puede exportar un CSV con filas de distinta longitud.');
  }
  const protectedColumns = new Set(formulaSafeColumns);
  const records: readonly (readonly unknown[])[] = [headers, ...rows];
  return '\uFEFF' + records
    .map((row) => row.map((value, index) => escapeCsvCell(value, protectedColumns.has(index))).join(';'))
    .join('\r\n') + '\r\n';
}

export function downloadTextFile(filename: string, content: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function exportDateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}


/** Values supported by the small, dependency-free OOXML workbook writer. Strings are always
 * encoded as inline text, never as formulas. Dates are written as Excel date serials. */
export type XlsxCellValue = string | number | boolean | Date | null | undefined;

export interface XlsxSheet {
  name: string;
  rows: readonly (readonly XlsxCellValue[])[];
  widths?: readonly number[];
  /** 1-based rows styled as table headers. Defaults to row 1. */
  headerRows?: readonly number[];
  /** 1-based row used for Excel's autofilter; omit for non-tabular sheets. */
  filterHeaderRow?: number;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Return the ISO currency's conventional fraction digits, rather than assuming two. */
export function currencyMinorUnitExponent(currency: string): number {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error('No se puede convertir un importe sin un código de divisa válido.');
  }
  try {
    const digits = new Intl.NumberFormat('en-US', { style: 'currency', currency: normalized })
      .resolvedOptions().maximumFractionDigits;
    if (digits === undefined) {
      throw new Error('No se conoce la precisión monetaria de la divisa ' + normalized + '.');
    }
    return digits;
  } catch {
    throw new Error('No se conoce la precisión monetaria de la divisa ' + normalized + '.');
  }
}

/** Convert an integer minor-unit amount to a major-unit numeric value without changing its sign. */
export function minorUnitsToMajor(amountMinor: number, currency: string): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error('El importe en unidades menores no es un entero seguro.');
  }
  const exponent = currencyMinorUnitExponent(currency);
  const major = amountMinor / Math.pow(10, exponent);
  if (!Number.isFinite(major)) throw new Error('El importe no se puede representar de forma segura.');
  return major;
}

/** Currency-format an amount using the exponent resolved by Intl for the specified currency. */
export function formatMinorAmount(
  amountMinor: number,
  currency: string,
  locale: 'es-ES' | 'en-GB' = 'es-ES',
): string {
  const exponent = currencyMinorUnitExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.trim().toUpperCase(),
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minorUnitsToMajor(amountMinor, currency));
}

function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function validSheetNames(sheets: readonly XlsxSheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((sheet, index) => {
    const base = (sheet.name || ('Hoja ' + (index + 1)))
      .replace(/[\[\]:*?\/\\]/g, ' ')
      .replace(/^'+|'+$/g, '')
      .slice(0, 31) || ('Hoja ' + (index + 1));
    let name = base;
    let suffix = 2;
    while (used.has(name.toLocaleLowerCase())) {
      const tail = ' (' + suffix + ')';
      name = base.slice(0, 31 - tail.length) + tail;
      suffix += 1;
    }
    used.add(name.toLocaleLowerCase());
    return name;
  });
}

function excelColumnName(columnNumber: number): string {
  let number = columnNumber;
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function excelDateSerial(value: Date): number {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) throw new Error('El libro contiene una fecha no válida.');
  return timestamp / 86_400_000 + 25_569;
}

function worksheetXml(sheet: XlsxSheet): string {
  const rows = sheet.rows;
  const maximumColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (maximumColumns > 16_384 || rows.length > 1_048_576) {
    throw new Error('El libro supera los límites de filas o columnas de Excel.');
  }
  const lastColumn = excelColumnName(Math.max(1, maximumColumns));
  const lastRow = Math.max(1, rows.length);
  const headerRows = new Set(sheet.headerRows ?? [1]);
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ';
  xml += 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
  xml += '<dimension ref="A1:' + lastColumn + lastRow + '"/>';
  xml += '<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
  if (sheet.widths?.length) {
    xml += '<cols>';
    sheet.widths.forEach((width, index) => {
      if (Number.isFinite(width) && width > 0) {
        const safeWidth = Math.min(60, Math.max(8, width));
        xml += '<col min="' + (index + 1) + '" max="' + (index + 1) + '" width="' + safeWidth + '" customWidth="1"/>';
      }
    });
    xml += '</cols>';
  }
  xml += '<sheetData>';
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    xml += '<row r="' + rowNumber + '">';
    row.forEach((value, columnIndex) => {
      if (value === null || value === undefined) return;
      const reference = excelColumnName(columnIndex + 1) + rowNumber;
      if (value instanceof Date) {
        const serial = excelDateSerial(value);
        xml += '<c r="' + reference + '" s="2"><v>' + serial + '</v></c>';
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('El libro contiene un valor numérico no finito.');
        const numberStyle = headerRows.has(rowNumber) ? '1' : '3';
        xml += '<c r="' + reference + '" s="' + numberStyle + '"><v>' + String(value) + '</v></c>';
      } else if (typeof value === 'boolean') {
        xml += '<c r="' + reference + '" t="b"><v>' + (value ? '1' : '0') + '</v></c>';
      } else {
        const text = xmlEscape(String(value));
        const style = headerRows.has(rowNumber) ? ' s="1"' : '';
        xml += '<c r="' + reference + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + text + '</t></is></c>';
      }
    });
    xml += '</row>';
  });
  xml += '</sheetData>';
  if (sheet.filterHeaderRow && rows.length > sheet.filterHeaderRow) {
    xml += '<autoFilter ref="A' + sheet.filterHeaderRow + ':' + lastColumn + lastRow + '"/>';
  }
  xml += '<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>';
  xml += '</worksheet>';
  return xml;
}

function workbookStylesXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.########;[Red]-#,##0.########"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF23395B"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  crc: number;
  offset: number;
}

function zipCrc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xFF;
  target[offset + 1] = (value >>> 8) & 0xFF;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xFF;
  target[offset + 1] = (value >>> 8) & 0xFF;
  target[offset + 2] = (value >>> 16) & 0xFF;
  target[offset + 3] = (value >>> 24) & 0xFF;
}

/** Small ZIP writer using the interoperable "store" method. Export limits keep the archive bounded. */
function createStoredZip(input: readonly { name: string; content: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = input.map((item) => {
    const bytes = encoder.encode(item.content);
    return { name: item.name, bytes, crc: zipCrc32(bytes), offset: 0 };
  });
  if (entries.length > 65_535) throw new Error('El libro contiene demasiados componentes.');
  let localLength = 0;
  let directoryLength = 0;
  for (const entry of entries) {
    const nameLength = encoder.encode(entry.name).length;
    if (entry.bytes.length > 0xFFFFFFFF) throw new Error('Un componente del libro supera el tamaño ZIP admitido.');
    entry.offset = localLength;
    localLength += 30 + nameLength + entry.bytes.length;
    directoryLength += 46 + nameLength;
  }
  const totalLength = localLength + directoryLength + 22;
  if (!Number.isSafeInteger(totalLength) || totalLength > 0xFFFFFFFF) {
    throw new Error('El libro supera el tamaño ZIP admitido.');
  }
  const result = new Uint8Array(totalLength);
  let cursor = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    writeU32(result, cursor, 0x04034B50);
    writeU16(result, cursor + 4, 20);
    writeU16(result, cursor + 6, 0);
    writeU16(result, cursor + 8, 0);
    writeU16(result, cursor + 10, 0);
    writeU16(result, cursor + 12, 0x21);
    writeU32(result, cursor + 14, entry.crc);
    writeU32(result, cursor + 18, entry.bytes.length);
    writeU32(result, cursor + 22, entry.bytes.length);
    writeU16(result, cursor + 26, name.length);
    writeU16(result, cursor + 28, 0);
    result.set(name, cursor + 30);
    result.set(entry.bytes, cursor + 30 + name.length);
    cursor += 30 + name.length + entry.bytes.length;
  }
  const directoryOffset = cursor;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    writeU32(result, cursor, 0x02014B50);
    writeU16(result, cursor + 4, 20);
    writeU16(result, cursor + 6, 20);
    writeU16(result, cursor + 8, 0);
    writeU16(result, cursor + 10, 0);
    writeU16(result, cursor + 12, 0);
    writeU16(result, cursor + 14, 0x21);
    writeU32(result, cursor + 16, entry.crc);
    writeU32(result, cursor + 20, entry.bytes.length);
    writeU32(result, cursor + 24, entry.bytes.length);
    writeU16(result, cursor + 28, name.length);
    writeU16(result, cursor + 30, 0);
    writeU16(result, cursor + 32, 0);
    writeU16(result, cursor + 34, 0);
    writeU16(result, cursor + 36, 0);
    writeU32(result, cursor + 38, 0);
    writeU32(result, cursor + 42, entry.offset);
    result.set(name, cursor + 46);
    cursor += 46 + name.length;
  }
  const directorySize = cursor - directoryOffset;
  writeU32(result, cursor, 0x06054B50);
  writeU16(result, cursor + 4, 0);
  writeU16(result, cursor + 6, 0);
  writeU16(result, cursor + 8, entries.length);
  writeU16(result, cursor + 10, entries.length);
  writeU32(result, cursor + 12, directorySize);
  writeU32(result, cursor + 16, directoryOffset);
  writeU16(result, cursor + 20, 0);
  return result;
}

/** Create a portable .xlsx without network services or a runtime dependency. All text is inline
 * OOXML text; user-controlled values can never become spreadsheet formulas. */
export function buildXlsxBytes(sheets: readonly XlsxSheet[]): Uint8Array {
  if (sheets.length === 0 || sheets.length > 100) {
    throw new Error('El libro debe contener entre 1 y 100 hojas.');
  }
  const names = validSheetNames(sheets);
  const contentOverrides = sheets.map((_, index) =>
    '<Override PartName="/xl/worksheets/sheet' + (index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
  ).join('');
  const workbookSheets = names.map((name, index) =>
    '<sheet name="' + xmlEscape(name) + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>',
  ).join('');
  const workbookRelationships = names.map((_, index) =>
    '<Relationship Id="rId' + (index + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>',
  ).join('');
  const worksheets = sheets.map((sheet, index) => ({
    name: 'xl/worksheets/sheet' + (index + 1) + '.xml',
    content: worksheetXml(sheet),
  }));
  const entries = [
    {
      name: '[Content_Types].xml',
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        contentOverrides + '</Types>',
    },
    {
      name: '_rels/.rels',
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' + workbookSheets + '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        workbookRelationships +
        '<Relationship Id="rId' + (names.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    { name: 'xl/styles.xml', content: workbookStylesXml() },
    ...worksheets,
  ];
  return createStoredZip(entries);
}

export function downloadXlsxFile(filename: string, sheets: readonly XlsxSheet[]): void {
  const bytes = buildXlsxBytes(sheets);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: XLSX_MIME });
  downloadBlobFile(filename, blob);
}

export function downloadBlobFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Escape values before placing them into the locally generated print document. */
export function escapeHtml(value: unknown): string {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build a self-contained print document: no remote scripts, fonts, images or data uploads. */
export function buildPrintableDocument(title: string, bodyHtml: string): string {
  return '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>' + escapeHtml(title) + '</title>' +
    '<style>' +
    '@page{size:A4;margin:14mm}@page appendix{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font:11px/1.45 Arial,Helvetica,sans-serif;color:#172033;margin:0}' +
    'h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;break-after:avoid}.appendix{page:appendix;break-before:page;page-break-before:always}' +
    'p{margin:4px 0 10px}.muted{color:#596579}.metadata{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;margin:12px 0 18px}' +
    '.metadata div{overflow-wrap:anywhere}.notice{border:1px solid #b8c3d4;padding:8px;margin:10px 0}' +
    'table{width:100%;border-collapse:collapse;margin:6px 0 16px;font-size:10px;table-layout:auto}' +
    'thead{display:table-header-group}th,td{border:1px solid #cfd6e1;padding:5px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}' +
    'th{background:#edf1f7;font-weight:700}tr{break-inside:avoid}small{font-size:9px;color:#596579}' +
    '.numeric{text-align:right;white-space:nowrap}.amount{font-weight:700;white-space:nowrap}.nowrap{white-space:nowrap}' +
    'ul{padding-left:18px}li{margin:2px 0}.footer{margin-top:20px;padding-top:8px;border-top:1px solid #cfd6e1;font-size:9px;color:#596579}' +
    '@media print{a{color:inherit;text-decoration:none}.no-print{display:none!important}}' +
    '</style></head><body>' + bodyHtml + '</body></html>';
}

export function printHtmlDocument(title: string, bodyHtml: string, targetWindow?: Window | null): void {
  const printWindow = targetWindow ?? window.open('', '_blank');
  if (!printWindow) {
    throw new Error('El navegador ha bloqueado la ventana de impresión. Permite ventanas emergentes para esta aplicación y vuelve a intentarlo.');
  }
  printWindow.opener = null;
  let printed = false;
  const runPrint = (): void => {
    if (printed || printWindow.closed) return;
    printed = true;
    printWindow.focus();
    printWindow.print();
  };
  printWindow.addEventListener('load', runPrint, { once: true });
  printWindow.document.open();
  printWindow.document.write(buildPrintableDocument(title, bodyHtml));
  printWindow.document.close();
  if (printWindow.document.readyState === 'complete') window.setTimeout(runPrint, 0);
}
