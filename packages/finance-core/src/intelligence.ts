import type { FinancialSummary, LedgerEntry, Period } from './domain.js';

export type FindingType =
  | 'expense-change'
  | 'income-change'
  | 'budget-overspend'
  | 'pending-categorization'
  | 'commitment-upcoming'
  | 'recurring-candidate-upcoming'
  | 'goal-at-risk'
  | 'goal-progress';

export type FindingConfidence = 'observed' | 'estimated' | 'candidate' | 'suggestion';
export type FindingPriority = 'low' | 'medium' | 'high';
export type FindingReviewStatus = 'new' | 'reviewed' | 'dismissed' | 'snoozed';
export type FindingNavigationTarget = '/reports' | '/movements' | '/budgets' | '/planning' | '/goals';

export interface FindingAccountScope {
  readonly mode: 'all' | 'selected';
  readonly accountIds: readonly string[];
  readonly label: string;
}

export interface FindingEvidence {
  readonly label: string;
  readonly value: string | number;
  readonly source: string;
  readonly rule: string;
}

export interface FinancialFinding {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly fingerprint: string;
  readonly type: FindingType;
  readonly title: string;
  readonly explanation: string;
  readonly period: Period;
  readonly accountScope: FindingAccountScope;
  readonly currency: string;
  readonly confidence: FindingConfidence;
  readonly priority: FindingPriority;
  readonly priorityReason: string;
  readonly impactMinor: number | null;
  readonly metrics: Readonly<Record<string, number | string | boolean | null>>;
  readonly evidence: readonly FindingEvidence[];
  readonly limitations: readonly string[];
  readonly calculatedAt: string;
  readonly reviewStatus: FindingReviewStatus;
  readonly snoozedUntil?: string;
  readonly navigationTarget: FindingNavigationTarget;
}

export type FinancialFindingDraft = Omit<
  FinancialFinding,
  'schemaVersion' | 'id' | 'fingerprint' | 'reviewStatus' | 'snoozedUntil'
> & { readonly entityKey: string };

export interface FindingComparisonContext {
  readonly accountScope: FindingAccountScope;
  readonly calculatedAt: string;
  readonly minimumObservations?: number;
  /** Threshold in the selected display currency's minor units. */
  readonly minimumAbsoluteChangeMinor?: number;
  readonly minimumRelativeChangePercent?: number;
  /** Optional third equivalent window used to detect a persistent direction. */
  readonly priorSummary?: FinancialSummary;
}

export interface FindingBuildResult {
  readonly findings: readonly FinancialFinding[];
  readonly limitations: readonly string[];
}

function stableHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = (Math.imul(right ^ code, 0x85ebca6b) + index) >>> 0;
  }
  return left.toString(16).padStart(8, '0') + right.toString(16).padStart(8, '0');
}

/** Stable identity excludes observed amounts; the evidence fingerprint does not. */
export function createFinancialFinding(draft: FinancialFindingDraft): FinancialFinding {
  if (!/^[A-Z]{3}$/.test(draft.currency)) throw new RangeError('Finding currency must be a three-letter uppercase code.');
  if (!Number.isFinite(Date.parse(draft.calculatedAt))) throw new RangeError('Finding calculatedAt must be an ISO timestamp.');
  const { entityKey, ...finding } = draft;
  const identity = [
    finding.type,
    finding.period.startDate,
    finding.period.endDate,
    finding.accountScope.mode,
    [...finding.accountScope.accountIds].sort().join(','),
    entityKey,
  ].join('|');
  const id = 'fi-v1-' + finding.type + '-' + finding.period.startDate + '-' + finding.period.endDate + '-' + stableHash(identity);
  const fingerprintSource = JSON.stringify({
    type: finding.type,
    period: finding.period,
    accountScope: finding.accountScope,
    currency: finding.currency,
    metrics: finding.metrics,
    evidence: finding.evidence,
    confidence: finding.confidence,
    impactMinor: finding.impactMinor,
    priority: finding.priority,
    limitations: finding.limitations,
  });
  return {
    ...finding,
    schemaVersion: 1,
    id,
    fingerprint: stableHash(fingerprintSource),
    reviewStatus: 'new',
  };
}

function dayIndex(date: string): number {
  const value = Date.parse(date + 'T00:00:00.000Z');
  if (!Number.isFinite(value)) throw new RangeError('Finding period must use valid ISO calendar dates.');
  return Math.floor(value / 86_400_000);
}

function comparablePeriods(current: Period, previous: Period): boolean {
  const currentDays = dayIndex(current.endDate) - dayIndex(current.startDate);
  const previousDays = dayIndex(previous.endDate) - dayIndex(previous.startDate);
  return currentDays >= 0 && previousDays >= 0 &&
    currentDays === previousDays && previous.endDate < current.startDate;
}

function impactPriority(impactMinor: number, percentageChange: number | null): { priority: FindingPriority; reason: string } {
  if (impactMinor >= 100_000 || (impactMinor >= 25_000 && percentageChange !== null && Math.abs(percentageChange) >= 50)) {
    return {
      priority: 'high',
      reason: 'Impacto ≥ 100000 unidades menores, o ≥ 25000 con variación relativa ≥ 50 % (regla v1).',
    };
  }
  if (impactMinor >= 25_000 || (percentageChange !== null && Math.abs(percentageChange) >= 30)) {
    return {
      priority: 'medium',
      reason: 'Impacto ≥ 25000 unidades menores o variación relativa ≥ 30 % (regla v1).',
    };
  }
  return { priority: 'low', reason: 'Impacto y variación por debajo de los umbrales de prioridad media (regla v1).' };
}

/** Generates traceable changes and abstains when periods, history or currency data are insufficient. */
export function buildPeriodChangeFindings(
  current: FinancialSummary,
  previous: FinancialSummary,
  context: FindingComparisonContext,
): FindingBuildResult {
  const limitations: string[] = [];
  if (!comparablePeriods(current, previous)) {
    return { findings: [], limitations: ['Comparación omitida: los periodos no tienen la misma duración o se solapan.'] };
  }
  if (current.currency !== previous.currency || !/^[A-Z]{3}$/.test(current.currency)) {
    return { findings: [], limitations: ['Comparación omitida: las divisas de los periodos no coinciden o no son válidas.'] };
  }
  const minimumObservations = context.minimumObservations ?? 3;
  const minimumAbsoluteChangeMinor = context.minimumAbsoluteChangeMinor ?? 5_000;
  const minimumRelativeChangePercent = context.minimumRelativeChangePercent ?? 20;
  if (current.transactionCount < minimumObservations || previous.transactionCount < minimumObservations) {
    limitations.push('No se generan variaciones significativas: alguno de los periodos tiene menos de ' + minimumObservations + ' movimientos comparables.');
    return { findings: [], limitations };
  }
  if (current.unconvertedTransactionCount > 0 || previous.unconvertedTransactionCount > 0) {
    limitations.push('No se comparan periodos con movimientos sin conversión monetaria válida.');
    return { findings: [], limitations };
  }

  const findings: FinancialFinding[] = [];
  const candidates: readonly {
    type: 'expense-change' | 'income-change';
    label: string;
    currentValue: number;
    previousValue: number;
    direction: 'increase' | 'decrease';
    explanation: string;
  }[] = [
    {
      type: 'expense-change', label: 'Gasto neto',
      currentValue: current.expenseMinor, previousValue: previous.expenseMinor, direction: 'increase',
      explanation: 'El gasto neto observado aumentó frente al periodo de duración equivalente. Revisa el desglose y los movimientos antes de atribuir una causa.',
    },
    {
      type: 'expense-change', label: 'Gasto neto',
      currentValue: current.expenseMinor, previousValue: previous.expenseMinor, direction: 'decrease',
      explanation: 'El gasto neto observado disminuyó frente al periodo de duración equivalente. Comprueba si responde a una reducción sostenible y si hay movimientos que aún no se han registrado.',
    },
    {
      type: 'income-change', label: 'Ingresos clasificados',
      currentValue: current.incomeMinor, previousValue: previous.incomeMinor, direction: 'decrease',
      explanation: 'Los ingresos clasificados observados disminuyeron frente al periodo de duración equivalente. Comprueba si el periodo está completo y si faltan ingresos por registrar o clasificar.',
    },
    {
      type: 'income-change', label: 'Ingresos clasificados',
      currentValue: current.incomeMinor, previousValue: previous.incomeMinor, direction: 'increase',
      explanation: 'Los ingresos clasificados observados aumentaron frente al periodo de duración equivalente. Revisa el origen y la regularidad de ese cambio antes de extrapolarlo.',
    },
  ];
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.currentValue) || !Number.isSafeInteger(candidate.previousValue)) continue;
    if (candidate.previousValue <= 0 || candidate.currentValue < 0) continue;
    const deltaMinor = candidate.currentValue - candidate.previousValue;
    if (!Number.isSafeInteger(deltaMinor)) continue;
    if (candidate.direction === 'increase' ? deltaMinor <= 0 : deltaMinor >= 0) continue;
    const percentageChange = (deltaMinor / candidate.previousValue) * 100;
    const impactMinor = Math.abs(deltaMinor);
    if (impactMinor < minimumAbsoluteChangeMinor || Math.abs(percentageChange) < minimumRelativeChangePercent) continue;
    const basePriority = impactPriority(impactMinor, percentageChange);
    const prior = context.priorSummary;
    const canAssessPersistence = prior !== undefined &&
      comparablePeriods(previous, prior) &&
      prior.currency === current.currency &&
      prior.transactionCount >= minimumObservations &&
      previous.transactionCount >= minimumObservations &&
      prior.unconvertedTransactionCount === 0 &&
      previous.unconvertedTransactionCount === 0;
    let persistentChange: boolean | null = null;
    if (canAssessPersistence && prior) {
      const earlierValue = candidate.type === 'expense-change' ? prior.expenseMinor : prior.incomeMinor;
      const previousDelta = candidate.previousValue - earlierValue;
      const previousPercent = earlierValue > 0 ? (previousDelta / earlierValue) * 100 : null;
      persistentChange = candidate.direction === 'increase' ? previousDelta > 0 : previousDelta < 0;
      persistentChange = persistentChange &&
        Math.abs(previousDelta) >= minimumAbsoluteChangeMinor &&
        previousPercent !== null &&
        Math.abs(previousPercent) >= minimumRelativeChangePercent;
    }
    const priority: { priority: FindingPriority; reason: string } = persistentChange === true
      ? {
          priority: basePriority.priority === 'low' ? 'medium' : 'high',
          reason: basePriority.reason + ' Escalada porque la misma dirección supera los umbrales en dos variaciones consecutivas.',
        }
      : basePriority;
    findings.push(createFinancialFinding({
      entityKey: candidate.type,
      type: candidate.type,
      title: candidate.type === 'expense-change'
        ? candidate.direction === 'increase' ? 'El gasto neto aumentó' : 'El gasto neto disminuyó'
        : candidate.direction === 'increase' ? 'Los ingresos clasificados aumentaron' : 'Los ingresos clasificados disminuyeron',
      explanation: candidate.explanation,
      period: { startDate: current.startDate, endDate: current.endDate },
      accountScope: context.accountScope,
      currency: current.currency,
      confidence: 'observed',
      priority: priority.priority,
      priorityReason: priority.reason,
      impactMinor,
      metrics: {
        currentMinor: candidate.currentValue,
        previousMinor: candidate.previousValue,
        deltaMinor,
        percentageChange,
        previousStartDate: previous.startDate,
        previousEndDate: previous.endDate,
        minimumAbsoluteChangeMinor,
        minimumRelativeChangePercent,
        observationsCurrent: current.transactionCount,
        observationsPrevious: previous.transactionCount,
        persistentChange,
        comparisonWindowsSupportingDirection: persistentChange === true ? 2 : persistentChange === false ? 1 : null,
      },
      evidence: [
        { label: 'Valor del periodo actual', value: candidate.currentValue, source: 'finance-core.calculateSummary', rule: 'Agregado determinista; excluye traspasos internos.' },
        { label: 'Valor del periodo comparable', value: candidate.previousValue, source: 'finance-core.calculateSummary', rule: 'Misma duración; divisa y ámbito de cuentas coincidentes.' },
        { label: 'Variación absoluta', value: deltaMinor, source: 'finance-core', rule: 'Diferencia entre los dos agregados.' },
        { label: 'Variación relativa (%)', value: Number(percentageChange.toFixed(2)), source: 'finance-core', rule: 'Diferencia dividida por el valor anterior, que debe ser positivo.' },
        { label: 'Umbral de activación', value: minimumAbsoluteChangeMinor, source: 'finance-core', rule: 'Se exige además una variación relativa mínima de ' + minimumRelativeChangePercent + ' %.' },
        { label: 'Persistencia observada', value: persistentChange === null ? 'No evaluada' : persistentChange ? 'Sí' : 'No', source: 'finance-core', rule: 'Se evalúan dos variaciones consecutivas con duración equivalente cuando existe una tercera ventana con suficientes datos y conversiones válidas.' },
      ],
      limitations: [
        'La variación describe los agregados y no determina su causa.',
        'Reembolsos netos pueden reducir el gasto; los traspasos internos se excluyen.',
        'La prioridad usa impacto absoluto, porcentaje y persistencia observable; no implica riesgo, fraude ni asesoramiento.',
        ...(persistentChange === null ? ['La persistencia no se evaluó por falta de una tercera ventana equivalente con datos suficientes.'] : []),
      ],
      calculatedAt: context.calculatedAt,
      navigationTarget: '/reports',
    }));
  }
  return { findings, limitations };
}

/** Finds unclassified current-period ledger entries after split normalization and currency conversion. */
export function buildUncategorizedFinding(
  entries: readonly LedgerEntry[],
  context: {
    readonly period: Period;
    readonly accountScope: FindingAccountScope;
    readonly currency: string;
    readonly calculatedAt: string;
    readonly sourceWarnings?: readonly string[];
  },
): FinancialFinding | null {
  const pending = entries.filter((entry) =>
    entry.date >= context.period.startDate &&
    entry.date <= context.period.endDate &&
    !entry.isTransfer && !entry.transferId && entry.categoryId === null,
  );
  if (pending.length === 0) return null;
  let outflowMinor = 0;
  let inflowMinor = 0;
  for (const entry of pending) {
    if (entry.amountMinor < 0) outflowMinor += -entry.amountMinor;
    else if (entry.amountMinor > 0) inflowMinor += entry.amountMinor;
    if (!Number.isSafeInteger(outflowMinor) || !Number.isSafeInteger(inflowMinor)) {
      throw new RangeError('Uncategorized totals exceed the safe integer range.');
    }
  }
  const impactMinor = outflowMinor > 0 ? outflowMinor : inflowMinor > 0 ? inflowMinor : null;
  const priority = impactPriority(impactMinor ?? 0, null);
  return createFinancialFinding({
    entityKey: 'uncategorized-movements',
    type: 'pending-categorization',
    title: 'Hay movimientos pendientes de clasificar',
    explanation: 'Hay movimientos sin categoría en el periodo. Revisarlos mejora la clasificación de los informes; el sistema no aplicará categorías automáticamente.',
    period: context.period,
    accountScope: context.accountScope,
    currency: context.currency,
    confidence: 'observed',
    priority: priority.priority,
    priorityReason: priority.reason,
    impactMinor,
    metrics: { transactionCount: pending.length, uncategorizedOutflowMinor: outflowMinor, unclassifiedInflowMinor: inflowMinor },
    evidence: [
      { label: 'Movimientos sin categoría', value: pending.length, source: 'finance-core.normalizeTransactions', rule: 'Cuenta cada entrada normalizada una vez; excluye traspasos internos.' },
      ...(outflowMinor > 0 ? [{ label: 'Gasto sin categoría', value: outflowMinor, source: 'finance-core', rule: 'Suma del valor absoluto de las salidas sin categoría.' }] : []),
      ...(inflowMinor > 0 ? [{ label: 'Entrada sin categoría', value: inflowMinor, source: 'finance-core', rule: 'Suma de las entradas sin categoría; no se considera ingreso clasificado.' }] : []),
    ],
    limitations: ['Una entrada sin categoría no se contabiliza como ingreso clasificado.', ...(context.sourceWarnings ?? [])],
    calculatedAt: context.calculatedAt,
    navigationTarget: '/movements',
  });
}

export function sortFinancialFindings(findings: readonly FinancialFinding[]): FinancialFinding[] {
  const priority = { high: 3, medium: 2, low: 1 } as const;
  return [...findings].sort((left, right) =>
    priority[right.priority] - priority[left.priority] ||
    (right.impactMinor ?? 0) - (left.impactMinor ?? 0) ||
    left.period.startDate.localeCompare(right.period.startDate) ||
    left.id.localeCompare(right.id),
  );
}

export interface FindingQualitySample {
  /** Label supplied by a local, independently reviewed synthetic or curated dataset. */
  readonly expectedPositive: boolean;
  readonly detected: boolean;
  /** Optional explicit user feedback, separate from the ground-truth label. */
  readonly dismissed?: boolean;
}

export interface FindingQualityMetrics {
  readonly sampleCount: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly precisionPercent: number | null;
  readonly falsePositiveRatePercent: number | null;
  readonly dismissedCount: number;
  readonly dismissalRatePercent: number | null;
}

/**
 * Evaluates a detector against explicit labels. User dismissals are counted
 * separately and are never substituted for ground truth. An empty denominator
 * yields null rather than a fabricated 0% metric.
 */
export function evaluateFindingQuality(samples: readonly FindingQualitySample[]): FindingQualityMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  let dismissedCount = 0;
  for (const sample of samples) {
    if (typeof sample.expectedPositive !== 'boolean' || typeof sample.detected !== 'boolean' ||
        (sample.dismissed !== undefined && typeof sample.dismissed !== 'boolean')) {
      throw new TypeError('Finding quality samples require explicit boolean labels.');
    }
    if (sample.expectedPositive && sample.detected) truePositives += 1;
    else if (!sample.expectedPositive && sample.detected) falsePositives += 1;
    else if (sample.expectedPositive && !sample.detected) falseNegatives += 1;
    else trueNegatives += 1;
    if (sample.dismissed) dismissedCount += 1;
  }
  const predictedPositive = truePositives + falsePositives;
  const actualNegative = falsePositives + trueNegatives;
  return {
    sampleCount: samples.length,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precisionPercent: predictedPositive > 0 ? truePositives / predictedPositive * 100 : null,
    falsePositiveRatePercent: actualNegative > 0 ? falsePositives / actualNegative * 100 : null,
    dismissedCount,
    dismissalRatePercent: samples.length > 0 ? dismissedCount / samples.length * 100 : null,
  };
}
