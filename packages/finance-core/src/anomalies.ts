import type { BudgetCategory, LedgerEntry, Period } from './domain.js';
import { isIsoDate } from './date-range.js';
import { createFinancialFinding } from './intelligence.js';
import type { FindingAccountScope, FindingPriority, FinancialFinding } from './intelligence.js';

export type FinancialAnomalyKind =
  | 'transaction-outlier' | 'total-expense-change' | 'category-change' | 'payee-change'
  | 'possible-duplicate' | 'income-change' | 'refund-change' | 'frequency-change';

export const FINANCIAL_ANOMALY_KINDS: readonly FinancialAnomalyKind[] = [
  'transaction-outlier', 'total-expense-change', 'category-change', 'payee-change',
  'possible-duplicate', 'income-change', 'refund-change', 'frequency-change',
];

export interface FinancialAnomalyOptions {
  readonly period: Period;
  readonly accountScope: FindingAccountScope;
  readonly currency: string;
  readonly calculatedAt: string;
  readonly categories: readonly BudgetCategory[];
  /** Equal-duration historical windows, from 3 to 24. Defaults to 6. */
  readonly referenceWindows?: number;
  /** Minimum absolute change, in minor units of the display currency. */
  readonly minimumAbsoluteChangeMinor?: number;
  readonly minimumRelativeChangePercent?: number;
  readonly minimumObservations?: number;
  readonly enabledKinds?: readonly FinancialAnomalyKind[];
  readonly allowPeriodComparisons?: boolean;
  readonly allowTransactionOutliers?: boolean;
  readonly historyStartDate?: string;
  readonly sourceWarnings?: readonly string[];
}
export interface FinancialAnomalyResult {
  readonly findings: readonly FinancialFinding[];
  readonly limitations: readonly string[];
}
type Flow = 'expense' | 'income' | 'refund' | null;
interface EntrySignal {
  readonly entry: LedgerEntry;
  readonly payee: string;
  readonly amountMinor: number;
  readonly flow: Flow;
}
interface Aggregates {
  readonly expense: Map<number, number>;
  readonly byCategory: Map<string, Map<number, number>>;
  readonly byPayee: Map<string, Map<number, number>>;
  readonly income: Map<number, number>;
  readonly refunds: Map<number, number>;
  readonly frequency: Map<number, Set<string>>;
  readonly expenseByMonth: Map<string, number>;
  readonly categoryByMonth: Map<string, Map<string, number>>;
  readonly payeeByMonth: Map<string, Map<string, number>>;
  readonly incomeByMonth: Map<string, number>;
  readonly refundsByMonth: Map<string, number>;
  readonly frequencyByMonth: Map<string, Set<string>>;
}
function day(date: string): number {
  if (!isIsoDate(date)) throw new RangeError('Anomaly dates must use valid YYYY-MM-DD dates.');
  return Math.floor(Date.parse(date + 'T00:00:00.000Z') / 86_400_000);
}
function addDays(date: string, delta: number): string {
  const result = new Date(date + 'T00:00:00.000Z');
  result.setUTCDate(result.getUTCDate() + delta);
  return result.toISOString().slice(0, 10);
}
function monthEnd(date: string): string {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).toISOString().slice(0, 10);
}
function isFullMonth(period: Period): boolean {
  return period.startDate.endsWith('-01') && period.endDate === monthEnd(period.startDate) &&
    period.startDate.slice(0, 7) === period.endDate.slice(0, 7);
}
function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
function mad(values: readonly number[], center: number): number {
  return median(values.map((value) => Math.abs(value - center)));
}
function normalizedPayee(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function addSafe(current: number, value: number, label: string): number {
  const result = current + value;
  if (!Number.isSafeInteger(result)) throw new RangeError(label + ' exceeds the safe integer range.');
  return result;
}
function addBucket(map: Map<number, number>, bucket: number, value: number, label: string): void {
  map.set(bucket, addSafe(map.get(bucket) ?? 0, value, label));
}
function addMonthly(map: Map<string, Map<string, number>>, month: string, key: string, value: number): void {
  const values = map.get(month) ?? new Map<string, number>();
  values.set(key, addSafe(values.get(key) ?? 0, value, 'Monthly anomaly aggregate'));
  map.set(month, values);
}
function addScalarMonth(map: Map<string, number>, month: string, value: number, label: string): void {
  map.set(month, addSafe(map.get(month) ?? 0, value, label));
}
function addFrequency(map: Map<number, Set<string>>, bucket: number, groupId: string): void {
  const group = map.get(bucket) ?? new Set<string>();
  group.add(groupId);
  map.set(bucket, group);
}
function classify(entry: LedgerEntry, categories: ReadonlyMap<string, BudgetCategory>): Flow {
  const category = entry.categoryId ? categories.get(entry.categoryId) : undefined;
  if (entry.amountMinor < 0) return category?.isIncome ? 'refund' : 'expense';
  if (entry.amountMinor > 0 && category?.isIncome) return 'income';
  if (entry.amountMinor > 0 && entry.categoryId) return 'refund';
  return null;
}
function priorityFor(impact: number | null, percent: number): { priority: FindingPriority; reason: string } {
  if (impact !== null && (impact >= 100_000 || (impact >= 25_000 && Math.abs(percent) >= 50))) {
    return { priority: 'high', reason: 'Impacto ≥ 100000 unidades menores, o ≥ 25000 con variación relativa ≥ 50 % (regla de anomalías v1).' };
  }
  if ((impact !== null && impact >= 25_000) || Math.abs(percent) >= 30) {
    return { priority: 'medium', reason: 'Impacto ≥ 25000 unidades menores o variación relativa ≥ 30 % (regla de anomalías v1).' };
  }
  return { priority: 'low', reason: 'La desviación supera la regla de detección, sin alcanzar un umbral de prioridad superior.' };
}
function createAggregates(): Aggregates {
  return {
    expense: new Map(), byCategory: new Map(), byPayee: new Map(), income: new Map(), refunds: new Map(),
    frequency: new Map(), expenseByMonth: new Map(), categoryByMonth: new Map(), payeeByMonth: new Map(),
    incomeByMonth: new Map(), refundsByMonth: new Map(), frequencyByMonth: new Map(),
  };
}
function aggregate(entries: readonly EntrySignal[], period: Period, windows: number, historyStart: string): Aggregates {
  const result = createAggregates();
  const duration = day(period.endDate) - day(period.startDate) + 1;
  const start = day(period.startDate);
  const end = day(period.endDate);
  const history = day(historyStart);
  for (const item of entries) {
    const entryDay = day(item.entry.date);
    if (entryDay < history || entryDay > end) continue;
    const current = entryDay >= start;
    const bucket = current ? 0 : Math.ceil((start - entryDay) / duration);
    if (!current && (bucket < 1 || bucket > windows)) continue;
    const month = item.entry.date.slice(0, 7);
    const groupId = item.entry.transactionGroupId ?? item.entry.id;
    addFrequency(result.frequency, bucket, groupId);
    const monthGroups = result.frequencyByMonth.get(month) ?? new Set<string>();
    monthGroups.add(groupId);
    result.frequencyByMonth.set(month, monthGroups);
    if (item.flow === null) continue;
    if (item.flow === 'expense') {
      addBucket(result.expense, bucket, item.amountMinor, 'Total expense anomaly aggregate');
      addScalarMonth(result.expenseByMonth, month, item.amountMinor, 'Monthly expense anomaly aggregate');
      if (item.entry.categoryId) {
        const values = result.byCategory.get(item.entry.categoryId) ?? new Map<number, number>();
        addBucket(values, bucket, item.amountMinor, 'Category anomaly aggregate');
        result.byCategory.set(item.entry.categoryId, values);
        addMonthly(result.categoryByMonth, month, item.entry.categoryId, item.amountMinor);
      }
      if (item.payee) {
        const values = result.byPayee.get(item.payee) ?? new Map<number, number>();
        addBucket(values, bucket, item.amountMinor, 'Payee anomaly aggregate');
        result.byPayee.set(item.payee, values);
        addMonthly(result.payeeByMonth, month, item.payee, item.amountMinor);
      }
    } else if (item.flow === 'income') {
      addBucket(result.income, bucket, item.amountMinor, 'Income anomaly aggregate');
      addScalarMonth(result.incomeByMonth, month, item.amountMinor, 'Monthly income anomaly aggregate');
    } else {
      addBucket(result.refunds, bucket, item.amountMinor, 'Refund anomaly aggregate');
      addScalarMonth(result.refundsByMonth, month, item.amountMinor, 'Monthly refund anomaly aggregate');
    }
  }
  return result;
}
function seasonalMonths(period: Period, historyStart: string, windows: number): string[] {
  if (!isFullMonth(period) || windows < 12) return [];
  const years = Math.floor(windows / 12);
  const month = period.startDate.slice(5, 7);
  const year = Number(period.startDate.slice(0, 4));
  const history = day(historyStart);
  const months: string[] = [];
  for (let back = 1; back <= years; back += 1) {
    const key = String(year - back).padStart(4, '0') + '-' + month;
    if (day(key + '-01') >= history && monthEnd(key + '-01') < period.startDate) months.push(key);
  }
  return months;
}
function getBaseline(args: {
  readonly key: string;
  readonly bucketValues?: Map<number, number>;
  readonly bucketSets?: Map<number, Set<string>>;
  readonly monthlyValues?: Map<string, Map<string, number>>;
  readonly monthlyScalar?: Map<string, number>;
  readonly monthlySets?: Map<string, Set<string>>;
  readonly matchingMonths: readonly string[];
  readonly eligibleWindows: readonly number[];
}): { values: number[]; seasonal: boolean } {
  if (args.matchingMonths.length >= 2) {
    if (args.monthlyValues) return { values: args.matchingMonths.map((m) => args.monthlyValues!.get(m)?.get(args.key) ?? 0), seasonal: true };
    if (args.monthlyScalar) return { values: args.matchingMonths.map((m) => args.monthlyScalar!.get(m) ?? 0), seasonal: true };
    if (args.monthlySets) return { values: args.matchingMonths.map((m) => args.monthlySets!.get(m)?.size ?? 0), seasonal: true };
  }
  return {
    values: args.eligibleWindows.map((w) => args.bucketSets ? args.bucketSets.get(w)?.size ?? 0 : args.bucketValues?.get(w) ?? 0),
    seasonal: false,
  };
}
function aggregateFinding(args: {
  readonly kind: FinancialAnomalyKind;
  readonly entityKey: string;
  readonly title: string;
  readonly explanation: string;
  readonly current: number;
  readonly baseline: readonly number[];
  readonly minimumObservations: number;
  readonly minimumAbsoluteChangeMinor: number;
  readonly minimumRelativeChangePercent: number;
  readonly period: Period;
  readonly accountScope: FindingAccountScope;
  readonly currency: string;
  readonly calculatedAt: string;
  readonly subject: string;
  readonly source: string;
  readonly windows: number;
  readonly seasonal: boolean;
  readonly frequency?: boolean;
}): FinancialFinding | null {
  const observedBaseline = args.baseline.filter((value) => value > 0);
  const observations = observedBaseline.length;
  if (observations < args.minimumObservations) return null;
  const center = median(observedBaseline);
  if (!Number.isSafeInteger(center) || center <= 0) return null;
  const delta = args.current - center;
  if (!Number.isSafeInteger(delta) || delta === 0) return null;
  const percent = delta / center * 100;
  const dispersion = mad(observedBaseline, center);
  const threshold = args.frequency
    ? Math.max(3, Math.ceil(center * args.minimumRelativeChangePercent / 100))
    : Math.max(args.minimumAbsoluteChangeMinor, Math.ceil(center * args.minimumRelativeChangePercent / 100), Math.ceil(3 * 1.4826 * dispersion));
  if (Math.abs(delta) < threshold) return null;
  const impact = args.frequency ? null : Math.abs(delta);
  const priority = priorityFor(impact, percent);
  return createFinancialFinding({
    entityKey: args.entityKey, type: 'financial-anomaly', title: args.title, explanation: args.explanation,
    period: args.period, accountScope: args.accountScope, currency: args.currency, confidence: 'candidate',
    priority: priority.priority, priorityReason: priority.reason, impactMinor: impact,
    metrics: {
      anomalyKind: args.kind, subject: args.subject, currentMinor: args.current, baselineMedianMinor: center,
      deltaMinor: delta, percentageChange: Number(percent.toFixed(2)), medianAbsoluteDeviationMinor: dispersion,
      minimumAbsoluteChangeMinor: args.minimumAbsoluteChangeMinor, minimumRelativeChangePercent: args.minimumRelativeChangePercent,
      triggerThresholdMinor: threshold, historicalObservationCount: observations, referenceWindows: args.windows,
      seasonalBaseline: args.seasonal,
    },
    evidence: [
      { label: 'Valor observado en el periodo', value: args.current, source: args.source, rule: 'Agregado determinista dentro del ámbito de cuentas elegido.' },
      { label: 'Mediana de referencia', value: center, source: args.source, rule: 'Mediana de periodos históricos comparables en unidades menores de ' + args.currency + '.' },
      { label: 'Variación absoluta', value: delta, source: args.source, rule: 'Valor observado menos mediana de referencia.' },
      { label: 'Variación relativa (%)', value: Number(percent.toFixed(2)), source: args.source, rule: 'Diferencia dividida por la mediana histórica.' },
      { label: 'Umbral de activación', value: threshold, source: args.source, rule: args.frequency ? 'Máximo entre 3 operaciones y el porcentaje relativo configurado.' : 'Máximo entre umbral absoluto, porcentaje mínimo y tres MAD escaladas (1,4826 × MAD).' },
      { label: 'Observaciones históricas válidas', value: observations, source: args.source, rule: 'Ventanas con actividad positiva; se exige un mínimo antes de comparar.' },
      { label: 'Ajuste estacional', value: args.seasonal ? 'Aplicado' : 'No aplicado', source: args.source, rule: args.seasonal ? 'Comparación con meses naturales homólogos de años anteriores.' : 'Ventanas contiguas de igual duración; estacionalidad no evaluada sin suficientes meses homólogos.' },
    ],
    limitations: [
      'La desviación estadística ayuda a revisar cambios; no demuestra fraude ni determina la causa.',
      'La mediana histórica puede dejar de representar el patrón tras cambios de hábitos, precios o circunstancias.',
      ...(args.seasonal ? [] : ['No se aplicó ajuste estacional: no hay al menos dos meses homólogos completos disponibles.']),
    ],
    calculatedAt: args.calculatedAt,
    navigationTarget: '/reports',
  });
}

/** Detects statistical deviations and exact duplicate candidates; it never changes ledger data. */
export function buildFinancialAnomalyFindings(
  rawEntries: readonly LedgerEntry[],
  context: FinancialAnomalyOptions,
): FinancialAnomalyResult {
  const windows = context.referenceWindows ?? 6;
  const minAmount = context.minimumAbsoluteChangeMinor ?? 5_000;
  const minPercent = context.minimumRelativeChangePercent ?? 30;
  const minObservations = context.minimumObservations ?? 3;
  const enabled = new Set<FinancialAnomalyKind>(context.enabledKinds ?? FINANCIAL_ANOMALY_KINDS);
  if (!/^[A-Z]{3}$/.test(context.currency)) throw new RangeError('Anomaly currency must be a three-letter uppercase code.');
  if (!Number.isFinite(Date.parse(context.calculatedAt))) throw new RangeError('Anomaly calculatedAt must be a valid timestamp.');
  if (!Number.isInteger(windows) || windows < 3 || windows > 24) throw new RangeError('referenceWindows must be from 3 to 24.');
  if (!Number.isSafeInteger(minAmount) || minAmount < 1) throw new RangeError('minimumAbsoluteChangeMinor must be a positive safe integer.');
  if (!Number.isFinite(minPercent) || minPercent < 1 || minPercent > 1_000) throw new RangeError('minimumRelativeChangePercent must be between 1 and 1000.');
  if (!Number.isInteger(minObservations) || minObservations < 2 || minObservations > windows) throw new RangeError('minimumObservations must be between 2 and referenceWindows.');
  if (context.period.startDate > context.period.endDate) throw new RangeError('Anomaly period is inverted.');
  day(context.period.startDate); day(context.period.endDate);
  const duration = day(context.period.endDate) - day(context.period.startDate) + 1;
  const historyStart = context.historyStartDate ?? addDays(context.period.startDate, -duration * windows);
  const historyDay = day(historyStart);
  const startDay = day(context.period.startDate);
  const endDay = day(context.period.endDate);
  const accountIds = new Set(context.accountScope.accountIds);
  const categoryById = new Map(context.categories.map((category) => [category.id, category]));
  const limitations = new Set(context.sourceWarnings ?? []);
  const signals: EntrySignal[] = [];
  for (const entry of rawEntries) {
    if (!accountIds.has(entry.accountId) || entry.date < historyStart || entry.date > context.period.endDate) continue;
    if (!Number.isSafeInteger(entry.amountMinor)) throw new RangeError('Anomaly amounts must be safe integer minor units.');
    if (entry.isTransfer || entry.transferId) continue;
    if (entry.currencyCode !== context.currency) {
      if (entry.date >= context.period.startDate) limitations.add('Se excluyeron movimientos actuales con divisa desconocida o sin conversión válida; no se comparan importes incompatibles.');
      else limitations.add('Algunos movimientos históricos no tienen conversión válida a ' + context.currency + ' y se excluyeron de las líneas base.');
      continue;
    }
    signals.push({
      entry, payee: normalizedPayee(entry.payeeLabel), amountMinor: Math.abs(entry.amountMinor),
      flow: classify(entry, categoryById),
    });
  }
  const current = signals.filter((s) => s.entry.date >= context.period.startDate && s.entry.date <= context.period.endDate);
  const historical = signals.filter((s) => s.entry.date < context.period.startDate);
  const totals = aggregate(signals, context.period, windows, historyStart);
  const seasons = seasonalMonths(context.period, historyStart, windows);
  const eligibleWindows: number[] = [];
  for (let w = 1; w <= windows; w += 1) {
    const windowStart = addDays(context.period.startDate, -duration * w);
    const windowEnd = addDays(windowStart, duration - 1);
    if (day(windowStart) >= historyDay && windowEnd < context.period.startDate) eligibleWindows.push(w);
  }
  const findings: FinancialFinding[] = [];
  const source = 'finance-core.buildFinancialAnomalyFindings';

  if (enabled.has('possible-duplicate')) {
    const matches = new Map<string, EntrySignal[]>();
    for (const signal of current) {
      const tx = signal.entry;
      if (tx.isSplitLine || !signal.payee || tx.amountMinor === 0 || tx.currencyCode !== context.currency) continue;
      const key = [tx.accountId, tx.date, tx.amountMinor, tx.currencyCode, signal.payee].join('|');
      const group = matches.get(key) ?? [];
      group.push(signal); matches.set(key, group);
    }
    for (const [key, group] of matches) {
      const unique = [...new Map(group.map((signal) => [signal.entry.id, signal])).values()];
      if (unique.length < 2) continue;
      const first = unique[0]!;
      const impact = Math.abs(first.entry.amountMinor) * (unique.length - 1);
      if (!Number.isSafeInteger(impact)) continue;
      const priority = priorityFor(impact, 0);
      findings.push(createFinancialFinding({
        entityKey: 'duplicate:' + key, type: 'financial-anomaly',
        title: 'Posibles operaciones duplicadas para ' + first.payee,
        explanation: 'Hay operaciones con la misma fecha, importe, beneficiario normalizado, cuenta y divisa. La coincidencia puede ser legítima y únicamente indica que conviene revisar los movimientos.',
        period: { startDate: first.entry.date, endDate: first.entry.date }, accountScope: context.accountScope,
        currency: context.currency, confidence: 'candidate', priority: priority.priority, priorityReason: priority.reason,
        impactMinor: impact,
        metrics: {
          anomalyKind: 'possible-duplicate', transactionDate: first.entry.date, amountMinor: Math.abs(first.entry.amountMinor),
          matchingTransactionCount: unique.length, potentiallyRepeatedAmountMinor: impact,
          matchingRule: 'exact-normalized-payee-account-date-amount-currency',
        },
        evidence: [
          { label: 'Fecha de las operaciones', value: first.entry.date, source, rule: 'Coincidencia exacta de fecha.' },
          { label: 'Importe por operación', value: Math.abs(first.entry.amountMinor), source, rule: 'Coincidencia del importe firmado y la divisa.' },
          { label: 'Operaciones coincidentes', value: unique.length, source, rule: 'Mismo beneficiario normalizado y cuenta; no se usa coincidencia difusa.' },
          { label: 'Importe potencialmente repetido', value: impact, source, rule: 'Importe por coincidencias adicionales; no demuestra duplicidad.' },
        ],
        limitations: [
          'Dos operaciones legítimas pueden compartir estos atributos; la alerta no demuestra duplicidad.',
          'Las líneas de transacciones divididas se excluyen para evitar contar asignaciones como cargos adicionales.',
          'No se elimina, fusiona ni modifica ninguna operación; esta regla es distinta de la prevención de duplicados de importación.',
        ],
        calculatedAt: context.calculatedAt, navigationTarget: '/movements',
      }));
    }
  }

  if (enabled.has('transaction-outlier') && (context.allowTransactionOutliers ?? true)) {
    for (const signal of current) {
      if (signal.entry.isSplitLine || signal.flow === null || !signal.payee || signal.amountMinor <= 0) continue;
      const prior = historical.filter((s) =>
        !s.entry.isSplitLine && s.payee === signal.payee && s.flow === signal.flow && s.amountMinor > 0,
      ).sort((a, b) => a.entry.date.localeCompare(b.entry.date)).slice(-24);
      if (prior.length < minObservations) continue;
      const values = prior.map((s) => s.amountMinor);
      const center = median(values);
      if (center <= 0) continue;
      const dispersion = mad(values, center);
      const threshold = Math.max(minAmount, Math.ceil(center * minPercent / 100), Math.ceil(3 * 1.4826 * dispersion));
      const delta = signal.amountMinor - center;
      if (delta <= 0 || delta < threshold) continue;
      const percent = delta / center * 100;
      const priority = priorityFor(delta, percent);
      const series = prior.map((s) => ({ date: s.entry.date, amountMinor: s.amountMinor }));
      findings.push(createFinancialFinding({
        entityKey: 'outlier:' + signal.entry.id, type: 'financial-anomaly',
        title: 'Importe inusualmente alto para ' + signal.payee,
        explanation: 'El importe de esta operación supera de forma material los importes previos comparables de ese beneficiario. Comprueba la factura o el recibo; la desviación no demuestra error ni fraude.',
        period: { startDate: signal.entry.date, endDate: signal.entry.date }, accountScope: context.accountScope,
        currency: context.currency, confidence: 'candidate', priority: priority.priority, priorityReason: priority.reason,
        impactMinor: delta,
        metrics: {
          anomalyKind: 'transaction-outlier', transactionDate: signal.entry.date, flowKind: signal.flow,
          observedMinor: signal.amountMinor, baselineMedianMinor: center, deltaMinor: delta,
          percentageChange: Number(percent.toFixed(2)), medianAbsoluteDeviationMinor: dispersion,
          triggerThresholdMinor: threshold, historicalObservationCount: prior.length,
          minimumAbsoluteChangeMinor: minAmount, minimumRelativeChangePercent: minPercent,
        },
        evidence: [
          { label: 'Importe observado', value: signal.amountMinor, source, rule: 'Importe absoluto en unidades menores de ' + context.currency + '.' },
          { label: 'Mediana de importes históricos', value: center, source, rule: 'Mediana de hasta 24 operaciones previas del mismo beneficiario normalizado y tipo de flujo.' },
          { label: 'Serie histórica de importes', value: JSON.stringify(series), source, rule: 'Observaciones previas ordenadas por fecha; importes en unidades menores de ' + context.currency + '.' },
          { label: 'Umbral de activación', value: threshold, source, rule: 'Máximo entre umbral absoluto, porcentaje mínimo y tres MAD escaladas.' },
          { label: 'Observaciones históricas', value: prior.length, source, rule: 'Se requieren al menos ' + minObservations + ' operaciones previas comparables.' },
        ],
        limitations: [
          'El cambio puede deberse a consumo, tarifas, cambios de servicio u otras circunstancias puntuales.',
          'Solo compara el mismo beneficiario normalizado y tipo de flujo.',
          ...(context.sourceWarnings?.length ? ['La referencia puede ser incompleta debido a movimientos excluidos sin conversión válida.'] : []),
        ],
        calculatedAt: context.calculatedAt, navigationTarget: '/movements',
      }));
    }
  } else if (enabled.has('transaction-outlier') && !(context.allowTransactionOutliers ?? true)) {
    limitations.add('Se omitieron anomalías de importes individuales porque la cobertura de divisas del historial no es completa.');
  }

  if (!(context.allowPeriodComparisons ?? true)) {
    limitations.add('Se omitieron comparaciones agregadas: el periodo no está completo o hay movimientos sin conversión válida.');
  } else {
    const normalBaselineMinimum = minObservations;
    const seasonalMinimum = Math.min(minObservations, seasons.length);
    const withMinimum = (baseline: { values: number[]; seasonal: boolean }) => ({
      ...baseline, required: baseline.seasonal ? seasonalMinimum : normalBaselineMinimum,
    });
    if (enabled.has('total-expense-change')) {
      const b = withMinimum(getBaseline({ key: 'expense', bucketValues: totals.expense, monthlyScalar: totals.expenseByMonth, matchingMonths: seasons, eligibleWindows }));
      const finding = aggregateFinding({
        kind: 'total-expense-change', entityKey: 'total-expense', title: 'El gasto total difiere del patrón habitual',
        explanation: 'El gasto agregado se desvía de la mediana histórica comparable. Revisa las categorías y operaciones que contribuyen al cambio; la señal no atribuye una causa.',
        current: totals.expense.get(0) ?? 0, baseline: b.values, minimumObservations: b.required,
        minimumAbsoluteChangeMinor: minAmount, minimumRelativeChangePercent: minPercent, period: context.period,
        accountScope: context.accountScope, currency: context.currency, calculatedAt: context.calculatedAt,
        subject: 'Gasto total', source, windows, seasonal: b.seasonal,
      });
      if (finding) findings.push(finding);
    }
    if (enabled.has('category-change')) {
      for (const [id, buckets] of totals.byCategory) {
        const name = categoryById.get(id)?.name ?? 'Categoría sin nombre';
        const b = withMinimum(getBaseline({ key: id, bucketValues: buckets, monthlyValues: totals.categoryByMonth, matchingMonths: seasons, eligibleWindows }));
        const finding = aggregateFinding({
          kind: 'category-change', entityKey: 'category:' + id, title: 'Gasto inusual en ' + name,
          explanation: 'El gasto de esta categoría difiere de su referencia histórica. Revisa movimientos y contexto antes de modificar el presupuesto.',
          current: buckets.get(0) ?? 0, baseline: b.values, minimumObservations: b.required,
          minimumAbsoluteChangeMinor: minAmount, minimumRelativeChangePercent: minPercent, period: context.period,
          accountScope: context.accountScope, currency: context.currency, calculatedAt: context.calculatedAt,
          subject: name, source, windows, seasonal: b.seasonal,
        });
        if (finding) findings.push(finding);
      }
    }
    if (enabled.has('payee-change')) {
      for (const [payee, buckets] of totals.byPayee) {
        const b = withMinimum(getBaseline({ key: payee, bucketValues: buckets, monthlyValues: totals.payeeByMonth, matchingMonths: seasons, eligibleWindows }));
        const finding = aggregateFinding({
          kind: 'payee-change', entityKey: 'payee:' + payee, title: 'Gasto inusual para ' + payee,
          explanation: 'El gasto de este beneficiario difiere de su referencia histórica. Revisa facturas, frecuencia y movimientos antes de atribuir el cambio.',
          current: buckets.get(0) ?? 0, baseline: b.values, minimumObservations: b.required,
          minimumAbsoluteChangeMinor: minAmount, minimumRelativeChangePercent: minPercent, period: context.period,
          accountScope: context.accountScope, currency: context.currency, calculatedAt: context.calculatedAt,
          subject: payee, source, windows, seasonal: b.seasonal,
        });
        if (finding) findings.push(finding);
      }
    }
    for (const item of [
      { kind: 'income-change' as const, enabled: enabled.has('income-change'), key: 'income', buckets: totals.income, months: totals.incomeByMonth,
        title: 'Los ingresos se desviaron del patrón habitual', subject: 'Ingresos clasificados',
        explanation: 'Los ingresos clasificados difieren de la referencia histórica. Comprueba si el periodo está completo y si faltan ingresos por registrar o clasificar.' },
      { kind: 'refund-change' as const, enabled: enabled.has('refund-change'), key: 'refunds', buckets: totals.refunds, months: totals.refundsByMonth,
        title: 'Los reembolsos cambiaron de forma inusual', subject: 'Reembolsos clasificados',
        explanation: 'Los reembolsos clasificados difieren de su referencia histórica. Revisa devoluciones y abonos; no se interpretan como nuevos ingresos.' },
    ]) {
      if (!item.enabled) continue;
      const b = withMinimum(getBaseline({ key: item.key, bucketValues: item.buckets, monthlyScalar: item.months, matchingMonths: seasons, eligibleWindows }));
      const finding = aggregateFinding({
        kind: item.kind, entityKey: item.key, title: item.title, explanation: item.explanation,
        current: item.buckets.get(0) ?? 0, baseline: b.values, minimumObservations: b.required,
        minimumAbsoluteChangeMinor: minAmount, minimumRelativeChangePercent: minPercent, period: context.period,
        accountScope: context.accountScope, currency: context.currency, calculatedAt: context.calculatedAt,
        subject: item.subject, source, windows, seasonal: b.seasonal,
      });
      if (finding) findings.push(finding);
    }
    if (enabled.has('frequency-change')) {
      const frequencyValues = new Map([...totals.frequency].map(([w, groups]) => [w, groups.size]));
      const b = withMinimum(getBaseline({ key: 'frequency', bucketValues: frequencyValues, monthlySets: totals.frequencyByMonth, matchingMonths: seasons, eligibleWindows }));
      const center = median(b.values.filter((value) => value > 0));
      const currentCount = totals.frequency.get(0)?.size ?? 0;
      const observations = b.values.filter((v) => v > 0).length;
      if (observations >= b.required && center > 0) {
        const delta = currentCount - center;
        const percent = delta / center * 100;
        const threshold = Math.max(3, Math.ceil(center * minPercent / 100));
        if (delta !== 0 && Math.abs(delta) >= threshold) {
          const priority = priorityFor(null, percent);
          findings.push(createFinancialFinding({
            entityKey: 'frequency-change', type: 'financial-anomaly', title: 'La frecuencia de movimientos cambió de forma inusual',
            explanation: 'El número de operaciones distintas se aparta de la referencia histórica. Las líneas de un movimiento dividido cuentan una sola vez; revisa la actividad del periodo.',
            period: context.period, accountScope: context.accountScope, currency: context.currency, confidence: 'candidate',
            priority: priority.priority, priorityReason: priority.reason, impactMinor: null,
            metrics: { anomalyKind: 'frequency-change', currentTransactionCount: currentCount, baselineMedianCount: center,
              deltaCount: delta, percentageChange: Number(percent.toFixed(2)), triggerThresholdCount: threshold,
              historicalObservationCount: observations, referenceWindows: windows, seasonalBaseline: b.seasonal },
            evidence: [
              { label: 'Operaciones del periodo', value: currentCount, source, rule: 'Cuenta IDs de grupo de transacción únicos; las líneas divididas comparten grupo.' },
              { label: 'Mediana de operaciones', value: center, source, rule: 'Mediana de ventanas históricas comparables.' },
              { label: 'Umbral de activación', value: threshold, source, rule: 'Diferencia mínima de 3 operaciones o el porcentaje configurado.' },
              { label: 'Observaciones históricas', value: observations, source, rule: 'Ventanas con actividad positiva.' },
            ],
            limitations: [
              'La frecuencia puede variar por estacionalidad, viajes, vacaciones o importaciones por lotes.',
              ...(b.seasonal ? [] : ['No se aplicó ajuste estacional: no hay al menos dos meses homólogos completos disponibles.']),
            ],
            calculatedAt: context.calculatedAt, navigationTarget: '/movements',
          }));
        }
      }
    }
  }
  if (!historical.length) limitations.add('No hay movimientos históricos en la ventana seleccionada; se necesita más historial para calcular líneas base.');
  else if (eligibleWindows.length < minObservations && (context.allowPeriodComparisons ?? true)) {
    limitations.add('Historial insuficiente: solo hay ' + eligibleWindows.length + ' ventanas completas; las comparaciones agregadas requieren ' + minObservations + '.');
  }
  return { findings, limitations: [...limitations] };
}
