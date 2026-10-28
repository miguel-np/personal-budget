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
