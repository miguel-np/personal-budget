import { useEffect, useState } from 'react';
import { downloadTextFile, exportDateStamp, serializeCsv } from './export-utils.js';

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
      unconvertedTransactionCount: summary.unconvertedTransactionCount ?? 0,
      excludedTransferCount: summary.excludedTransferCount,
    },
    expensesByCategory: summary.expensesByCategory.map((item) => ({ ...item })),
    incomeByCategory: summary.incomeByCategory.map((item) => ({ ...item })),
    exchangeRatesUsed: [...(summary.exchangeRatesUsed ?? [])],
    warnings: [...summary.warnings],
  };
}

export function ReportExportPanel({ current, previous, period, comparisonPeriod }: ReportExportPanelProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
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
      { label: 'Movimientos sin conversión', value: current.unconvertedTransactionCount ?? 0, previousValue: previous.unconvertedTransactionCount ?? 0, unit: 'movimientos' },
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
        current.currency, previousValue === null ? '' : previousValue, delta === null ? '' : delta,
        deltaPercent === null ? '' : deltaPercent, current.transactionCount,
        current.unconvertedTransactionCount ?? 0, current.excludedTransferCount,
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

  function download(format: 'csv' | 'json'): void {
    setExportError('');
    setExportMessage('');
    try {
      const generatedAt = new Date().toISOString();
      const filename = 'informe-financiero-' + exportDateStamp(new Date(generatedAt));
      if (format === 'csv') {
        const headers = [
          'tipo', 'periodo_inicio', 'periodo_fin', 'comparacion_inicio', 'comparacion_fin',
          'ambito_cuentas', 'cuentas', 'metrica', 'categoria', 'valor_actual', 'unidad',
          'divisa_analisis_actual', 'valor_periodo_anterior', 'variacion', 'variacion_pct',
          'cantidad_movimientos', 'movimientos_sin_conversion', 'traspasos_excluidos',
          'criterio_conversion', 'tipos_cambio_aplicados', 'advertencias',
        ];
        const formulaSafeColumns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 18, 19, 20];
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
            criteria: conversionCriteria,
            exchangeRatesUsed: [...(current.exchangeRatesUsed ?? [])],
            unconvertedTransactionCount: current.unconvertedTransactionCount ?? 0,
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
      setExportError(error instanceof Error ? error.message : 'No se ha podido generar la exportación del informe.');
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
            <div><dt>Contenido</dt><dd>9 indicadores y {current.expensesByCategory.length} categorías de gasto; importes conservados en unidades menores.</dd></div>
            <div><dt>Conversión</dt><dd>{ratesText}</dd></div>
            <div><dt>Advertencias</dt><dd>{warningsText}</dd></div>
          </dl>
          {!sameCurrency ? <p className="form-alert error" role="alert">Las divisas de análisis de ambos periodos son distintas; se omiten las variaciones monetarias.</p> : null}
          <p className="setting-hint">La exportación no modifica Actual Budget y no es un backup completo. La divisa nativa por movimiento se conserva en la exportación de movimientos; este informe agregado expresa los importes en la divisa de análisis.</p>
          <div className="button-row">
            <button className="button primary" type="button" onClick={() => download('csv')}>Descargar informe CSV</button>
            <button className="button secondary" type="button" onClick={() => download('json')}>Descargar informe JSON</button>
            <button className="button secondary" type="button" onClick={() => { setPreviewOpen(false); setExportMessage(''); setExportError(''); }}>Cancelar</button>
          </div>
        </section>
      ) : null}
      {exportError ? <p className="form-alert error" role="alert">{exportError}</p> : null}
      {exportMessage ? <p className="form-alert" role="status">{exportMessage}</p> : null}
    </section>
  );
}
