import { createHash } from 'node:crypto';
import { calculateSummary, normalizeTransactions } from '@personal-budget/finance-core';
import type {
  BudgetAccount,
  BudgetRepository,
  BudgetTransaction,
  FinancialFinding,
} from '@personal-budget/finance-core';
import type { AppConfig } from './config.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import { resolveAccountScope } from './account-scope.js';
import type { AccountScopePreference } from './account-scope.js';
import type { IntelligenceAnomalyOptions, IntelligenceResult } from './intelligence-service.js';
import {
  createPeriodicReview,
  readPeriodicReviewState,
} from './periodic-review-store.js';

export interface PeriodicReviewRequest {
  readonly periodType: 'weekly' | 'monthly';
  readonly anchorDate: string;
  readonly timeZone?: string;
}

interface Dependencies {
  readonly config: Pick<AppConfig, 'actualDataDir' | 'budgetCurrency' | 'aiEnabled'>;
  readonly repository: BudgetRepository;
  readonly currencyPreferences: () => Promise<CurrencyPreferences>;
  readonly accountScopePreference: () => Promise<AccountScopePreference>;
  readonly transactionsForAccounts: (
    accounts: readonly BudgetAccount[], startDate: string, endDate: string, preferences: CurrencyPreferences,
  ) => Promise<readonly BudgetTransaction[]>;
  readonly assertPeriod: (startDate: string, endDate: string) => void;
  readonly defaultAnomalyOptions: IntelligenceAnomalyOptions;
  readonly generateIntelligenceData: (
    startDate: string, endDate: string, anomalyOptions: IntelligenceAnomalyOptions, asOfDateOverride?: string,
  ) => Promise<IntelligenceResult>;
}

interface ReviewPeriod {
  readonly startDate: string;
  readonly endDate: string;
  readonly scheduledEndDate: string;
  readonly complete: boolean;
}

function addCivilDays(date: string, days: number): string {
  const shifted = new Date(date + 'T00:00:00.000Z');
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function civilDateInTimeZone(timeZone: string, instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = (type: 'year' | 'month' | 'day') => parts.find((entry) => entry.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new RangeError('Could not determine the current civil date in the selected time zone.');
  return year + '-' + month + '-' + day;
}

function buildReviewPeriod(
  periodType: PeriodicReviewRequest['periodType'],
  anchorDate: string,
  asOfDate: string,
  assertPeriod: Dependencies['assertPeriod'],
): ReviewPeriod {
  if (anchorDate > asOfDate) throw new RangeError('La fecha de referencia no puede estar en el futuro.');
  let startDate: string;
  let scheduledEndDate: string;
  if (periodType === 'monthly') {
    const year = Number(anchorDate.slice(0, 4));
    const month = Number(anchorDate.slice(5, 7));
    startDate = anchorDate.slice(0, 7) + '-01';
    scheduledEndDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  } else {
    const weekdayFromMonday = (new Date(anchorDate + 'T00:00:00.000Z').getUTCDay() + 6) % 7;
    startDate = addCivilDays(anchorDate, -weekdayFromMonday);
    scheduledEndDate = addCivilDays(startDate, 6);
  }
  const endDate = scheduledEndDate > asOfDate ? asOfDate : scheduledEndDate;
  assertPeriod(startDate, endDate);
  return { startDate, endDate, scheduledEndDate, complete: endDate === scheduledEndDate };
}

function previousReviewPeriod(
  periodType: PeriodicReviewRequest['periodType'],
  period: ReviewPeriod,
  assertPeriod: Dependencies['assertPeriod'],
): { readonly startDate: string; readonly endDate: string } {
  const durationDays = Math.floor((
    Date.parse(period.endDate + 'T00:00:00.000Z') -
    Date.parse(period.startDate + 'T00:00:00.000Z')) / 86_400_000) + 1;
  let startDate: string;
  let endDate: string;
  if (periodType === 'monthly') {
    const previousMonthLastDate = addCivilDays(period.startDate, -1);
    startDate = previousMonthLastDate.slice(0, 7) + '-01';
    const previousMonthDuration = Math.floor((
      Date.parse(previousMonthLastDate + 'T00:00:00.000Z') -
      Date.parse(startDate + 'T00:00:00.000Z')) / 86_400_000) + 1;
    endDate = period.complete
      ? previousMonthLastDate
      : addCivilDays(startDate, Math.min(durationDays, previousMonthDuration) - 1);
  } else {
    startDate = addCivilDays(period.startDate, -7);
    endDate = addCivilDays(startDate, durationDays - 1);
  }
  assertPeriod(startDate, endDate);
  return { startDate, endDate };
}

async function buildPreviousSummary(
  period: { readonly startDate: string; readonly endDate: string },
  dependencies: Dependencies,
) {
  const [accounts, categories, preferences, preference] = await Promise.all([
    dependencies.repository.listAccounts(),
    dependencies.repository.listCategories(),
    dependencies.currencyPreferences(),
    dependencies.accountScopePreference(),
  ]);
  const scope = resolveAccountScope(accounts, preference);
  const scoped = scope.accounts;
  const transactions = await dependencies.transactionsForAccounts(
    scoped, period.startDate, period.endDate, preferences,
  );
  const summary = calculateSummary(normalizeTransactions(transactions), categories, {
    startDate: period.startDate,
    endDate: period.endDate,
    currency: preferences.displayCurrency,
    exchangeRates: preferences.exchangeRates,
  });
  return summary;
}

function persistedScopeLabel(result: IntelligenceResult): string {
  return result.accountScope.mode === 'all'
    ? 'Todas las cuentas abiertas (' + result.accountScope.accountIds.length + ')'
    : 'Ámbito seleccionado (' + result.accountScope.accountIds.length + ' cuentas)';
}

function scopeFingerprint(result: IntelligenceResult): string {
  return createHash('sha256')
    .update([...result.accountScope.accountIds].sort().join('\0'))
    .digest('hex')
    .slice(0, 16);
}

function persistedScopeLabel(result: IntelligenceResult): string {
  return result.accountScope.mode === 'all'
    ? 'Todas las cuentas abiertas (' + result.accountScope.accountIds.length + ')'
    : 'Ámbito seleccionado (' + result.accountScope.accountIds.length + ' cuentas)';
}

function previousRunForPeriod(
  state: Awaited<ReturnType<typeof readPeriodicReviewState>>,
  parsed: PeriodicReviewRequest,
  period: ReviewPeriod,
  result: IntelligenceResult,
  fingerprint: string,
) {
  return state.reviews.find((review) =>
    review.periodType === parsed.periodType &&
    review.startDate === period.startDate &&
    review.endDate === period.endDate &&
    review.currency === result.currency &&
    review.accountScope.mode === result.accountScope.mode &&
    review.accountScope.fingerprint === fingerprint);
}

function createReviewItems(
  findings: readonly FinancialFinding[],
  previousItems: ReadonlyMap<string, Awaited<ReturnType<typeof readPeriodicReviewState>>['reviews'][number]['items'][number]>,
  asOfDate: string,
) {
  return findings
    .filter((finding) => finding.reviewStatus !== 'dismissed' && finding.reviewStatus !== 'expected')
    .map((finding) => {
      const previousItem = previousItems.get(finding.id);
      const reusableDecision = previousItem?.fingerprint === finding.fingerprint &&
        (previousItem.status === 'reviewed' ||
          (previousItem.status === 'postponed' && Boolean(previousItem.postponedUntil) &&
            previousItem.postponedUntil! >= asOfDate));
      if (reusableDecision && previousItem) {
        return {
          findingId: finding.id,
          findingType: finding.type,
          identityKey: finding.identityKey,
          evidenceFingerprint: finding.evidenceFingerprint,
          fingerprint: finding.fingerprint,
          status: previousItem.status,
          ...(previousItem.status === 'postponed' && previousItem.postponedUntil
            ? { postponedUntil: previousItem.postponedUntil } : {}),
        };
      }
      return {
        findingId: finding.id,
        findingType: finding.type,
        identityKey: finding.identityKey,
        evidenceFingerprint: finding.evidenceFingerprint,
        fingerprint: finding.fingerprint,
        status: finding.reviewStatus === 'reviewed'
          ? 'reviewed' as const
          : finding.reviewStatus === 'snoozed' ? 'postponed' as const : 'pending' as const,
        ...(finding.reviewStatus === 'snoozed' && finding.snoozedUntil
          ? { postponedUntil: finding.snoozedUntil } : {}),
      };
    });
}

function previousComparableRun(
  reviews: Awaited<ReturnType<typeof readPeriodicReviewState>>['reviews'],
  parsed: PeriodicReviewRequest,
  period: ReviewPeriod,
  result: IntelligenceResult,
  fingerprint: string,
) {
  return reviews
    .filter((review) =>
      review.periodType === parsed.periodType &&
      review.currency === result.currency &&
      review.accountScope.mode === result.accountScope.mode &&
      review.accountScope.fingerprint === fingerprint &&
      review.endDate < period.startDate)
    .sort((left, right) =>
      right.endDate.localeCompare(left.endDate) || right.generatedAt.localeCompare(left.generatedAt))[0];
}

function buildReviewComparison(
  previous: ReturnType<typeof previousComparableRun>,
  items: ReturnType<typeof createReviewItems>,
) {
  const unavailable = Boolean(previous?.items.some((item) => !item.identityKey || !item.evidenceFingerprint));
  if (!previous || unavailable) return { comparison: null, legacyUnavailable: unavailable };
  const previousItems = new Map(previous.items.map((item) => [item.identityKey!, item]));
  const currentItems = new Map(items.map((item) => [item.identityKey, item]));
  return {
    legacyUnavailable: false,
    comparison: {
      previousReview: {
        startDate: previous.startDate, endDate: previous.endDate,
        generatedAt: previous.generatedAt, status: previous.status,
      },
      newFindingCount: items.filter((item) => !previousItems.has(item.identityKey)).length,
      repeatedFindingCount: items.filter((item) => previousItems.has(item.identityKey)).length,
      changedEvidenceCount: items.filter((item) => {
        const previousItem = previousItems.get(item.identityKey);
        return previousItem !== undefined && previousItem.evidenceFingerprint !== item.evidenceFingerprint;
      }).length,
      noLongerPresentCount: previous.items.filter((item) =>
        !currentItems.has(item.identityKey ?? item.findingId)).length,
    },
  };
}

function buildBudgetAssessment(
  result: IntelligenceResult,
  period: ReviewPeriod,
  parsed: PeriodicReviewRequest,
  asOfDate: string,
  dependencies: Dependencies,
  warnings: string[],
) {
  const reviewMonth = period.startDate.slice(0, 7);
  const lastDay = new Date(Date.UTC(
    Number(reviewMonth.slice(0, 4)), Number(reviewMonth.slice(5, 7)), 0,
  )).toISOString().slice(0, 10);
  const fullMonth = parsed.periodType === 'monthly' && period.startDate === reviewMonth + '-01' &&
    period.endDate === lastDay && period.endDate < asOfDate;
  const limitations = warnings.filter((warning) => /desviaciones de presupuesto/i.test(warning));
  let reason: string | null = null;
  if (!fullMonth) reason = 'La comparación presupuestaria requiere un mes natural completo y cerrado.';
  else if (result.accountScope.mode !== 'all') reason = 'El presupuesto de Actual es global; el ámbito seleccionado no coincide con el presupuesto completo.';
  else if (result.currency !== dependencies.config.budgetCurrency) reason = 'La divisa de análisis no coincide con la divisa base del presupuesto.';
  else if (typeof dependencies.repository.getBudgetMonth !== 'function') reason = 'El adaptador de Actual no expone una consulta de presupuesto mensual.';
  else if (limitations.length > 0) reason = limitations[0]!;
  if (reason) warnings.push('Cumplimiento presupuestario no evaluable: ' + reason);
  return {
    available: reason === null,
    reason,
    overBudgetCategoryCount: result.findings.filter((finding) => finding.type === 'budget-overspend').length,
    scope: 'Categorías con asignación positiva y gasto verificable; no incluye categorías sin asignación comparable.',
  };
}

function buildGoalAssessment(result: IntelligenceResult, warnings: string[]) {
  const goalFindings = result.findings.filter((finding) =>
    finding.type === 'goal-progress' || finding.type === 'goal-at-risk');
  if (goalFindings.length === 0) {
    warnings.push('No hay objetivos activos y comparables en el ámbito y divisa actuales, o no hay datos suficientes para proyectarlos.');
  }
  return {
    evaluatedGoalCount: goalFindings.length,
    onTrackCount: goalFindings.filter((finding) => finding.type === 'goal-progress').length,
    atRiskCount: goalFindings.filter((finding) => finding.type === 'goal-at-risk').length,
    projections: goalFindings.map((finding) => ({
      findingId: finding.id,
      title: finding.title,
      type: finding.type,
      projectedProgressPercent: finding.metrics.projectedProgressPercent ?? null,
      targetDate: finding.metrics.targetDate ?? null,
      impactMinor: finding.impactMinor,
      currency: finding.currency,
      confidence: finding.confidence,
    })),
  };
}

function buildWarnings(
  result: IntelligenceResult,
  previousSummary: ReturnType<typeof calculateSummary>,
  period: ReviewPeriod,
  asOfDate: string,
  legacyUnavailable: boolean,
  warnings: string[],
): string[] {
  const allWarnings = [...result.warnings, ...result.currentSummary.warnings, ...previousSummary.warnings, ...warnings];
  if (legacyUnavailable) {
    allWarnings.push('La revisión anterior usa un historial v1 sin identidad estable de hallazgos. Se conserva y puede consultarse, pero se omite la comparación histórica para no clasificar hallazgos como nuevos o ausentes sin evidencia suficiente.');
  }
  if (!period.complete) {
    allWarnings.push('El periodo está incompleto: solo se incluyen movimientos hasta la fecha de corte. Los resultados pueden cambiar al cerrarse el periodo.');
  }
  if (result.currentSummary.unconvertedTransactionCount > 0 || previousSummary.unconvertedTransactionCount > 0) {
    allWarnings.push('Hay movimientos sin conversión válida. Los importes no convertidos no se consolidan y la comparación puede estar incompleta.');
  }
  return [...new Set(allWarnings)];
}

export async function createPeriodicReviewReport(
  parsed: PeriodicReviewRequest,
  dependencies: Dependencies,
) {
  const timeZone = parsed.timeZone ?? 'UTC';
  const asOfDate = civilDateInTimeZone(timeZone);
  const period = buildReviewPeriod(parsed.periodType, parsed.anchorDate, asOfDate, dependencies.assertPeriod);
  const result = await dependencies.generateIntelligenceData(
    period.startDate, period.endDate, dependencies.defaultAnomalyOptions, asOfDate,
  );
  const previousPeriod = previousReviewPeriod(parsed.periodType, period, dependencies.assertPeriod);
  const previousSummary = await buildPreviousSummary(previousPeriod, dependencies);
  const previousState = await readPeriodicReviewState(dependencies.config.actualDataDir);
  const fingerprint = scopeFingerprint(result);
  const previousRun = previousRunForPeriod(previousState, parsed, period, result, fingerprint);
  const previousItems = new Map((previousRun?.items ?? []).map((item) => [item.findingId, item]));
  const items = createReviewItems(result.findings, previousItems, asOfDate);
  const run = await createPeriodicReview(dependencies.config.actualDataDir, {
    periodType: parsed.periodType,
    startDate: period.startDate,
    endDate: period.endDate,
    currency: result.currency,
    accountScope: {
      mode: result.accountScope.mode,
      label: persistedScopeLabel(result),
      fingerprint,
    },
    items,
  });
  const previousRunCandidate = previousComparableRun(
    previousState.reviews, parsed, period, result, fingerprint,
  );
  const reviewComparison = buildReviewComparison(previousRunCandidate, items);
  const warnings: string[] = [...result.warnings];
  const budgetAssessment = buildBudgetAssessment(
    result, period, parsed, asOfDate, dependencies, warnings,
  );
  const goalAssessment = buildGoalAssessment(result, warnings);
  return {
    schemaVersion: 1,
    run,
    period: { periodType: parsed.periodType, ...period },
    timeZone,
    asOfDate,
    calculatedAt: result.calculatedAt,
    currency: result.currency,
    accountScope: result.accountScope,
    summary: result.currentSummary,
    budgetAssessment,
    goalAssessment,
    comparisonToPreviousReview: reviewComparison.comparison,
    comparison: { period: previousPeriod, summary: previousSummary },
    findings: result.findings,
    warnings: buildWarnings(result, previousSummary, period, asOfDate, reviewComparison.legacyUnavailable, warnings),
    capabilities: { aiEnabled: dependencies.config.aiEnabled, deterministicReportAvailable: true },
    notes: [
      'Los importes se calculan con finance-core y las mismas preferencias de divisa y ámbito que los informes.',
      'Los hallazgos son hechos observados, estimaciones o candidatos según la confianza indicada; la prioridad no expresa certeza.',
      'La revisión no modifica movimientos, presupuestos, objetivos ni compromisos. No se ejecutan acciones financieras.',
      'El historial de revisión conserva únicamente fechas, ámbito, divisa, IDs y tipos de hallazgo y estados; no duplica transacciones ni conversaciones.',
    ],
  };
}
