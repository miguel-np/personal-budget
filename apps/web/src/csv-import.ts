export type Delimiter = ',' | ';' | '\t';
export type DateFormat = 'iso' | 'dmy' | 'mdy';

export function parseCsvMoney(raw: string, decimalSeparator: ',' | '.'): number | null {
  let value = raw.trim().replace(/[\s€$£]/g, '');
  if (!value) return null;
  const negativeByParentheses = value.startsWith('(') && value.endsWith(')');
  if (negativeByParentheses) value = value.slice(1, -1);
  if (decimalSeparator === ',') value = value.replace(/\./g, '').replace(',', '.');
  else value = value.replace(/,/g, '');
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000_000_000) return null;
  const minor = Math.round(amount * 100) * (negativeByParentheses ? -1 : 1);
  return Number.isSafeInteger(minor) ? minor : null;
}
function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function parseDate(raw: string, format: DateFormat): string | null {
  const value = raw.trim();
  if (format === 'iso') return isValidIsoDate(value) ? value : null;
  const match = /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/.exec(value);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  const day = format === 'dmy' ? first : second;
  const month = format === 'dmy' ? second : first;
  const date = [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
  return isValidIsoDate(date) ? date : null;
}
export function parseCsv(source: string, delimiter: Delimiter): string[][] {
  const text = source.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      field = '';
      if (rows.length > 2_001) throw new Error('El CSV supera el límite de 2.000 filas de datos.');
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('El CSV contiene un campo entre comillas sin cerrar.');
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  if (rows.length === 0) throw new Error('El archivo CSV no contiene filas.');
  if (rows.length > 2_001) throw new Error('El CSV supera el límite de 2.000 filas de datos.');
  return rows;
}
