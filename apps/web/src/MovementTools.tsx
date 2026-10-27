import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { parseCsv, parseCsvMoney, parseDate, isValidIsoDate, type DateFormat, type Delimiter } from './csv-import.js';
import { decodeOfxBytes, MAX_OFX_FILE_BYTES, parseOfx, type OfxParseResult } from './ofx-import.js';

export interface MovementAccount {
  readonly id: string;
  readonly name: string;
  readonly closed: boolean;
  readonly currencyCode?: string | null;
  readonly nativeCurrencyCode?: string | null;
  readonly offBudget?: boolean;
}
export interface MovementCategory {
  readonly id: string;
  readonly name: string;
  readonly isIncome: boolean;
}
interface ImportRecord {
  date: string;
  amount: number;
  payee_name: string;
  imported_payee?: string;
  category?: string;
  notes?: string;
  imported_id: string;
}
interface ImportResult {
  added: number;
  updated: number;
  errors: number;
  submitted: number;
  dryRun: boolean;
}
interface ImportSourceOptions {
  readonly sourceFormat?: 'ofx';
  readonly sourceCurrencyCode?: string;
  readonly allowUnverifiedCurrency?: boolean;
}
interface TransferRequestPayload {
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly date: string;
  readonly amountMinor: number;
  readonly notes?: string;
  readonly importedId: string;
}
interface TransferResult extends ImportResult {
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly linkedTransfer: boolean;
}
interface ApiResponse<T> {
  data?: T;
  error?: { code?: string; message?: string };
}
interface MovementToolsProps {
  accounts: readonly MovementAccount[];
  categories: readonly MovementCategory[];
  currency: string;
  onImported: (notice?: string) => void;
  quickRequest?: { readonly key: number; readonly kind: 'income' | 'expense' | 'transfer' } | null;
}

function localToday(): string {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function newIdentifier(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? 'personal-budget-manual:' + crypto.randomUUID()
    : 'personal-budget-manual:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2);
}
function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return (first >>> 0).toString(36) + (second >>> 0).toString(36);
}
function parseMoney(raw: string): number | null {
  let value = raw.trim().replace(/[\s€$£]/g, '');
  if (!value) return null;
  if (value.startsWith('(') && value.endsWith(')')) value = '-' + value.slice(1, -1);
  if (value.includes(',') && value.includes('.')) {
    if (value.lastIndexOf(',') > value.lastIndexOf('.')) value = value.replace(/\./g, '').replace(',', '.');
    else value = value.replace(/,/g, '');
  } else if (value.includes(',')) {
    value = value.replace(',', '.');
  }
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000_000_000) return null;
  const minor = Math.round(amount * 100);
  return Number.isSafeInteger(minor) && minor !== 0 ? minor : null;
}
function findHeader(headers: readonly string[], candidates: readonly string[]): string {
  const normalized = headers.map((header) => header.trim().toLocaleLowerCase('es'));
  const index = normalized.findIndex((header) => candidates.some((candidate) => header === candidate || header.includes(candidate)));
  return index >= 0 ? String(index) : '';
}
function selectorValue(row: readonly string[], index: string): string {
  if (index === '') return '';
  return row[Number(index)]?.trim() ?? '';
}
async function sendImport(
  path: '/api/v1/import/preview' | '/api/v1/import/commit',
  accountId: string,
  records: readonly ImportRecord[],
  sourceOptions?: ImportSourceOptions,
): Promise<ImportResult> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accountId, records, ...(sourceOptions ?? {}) }),
  });
  const payload = await response.json().catch(() => ({})) as ApiResponse<ImportResult>;
  if (!response.ok) throw new Error(payload.error?.message ?? 'La API local rechazó la importación.');
  if (!payload.data) throw new Error('La API local no devolvió un resultado verificable.');
  return payload.data;
}
async function sendTransfer(path: '/api/v1/transfers/preview' | '/api/v1/transfers/commit', request: TransferRequestPayload): Promise<TransferResult> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(request),
  });
  const payload = await response.json().catch(() => ({})) as ApiResponse<TransferResult>;
  if (!response.ok) throw new Error(payload.error?.message ?? 'La API local rechazó la transferencia.');
  if (!payload.data) throw new Error('La API local no devolvió una previsualización verificable de la transferencia.');
  return payload.data;
}
function FormAlert({ children, error = false }: { children: string; error?: boolean }) {
  return <p className={'form-alert' + (error ? ' error' : '')} role={error ? 'alert' : 'status'}>{children}</p>;
}

export function MovementTools({ accounts, categories, currency, onImported, quickRequest }: MovementToolsProps) {
  const openAccounts = useMemo(() => accounts.filter((account) => !account.closed), [accounts]);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualKind, setManualKind] = useState<'any' | 'income' | 'expense'>('any');
  const [accountId, setAccountId] = useState(openAccounts[0]?.id ?? '');
  const [date, setDate] = useState(localToday);
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [notes, setNotes] = useState('');
  const [manualRecords, setManualRecords] = useState<ImportRecord[] | null>(null);
  const [manualResult, setManualResult] = useState<ImportResult | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMessage, setManualMessage] = useState('');
  const [manualError, setManualError] = useState('');

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferSourceId, setTransferSourceId] = useState(openAccounts[0]?.id ?? '');
  const [transferDestinationId, setTransferDestinationId] = useState(openAccounts.find((account) => account.id !== openAccounts[0]?.id)?.id ?? '');
  const [transferDate, setTransferDate] = useState(localToday);
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNotes, setTransferNotes] = useState('');
  const [transferImportId, setTransferImportId] = useState(newIdentifier);
  const [transferResult, setTransferResult] = useState<TransferResult | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMessage, setTransferMessage] = useState('');
  const [transferError, setTransferError] = useState('');
  const selectedTransferSource = openAccounts.find((account) => account.id === transferSourceId);
  const transferCurrency = selectedTransferSource?.currencyCode ?? selectedTransferSource?.nativeCurrencyCode ?? currency;

  const [csvOpen, setCsvOpen] = useState(false);
  const [csvAccountId, setCsvAccountId] = useState('');
  const [fileName, setFileName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [delimiter, setDelimiter] = useState<Delimiter>(';');
  const [decimalSeparator, setDecimalSeparator] = useState<',' | '.'>(',');
  const [dateFormat, setDateFormat] = useState<DateFormat>('dmy');
  const [headers, setHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [csvDateColumn, setCsvDateColumn] = useState('');
  const [csvDescriptionColumn, setCsvDescriptionColumn] = useState('');
  const [csvAmountColumn, setCsvAmountColumn] = useState('');
  const [csvDebitColumn, setCsvDebitColumn] = useState('');
  const [csvCreditColumn, setCsvCreditColumn] = useState('');
  const [csvCategoryColumn, setCsvCategoryColumn] = useState('');
  const [invertCsvAmountSign, setInvertCsvAmountSign] = useState(false);
  const [csvRecords, setCsvRecords] = useState<ImportRecord[] | null>(null);
  const [csvResult, setCsvResult] = useState<ImportResult | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvMessage, setCsvMessage] = useState('');
  const [csvError, setCsvError] = useState('');
  const [fileFormat, setFileFormat] = useState<'csv' | 'ofx' | null>(null);
  const [ofxParsed, setOfxParsed] = useState<OfxParseResult | null>(null);
  const [ofxCurrencyAcknowledged, setOfxCurrencyAcknowledged] = useState(false);

  function destinationFor(sourceId: string): string {
    const source = openAccounts.find((account) => account.id === sourceId);
    const sourceCurrency = source?.currencyCode ?? source?.nativeCurrencyCode;
    if (!source || !sourceCurrency) return '';
    return openAccounts.find((account) => {
      if (account.id === sourceId) return false;
      const destinationCurrency = account.currencyCode ?? account.nativeCurrencyCode;
      return destinationCurrency === sourceCurrency &&
        (source.offBudget === undefined || account.offBudget === undefined || source.offBudget === account.offBudget);
    })?.id ?? '';
  }

  function openTransferForm(): void {
    const sourceId = openAccounts[0]?.id ?? '';
    setTransferOpen(true);
    setManualOpen(false);
    setTransferSourceId(sourceId);
    setTransferDestinationId(destinationFor(sourceId));
    setTransferDate(localToday());
    setTransferAmount('');
    setTransferNotes('');
    setTransferImportId(newIdentifier());
    setTransferResult(null);
    setTransferMessage('');
    setTransferError('');
  }

  useEffect(() => {
    if (!quickRequest) return;
    if (quickRequest.kind === 'transfer') {
      openTransferForm();
      return;
    }
    setTransferOpen(false);
    setManualOpen(true);
    setManualKind(quickRequest.kind);
    setAmount('');
    setManualRecords(null);
    setManualResult(null);
    setManualMessage('');
    setManualError('');
  }, [quickRequest]);

  async function previewTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTransferError('');
    setTransferMessage('');
    setTransferResult(null);
    if (!transferSourceId || !openAccounts.some((account) => account.id === transferSourceId)) {
      setTransferError('Selecciona una cuenta de origen abierta dentro del ámbito global.');
      return;
    }
    if (!transferDestinationId || !openAccounts.some((account) => account.id === transferDestinationId)) {
      setTransferError('Selecciona una cuenta de destino abierta dentro del ámbito global.');
      return;
    }
    if (transferSourceId === transferDestinationId) {
      setTransferError('El origen y el destino deben ser cuentas distintas.');
      return;
    }
    if (!isValidIsoDate(transferDate)) {
      setTransferError('Introduce una fecha válida.');
      return;
    }
    const amountMinor = parseMoney(transferAmount);
    if (amountMinor === null || amountMinor <= 0) {
      setTransferError('Introduce un importe positivo distinto de cero con un máximo de dos decimales.');
      return;
    }
    setTransferBusy(true);
    try {
      const result = await sendTransfer('/api/v1/transfers/preview', {
        sourceAccountId: transferSourceId,
        destinationAccountId: transferDestinationId,
        date: transferDate,
        amountMinor,
        importedId: transferImportId,
        ...(transferNotes.trim() ? { notes: transferNotes.trim() } : {}),
      });
      setTransferResult(result);
      setTransferMessage(result.added === 0 && result.updated === 0
        ? 'Actual no propone cambios para esta transferencia; no hay ninguna operación para confirmar.'
        : 'Previsualización recibida de Actual. Todavía no se ha escrito ningún cambio; confirma solo si el origen, destino e importe son correctos.');
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : 'No se ha podido previsualizar la transferencia.');
    } finally {
      setTransferBusy(false);
    }
  }

  async function commitTransfer() {
    const preview = transferResult;
    if (!preview || !preview.dryRun || !preview.linkedTransfer || preview.errors !== 0 ||
        preview.added + preview.updated === 0 ||
        preview.sourceAccountId !== transferSourceId || preview.destinationAccountId !== transferDestinationId) {
      setTransferError('Vuelve a previsualizar la transferencia antes de confirmarla.');
      return;
    }
    const amountMinor = parseMoney(transferAmount);
    if (amountMinor === null || amountMinor <= 0) {
      setTransferError('El importe ha cambiado. Previsualiza de nuevo antes de confirmar.');
      setTransferResult(null);
      return;
    }
    setTransferBusy(true);
    setTransferError('');
    setTransferMessage('');
    try {
      const result = await sendTransfer('/api/v1/transfers/commit', {
        sourceAccountId: transferSourceId,
        destinationAccountId: transferDestinationId,
        date: transferDate,
        amountMinor,
        importedId: transferImportId,
        ...(transferNotes.trim() ? { notes: transferNotes.trim() } : {}),
      });
      setTransferResult(result);
      setTransferAmount('');
      setTransferNotes('');
      setTransferImportId(newIdentifier());
      onImported('Actual ha confirmado la operación. La transferencia se registra como pareja vinculada, no como ingreso y gasto independientes.');
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : 'No se ha podido confirmar la transferencia.');
    } finally {
      setTransferBusy(false);
    }
  }

  async function previewManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setManualError('');
    setManualMessage('');
    const amountMinor = parseMoney(amount);
    if (!accountId || !openAccounts.some((account) => account.id === accountId)) {
      setManualError('Selecciona una cuenta abierta del presupuesto.');
      return;
    }
    if (!isValidIsoDate(date)) {
      setManualError('Introduce una fecha válida.');
      return;
    }
    if (amountMinor === null) {
      setManualError('El importe debe ser distinto de cero y tener como máximo dos decimales.');
      return;
    }
    if (manualKind === 'income' && amountMinor < 0) {
      setManualError('Para registrar un ingreso, introduce un importe positivo.');
      return;
    }
    if (manualKind === 'expense' && amountMinor > 0) {
      setManualError('Para registrar un gasto, introduce un importe negativo.');
      return;
    }
    if (!payee.trim()) {
      setManualError('El concepto es obligatorio.');
      return;
    }
    setManualBusy(true);
    try {
      const record: ImportRecord = {
        date,
        amount: amountMinor,
        payee_name: payee.trim(),
        imported_payee: payee.trim(),
        imported_id: newIdentifier(),
        ...(categoryId ? { category: categoryId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      const result = await sendImport('/api/v1/import/preview', accountId, [record]);
      setManualRecords([record]);
      setManualResult(result);
      setManualMessage('Previsualización calculada. Actual no se ha modificado.');
    } catch (error) {
      setManualError(error instanceof Error ? error.message : 'No se ha podido previsualizar el movimiento.');
    } finally {
      setManualBusy(false);
    }
  }
  async function commitManual() {
    if (!manualRecords) return;
    setManualBusy(true);
    setManualError('');
    setManualMessage('');
    try {
      const result = await sendImport('/api/v1/import/commit', accountId, manualRecords);
      setManualResult(result);
      setManualRecords(null);
      setAmount('');
      setPayee('');
      setNotes('');
      onImported('Movimiento confirmado por Actual: ' + result.added + ' añadido(s), ' + result.updated + ' actualizado(s) y ' + result.errors + ' error(es).');
    } catch (error) {
      setManualError(error instanceof Error ? error.message : 'No se ha podido registrar el movimiento.');
    } finally {
      setManualBusy(false);
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    setCsvError('');
    setCsvMessage('');
    setCsvRecords(null);
    setCsvResult(null);
    setCsvRows([]);
    setHeaders([]);
    setCsvText('');
    setFileName('');
    setFileFormat(null);
    setOfxParsed(null);
    setOfxCurrencyAcknowledged(false);
    if (!file) return;

    const hasExtension = /\.[^.]+$/i.test(file.name);
    const isCsvFile = /\.csv$/i.test(file.name) || (!hasExtension && (file.type === 'text/csv' || file.type === 'application/vnd.ms-excel'));
    const isOfxFile = /\.ofx$/i.test(file.name) || (!hasExtension && (file.type === 'application/x-ofx' || file.type === 'application/ofx'));
    if (!isCsvFile && !isOfxFile) {
      setCsvError('Selecciona un archivo .csv o .ofx. No se admiten QFX, QIF ni CAMT.');
      input.value = '';
      return;
    }
    if (file.size > MAX_OFX_FILE_BYTES) {
      setCsvError('El archivo supera el límite de 350 KB. Divide el extracto en archivos más pequeños.');
      input.value = '';
      return;
    }
    try {
      if (isOfxFile) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = parseOfx(decodeOfxBytes(bytes));
        setFileFormat('ofx');
        setOfxParsed(parsed);
        setFileName(file.name);
        setCsvMessage(
          parsed.records.length + ' operaciones válidas; ' + parsed.rejected.length +
          ' rechazadas y ' + parsed.duplicateRecords +
          ' duplicadas dentro del archivo omitidas. El extracto se ha procesado íntegramente en este navegador.',
        );
        return;
      }

      const text = await file.text();
      const rows = parseCsv(text, delimiter);
      if (rows.length < 2) throw new Error('El archivo debe contener una cabecera y al menos una fila de datos.');
      const headerRow = rows[0]!.map((cell) => cell.trim());
      setFileFormat('csv');
      setFileName(file.name);
      setCsvText(text);
      setHeaders(headerRow);
      setCsvRows(rows.slice(1));
      setCsvDateColumn(findHeader(headerRow, ['date', 'fecha', 'booking date', 'transaction date']));
      setCsvDescriptionColumn(findHeader(headerRow, ['description', 'concepto', 'concept', 'payee', 'beneficiario', 'counterparty', 'merchant']));
      setCsvAmountColumn(findHeader(headerRow, ['amount', 'importe', 'monto', 'amount eur']));
      setCsvDebitColumn(findHeader(headerRow, ['debit', 'cargo', 'debe', 'outflow']));
      setCsvCreditColumn(findHeader(headerRow, ['credit', 'abono', 'haber', 'inflow']));
      setCsvCategoryColumn(findHeader(headerRow, ['category', 'categoría', 'categoria']));
      setCsvMessage((rows.length - 1) + ' filas detectadas. El archivo se procesa en el navegador y no se envía al servidor hasta que confirmes la importación.');
    } catch (error) {
      setFileFormat(null);
      setOfxParsed(null);
      setCsvError(error instanceof Error ? error.message : 'No se ha podido leer el archivo local.');
      input.value = '';
    }
  }
  function rebuildCsvForDelimiter(nextDelimiter: Delimiter) {
    setDelimiter(nextDelimiter);
    if (!csvText) return;
    try {
      const rows = parseCsv(csvText, nextDelimiter);
      if (rows.length < 2) throw new Error('El archivo debe tener cabecera y datos.');
      const nextHeaders = rows[0]!.map((cell) => cell.trim());
      setHeaders(nextHeaders);
      setCsvRows(rows.slice(1));
      setCsvDateColumn(findHeader(nextHeaders, ['date', 'fecha', 'booking date', 'transaction date']));
      setCsvDescriptionColumn(findHeader(nextHeaders, ['description', 'concepto', 'concept', 'payee', 'beneficiario', 'counterparty', 'merchant']));
      setCsvAmountColumn(findHeader(nextHeaders, ['amount', 'importe', 'monto', 'amount eur']));
      setCsvDebitColumn(findHeader(nextHeaders, ['debit', 'cargo', 'debe', 'outflow']));
      setCsvCreditColumn(findHeader(nextHeaders, ['credit', 'abono', 'haber', 'inflow']));
      setCsvCategoryColumn(findHeader(nextHeaders, ['category', 'categoría', 'categoria']));
      setCsvRecords(null);
      setCsvResult(null);
      setCsvMessage((rows.length - 1) + ' filas detectadas con el nuevo delimitador.');
      setCsvError('');
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : 'Delimitador no válido.');
    }
  }
  function buildCsvRecords(): ImportRecord[] {
    if (!csvAccountId || !openAccounts.some((account) => account.id === csvAccountId)) throw new Error('Selecciona explícitamente una cuenta de destino abierta.');
    if (csvDateColumn === '' || csvDescriptionColumn === '') throw new Error('Asigna las columnas de fecha y concepto.');
    if (csvAmountColumn === '' && csvDebitColumn === '' && csvCreditColumn === '') throw new Error('Asigna una columna de importe o de cargo/abono.');
    const categoryMap = new Map(categories.map((category) => [category.name.trim().toLocaleLowerCase('es'), category.id]));
    const records: ImportRecord[] = [];
    const errors: string[] = [];
    for (const [index, row] of csvRows.entries()) {
      const rowNumber = index + 2;
      const rawDate = selectorValue(row, csvDateColumn);
      const parsedDate = parseDate(rawDate, dateFormat);
      const description = selectorValue(row, csvDescriptionColumn);
      let amountMinor: number | null;
      if (csvAmountColumn !== '') {
        const parsedAmount = parseCsvMoney(selectorValue(row, csvAmountColumn), decimalSeparator);
        amountMinor = parsedAmount === null ? null : invertCsvAmountSign ? -parsedAmount : parsedAmount;
      } else {
        const debitText = selectorValue(row, csvDebitColumn);
        const creditText = selectorValue(row, csvCreditColumn);
        const debit = debitText ? parseCsvMoney(debitText, decimalSeparator) : 0;
        const credit = creditText ? parseCsvMoney(creditText, decimalSeparator) : 0;
        if (debit === null || credit === null) amountMinor = null;
        else if (debitText && creditText && debit !== 0 && credit !== 0) amountMinor = null;
        else if (credit !== 0) amountMinor = Math.abs(credit);
        else if (debit !== 0) amountMinor = -Math.abs(debit);
        else amountMinor = null;
      }
      const rawCategory = selectorValue(row, csvCategoryColumn);
      const matchedCategory = rawCategory ? categoryMap.get(rawCategory.toLocaleLowerCase('es')) : undefined;
      if (!parsedDate) errors.push('Fila ' + rowNumber + ': fecha "' + rawDate + '" no válida.');
      if (amountMinor === null || amountMinor === 0) errors.push('Fila ' + rowNumber + ': importe no válido.');
      if (!description) errors.push('Fila ' + rowNumber + ': falta el concepto.');
      if (rawCategory && !matchedCategory) errors.push('Fila ' + rowNumber + ': la categoría "' + rawCategory + '" no coincide con Actual Budget.');
      if (!parsedDate || amountMinor === null || amountMinor === 0 || !description || (rawCategory && !matchedCategory)) continue;
      const importedId = 'personal-budget-csv:' + stableHash(String(rowNumber) + '|' + parsedDate + '|' + amountMinor + '|' + description + '|' + (matchedCategory ?? ''));
      records.push({
        date: parsedDate,
        amount: amountMinor,
        payee_name: description.slice(0, 200),
        imported_payee: description.slice(0, 500),
        imported_id: importedId,
        ...(matchedCategory ? { category: matchedCategory } : {}),
      });
    }
    if (errors.length) throw new Error(errors.slice(0, 8).join(' ') + (errors.length > 8 ? ' Y ' + (errors.length - 8) + ' errores más.' : ''));
    if (records.length === 0) throw new Error('No hay movimientos válidos que importar.');
    if (records.length > 2_000) throw new Error('El CSV supera el máximo de 2.000 movimientos por importación.');
    return records;
  }
  async function previewCsv() {
    setCsvError('');
    setCsvMessage('');
    // A failed re-preview must not leave an older import confirmation actionable.
    setCsvRecords(null);
    setCsvResult(null);
    setCsvBusy(true);
    try {
      if (!csvAccountId || !openAccounts.some((account) => account.id === csvAccountId)) {
        throw new Error('Selecciona explícitamente una cuenta de destino abierta.');
      }
      let records: ImportRecord[];
      if (fileFormat === 'ofx') {
        if (!ofxParsed) throw new Error('Carga primero un archivo OFX válido.');
        if (ofxParsed.records.length === 0) throw new Error('El OFX no contiene operaciones importables. Revisa los registros rechazados.');
        const selected = openAccounts.find((account) => account.id === csvAccountId);
        const selectedCurrency = (selected?.nativeCurrencyCode ?? selected?.currencyCode)?.trim().toUpperCase() ?? '';
        if (ofxParsed.currencyCode && selectedCurrency && ofxParsed.currencyCode !== selectedCurrency) {
          throw new Error('La divisa del extracto (' + ofxParsed.currencyCode + ') no coincide con la divisa nativa de la cuenta destino (' + selectedCurrency + '). No se ha escrito ningún cambio.');
        }
        if ((!ofxParsed.currencyCode || !selectedCurrency) && !ofxCurrencyAcknowledged) {
          throw new Error('No se ha podido verificar la divisa de origen. Confirma explícitamente que el extracto corresponde a la cuenta y divisa destino antes de continuar.');
        }
        records = ofxParsed.records.map((record) => ({ ...record }));
      } else {
        if (fileFormat !== 'csv' || !csvRows.length) throw new Error('Carga primero un archivo CSV con cabecera y datos.');
        records = buildCsvRecords();
      }

      const sourceOptions: ImportSourceOptions | undefined = fileFormat === 'ofx' && ofxParsed
        ? {
            sourceFormat: 'ofx',
            ...(ofxParsed.currencyCode ? { sourceCurrencyCode: ofxParsed.currencyCode } : {}),
            allowUnverifiedCurrency: ofxNeedsCurrencyAcknowledgement && ofxCurrencyAcknowledged,
          }
        : undefined;
      const result = await sendImport('/api/v1/import/preview', csvAccountId, records, sourceOptions);
      setCsvRecords(records);
      setCsvResult(result);
      if (fileFormat === 'ofx' && ofxParsed) {
        setCsvMessage(
          'Previsualización OFX de ' + ofxParsed.profile + ': ' + records.length + ' operaciones válidas; ' +
          ofxParsed.rejected.length + ' rechazadas y ' + ofxParsed.duplicateRecords +
          ' duplicadas internas omitidas. Actual detecta ' + result.added + ' nuevas y ' + result.updated +
          ' posibles coincidencias/actualizaciones. No se han escrito cambios.',
        );
      } else {
        setCsvMessage('Previsualización completada: ' + result.added + ' movimientos nuevos y ' + result.updated + ' posibles conciliaciones/actualizaciones. No se han escrito cambios.');
      }
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : 'No se ha podido previsualizar la importación.');
    } finally {
      setCsvBusy(false);
    }
  }
  async function commitCsv() {
    if (!csvRecords) return;
    setCsvBusy(true);
    setCsvError('');
    setCsvMessage('');
    try {
      if (!csvAccountId || !openAccounts.some((account) => account.id === csvAccountId)) {
        throw new Error('La cuenta destino ya no está abierta. Selecciona una cuenta y vuelve a previsualizar.');
      }
      if (fileFormat === 'ofx') {
        if (!ofxParsed || !ofxParsed.records.length) throw new Error('El archivo OFX ya no contiene registros validados. Vuelve a cargarlo.');
        const selected = openAccounts.find((account) => account.id === csvAccountId);
        const selectedCurrency = (selected?.nativeCurrencyCode ?? selected?.currencyCode)?.trim().toUpperCase() ?? '';
        if (ofxParsed.currencyCode && selectedCurrency && ofxParsed.currencyCode !== selectedCurrency) {
          setCsvRecords(null);
          throw new Error('La divisa del extracto ya no coincide con la cuenta destino. No se ha escrito ningún cambio.');
        }
        if ((!ofxParsed.currencyCode || !selectedCurrency) && !ofxCurrencyAcknowledged) {
          setCsvRecords(null);
          throw new Error('Debes confirmar la divisa del extracto antes de importar.');
        }
      }
      const sourceOptions: ImportSourceOptions | undefined = fileFormat === 'ofx' && ofxParsed
        ? {
            sourceFormat: 'ofx',
            ...(ofxParsed.currencyCode ? { sourceCurrencyCode: ofxParsed.currencyCode } : {}),
            allowUnverifiedCurrency: ofxNeedsCurrencyAcknowledgement && ofxCurrencyAcknowledged,
          }
        : undefined;
      const result = await sendImport('/api/v1/import/commit', csvAccountId, csvRecords, sourceOptions);
      setCsvResult(result);
      setCsvRecords(null);
      onImported(
        (fileFormat === 'ofx' ? 'Importación OFX' : 'Importación CSV') +
        ' confirmada por Actual: ' + result.added + ' añadido(s), ' + result.updated +
        ' actualizado(s) y ' + result.errors +
        ' error(es). Los movimientos se concilian mediante su identificador importado.',
      );
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : 'No se ha podido confirmar la importación.');
    } finally {
      setCsvBusy(false);
    }
  }
  const columnOptions = useMemo(() => headers.map((header, index) => ({
    value: String(index),
    label: (header || ('Columna ' + (index + 1))) + ' (' + (index + 1) + ')',
  })), [headers]);
  const selectedImportAccount = openAccounts.find((account) => account.id === csvAccountId);
  const selectedImportCurrency = (selectedImportAccount?.nativeCurrencyCode ?? selectedImportAccount?.currencyCode)?.trim().toUpperCase() ?? '';
  const importCurrency = fileFormat === 'ofx' ? selectedImportCurrency || ofxParsed?.currencyCode || currency : currency;
  const ofxCurrencyMismatch = Boolean(fileFormat === 'ofx' && ofxParsed?.currencyCode && selectedImportCurrency && ofxParsed.currencyCode !== selectedImportCurrency);
  const ofxNeedsCurrencyAcknowledgement = Boolean(fileFormat === 'ofx' && ofxParsed && (!ofxParsed.currencyCode || !selectedImportCurrency));
  const hasImportSource = fileFormat === 'csv' ? csvRows.length > 0 : fileFormat === 'ofx' ? (ofxParsed?.records.length ?? 0) > 0 : false;

  return (
    <section className="movement-tools" aria-label="Registro e importación de movimientos">
      <div className="movement-tools-header">
        <div><p className="eyebrow">GESTIÓN DE MOVIMIENTOS</p><h3>Nuevo movimiento o importación</h3></div>
        <div className="tool-actions">
          <button className="button secondary" type="button" onClick={() => { setManualOpen((open) => { if (!open) setManualKind('any'); return !open; }); setTransferOpen(false); setManualError(''); setManualRecords(null); }}>{manualOpen ? 'Cerrar formulario' : 'Registrar movimiento'}</button>
          <button className="button secondary" type="button" disabled={openAccounts.length < 2} onClick={() => { if (transferOpen) { setTransferOpen(false); setTransferResult(null); setTransferMessage(''); setTransferError(''); } else openTransferForm(); }}>{transferOpen ? 'Cerrar transferencia' : 'Registrar transferencia'}</button>
          <button className="button secondary" type="button" onClick={() => { setCsvOpen((open) => !open); setCsvError(''); }}>{csvOpen ? 'Cerrar importación' : 'Importar CSV / OFX'}</button>
        </div>
      </div>

      {manualOpen ? (
        <form className="tool-panel" onSubmit={previewManual}>
          <div className="panel-heading"><div><p className="eyebrow">REGISTRO MANUAL</p><h4>{manualKind === 'income' ? 'Registrar ingreso' : manualKind === 'expense' ? 'Registrar gasto' : 'Añadir a Actual Budget'}</h4></div><span className="muted-label">Importe en {currency}</span></div>
          <div className="manual-form-grid">
            <label className="field-label">Cuenta destino<select value={accountId} onChange={(event) => { setAccountId(event.currentTarget.value); setManualRecords(null); }} required>{openAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
            <label className="field-label">Fecha<input type="date" value={date} onChange={(event) => { setDate(event.currentTarget.value); setManualRecords(null); }} required /></label>
            <label className="field-label">Importe ({currency})<input type="text" inputMode="decimal" autoComplete="off" placeholder={manualKind === 'income' ? 'Importe positivo, por ejemplo 1500' : manualKind === 'expense' ? 'Importe negativo, por ejemplo -25,99' : '-25,99 gasto · 1500 ingreso'} value={amount} onChange={(event) => { setAmount(event.currentTarget.value); setManualRecords(null); }} required /></label>
            <label className="field-label">Concepto<input type="text" maxLength={200} value={payee} onChange={(event) => { setPayee(event.currentTarget.value); setManualRecords(null); }} placeholder="Supermercado, nómina…" required /></label>
            <label className="field-label">Categoría<select value={categoryId} onChange={(event) => { setCategoryId(event.currentTarget.value); setManualRecords(null); }}><option value="">Sin categoría</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label className="field-label">Notas (opcional)<input type="text" maxLength={2000} value={notes} onChange={(event) => { setNotes(event.currentTarget.value); setManualRecords(null); }} /></label>
          </div>
          <p className="tool-hint">Los gastos usan importes negativos y los ingresos positivos{manualKind === 'income' ? '; este formulario valida que el importe sea positivo.' : manualKind === 'expense' ? '; este formulario valida que el importe sea negativo.' : '.'} Antes de escribir, se muestra una previsualización de conciliación de Actual Budget.</p>
          <div className="tool-actions">
            <button className="button primary" type="submit" disabled={manualBusy || openAccounts.length === 0}>{manualBusy ? 'Comprobando…' : 'Previsualizar'}</button>
            {manualRecords ? <button className="button primary" type="button" disabled={manualBusy} onClick={() => void commitManual()}>{manualBusy ? 'Guardando…' : 'Confirmar y registrar'}</button> : null}
            {manualRecords ? <button className="button secondary" type="button" disabled={manualBusy} onClick={() => { setManualRecords(null); setManualMessage('Previsualización cancelada. No se ha modificado el presupuesto.'); }}>{'Cancelar'}</button> : null}
          </div>
          {manualResult ? <FormAlert>{manualResult.dryRun ? 'Previsualización: ' + manualResult.added + ' nuevos, ' + manualResult.updated + ' actualizables, ' + manualResult.errors + ' errores.' : 'Resultado: ' + manualResult.added + ' añadidos, ' + manualResult.updated + ' actualizados.'}</FormAlert> : null}
          {manualMessage ? <FormAlert>{manualMessage}</FormAlert> : null}
          {manualError ? <FormAlert error>{manualError}</FormAlert> : null}
        </form>
      ) : null}


      {transferOpen ? (
        <form className="tool-panel" onSubmit={previewTransfer}>
          <div className="panel-heading"><div><p className="eyebrow">TRANSFERENCIA VINCULADA</p><h4>Entre cuentas de Actual Budget</h4></div><span className="muted-label">Importe en moneda de las cuentas</span></div>
          {openAccounts.length < 2 ? <FormAlert error>Necesitas al menos dos cuentas abiertas dentro del ámbito global para registrar una transferencia.</FormAlert> : null}
          <div className="manual-form-grid">
            <label className="field-label">Cuenta de origen<select value={transferSourceId} onChange={(event) => { const nextSource = event.currentTarget.value; setTransferSourceId(nextSource); setTransferDestinationId(destinationFor(nextSource)); setTransferResult(null); setTransferMessage(''); setTransferError(''); }} required><option value="">Selecciona origen…</option>{openAccounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
            <label className="field-label">Cuenta de destino<select value={transferDestinationId} onChange={(event) => { setTransferDestinationId(event.currentTarget.value); setTransferResult(null); setTransferMessage(''); setTransferError(''); }} required><option value="">Selecciona destino…</option>{openAccounts.filter((account) => account.id !== transferSourceId).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
            <label className="field-label">Fecha<input type="date" value={transferDate} onChange={(event) => { setTransferDate(event.currentTarget.value); setTransferResult(null); setTransferMessage(''); setTransferError(''); }} required /></label>
            <label className="field-label">Importe positivo ({transferCurrency})<input type="text" inputMode="decimal" autoComplete="off" placeholder="Por ejemplo, 125,00" value={transferAmount} onChange={(event) => { setTransferAmount(event.currentTarget.value); setTransferResult(null); setTransferMessage(''); setTransferError(''); }} required /></label>
            <label className="field-label">Notas (opcional)<input type="text" maxLength={2000} value={transferNotes} onChange={(event) => { setTransferNotes(event.currentTarget.value); setTransferResult(null); setTransferMessage(''); setTransferError(''); }} /></label>
          </div>
          <p className="tool-hint">El importe se introduce en la divisa nativa del origen ({transferCurrency}); se descuenta del origen y Actual crea la contrapartida vinculada en el destino a través del beneficiario de transferencia oficial. Solo se admiten dos cuentas abiertas del ámbito activo, de la misma divisa y ambas dentro o ambas fuera de presupuesto. No se guarda nada hasta confirmar.</p>
          <div className="tool-actions">
            <button className="button primary" type="submit" disabled={transferBusy || openAccounts.length < 2}>{transferBusy ? 'Comprobando…' : 'Previsualizar transferencia'}</button>
            {transferResult?.dryRun && transferResult.linkedTransfer && transferResult.errors === 0 && transferResult.added + transferResult.updated > 0
              ? <button className="button primary" type="button" disabled={transferBusy} onClick={() => void commitTransfer()}>{transferBusy ? 'Guardando…' : 'Confirmar transferencia'}</button>
              : null}
            {transferResult?.dryRun
              ? <button className="button secondary" type="button" disabled={transferBusy} onClick={() => { setTransferResult(null); setTransferMessage('Previsualización cancelada. Actual no se ha modificado.'); setTransferError(''); }}>Cancelar previsualización</button>
              : null}
          </div>
          {transferResult ? <FormAlert>{(transferResult.dryRun
            ? 'Previsualización: ' + transferResult.added + ' nueva(s), ' + transferResult.updated + ' actualizable(s), ' + transferResult.errors + ' error(es).'
            : 'Resultado confirmado por Actual: ' + transferResult.added + ' añadida(s), ' + transferResult.updated + ' actualizada(s).') + ' ' + (transferResult.linkedTransfer ? 'Vinculación de transferencia identificada.' : 'No se ha confirmado una pareja vinculada.')}</FormAlert> : null}
          {transferMessage ? <FormAlert>{transferMessage}</FormAlert> : null}
          {transferError ? <FormAlert error>{transferError}</FormAlert> : null}
        </form>
      ) : null}

      {csvOpen ? (
        <div className="tool-panel">
          <div className="panel-heading"><div><p className="eyebrow">EXTRACTO LOCAL</p><h4>CSV / OFX con previsualización y conciliación</h4></div><span className="muted-label">Máx. 350 KB / 2.000 operaciones</span></div>
          <p className="tool-hint">Los archivos se leen y procesan localmente en el navegador. Selecciona la cuenta destino de forma explícita y revisa los registros, advertencias y posibles coincidencias antes de confirmar. OFX admite SGML 1.02/1.03 y XML OFX 2.x; no se admiten QFX, QIF ni CAMT. Consulta la <a href="https://github.com/miguel-np/personal-budget/blob/main/docs/ofx-import.md" target="_blank" rel="noreferrer">guía de importación OFX</a>.</p>
          <div className="csv-controls-top">
            <label className="field-label">Archivo CSV u OFX<input type="file" accept=".csv,text/csv,.ofx,application/x-ofx,application/ofx" onChange={(event) => void handleFile(event)} /></label>
            <label className="field-label">Cuenta destino<select value={csvAccountId} onChange={(event) => { setCsvAccountId(event.currentTarget.value); setCsvRecords(null); setCsvResult(null); setOfxCurrencyAcknowledged(false); setCsvError(''); }} required><option value="">Selecciona cuenta destino…</option>{openAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
            <label className="field-label">Delimitador<select value={delimiter} onChange={(event) => rebuildCsvForDelimiter(event.currentTarget.value as Delimiter)}><option value=";">Punto y coma (;)</option><option value=",">Coma (,)</option><option value={'\t'}>Tabulador</option></select></label>
            <label className="field-label">Separador decimal<select value={decimalSeparator} onChange={(event) => { setDecimalSeparator(event.currentTarget.value as ',' | '.'); setCsvRecords(null); }}><option value=",">Coma (12,34)</option><option value=".">Punto (12.34)</option></select></label>
            <label className="field-label">Formato de fecha<select value={dateFormat} onChange={(event) => { setDateFormat(event.currentTarget.value as DateFormat); setCsvRecords(null); }}><option value="iso">AAAA-MM-DD</option><option value="dmy">DD/MM/AAAA</option><option value="mdy">MM/DD/AAAA</option></select></label>
            <label className="field-label">Signo del importe<select value={invertCsvAmountSign ? 'invert' : 'signed'} onChange={(event) => { setInvertCsvAmountSign(event.currentTarget.value === 'invert'); setCsvRecords(null); }}><option value="signed">Mantener signo del archivo</option><option value="invert">Invertir signo del importe</option></select></label>
          </div>
          {fileName ? <p className="file-caption">Archivo cargado: <strong>{fileName}</strong>{fileFormat === 'ofx' ? ' · Extracto OFX local' : ' · ' + csvRows.length + ' filas de datos'}</p> : null}
          {fileFormat === 'ofx' && ofxParsed ? (
            <div className="csv-sample ofx-import-summary" role="region" aria-label="Resumen de validación del extracto OFX">
              <strong>{ofxParsed.profile} · {ofxParsed.currencyCode ?? 'Divisa no declarada'}</strong>
              <p>{ofxParsed.records.length} operaciones válidas · {ofxParsed.rejected.length} rechazadas · {ofxParsed.duplicateRecords} duplicadas dentro del archivo omitidas.</p>
              {ofxParsed.warnings.map((warning, index) => <p className="tool-hint" key={'warning-' + index}>Aviso: {warning}</p>)}
              {ofxParsed.omittedFields.map((field, index) => <p className="tool-hint" key={'omitted-' + index}>Dato omitido: {field}</p>)}
              {ofxParsed.rejected.length > 0 ? (
                <div role="note" aria-label="Registros rechazados">
                  <strong>Registros rechazados ({ofxParsed.rejected.length})</strong>
                  <ul>{ofxParsed.rejected.slice(0, 8).map((issue, index) => <li key={'rejected-' + index}>{issue}</li>)}</ul>
                  {ofxParsed.rejected.length > 8 ? <p className="tool-hint">Se muestran los primeros 8 de {ofxParsed.rejected.length} errores de formato. El contenido del extracto no se registra en logs.</p> : null}
                </div>
              ) : null}
              {ofxCurrencyMismatch ? <FormAlert error>{'La divisa declarada (' + ofxParsed.currencyCode + ') no coincide con la divisa de la cuenta destino (' + selectedImportCurrency + '). La importación está bloqueada y no se realizará ninguna conversión.'}</FormAlert> : null}
              {csvAccountId && ofxNeedsCurrencyAcknowledgement ? (
                <label className="field-label ofx-currency-ack">
                  <input type="checkbox" checked={ofxCurrencyAcknowledged} onChange={(event) => { setOfxCurrencyAcknowledged(event.currentTarget.checked); setCsvRecords(null); setCsvResult(null); setCsvError(''); }} />
                  {ofxParsed.currencyCode
                    ? 'Actual no declara una divisa fiable para esta cuenta. Confirmo que el extracto está expresado en ' + ofxParsed.currencyCode + ' y corresponde a la cuenta destino seleccionada.'
                    : 'El extracto no declara CURDEF o la cuenta no tiene divisa fiable. Confirmo que ambos corresponden a la misma divisa; no se aplicará conversión.'}
                </label>
              ) : null}
            </div>
          ) : null}
          {fileFormat === 'csv' && headers.length ? (
            <>
              <div className="csv-mapping-grid">
                <label className="field-label">Fecha<select value={csvDateColumn} onChange={(event) => { setCsvDateColumn(event.currentTarget.value); setCsvRecords(null); }}><option value="">Elegir columna…</option>{columnOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label className="field-label">Concepto / beneficiario<select value={csvDescriptionColumn} onChange={(event) => { setCsvDescriptionColumn(event.currentTarget.value); setCsvRecords(null); }}><option value="">Elegir columna…</option>{columnOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label className="field-label">Importe firmado<select value={csvAmountColumn} onChange={(event) => { setCsvAmountColumn(event.currentTarget.value); setCsvRecords(null); }}><option value="">Usar cargo / abono…</option>{columnOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label className="field-label">Cargos / gastos<select value={csvDebitColumn} onChange={(event) => { setCsvDebitColumn(event.currentTarget.value); setCsvAmountColumn(''); setCsvRecords(null); }}><option value="">Sin columna de cargos</option>{columnOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label className="field-label">Abonos / ingresos<select value={csvCreditColumn} onChange={(event) => { setCsvCreditColumn(event.currentTarget.value); setCsvAmountColumn(''); setCsvRecords(null); }}><option value="">Sin columna de abonos</option>{columnOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label className="field-label">Categoría (opcional)<select value={csvCategoryColumn} onChange={(event) => { setCsvCategoryColumn(event.currentTarget.value); setCsvRecords(null); }}><option value="">Sin importar categorías</option>{columnOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              </div>
              <div className="csv-sample">
                <strong>Ejemplo de cabecera detectada</strong>
                <div className="csv-sample-header">{headers.slice(0, 6).map((header, index) => <span key={index}>{header || ('Columna ' + (index + 1))}</span>)}</div>
                {csvRows.slice(0, 3).map((row, index) => <div className="csv-sample-row" key={index}>{row.slice(0, 6).map((cell, cellIndex) => <span key={cellIndex}>{cell}</span>)}</div>)}
              </div>
            </>
          ) : null}
          {csvRecords ? (
            <div className="csv-preview-result">
              <div className="panel-heading"><div><p className="eyebrow">PREVISUALIZACIÓN DE CONCILIACIÓN</p><h4>Movimientos normalizados</h4></div><span className="muted-label">{csvRecords.length} filas</span></div>
              <p className="tool-hint">
                Cuenta destino: <strong>{openAccounts.find((account) => account.id === csvAccountId)?.name ?? 'Cuenta no disponible'}</strong>.
                {csvResult?.dryRun ? ' Actual informa ' + csvResult.added + ' movimientos nuevos y ' + csvResult.updated + ' actualizables; el análisis no ha escrito cambios.' : ' Revisa las filas antes de confirmar.'}
              </p>
              <div className="csv-preview-table-wrap" role="region" aria-label="Previsualización de movimientos importados; desplázate horizontalmente para ver todas las columnas" tabIndex={0}>
                <table className="csv-preview-table">
                  <thead><tr><th scope="col">Fecha</th><th scope="col">Concepto</th><th scope="col">Categoría</th><th scope="col">Importe ({importCurrency})</th><th scope="col">Resultado</th></tr></thead>
                  <tbody>{csvRecords.slice(0, 50).map((record) => {
                    const category = categories.find((candidate) => candidate.id === record.category);
                    const amountLabel = new Intl.NumberFormat('es-ES', { style: 'currency', currency: importCurrency, maximumFractionDigits: 2 }).format(record.amount / 100);
                    return <tr key={record.imported_id}>
                      <td>{record.date}</td>
                      <td>{record.payee_name}</td>
                      <td>{category?.name ?? 'Sin categoría'}</td>
                      <td className={'amount-cell ' + (record.amount < 0 ? 'expense' : 'income')}>{amountLabel}</td>
                      <td><span className="cleared-badge">Pendiente de confirmación</span></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              {csvRecords.length > 50 ? <p className="tool-hint">Se muestran las primeras 50 filas de {csvRecords.length}; todas se incluyen en la operación confirmada.</p> : null}
            </div>
          ) : null}
          <div className="tool-actions">
            <button className="button primary" type="button" disabled={csvBusy || !hasImportSource || !csvAccountId || openAccounts.length === 0 || ofxCurrencyMismatch || (ofxNeedsCurrencyAcknowledgement && !ofxCurrencyAcknowledged)} onClick={() => void previewCsv()}>{csvBusy ? 'Analizando…' : 'Validar y previsualizar'}</button>
            {csvRecords ? <button className="button primary" type="button" disabled={csvBusy} onClick={() => void commitCsv()}>{csvBusy ? 'Importando…' : 'Confirmar importación (' + csvRecords.length + ')'}</button> : null}
            {csvRecords ? <button className="button secondary" type="button" disabled={csvBusy} onClick={() => { setCsvRecords(null); setCsvMessage('Confirmación cancelada. No se han escrito movimientos.'); }}>{'Cancelar'}</button> : null}
          </div>
          {csvResult ? <FormAlert>{csvResult.dryRun ? 'Previsualización: ' + csvResult.added + ' nuevos, ' + csvResult.updated + ' posibles coincidencias, ' + csvResult.errors + ' errores.' : 'Resultado confirmado: ' + csvResult.added + ' añadidos, ' + csvResult.updated + ' actualizados, ' + csvResult.errors + ' errores.'}</FormAlert> : null}
          {csvMessage ? <FormAlert>{csvMessage}</FormAlert> : null}
          {csvError ? <FormAlert error>{csvError}</FormAlert> : null}
        </div>
      ) : null}
    </section>
  );
}
