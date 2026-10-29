import { useEffect, useState } from 'react';
import { downloadTextFile, downloadXlsxFile, exportDateStamp, escapeHtml, formatMinorAmount, minorUnitsToMajor, printHtmlDocument, serializeCsv, type XlsxCellValue, type XlsxSheet } from './export-utils.js';

interface ReportCategory {
  categoryId: string | null;
  categoryName: string;
  amountMinor: number;
  transactionCount: number;
}
interface ExchangeRateUsed {
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveDate: string;
  source: string;
  inverseRate: boolean;
  transactionCount: number;
}
interface ReportSummary {
  currency: string;
  accountScope?: {
    mode: 'all' | 'selected';
    accountIds: readonly string[];
    accountNames: readonly string[];
    label: string;
  };
  startDate: string;
  endDate: string;
  incomeMinor: number;
  expenseMinor: number;
  savingsMinor: number;
  savingsRatePercent: number | null;
  uncategorizedOutflowMinor: number;
  unclassifiedInflowMinor: number;
  excludedTransferCount: number;
  transactionCount: number;
  unconvertedTransactionCount?: number;
  exchangeRatesUsed?: readonly ExchangeRateUsed[];
  expensesByCategory: readonly ReportCategory[];
  incomeByCategory: readonly ReportCategory[];
  warnings: readonly string[];
}
interface Period {
  startDate: string;
  endDate: string;
}
interface ReportMovement {
  id: string;
  date: string;
  account: string;
  amount: number;
  currencyCode?: string | null;
  currency_code?: string | null;
  displayAmountMinor?: number | null;
  displayCurrency?: string | null;
  category?: string | null;
  payee_name?: string | null;
  imported_payee?: string | null;
  notes?: string | null;
  cleared?: boolean;
  transfer_id?: string | null;
  parent_id?: string | null;
  parent_transaction_id?: string | null;
  is_parent?: boolean;
  is_child?: boolean;
  is_split_child?: boolean;
  conversion?: { warning?: string; rate?: string | null; effectiveDate?: string | null; source?: string | null };
}
interface ReportMovementResponse {
  data?: ReportMovement[];
  error?: { message?: string };
  pagination?: { total: number; limit: number; offset: number };
}
interface ReportExportPanelProps {
  current: ReportSummary;
  previous: ReportSummary;
  period: Period;
  comparisonPeriod: Period;
}
type MetricUnit = 'minor' | 'porcentaje' | 'movimientos';
interface MetricRow {
  label: string;
  value: number | null;
  previousValue: number | null;
  unit: MetricUnit;
  category?: string;
}

function ratesDescription(summary: ReportSummary): string {
  const rates = summary.exchangeRatesUsed ?? [];
  if (rates.length === 0) return 'Sin tipos de cambio aplicados o declarados por la API.';
  return rates.map((rate) =>
    rate.fromCurrency + '/' + rate.toCurrency + '=' + rate.rate +
    ' (' + rate.effectiveDate + '; ' + rate.source + '; ' +
    rate.transactionCount + ' movimientos' + (rate.inverseRate ? '; tasa inversa' : '') + ')',
  ).join(' | ');
}

function reportSnapshot(summary: ReportSummary): Record<string, unknown> {
  return {
    period: { startDate: summary.startDate, endDate: summary.endDate },
    analysisCurrency: summary.currency,
    accountScope: summary.accountScope ? {
      mode: summary.accountScope.mode,
      label: summary.accountScope.label,
      accountNames: [...summary.accountScope.accountNames],
    } : null,
    metrics: {
      incomeMinor: summary.incomeMinor,
      expenseMinor: summary.expenseMinor,
      savingsMinor: summary.savingsMinor,
      savingsRatePercent: summary.savingsRatePercent,
      uncategorizedOutflowMinor: summary.uncategorizedOutflowMinor,
      unclassifiedInflowMinor: summary.unclassifiedInflowMinor,
      transactionCount: summary.transactionCount,
      unconvertedTransactionCount: summary.unconvertedTransactionCount ?? null,
      excludedTransferCount: summary.excludedTransferCount,
    },
    expensesByCategory: summary.expensesByCategory.map((item) => ({ ...item })),
    incomeByCategory: summary.incomeByCategory.map((item) => ({ ...item })),
    exchangeRatesUsed: [...(summary.exchangeRatesUsed ?? [])],
    warnings: [...summary.warnings],
  };
}



async function fetchReportMovements(
  current: ReportSummary,
  period: Period,
  maxRows: number,
): Promise<readonly ReportMovement[]> {
  const selectedIds = current.accountScope?.mode === 'selected' ? [...current.accountScope.accountIds] : [];
  if (current.accountScope?.mode === 'selected' && selectedIds.length === 0) {
    throw new Error('El informe declara cuentas seleccionadas, pero no proporciona sus identificadores. No se exportará un conjunto más amplio por defecto.');
  }
  const requestedAccounts: (string | null)[] = selectedIds.length ? selectedIds : [null];
  const allRows: ReportMovement[] = [];
  const pageLimit = 200;
  for (const accountId of requestedAccounts) {
    const filters = new URLSearchParams({
      startDate: period.startDate, endDate: period.endDate, limit: String(pageLimit),
      offset: '0', sortBy: 'date', order: 'asc',
    });
    if (accountId) filters.set('accountId', accountId);
    const localRows: ReportMovement[] = [];
    let expectedTotal: number | null = null;
    let offset = 0;
    while (true) {
      filters.set('offset', String(offset));
      const response = await fetch('/api/v1/transactions?' + filters.toString(), { headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => ({})) as ReportMovementResponse;
      if (!response.ok || !Array.isArray(payload.data)) {
        throw new Error(payload.error?.message ?? 'No se han podido consultar los movimientos del informe.');
      }
      const page = payload.data;
      const reportedTotal = payload.pagination?.total ?? (offset === 0 ? page.length : undefined);
      if (reportedTotal === undefined || !Number.isSafeInteger(reportedTotal) || reportedTotal < 0) {
        throw new Error('La API devolvió un total de movimientos no válido. No se ha creado ningún archivo.');
      }
      if (expectedTotal === null) {
        expectedTotal = reportedTotal;
        if (allRows.length + expectedTotal > maxRows) {
          throw new Error('El anexo incluiría más de ' + maxRows + ' movimientos. Reduce el periodo o el ámbito de cuentas; no se ha creado ningún archivo parcial.');
        }
      } else if (reportedTotal !== expectedTotal) {
        throw new Error('El total de movimientos cambió durante la consulta del anexo. Vuelve a preparar la exportación.');
      }
      if (page.length === 0 && localRows.length < expectedTotal) {
        throw new Error('La consulta del anexo quedó incompleta. No se ha creado ningún archivo.');
      }
      localRows.push(...page);
      if (localRows.length > expectedTotal) {
        throw new Error('La consulta del anexo devolvió más movimientos de los esperados. No se ha creado ningún archivo.');
      }
      if (localRows.length === expectedTotal) break;
      offset += page.length;
    }
    const ids = new Set(localRows.map((item) => item.id));
    if (localRows.length !== expectedTotal || ids.size !== localRows.length) {
      throw new Error('No se pudo verificar el total o la unicidad de los movimientos del anexo. No se ha creado ningún archivo.');
    }
    allRows.push(...localRows);
  }
  if (new Set(allRows.map((item) => item.id)).size !== allRows.length) {
    throw new Error('Se han detectado identificadores repetidos al combinar las cuentas. No se ha creado ningún archivo.');
  }
  return allRows;
}

function reportMovementLabels(
  current: ReportSummary,
  previous: ReportSummary,
): { accounts: ReadonlyMap<string, string>; categories: ReadonlyMap<string, string> } {
  const accounts = new Map<string, string>();
  current.accountScope?.accountIds.forEach((id, index) => {
    accounts.set(id, current.accountScope?.accountNames[index] ?? id);
  });
  const categories = new Map<string, string>();
  for (const item of [
    ...current.expensesByCategory, ...current.incomeByCategory,
    ...previous.expensesByCategory, ...previous.incomeByCategory,
  ]) if (item.categoryId) categories.set(item.categoryId, item.categoryName);
  return { accounts, categories };
}

function reportMovementSheet(
  movements: readonly ReportMovement[],
  labels: { accounts: ReadonlyMap<string, string>; categories: ReadonlyMap<string, string> },
): XlsxSheet {
  const rows: XlsxCellValue[][] = [[
    'Fecha', 'Concepto', 'Cuenta', 'Categoría', 'Importe nativo', 'Divisa nativa',
    'Importe nativo (unidades menores)', 'Importe de análisis', 'Divisa de análisis',
    'Importe análisis (unidades menores)', 'Tipo de cambio', 'Fecha de conversión',
    'Fuente de conversión', 'Notas', 'Conciliado', 'ID movimiento', 'ID transferencia',
    'ID padre', 'ID movimiento padre', 'Es padre', 'Es hijo', 'Es parte de desglose',
  ]];
  const major = (minor: number | null | undefined, currency: string | null | undefined): number | null => {
    if (minor === null || minor === undefined || !currency) return null;
    try { return minorUnitsToMajor(minor, currency); } catch { return null; }
  };
  const date = (value: string): Date | string => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : value;
  };
  for (const item of movements) {
    const nativeCurrency = item.currencyCode ?? item.currency_code ?? null;
    rows.push([
      date(item.date),
      item.imported_payee?.trim() || item.payee_name?.trim() || item.notes?.trim() || 'Movimiento sin concepto',
      labels.accounts.get(item.account) ?? item.account,
      labels.categories.get(item.category ?? '') ?? item.category ?? 'Sin categoría',
      major(item.amount, nativeCurrency), nativeCurrency, item.amount,
      major(item.displayAmountMinor, item.displayCurrency), item.displayCurrency ?? null, item.displayAmountMinor ?? null,
      item.conversion?.rate ?? null,
      item.conversion?.effectiveDate ? date(item.conversion.effectiveDate) : null,
      item.conversion?.source ?? null, item.notes ?? null, Boolean(item.cleared), item.id,
      item.transfer_id ?? null, item.parent_id ?? null, item.parent_transaction_id ?? null,
      Boolean(item.is_parent), Boolean(item.is_child), Boolean(item.is_split_child),
    ]);
  }
  if (movements.length === 0) rows.push(['Sin movimientos en el periodo y ámbito seleccionados.']);
  return {
    name: 'Movimientos', rows,
    widths: [14, 34, 24, 24, 18, 14, 24, 18, 18, 25, 16, 18, 22, 36, 14, 38, 38, 38, 38, 12, 12, 18],
    headerRows: [1],
    ...(movements.length ? { filterHeaderRow: 1 } : {}),
  };
}

function reportMovementAppendixHtml(
  movements: readonly ReportMovement[],
  labels: { accounts: ReadonlyMap<string, string>; categories: ReadonlyMap<string, string> },
  current: ReportSummary,
  locale: 'es-ES' | 'en-GB' = 'es-ES',
): string {
  const rows = movements.map((item) => {
    const currency = item.currencyCode ?? item.currency_code ?? null;
    const description = item.imported_payee?.trim() || item.payee_name?.trim() || item.notes?.trim() || 'Movimiento sin concepto';
    const native = currency ? (() => {
      try { return formatMinorAmount(item.amount, currency, locale); }
      catch { return String(item.amount) + ' unidades menores; precisión desconocida'; }
    })() : String(item.amount) + ' unidades menores; divisa desconocida';
    const analysis = item.displayAmountMinor === null || item.displayAmountMinor === undefined
      ? 'No disponible'
      : (() => {
        try { return formatMinorAmount(item.displayAmountMinor as number, item.displayCurrency ?? '', locale); }
        catch { return 'No disponible; importe original en unidades menores'; }
      })();
    return '<tr><td class="nowrap">' + escapeHtml(item.date) + '</td><td>' + escapeHtml(description) +
      '</td><td>' + escapeHtml(labels.accounts.get(item.account) ?? item.account) +
      '</td><td>' + escapeHtml(labels.categories.get(item.category ?? '') ?? item.category ?? 'Sin categoría') +
      '</td><td class="numeric">' + escapeHtml(native) + '</td><td>' + escapeHtml(currency ?? 'Desconocida') +
      '</td><td class="numeric">' + escapeHtml(analysis) + '</td><td>' +
      escapeHtml(item.cleared ? 'Conciliado' : 'Pendiente') + '</td></tr>';
  }).join('');
  return '<section class="appendix"><h2>Anexo de movimientos del periodo actual</h2>' +
    '<p class="muted">Movimientos incluidos: ' + movements.length + '. Periodo: ' +
    escapeHtml(current.startDate + ' — ' + current.endDate) +
    '. El anexo sigue el ámbito de cuentas del informe. Los importes nativos y de análisis se muestran por separado.</p>' +
    '<table><thead><tr><th>Fecha</th><th>Concepto</th><th>Cuenta</th><th>Categoría</th><th>Importe nativo</th><th>Divisa</th><th>Importe de análisis</th><th>Conciliación</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="8">No hay movimientos para el periodo y ámbito seleccionados.</td></tr>') +
    '</tbody></table><p class="footer">Los importes proceden de la API local. Las conversiones no disponibles se dejan como tales; no se crean tipos de cambio durante la exportación.</p></section>';
}

function amountAsMajor(value: number | null, currency: string): number | null {
  if (value === null) return null;
  try { return minorUnitsToMajor(value, currency); } catch { return null; }
}

function formatReportAmount(value: number | null, currency: string): string {
  if (value === null) return 'No disponible';
  try { return formatMinorAmount(value, currency, 'es-ES'); }
  catch { return String(value) + ' unidades menores; precisión de ' + currency + ' desconocida'; }
}

function categoryUnion(current: readonly ReportCategory[], previous: readonly ReportCategory[]): {
  key: string; name: string; current?: ReportCategory; previous?: ReportCategory;
}[] {
  const items = new Map<string, { key: string; name: string; current?: ReportCategory; previous?: ReportCategory }>();
  for (const item of current) {
    const key = item.categoryId ?? item.categoryName;
    items.set(key, { key, name: item.categoryName, current: item });
  }
  for (const item of previous) {
    const key = item.categoryId ?? item.categoryName;
    const found = items.get(key);
    if (found) {
      if (!found.current) found.name = item.categoryName;
      found.previous = item;
    } else {
      items.set(key, { key, name: item.categoryName, previous: item });
    }
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function reportWorkbookSheets(
  current: ReportSummary,
  previous: ReportSummary,
  period: Period,
  comparisonPeriod: Period,
  scopeLabel: string,
  accountNames: string,
  sameCurrency: boolean,
  warningsText: string,
  ratesText: string,
  generatedAt: string,
): readonly XlsxSheet[] {
  const metricSpecs: readonly { label: string; current: number | null; previous: number | null; unit: 'amount' | 'percent' | 'count' }[] = [
    { label: 'Ingresos', current: current.incomeMinor, previous: previous.incomeMinor, unit: 'amount' },
    { label: 'Gastos', current: current.expenseMinor, previous: previous.expenseMinor, unit: 'amount' },
    { label: 'Ahorro neto', current: current.savingsMinor, previous: previous.savingsMinor, unit: 'amount' },
    { label: 'Tasa de ahorro', current: current.savingsRatePercent, previous: previous.savingsRatePercent, unit: 'percent' },
    { label: 'Gasto sin categoría', current: current.uncategorizedOutflowMinor, previous: previous.uncategorizedOutflowMinor, unit: 'amount' },
    { label: 'Ingreso sin categoría', current: current.unclassifiedInflowMinor, previous: previous.unclassifiedInflowMinor, unit: 'amount' },
    { label: 'Movimientos del periodo', current: current.transactionCount, previous: previous.transactionCount, unit: 'count' },
    { label: 'Movimientos sin conversión', current: current.unconvertedTransactionCount ?? null, previous: previous.unconvertedTransactionCount ?? null, unit: 'count' },
    { label: 'Traspasos excluidos', current: current.excludedTransferCount, previous: previous.excludedTransferCount, unit: 'count' },
  ];
  const summaryRows: XlsxCellValue[][] = [[
    'Métrica', 'Valor actual', 'Unidad actual', 'Valor comparado', 'Unidad comparada',
    'Variación', 'Variación (%)',
  ]];
  for (const metric of metricSpecs) {
    const currentValue = metric.unit === 'amount'
      ? amountAsMajor(metric.current, current.currency)
      : metric.current;
    const previousValue = metric.unit === 'amount'
      ? amountAsMajor(metric.previous, previous.currency)
      : metric.previous;
    const canCompare = metric.unit !== 'amount' || sameCurrency;
    const comparable = canCompare && currentValue !== null && currentValue !== undefined &&
      previousValue !== null && previousValue !== undefined;
    const delta = comparable ? (currentValue as number) - (previousValue as number) : null;
    const deltaPercent = metric.unit === 'amount' && sameCurrency && comparable && previousValue !== 0
      ? (delta as number) / Math.abs(previousValue as number) * 100
      : null;
    const currentUnit = metric.unit === 'amount' ? current.currency + ' (unidades principales)'
      : metric.unit === 'percent' ? '%'
      : 'movimientos';
    const previousUnit = metric.unit === 'amount' ? previous.currency + ' (unidades principales)'
      : metric.unit === 'percent' ? '%'
      : 'movimientos';
    summaryRows.push([
      metric.label, currentValue ?? null, currentUnit, previousValue ?? null, previousUnit,
      delta, deltaPercent,
    ]);
  }
  summaryRows.push([]);
  summaryRows.push(['Metadato', 'Valor']);
  summaryRows.push(['Periodo actual', period.startDate + ' — ' + period.endDate]);
  summaryRows.push(['Periodo comparado', comparisonPeriod.startDate + ' — ' + comparisonPeriod.endDate]);
  summaryRows.push(['Ámbito de cuentas', scopeLabel]);
  summaryRows.push(['Cuentas', accountNames]);
  summaryRows.push(['Divisa de análisis actual', current.currency]);
  summaryRows.push(['Divisa de análisis comparada', previous.currency]);
  summaryRows.push(['Divisas monetarias comparables', sameCurrency ? 'Sí' : 'No; las variaciones monetarias se omiten']);
  summaryRows.push(['Generado en (UTC)', generatedAt]);
  summaryRows.push(['Tipos de cambio declarados', ratesText]);
  summaryRows.push(['Advertencias', warningsText]);
  const summaryHeaderRows = [1, metricSpecs.length + 3];

  function categorySheet(
    name: string,
    currentItems: readonly ReportCategory[],
    previousItems: readonly ReportCategory[],
  ): XlsxSheet {
    const rows: XlsxCellValue[][] = [[
      'Categoría',
      'Importe actual (' + period.startDate + ' a ' + period.endDate + ')',
      'Divisa actual',
      'Movimientos actuales',
      'Importe comparado (' + comparisonPeriod.startDate + ' a ' + comparisonPeriod.endDate + ')',
      'Divisa comparada',
      'Movimientos comparados',
      'Variación',
    ]];
    for (const item of categoryUnion(currentItems, previousItems)) {
      const currentMinor = item.current?.amountMinor;
      const previousMinor = item.previous?.amountMinor;
      const currentMajor = currentMinor === undefined ? null : amountAsMajor(currentMinor, current.currency);
      const previousMajor = previousMinor === undefined ? null : amountAsMajor(previousMinor, previous.currency);
      const delta = sameCurrency && currentMajor !== null && currentMajor !== undefined &&
        previousMajor !== null && previousMajor !== undefined
        ? currentMajor - previousMajor
        : null;
      rows.push([
        item.name,
        currentMajor,
        item.current ? current.currency : null,
        item.current?.transactionCount ?? null,
        previousMajor,
        item.previous ? previous.currency : null,
        item.previous?.transactionCount ?? null,
        delta,
      ]);
    }
    return {
      name,
      rows,
      widths: [30, 22, 14, 18, 25, 16, 22, 18],
      headerRows: [1],
      filterHeaderRow: 1,
    };
  }

  return [
    {
      name: 'Resumen',
      rows: summaryRows,
      widths: [30, 20, 25, 22, 25, 18, 18],
      headerRows: summaryHeaderRows,
    },
    categorySheet('Gastos por categoría', current.expensesByCategory, previous.expensesByCategory),
    categorySheet('Ingresos por categoría', current.incomeByCategory, previous.incomeByCategory),
  ];
}

function reportPrintHtml(
  current: ReportSummary,
  previous: ReportSummary,
  period: Period,
  comparisonPeriod: Period,
  scopeLabel: string,
  accountNames: string,
  sameCurrency: boolean,
  warningsText: string,
  ratesText: string,
  generatedAt: string,
  movementAppendixHtml = '',
): string {
  const metrics: readonly { label: string; current: number | null; previous: number | null; unit: 'amount' | 'percent' | 'count' }[] = [
    { label: 'Ingresos', current: current.incomeMinor, previous: previous.incomeMinor, unit: 'amount' },
    { label: 'Gastos', current: current.expenseMinor, previous: previous.expenseMinor, unit: 'amount' },
    { label: 'Ahorro neto', current: current.savingsMinor, previous: previous.savingsMinor, unit: 'amount' },
    { label: 'Tasa de ahorro', current: current.savingsRatePercent, previous: previous.savingsRatePercent, unit: 'percent' },
    { label: 'Gasto sin categoría', current: current.uncategorizedOutflowMinor, previous: previous.uncategorizedOutflowMinor, unit: 'amount' },
    { label: 'Ingreso sin categoría', current: current.unclassifiedInflowMinor, previous: previous.unclassifiedInflowMinor, unit: 'amount' },
    { label: 'Movimientos del periodo', current: current.transactionCount, previous: previous.transactionCount, unit: 'count' },
    { label: 'Movimientos sin conversión', current: current.unconvertedTransactionCount ?? null, previous: previous.unconvertedTransactionCount ?? null, unit: 'count' },
    { label: 'Traspasos excluidos', current: current.excludedTransferCount, previous: previous.excludedTransferCount, unit: 'count' },
  ];
  const metricRows = metrics.map((metric) => {
    const currentText = metric.current === null ? 'No disponible'
      : metric.unit === 'amount' ? formatReportAmount(metric.current, current.currency)
      : metric.unit === 'percent' ? String(metric.current) + ' %'
      : String(metric.current);
    const previousText = metric.previous === null ? 'No disponible'
      : metric.unit === 'amount' ? formatReportAmount(metric.previous, previous.currency)
      : metric.unit === 'percent' ? String(metric.previous) + ' %'
      : String(metric.previous);
    let deltaText = 'No disponible';
    if (metric.current !== null && metric.previous !== null && (metric.unit !== 'amount' || sameCurrency)) {
      if (metric.unit === 'amount') deltaText = formatReportAmount(metric.current - metric.previous, current.currency);
      else if (metric.unit === 'percent') deltaText = String(Number((metric.current - metric.previous).toFixed(2))) + ' puntos porcentuales';
      else deltaText = String(metric.current - metric.previous);
    } else if (metric.unit === 'amount' && !sameCurrency) {
      deltaText = 'Omitida: divisas distintas';
    }
    return '<tr><th>' + escapeHtml(metric.label) + '</th><td>' + escapeHtml(currentText) +
      '</td><td>' + escapeHtml(previousText) + '</td><td>' + escapeHtml(deltaText) + '</td></tr>';
  }).join('');
  const categoryTable = (label: string, currentItems: readonly ReportCategory[], previousItems: readonly ReportCategory[]): string => {
    const rows = categoryUnion(currentItems, previousItems).map((item) => {
      const currentAmount = item.current ? formatReportAmount(item.current.amountMinor, current.currency) : 'Sin valor en el periodo';
      const previousAmount = item.previous ? formatReportAmount(item.previous.amountMinor, previous.currency) : 'Sin valor en el periodo comparado';
      const delta = sameCurrency && item.current && item.previous
        ? formatReportAmount(item.current.amountMinor - item.previous.amountMinor, current.currency)
        : sameCurrency ? 'No comparable' : 'Omitida: divisas distintas';
      return '<tr><td>' + escapeHtml(item.name) + '</td><td>' + escapeHtml(currentAmount) +
        '</td><td>' + escapeHtml(previousAmount) + '</td><td>' + escapeHtml(delta) + '</td></tr>';
    }).join('');
    return '<h2>' + escapeHtml(label) + '</h2><table><thead><tr><th>Categoría</th><th>Actual</th><th>Periodo comparado</th><th>Variación</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4">Sin categorías para los periodos consultados.</td></tr>') + '</tbody></table>';
  };
  const warningList = [...current.warnings, ...previous.warnings, ...(!sameCurrency ? ['Las divisas de análisis son distintas; se omiten variaciones monetarias.',] : [])];
  return '<header><h1>Informe financiero</h1><p class="muted">Exportación local de Personal Budget · Generado (UTC): ' +
    escapeHtml(generatedAt) + '</p></header>' +
    '<section class="metadata">' +
    '<div><strong>Periodo actual:</strong> ' + escapeHtml(period.startDate + ' — ' + period.endDate) + '</div>' +
    '<div><strong>Periodo comparado:</strong> ' + escapeHtml(comparisonPeriod.startDate + ' — ' + comparisonPeriod.endDate) + '</div>' +
    '<div><strong>Ámbito de cuentas:</strong> ' + escapeHtml(scopeLabel) + '</div>' +
    '<div><strong>Cuentas:</strong> ' + escapeHtml(accountNames) + '</div>' +
    '<div><strong>Divisa actual:</strong> ' + escapeHtml(current.currency) + '</div>' +
    '<div><strong>Divisa comparada:</strong> ' + escapeHtml(previous.currency) + '</div>' +
    '</section><h2>Resumen comparativo</h2>' +
    '<table><thead><tr><th>Métrica</th><th>Actual</th><th>Periodo comparado</th><th>Variación</th></tr></thead><tbody>' + metricRows + '</tbody></table>' +
    categoryTable('Gastos por categoría', current.expensesByCategory, previous.expensesByCategory) +
    categoryTable('Ingresos por categoría', current.incomeByCategory, previous.incomeByCategory) +
    '<h2>Criterios y advertencias</h2><p>' + escapeHtml(ratesText) + '</p>' +
    '<p>' + escapeHtml(warningsText) + '</p>' +
    (warningList.length ? '<ul>' + warningList.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>' : '<p>Sin advertencias registradas.</p>') +
    '<div class="footer">Los importes proceden de finance-core/API y se exportan sin recalcular. No se inventan conversiones de divisa. Este documento es un informe, no una copia de seguridad ni asesoramiento financiero profesional.</div>' +
    movementAppendixHtml;
}

export function ReportExportPanel({ current, previous, period, comparisonPeriod }: ReportExportPanelProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [includeMovements, setIncludeMovements] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [exportError, setExportError] = useState('');
  const sameCurrency = current.currency.trim().toUpperCase() === previous.currency.trim().toUpperCase();
  const scopeLabel = current.accountScope?.label ??
    (current.accountScope?.mode === 'selected' ? 'Cuentas seleccionadas' : 'Todas las cuentas del ámbito');
  const accountNames = current.accountScope?.accountNames.join(', ') || 'No disponibles';
  const ratesText = ratesDescription(current);
  const warningsText = [...current.warnings, ...(sameCurrency ? [] : [
    'Los periodos usan divisas de análisis distintas; las diferencias monetarias se omiten.',
  ])].join(' | ') || 'Sin advertencias registradas.';
  const conversionCriteria = 'Importes agregados calculados por la API/finance-core en la divisa de análisis; se exportan en unidades menores sin recálculo. Los movimientos sin conversión se identifican por separado; no se inventa una equivalencia.';

  useEffect(() => {
    setPreviewOpen(false);
    setIncludeMovements(false);
    setExportMessage('');
    setExportError('');
  }, [period.startDate, period.endDate, comparisonPeriod.startDate, comparisonPeriod.endDate,
    current.currency, previous.currency, scopeLabel, current.transactionCount, current.expenseMinor,
    current.incomeMinor, current.savingsMinor]);

  function buildRows(): readonly (readonly unknown[])[] {
    const rows: (readonly unknown[])[] = [];
    const metrics: readonly MetricRow[] = [
      { label: 'Ingresos', value: current.incomeMinor, previousValue: previous.incomeMinor, unit: 'minor' },
      { label: 'Gastos', value: current.expenseMinor, previousValue: previous.expenseMinor, unit: 'minor' },
      { label: 'Ahorro neto', value: current.savingsMinor, previousValue: previous.savingsMinor, unit: 'minor' },
      { label: 'Tasa de ahorro', value: current.savingsRatePercent, previousValue: previous.savingsRatePercent, unit: 'porcentaje' },
      { label: 'Gasto sin categoría', value: current.uncategorizedOutflowMinor, previousValue: previous.uncategorizedOutflowMinor, unit: 'minor' },
      { label: 'Ingreso sin categoría', value: current.unclassifiedInflowMinor, previousValue: previous.unclassifiedInflowMinor, unit: 'minor' },
      { label: 'Movimientos del periodo', value: current.transactionCount, previousValue: previous.transactionCount, unit: 'movimientos' },
      { label: 'Movimientos sin conversión', value: current.unconvertedTransactionCount ?? null, previousValue: previous.unconvertedTransactionCount ?? null, unit: 'movimientos' },
      { label: 'Traspasos excluidos', value: current.excludedTransferCount, previousValue: previous.excludedTransferCount, unit: 'movimientos' },
    ];
    const toRow = (type: string, metric: MetricRow): readonly unknown[] => {
      const canCompare = sameCurrency || metric.unit !== 'minor';
      const value = metric.value;
      const previousValue = canCompare ? metric.previousValue : null;
      const delta = value !== null && previousValue !== null ? value - previousValue : null;
      const deltaPercent = delta !== null && previousValue !== 0
        ? Number((delta / Math.abs(previousValue as number) * 100).toFixed(4))
        : null;
      return [
        type, period.startDate, period.endDate, comparisonPeriod.startDate, comparisonPeriod.endDate,
        scopeLabel, accountNames, metric.label, metric.category ?? '',
        value === null ? '' : value, metric.unit === 'minor' ? 'unidades menores (minor units)' : metric.unit,
        current.currency, 'No desglosada en informe agregado; consulta exportación de movimientos para ver divisa nativa', previousValue === null ? '' : previousValue, delta === null ? '' : delta,
        deltaPercent === null ? '' : deltaPercent, current.transactionCount,
        current.unconvertedTransactionCount ?? '', current.excludedTransferCount,
        conversionCriteria, ratesText, warningsText,
      ];
    };
    for (const metric of metrics) rows.push(toRow('resumen', metric));
    const previousCategories = new Map(previous.expensesByCategory.map((item) => [
      item.categoryId ?? item.categoryName, item,
    ]));
    for (const item of current.expensesByCategory) {
      const prior = previousCategories.get(item.categoryId ?? item.categoryName);
      rows.push(toRow('categoria', {
        label: 'Gasto por categoría',
        category: item.categoryName,
        value: item.amountMinor,
        previousValue: prior?.amountMinor ?? null,
        unit: 'minor',
      }));
    }
    return rows;
  }

  async function download(format: 'csv' | 'json' | 'xlsx' | 'pdf'): Promise<void> {
    if (exportBusy) return;
    setExportBusy(true);
    setExportError('');
    setExportMessage('');
    let reservedPrintWindow: Window | null = null;
    // Reserve the popup synchronously inside the click event so an optional async
    // local API query cannot trigger the browser's popup blocker.
    if (format === 'pdf' && includeMovements) {
      reservedPrintWindow = window.open('', '_blank');
      if (!reservedPrintWindow) {
        setExportBusy(false);
        setExportError('El navegador ha bloqueado la ventana de impresión. Permite ventanas emergentes para esta aplicación y vuelve a intentarlo.');
        return;
      }
      reservedPrintWindow.document.write('<!doctype html><html lang="es"><meta charset="utf-8"><title>Preparando informe</title><body>Preparando el anexo de movimientos localmente…</body></html>');
      reservedPrintWindow.document.close();
    }
    try {
      const generatedAt = new Date().toISOString();
      const filename = 'informe-financiero-' + exportDateStamp(new Date(generatedAt));
      let movements: readonly ReportMovement[] = [];
      if (includeMovements && (format === 'pdf' || format === 'xlsx')) {
        const limit = format === 'pdf' ? 1_000 : 10_000;
        setExportMessage('Consultando los movimientos del periodo y verificando que el conjunto esté completo…');
        movements = await fetchReportMovements(current, period, limit);
      }
      if (format === 'pdf') {
        const labels = reportMovementLabels(current, previous);
        const appendix = includeMovements
          ? reportMovementAppendixHtml(movements, labels, current)
          : '';
        printHtmlDocument('Informe financiero', reportPrintHtml(
          current, previous, period, comparisonPeriod, scopeLabel, accountNames,
          sameCurrency, warningsText, ratesText, generatedAt, appendix,
        ), reservedPrintWindow);
        reservedPrintWindow = null;
        setExportMessage(includeMovements
          ? 'Se ha abierto el informe imprimible con anexo. En el diálogo del navegador elige “Guardar como PDF”; los datos permanecen en este equipo.'
          : 'Se ha abierto el informe imprimible. En el diálogo del navegador elige “Guardar como PDF”; los datos permanecen en este equipo.');
        return;
      }
      if (format === 'xlsx') {
        const baseSheets = reportWorkbookSheets(current, previous, period, comparisonPeriod, scopeLabel, accountNames, sameCurrency, warningsText, ratesText, generatedAt);
        const sheets = includeMovements
          ? [...baseSheets, reportMovementSheet(movements, reportMovementLabels(current, previous))]
          : baseSheets;
        downloadXlsxFile(filename + '.xlsx', sheets);
      } else if (format === 'csv') {
        const headers = [
          'tipo', 'periodo_inicio', 'periodo_fin', 'comparacion_inicio', 'comparacion_fin',
          'ambito_cuentas', 'cuentas', 'metrica', 'categoria', 'valor_actual', 'unidad',
          'divisa_analisis_actual', 'divisas_nativas_por_movimiento', 'valor_periodo_anterior', 'variacion', 'variacion_pct',
          'cantidad_movimientos', 'movimientos_sin_conversion', 'traspasos_excluidos',
          'criterio_conversion', 'tipos_cambio_aplicados', 'advertencias',
        ];
        const formulaSafeColumns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 19, 20, 21];
        const csv = serializeCsv(headers, buildRows(), formulaSafeColumns);
        downloadTextFile(filename + '.csv', csv, 'text/csv;charset=utf-8');
      } else {
        const payload = {
          schema: 'personal-budget.report-export.v1',
          generatedAt,
          period: { startDate: period.startDate, endDate: period.endDate },
          comparisonPeriod: { startDate: comparisonPeriod.startDate, endDate: comparisonPeriod.endDate },
          accountScope: current.accountScope ? {
            mode: current.accountScope.mode,
            label: scopeLabel,
            accountNames: [...current.accountScope.accountNames],
          } : { label: scopeLabel, accountNames },
          analysisCurrency: current.currency,
          comparisonCurrency: previous.currency,
          currenciesComparable: sameCurrency,
          conversion: {
            nativeCurrencyScope: 'El resumen agregado no desglosa los movimientos por moneda nativa; consulta la exportación de movimientos para ese detalle.',
            criteria: conversionCriteria,
            exchangeRatesUsed: [...(current.exchangeRatesUsed ?? [])],
            unconvertedTransactionCount: current.unconvertedTransactionCount ?? null,
            warnings: [...current.warnings, ...(sameCurrency ? [] : [
              'Los periodos usan divisas de análisis distintas; las diferencias monetarias se omiten.',
            ])],
          },
          current: reportSnapshot(current),
          comparison: reportSnapshot(previous),
          disclaimer: 'Exportación del resumen visible; no es una copia de seguridad ni incluye todos los datos, preferencias o el historial de Actual Budget.',
        };
        downloadTextFile(filename + '.json', JSON.stringify(payload, null, 2) + '\n', 'application/json;charset=utf-8');
      }
      setExportMessage('Descarga iniciada en el navegador. El archivo no se guarda en el servidor ni se envía a terceros.');
    } catch (error) {
      reservedPrintWindow?.close();
      setExportError(error instanceof Error ? error.message : 'No se ha podido generar la exportación del informe.');
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <section className="panel report-export-panel" aria-label="Exportación de informes">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">PORTABILIDAD LOCAL</p>
          <h3>Exportar informe</h3>
        </div>
        <button className="button secondary" type="button" onClick={() => {
          setPreviewOpen((open) => !open);
          setExportMessage('');
          setExportError('');
        }}>
          {previewOpen ? 'Ocultar previsualización' : 'Preparar exportación del informe'}
        </button>
      </div>
      <p className="setting-hint">Exporta el resumen comparativo y el gasto por categoría que aparecen en esta pantalla. Los datos se preparan en este navegador; no se envían a servicios externos.</p>
      {previewOpen ? (
        <section className="confirmation-panel export-preview" aria-label="Previsualización de exportación del informe">
          <h4>Previsualización — todavía no se ha creado ningún archivo</h4>
          <dl className="export-preview-metadata">
            <div><dt>Periodo actual</dt><dd>{period.startDate} — {period.endDate}</dd></div>
            <div><dt>Periodo comparado</dt><dd>{comparisonPeriod.startDate} — {comparisonPeriod.endDate}</dd></div>
            <div><dt>Ámbito de cuentas</dt><dd>{scopeLabel}</dd></div>
            <div><dt>Cuentas</dt><dd>{accountNames}</dd></div>
            <div><dt>Divisa de análisis</dt><dd>{current.currency}</dd></div>
            <div><dt>Divisas nativas por movimiento</dt><dd>No se desglosan en el resumen agregado; exporta los movimientos para consultar la moneda original; este informe agregado expresa los importes en la divisa de análisis.</dd></div>
            <div><dt>Contenido</dt><dd>9 indicadores, {current.expensesByCategory.length} categorías de gasto y {current.incomeByCategory.length} categorías de ingreso; CSV/JSON mantienen importes en unidades menores y XLSX usa unidades principales según la precisión de cada divisa.</dd></div>
            <div><dt>Conversión</dt><dd>{ratesText}</dd></div>
            <div><dt>Advertencias</dt><dd>{warningsText}</dd></div>
          </dl>
          {!sameCurrency ? <p className="form-alert error" role="alert">Las divisas de análisis de ambos periodos son distintas; se omiten las variaciones monetarias.</p> : null}
          <label className="check-field"><input type="checkbox" checked={includeMovements} disabled={exportBusy} onChange={(event) => { setIncludeMovements(event.currentTarget.checked); setExportError(''); setExportMessage(''); }} /> Incluir anexo con movimientos del periodo actual en PDF/XLSX <small>(máximo 1.000 movimientos en PDF o 10.000 en XLSX; respeta el ámbito de cuentas)</small></label>
          <p className="setting-hint">El PDF usa la impresión local del navegador (elige “Guardar como PDF”). Excel incluye hojas de Resumen, Gastos por categoría e Ingresos por categoría; si seleccionas el anexo añade una hoja de movimientos. Los importes XLSX son celdas numéricas en unidades principales; los importes desconocidos no se convierten a cero. No se envían datos a terceros y el archivo no es un backup.</p>
          <div className="button-row">
            <button className="button primary" type="button" disabled={exportBusy} onClick={() => { void download('pdf'); }}>{exportBusy ? 'Preparando…' : 'Imprimir / Guardar como PDF'}</button>
            <button className="button secondary" type="button" disabled={exportBusy} onClick={() => { void download('xlsx'); }}>{exportBusy ? 'Preparando…' : 'Descargar libro Excel (XLSX)'}</button>
            <button className="button secondary" type="button" disabled={exportBusy} onClick={() => { void download('csv'); }}>Descargar informe CSV</button>
            <button className="button secondary" type="button" disabled={exportBusy} onClick={() => { void download('json'); }}>Descargar informe JSON</button>
            <button className="button secondary" type="button" onClick={() => { setPreviewOpen(false); setExportMessage(''); setExportError(''); }}>Cancelar</button>
          </div>
        </section>
      ) : null}
      {exportError ? <p className="form-alert error" role="alert">{exportError}</p> : null}
      {exportMessage ? <p className="form-alert" role="status">{exportMessage}</p> : null}
    </section>
  );
}
