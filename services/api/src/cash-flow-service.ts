import { createHash } from 'node:crypto';
import {
  convertAmountMinor,
  detectRecurringCandidates,
  expandCommitmentOccurrences,
  normalizeTransactions,
  projectCashFlow,
} from '@personal-budget/finance-core';
import type {
  BudgetAccount,
  BudgetRepository,
  BudgetTransaction,
  CashFlowEvent,
} from '@personal-budget/finance-core';
import { z } from 'zod';
import { isIsoDate } from '@personal-budget/finance-core';
import type { AppConfig } from './config.js';
import type { CurrencyPreferences } from './currency-preferences.js';
import { resolveAccountScope } from './account-scope.js';
import type { AccountScopePreference } from './account-scope.js';
import { readPlanningData } from './planning-store.js';

const SafeMinorAmountSchema = z.number().int().refine(Number.isSafeInteger, 'Amounts must be safe integers in minor currency units.');
export const CashFlowRequestSchema = z.object({
  horizonDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
  reserveMinor: SafeMinorAmountSchema.nonnegative().optional(),
  scenario: z.object({
    date: z.string().refine(isIsoDate),
    amountMinor: SafeMinorAmountSchema.positive(),
    direction: z.enum(['income', 'expense']),
    label: z.string().trim().min(1).max(100),
  }).strict().optional(),
  recurringCandidateIds: z.array(z.string().regex(/^rc_[a-f0-9]{24}$/)).max(50).default([]),
}).strict();

type CashFlowRequest = z.infer<typeof CashFlowRequestSchema>;
type ConvertedTransactions = {
  readonly transactions: readonly BudgetTransaction[];
  readonly warnings: readonly string[];
};

interface Dependencies {
  readonly config: Pick<AppConfig, 'actualDataDir'>;
  readonly repository: BudgetRepository;
  readonly currencyPreferences: () => Promise<CurrencyPreferences>;
  readonly accountScopePreference: () => Promise<AccountScopePreference>;
  readonly transactionsForAccounts: (
    accounts: readonly BudgetAccount[], startDate: string, endDate: string, preferences: CurrencyPreferences,
  ) => Promise<readonly BudgetTransaction[]>;
  readonly convertTransactionsForAnalysis: (
    transactions: readonly BudgetTransaction[], preferences: CurrencyPreferences,
  ) => ConvertedTransactions;
  readonly planningScopeMatches: (saved: AccountScopePreference, current: AccountScopePreference) => boolean;
  readonly toPlanningCommitment: (item: Awaited<ReturnType<typeof readPlanningData>>['commitments'][number]) => import('@personal-budget/finance-core').PlanningCommitment;
  readonly accountNativeCurrency: (
    account: { readonly id: string; readonly currencyCode?: string | null },
    preferences: CurrencyPreferences,
  ) => string | null;
}

interface FutureLedger {
  readonly entries: ReturnType<typeof normalizeTransactions>;
  readonly actualEvents: CashFlowEvent[];
  readonly actualMatchKeys: Set<string>;
  readonly actualAmountKeys: Set<string>;
}

interface CommitmentEvents {
  readonly manualEvents: CashFlowEvent[];
  readonly confirmedRecurringEvents: CashFlowEvent[];
  readonly duplicateCommitmentIds: string[];
  readonly possibleDuplicateCommitments: string[];
  readonly unconvertedCommitmentTitles: string[];
}

function addCivilDays(date: string, days: number): string {
  const value = new Date(date + 'T00:00:00.000Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function normalizedActionLabel(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es').replace(/[^a-z0-9]+/g, ' ').trim();
}

function futureMatchKey(date: string, amountMinor: number, direction: 'expense' | 'income'): string {
  return [date, amountMinor, direction].join('|');
}

function buildFutureLedger(converted: ConvertedTransactions, asOfDate: string): FutureLedger {
  const entries = normalizeTransactions(converted.transactions);
  const future = entries.filter((entry) => entry.date > asOfDate && entry.amountMinor !== 0);
  const actualEvents: CashFlowEvent[] = future.map((entry) => ({
    id: 'actual:' + entry.id,
    date: entry.date,
    amountMinor: entry.amountMinor,
    source: 'actual_transaction',
    label: entry.payeeLabel ?? 'Movimiento registrado en Actual',
    clearedStatus: entry.cleared === true ? 'cleared' : entry.cleared === false ? 'pending' : 'unknown',
    isTransfer: entry.isTransfer,
  }));
  const actualMatchKeys = new Set(future.map((entry) =>
    futureMatchKey(entry.date, Math.abs(entry.amountMinor), entry.amountMinor < 0 ? 'expense' : 'income') +
      '|' + normalizedActionLabel(entry.payeeLabel ?? '')));
  const actualAmountKeys = new Set(future.map((entry) =>
    futureMatchKey(entry.date, Math.abs(entry.amountMinor), entry.amountMinor < 0 ? 'expense' : 'income')));
  return { entries, actualEvents, actualMatchKeys, actualAmountKeys };
}

async function buildCommitmentEvents(
  planning: Awaited<ReturnType<typeof readPlanningData>>,
  accountPreference: AccountScopePreference,
  preferences: CurrencyPreferences,
  asOfDate: string,
  endDate: string,
  scopeMatches: Dependencies['planningScopeMatches'],
  toPlanningCommitment: Dependencies['toPlanningCommitment'],
  actualMatchKeys: ReadonlySet<string>,
  actualAmountKeys: ReadonlySet<string>,
): Promise<CommitmentEvents> {
  const unconvertedCommitmentTitles: string[] = [];
  const eligible = planning.commitments
    .filter((item) => item.status === 'active' && scopeMatches(item.scope, accountPreference))
    .flatMap((item) => {
      if (item.currency === preferences.displayCurrency) return [item];
      const conversion = convertAmountMinor(
        item.amountMinor, item.currency, preferences.displayCurrency, asOfDate, preferences.exchangeRates,
      );
      if (conversion.amountMinor === null || conversion.amountMinor <= 0) {
        unconvertedCommitmentTitles.push(item.title);
        return [];
      }
      return [{ ...item, amountMinor: conversion.amountMinor, currency: preferences.displayCurrency }];
    });
  const manualOccurrences = expandCommitmentOccurrences(eligible.map(toPlanningCommitment), asOfDate, endDate);
  const manualEvents: CashFlowEvent[] = [];
  const confirmedRecurringEvents: CashFlowEvent[] = [];
  const duplicateCommitmentIds: string[] = [];
  const possibleDuplicateCommitments: string[] = [];
  for (const occurrence of manualOccurrences) {
    if (occurrence.occurrenceDate <= asOfDate) continue;
    const signedAmount = occurrence.direction === 'expense' ? -occurrence.amountMinor : occurrence.amountMinor;
    const key = futureMatchKey(occurrence.occurrenceDate, occurrence.amountMinor, occurrence.direction);
    const label = normalizedActionLabel(occurrence.title);
    if (actualMatchKeys.has(key + '|' + label)) {
      duplicateCommitmentIds.push(occurrence.id + '@' + occurrence.occurrenceDate);
      continue;
    }
    if (actualAmountKeys.has(key)) {
      possibleDuplicateCommitments.push(occurrence.title + ' · ' + occurrence.occurrenceDate);
    }
    const recurring = occurrence.frequency !== 'once';
    const event: CashFlowEvent = {
      id: (recurring ? 'confirmed-recurring:' : 'manual:') + occurrence.id + '@' + occurrence.occurrenceDate,
      date: occurrence.occurrenceDate,
      amountMinor: signedAmount,
      source: recurring ? 'confirmed_recurring' : 'manual_commitment',
      label: occurrence.title,
    };
    (recurring ? confirmedRecurringEvents : manualEvents).push(event);
  }
  return {
    manualEvents, confirmedRecurringEvents, duplicateCommitmentIds,
    possibleDuplicateCommitments, unconvertedCommitmentTitles,
  };
}

function buildCandidateEventsForOne(
  candidate: ReturnType<typeof detectRecurringCandidates>[number],
  candidateId: string,
  asOfDate: string,
  endDate: string,
  actualMatchKeys: ReadonlySet<string>,
  knownCommitmentEvents: readonly CashFlowEvent[],
  target: (event: CashFlowEvent & { readonly candidateId: string }) => void,
): string | null {
  if (candidate.estimatedIntervalDays === null || candidate.estimatedIntervalDays <= 0) return null;
  let nextDate = addCivilDays(candidate.lastDate, candidate.estimatedIntervalDays);
  while (nextDate <= asOfDate) nextDate = addCivilDays(nextDate, candidate.estimatedIntervalDays);
  const firstDate = nextDate;
  let occurrenceIndex = 0;
  while (nextDate <= endDate && occurrenceIndex < 12) {
    const amountMinor = candidate.meanAbsoluteAmountMinor;
    const amountKey = futureMatchKey(nextDate, amountMinor, 'expense');
    const exactActualMatch = actualMatchKeys.has(amountKey + '|' + normalizedActionLabel(candidate.payee));
    const exactCommitmentMatch = knownCommitmentEvents.some((event) =>
      event.date === nextDate && event.amountMinor === -amountMinor &&
      normalizedActionLabel(event.label) === normalizedActionLabel(candidate.payee));
    if (!exactActualMatch && !exactCommitmentMatch) {
      target({
        id: 'recurring-candidate:' + candidateId + ':' + nextDate,
        candidateId,
        date: nextDate,
        amountMinor: -amountMinor,
        source: 'recurring_candidate',
        label: candidate.payee,
      });
    }
    occurrenceIndex += 1;
    nextDate = addCivilDays(nextDate, candidate.estimatedIntervalDays);
  }
  return firstDate;
}

function buildRecurringCandidateEvents(
  transactions: readonly BudgetTransaction[],
  asOfDate: string,
  endDate: string,
  actualMatchKeys: ReadonlySet<string>,
  manualEvents: readonly CashFlowEvent[],
  confirmedRecurringEvents: readonly CashFlowEvent[],
): {
  readonly candidates: Array<{ readonly id: string; readonly [key: string]: unknown }>;
  readonly events: Array<CashFlowEvent & { candidateId: string }>;
} {
  const detected = detectRecurringCandidates(transactions, {
    startDate: addCivilDays(asOfDate, -800),
    endDate: asOfDate,
    minOccurrences: 3,
    intervalWindowDays: [20, 400],
  });
  const events: Array<CashFlowEvent & { candidateId: string }> = [];
  const knownCommitments = [...manualEvents, ...confirmedRecurringEvents];
  const candidates = detected.map((candidate) => {
    const normalizedPayee = normalizedActionLabel(candidate.payee);
    const candidateId = 'rc_' + createHashLike(normalizedPayee + '|' + candidate.firstDate);
    const nextDate = buildCandidateEventsForOne(
      candidate, candidateId, asOfDate, endDate, actualMatchKeys, knownCommitments,
      (event) => events.push(event),
    );
    return {
      id: candidateId, payee: candidate.payee, occurrenceCount: candidate.occurrenceCount,
      estimatedIntervalDays: candidate.estimatedIntervalDays, estimatedFrequency: candidate.estimatedFrequency,
      meanAbsoluteAmountMinor: candidate.meanAbsoluteAmountMinor, amountDeviationPercent: candidate.amountDeviationPercent,
      nextDate,
      upcomingEventsCount: events.filter((event) => event.candidateId === candidateId).length,
      signals: candidate.signals, warnings: candidate.warnings,
    };
  });
  return { candidates, events };
}

function createHashLike(value: string): string {
  // Match the deterministic identifier used by the API for recurring candidate references.
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function buildScenarioEvents(parsed: CashFlowRequest): CashFlowEvent[] {
  if (!parsed.scenario) return [];
  return [{
    id: 'scenario:unsaved',
    date: parsed.scenario.date,
    amountMinor: parsed.scenario.direction === 'expense' ? -parsed.scenario.amountMinor : parsed.scenario.amountMinor,
    source: 'scenario',
    label: parsed.scenario.label,
  }];
}

function validateCandidateSelection(
  requestedIds: ReadonlySet<string>,
  candidates: readonly { readonly id: string }[],
): boolean {
  const known = new Set(candidates.map((candidate) => candidate.id));
  return [...requestedIds].every((id) => known.has(id));
}

export async function createCashFlowProjection(
  requestBody: unknown,
  dependencies: Dependencies,
) {
  const parsed = CashFlowRequestSchema.parse(requestBody);
  const asOfDate = new Date().toISOString().slice(0, 10);
  const endDate = addCivilDays(asOfDate, parsed.horizonDays);
  const [accounts, preferences, accountPreference, planning] = await Promise.all([
    dependencies.repository.listAccounts(),
    dependencies.currencyPreferences(),
    dependencies.accountScopePreference(),
    readPlanningData(dependencies.config.actualDataDir),
  ]);
  const scope = resolveAccountScope(accounts, accountPreference);
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const scopedAccounts = scope.accounts.map((account) => accountsById.get(account.id))
    .filter((account): account is BudgetAccount => account !== undefined);
  const opening = calculateOpeningBalance(scope.accounts, accounts, preferences, asOfDate, dependencies.accountNativeCurrency);
  const rawFuture = await dependencies.transactionsForAccounts(scopedAccounts, asOfDate, endDate, preferences);
  const convertedFuture = dependencies.convertTransactionsForAnalysis(rawFuture, preferences);
  const ledger = buildFutureLedger(convertedFuture, asOfDate);
  const commitments = await buildCommitmentEvents(
    planning, accountPreference, preferences, asOfDate, endDate,
    dependencies.planningScopeMatches, dependencies.toPlanningCommitment,
    ledger.actualMatchKeys, ledger.actualAmountKeys,
  );
  const historyStart = addCivilDays(asOfDate, -800);
  const rawHistory = await dependencies.transactionsForAccounts(scopedAccounts, historyStart, asOfDate, preferences);
  const convertedHistory = dependencies.convertTransactionsForAnalysis(rawHistory, preferences);
  const recurring = buildRecurringCandidateEvents(
    convertedHistory.transactions, asOfDate, endDate, ledger.actualMatchKeys,
    commitments.manualEvents, commitments.confirmedRecurringEvents,
  );
  const requestedIds = new Set(parsed.recurringCandidateIds);
  if (!validateCandidateSelection(requestedIds, recurring.candidates)) {
    return {
      statusCode: 400,
      body: { error: {
        code: 'UNKNOWN_RECURRING_CANDIDATE',
        message: 'One or more selected recurring candidates are stale. Refresh the cash-flow projection before selecting them.',
      } },
    };
  }
  const selectedEvents = recurring.events
    .filter((event) => requestedIds.has(event.candidateId))
    .map((event) => ({
      id: event.id, date: event.date, amountMinor: event.amountMinor,
      source: event.source, label: event.label,
    }));
  const scenarioEvents = buildScenarioEvents(parsed);
  const projection = projectCashFlow({
    asOfDate, startDate: asOfDate, endDate,
    openingBalanceMinor: opening.known ? opening.balanceMinor : null,
    reserveMinor: parsed.reserveMinor ?? null,
    events: [
      ...ledger.actualEvents, ...commitments.manualEvents, ...commitments.confirmedRecurringEvents,
      ...selectedEvents, ...scenarioEvents,
    ],
  });
  const warnings = buildCashFlowWarnings(
    projection.warnings, convertedFuture.warnings, opening.unknownAccounts,
    scope.accounts.length, commitments, convertedHistory.warnings,
  );
  return { data: {
    asOfDate, endDate, currency: preferences.displayCurrency, accountScope: scope.metadata,
    openingBalanceMinor: projection.openingBalanceMinor,
    unknownOpeningAccounts: opening.unknownAccounts,
    actualEvents: ledger.actualEvents,
    manualEvents: commitments.manualEvents,
    confirmedRecurringEvents: commitments.confirmedRecurringEvents,
    recurringCandidates: recurring.candidates,
    recurringCandidateEvents: recurring.events,
    scenarioEvents,
    duplicateCommitmentIds: commitments.duplicateCommitmentIds,
    possibleDuplicateCommitments: commitments.possibleDuplicateCommitments,
    projection: { ...projection, warnings },
    notes: [
      'Saldo estimado a partir del campo balance_current de Actual; no equivale a saldo bancario disponible, saldo liquidado ni efectivo garantizado.',
      'Las transferencias se incluyen con su signo para proyectar el ámbito seleccionado; las dos patas se compensan si ambas cuentas están dentro del ámbito.',
      'Los candidatos recurrentes se detectan sobre hasta 800 días de historial convertido; solo se proyectan como hipótesis cuando se seleccionan expresamente.',
      'Los compromisos en otra divisa se convierten con la tasa local conocida a la fecha de corte; cuando falta tasa, se excluyen y se advierten, sin tratarlos como cero.',
      ...(parsed.recurringCandidateIds.length > 0 ? ['Se han incorporado como hipótesis los candidatos recurrentes seleccionados; no son obligaciones confirmadas.'] : []),
    ],
  } };
}

function calculateOpeningBalance(
  scopedAccounts: readonly BudgetAccount[],
  allAccounts: readonly BudgetAccount[],
  preferences: CurrencyPreferences,
  asOfDate: string,
  accountNativeCurrency: Dependencies['accountNativeCurrency'],
) {
  const accountById = new Map(allAccounts.map((account) => [account.id, account]));
  const unknownAccounts: { id: string; name: string }[] = [];
  let balanceMinor = 0;
  let known = scopedAccounts.length > 0;
  for (const scoped of scopedAccounts) {
    const account = accountById.get(scoped.id);
    const currency = account ? accountNativeCurrency(account, preferences) : null;
    if (!account || account.currentBalanceMinor === null || currency === null) {
      known = false;
      unknownAccounts.push({ id: scoped.id, name: scoped.name });
      continue;
    }
    const converted = convertAmountMinor(
      account.currentBalanceMinor, currency, preferences.displayCurrency, asOfDate, preferences.exchangeRates,
    );
    if (converted.amountMinor === null) {
      known = false;
      unknownAccounts.push({ id: scoped.id, name: scoped.name });
      continue;
    }
    balanceMinor += converted.amountMinor;
    if (!Number.isSafeInteger(balanceMinor)) throw new RangeError('The consolidated opening balance exceeds the supported integer range.');
  }
  return { known, balanceMinor, unknownAccounts };
}

function buildCashFlowWarnings(
  projectionWarnings: readonly string[],
  futureWarnings: readonly string[],
  unknownAccounts: readonly { readonly name: string }[],
  accountCount: number,
  commitments: CommitmentEvents,
  historyWarnings: readonly string[],
): string[] {
  return [
    ...projectionWarnings,
    ...futureWarnings,
    ...(unknownAccounts.length > 0 ? ['Saldo no disponible o sin conversión para: ' + unknownAccounts.map((account) => account.name).join(', ') + '.'] : []),
    ...(accountCount === 0 ? ['El ámbito no contiene cuentas; selecciona cuentas antes de estimar saldo.'] : []),
    ...(commitments.duplicateCommitmentIds.length > 0 ? [commitments.duplicateCommitmentIds.length + ' compromiso(s) manual(es) se han omitido porque coinciden exactamente con un movimiento futuro de Actual.'] : []),
    ...(commitments.possibleDuplicateCommitments.length > 0 ? ['Posibles duplicados no confirmados; se han conservado ambos elementos: ' + commitments.possibleDuplicateCommitments.join(', ') + '. Revisa la agenda antes de interpretar el saldo.'] : []),
    ...(commitments.unconvertedCommitmentTitles.length > 0 ? [commitments.unconvertedCommitmentTitles.length + ' compromiso(s) activos no se han convertido a la divisa de análisis por falta de tasa local fechada: ' + commitments.unconvertedCommitmentTitles.join(', ') + '.'] : []),
    ...historyWarnings,
  ];
}
