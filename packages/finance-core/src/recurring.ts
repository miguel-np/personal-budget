import type { BudgetTransaction } from './domain.js';
import { validatePeriod } from './date-range.js';
import { normalizeTransactions } from './ledger.js';

export interface RecurringCandidateOptions {
  readonly startDate: string;
  readonly endDate: string;
  /** Minimum occurrences required to consider a payee recurrent. Default 3. */
  readonly minOccurrences?: number;
  /** Interval window in days that qualifies as a recurrent cadence. Default [20, 45]. */
  readonly intervalWindowDays?: readonly [number, number];
  /** Maximum amount deviation accepted before warning about variable amounts. Default 20%. */
  readonly maxAmountDeviationPercent?: number;
}

export interface RecurringCandidate {
  readonly payee: string;
  readonly payeeVariants: readonly string[];
  readonly occurrenceCount: number;
  readonly refundsExcluded: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly dates: readonly string[];
  readonly meanAbsoluteAmountMinor: number;
  readonly minAbsoluteAmountMinor: number;
  readonly maxAbsoluteAmountMinor: number;
  readonly amountDeviationPercent: number;
  readonly estimatedIntervalDays: number | null;
  readonly estimatedFrequency: string | null;
  readonly confidence: 'candidate_only';
  /** Deterministic explanation of the inferred signals; never a guarantee. */
  readonly signals: readonly string[];
  /** Known false-positive risks for this candidate. */
  readonly warnings: readonly string[];
}

interface CandidateAccumulator {
  occurrences: Array<{ date: string; amount: number }>;
  refunds: number;
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function dayDifference(later: string, earlier: string): number {
  return Math.round((Date.parse(later + 'T00:00:00.000Z') - Date.parse(earlier + 'T00:00:00.000Z')) / 86_400_000);
}

function frequencyLabel(intervalDays: number): string | null {
  if (intervalDays <= 9) return 'semanal';
  if (intervalDays <= 18) return 'quincenal';
  if (intervalDays <= 36) return 'mensual';
  if (intervalDays <= 100) return 'trimestral';
  if (intervalDays <= 400) return 'anual';
  return null;
}

/**
 * Detects recurring-expense candidates from local history using deterministic
 * signals: beneficiary, occurrence count, date gaps and amount similarity.
 * Results are candidates with explanations, never guarantees.
 */
export function detectRecurringCandidates(
  transactions: readonly BudgetTransaction[],
  options: RecurringCandidateOptions,
): readonly RecurringCandidate[] {
  validatePeriod(options);
  const minOccurrences = options.minOccurrences ?? 3;
  if (!Number.isInteger(minOccurrences) || minOccurrences < 2) {
    throw new RangeError('minOccurrences must be an integer of at least 2.');
  }
  const [windowStart, windowEnd] = options.intervalWindowDays ?? [20, 45];
  if (!Number.isInteger(windowStart) || !Number.isInteger(windowEnd) || windowStart < 1 || windowEnd < windowStart) {
    throw new RangeError('intervalWindowDays must be an ordered pair of positive integers.');
  }
  const maxDeviation = options.maxAmountDeviationPercent ?? 20;
  if (!Number.isFinite(maxDeviation) || maxDeviation < 0) {
    throw new RangeError('maxAmountDeviationPercent must be a non-negative number.');
  }

  const entries = normalizeTransactions(transactions);
  const variantByLabel = new Map<string, string[]>();
  for (const transaction of transactions) {
    const rawPayee = (transaction.payee_name ?? transaction.imported_payee ?? '').trim();
    if (!rawPayee) continue;
    const label = rawPayee.toLocaleLowerCase('es').replace(/\s+/g, ' ');
    const variants = variantByLabel.get(label) ?? [];
    if (!variants.includes(rawPayee)) variants.push(rawPayee);
    variantByLabel.set(label, variants);
  }

  const groups = new Map<string, CandidateAccumulator>();
  for (const entry of entries) {
    if (entry.isTransfer || !entry.payeeLabel) continue;
    if (entry.date < options.startDate || entry.date > options.endDate) continue;
    const group = groups.get(entry.payeeLabel) ?? { occurrences: [], refunds: 0 };
    if (entry.amountMinor < 0) {
      group.occurrences.push({ date: entry.date, amount: Math.abs(entry.amountMinor) });
    } else {
      group.refunds += 1;
    }
    groups.set(entry.payeeLabel, group);
  }

  const candidates: RecurringCandidate[] = [];
  for (const [payee, group] of groups) {
    if (group.occurrences.length < minOccurrences) continue;
    const sorted = [...group.occurrences].sort((left, right) => left.date.localeCompare(right.date));
    const amounts = sorted.map((item) => item.amount);
    const meanAmount = Math.round(meanOf(amounts));
    const minAmount = Math.min(...amounts);
    const maxAmount = Math.max(...amounts);
    const deviation = meanAmount > 0
      ? Math.max(...amounts.map((amount) => Math.abs(amount - meanAmount))) / meanAmount * 100
      : 0;

    const dates = [...new Set(sorted.map((item) => item.date))].sort();
    const gaps = dates.slice(1).map((date, index) => dayDifference(date, dates[index]!));
    let estimatedIntervalDays: number | null = null;
    if (gaps.length > 0) {
      const average = meanOf(gaps);
      const withinTolerance = gaps.every((gap) => Math.abs(gap - average) <= average * 0.25);
      estimatedIntervalDays = withinTolerance ? Math.round(average) : null;
    }
    const withinWindow = estimatedIntervalDays !== null
      && estimatedIntervalDays >= windowStart && estimatedIntervalDays <= windowEnd;
    if (estimatedIntervalDays !== null && !withinWindow) continue;

    const signals: string[] = [];
    const warnings: string[] = [];
    signals.push(
      estimatedIntervalDays === null
        ? `${group.occurrences.length} cargos en fechas con intervalos irregulares; no se infiere una cadencia estable.`
        : `${group.occurrences.length} cargos con una cadencia ${frequencyLabel(estimatedIntervalDays) ?? 'inferida'} aproximada de ${estimatedIntervalDays} días.`,
    );
    signals.push(
      deviation <= maxDeviation
        ? `Importe estable en torno a ${meanAmount} unidades monetarias menores.`
        : `Importes variables entre ${minAmount} y ${maxAmount} unidades monetarias menores.`,
    );
    if (group.refunds > 0) {
      warnings.push(`Se excluyeron ${group.refunds} abono(s) positivos del mismo beneficiario; verifica que no sean reembolsos que alteren la recurrencia.`);
    }
    if (estimatedIntervalDays === null) {
      warnings.push('Las fechas están desplazadas; el candidato puede corresponder a pagos puntuales agrupados por nombre similar.');
    }
    if (deviation > maxDeviation) {
      warnings.push('La variación de importes puede indicar facturas variables o falsos positivos; revisa antes de confirmar.');
    }
    warnings.push('Los beneficiarios con nombres similares se agrupan por texto normalizado; pueden aparecer como candidatos separados y requerir revisión.');

    candidates.push({
      payee,
      payeeVariants: variantByLabel.get(payee) ?? [],
      occurrenceCount: group.occurrences.length,
      refundsExcluded: group.refunds,
      firstDate: sorted[0]!.date,
      lastDate: sorted[sorted.length - 1]!.date,
      dates: dates.slice(-12),
      meanAbsoluteAmountMinor: meanAmount,
      minAbsoluteAmountMinor: minAmount,
      maxAbsoluteAmountMinor: maxAmount,
      amountDeviationPercent: Math.round(deviation * 100) / 100,
      estimatedIntervalDays,
      estimatedFrequency: estimatedIntervalDays === null ? null : frequencyLabel(estimatedIntervalDays),
      confidence: 'candidate_only',
      signals,
      warnings,
    });
  }

  return candidates.sort((left, right) =>
    right.occurrenceCount - left.occurrenceCount
    || right.meanAbsoluteAmountMinor - left.meanAbsoluteAmountMinor
    || left.payee.localeCompare(right.payee, 'es'));
}

/** Median helper exposed for deterministic, testable aggregation elsewhere in finance-core. */
export function stableMedian(values: readonly number[]): number | null {
  return medianOf(values);
}
