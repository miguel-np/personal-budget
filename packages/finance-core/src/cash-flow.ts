import { isIsoDate, validatePeriod } from './date-range.js';

export type CashFlowSource = 'actual_transaction' | 'manual_commitment' | 'confirmed_recurring' | 'recurring_candidate' | 'scenario';
export interface CashFlowEvent {
  readonly id: string;
  readonly date: string;
  /** Signed minor units: inflow positive, outflow negative. */
  readonly amountMinor: number;
  readonly source: CashFlowSource;
  readonly label: string;
  /** Only meaningful for Actual transactions; unknown when the source omits cleared. */
  readonly clearedStatus?: 'cleared' | 'pending' | 'unknown';
}
export interface CashFlowProjectionInput {
  readonly asOfDate: string;
  readonly startDate: string;
  readonly endDate: string;
  /** null means at least one selected account has an unknown/unconvertible balance. */
  readonly openingBalanceMinor: number | null;
  readonly reserveMinor?: number | null;
  readonly events: readonly CashFlowEvent[];
}
export interface CashFlowTimelineDay {
  readonly date: string;
  readonly actualNetChangeMinor: number;
  readonly actualClearedCount: number;
  readonly actualPendingCount: number;
  readonly actualUnknownCount: number;
  readonly commitmentNetChangeMinor: number;
  readonly confirmedRecurringNetChangeMinor: number;
  readonly recurringCandidateNetChangeMinor: number;
  readonly scenarioNetChangeMinor: number;
  readonly totalInflowMinor: number;
  readonly totalOutflowMinor: number;
  readonly netChangeMinor: number;
  readonly projectedBalanceMinor: number | null;
  readonly belowReserve: boolean | null;
  readonly eventIds: readonly string[];
}
export interface CashFlowSourceTotal {
  readonly inflowMinor: number;
  readonly outflowMinor: number;
  readonly netChangeMinor: number;
  readonly eventCount: number;
}
export interface CashFlowProjection {
  readonly isEstimate: true;
  readonly asOfDate: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly openingBalanceMinor: number | null;
  readonly endingBalanceMinor: number | null;
  readonly minimumProjectedBalanceMinor: number | null;
  readonly minimumBalanceDate: string | null;
  readonly firstDeficitDate: string | null;
  readonly reserveMinor: number | null;
  readonly firstReserveBreachDate: string | null;
  readonly totalInflowMinor: number;
  readonly totalOutflowMinor: number;
  readonly netChangeMinor: number;
  readonly timeline: readonly CashFlowTimelineDay[];
  readonly sourceTotals: Readonly<Record<CashFlowSource, CashFlowSourceTotal>>;
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
}
function assertMinor(value: number, label: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) throw new RangeError(label + ' must be a safe integer in minor currency units.');
}
function addSafe(left: number, right: number, label: string): number {
  const result = left + right;
  assertMinor(result, label, true);
  return result;
}
function shiftDate(date: string, days: number): string {
  const value = new Date(date + 'T00:00:00.000Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Daily deterministic projection. Unknown opening balances remain unknown. */
export function projectCashFlow(input: CashFlowProjectionInput): CashFlowProjection {
  if (!isIsoDate(input.asOfDate)) throw new RangeError('asOfDate must be a valid ISO calendar date.');
  validatePeriod({ startDate: input.startDate, endDate: input.endDate });
  if (input.startDate < input.asOfDate) throw new RangeError('startDate cannot precede asOfDate.');
  const dayCount = Math.round((Date.parse(input.endDate + 'T00:00:00.000Z') - Date.parse(input.startDate + 'T00:00:00.000Z')) / 86_400_000) + 1;
  if (dayCount < 1 || dayCount > 366) throw new RangeError('Cash-flow horizon must contain between 1 and 366 days.');
  if (input.openingBalanceMinor !== null) assertMinor(input.openingBalanceMinor, 'opening balance', true);
  const reserveMinor = input.reserveMinor ?? null;
  if (reserveMinor !== null) assertMinor(reserveMinor, 'reserve');
  const seen = new Set<string>();
  const byDate = new Map<string, CashFlowEvent[]>();
  const sourceTotals: Record<CashFlowSource, { inflowMinor: number; outflowMinor: number; netChangeMinor: number; eventCount: number }> = {
    actual_transaction: { inflowMinor: 0, outflowMinor: 0, netChangeMinor: 0, eventCount: 0 },
    manual_commitment: { inflowMinor: 0, outflowMinor: 0, netChangeMinor: 0, eventCount: 0 },
    confirmed_recurring: { inflowMinor: 0, outflowMinor: 0, netChangeMinor: 0, eventCount: 0 },
    recurring_candidate: { inflowMinor: 0, outflowMinor: 0, netChangeMinor: 0, eventCount: 0 },
    scenario: { inflowMinor: 0, outflowMinor: 0, netChangeMinor: 0, eventCount: 0 },
  };
  for (const event of input.events) {
    if (!event.id.trim() || seen.has(event.id)) throw new RangeError('Cash-flow event IDs must be non-empty and unique.');
    seen.add(event.id);
    if (!isIsoDate(event.date) || event.date < input.startDate || event.date > input.endDate) throw new RangeError('Cash-flow event date must be within the selected horizon.');
    if (!Number.isSafeInteger(event.amountMinor) || event.amountMinor === 0) throw new RangeError('Cash-flow event amount must be a non-zero safe integer in minor units.');
    if (!['actual_transaction', 'manual_commitment', 'confirmed_recurring', 'recurring_candidate', 'scenario'].includes(event.source)) throw new RangeError('Cash-flow event source is invalid.');
    const list = byDate.get(event.date) ?? [];
    list.push(event);
    byDate.set(event.date, list);
    const totals = sourceTotals[event.source];
    if (event.amountMinor > 0) totals.inflowMinor = addSafe(totals.inflowMinor, event.amountMinor, 'source inflows');
    else totals.outflowMinor = addSafe(totals.outflowMinor, -event.amountMinor, 'source outflows');
    totals.netChangeMinor = addSafe(totals.netChangeMinor, event.amountMinor, 'source net change');
    totals.eventCount += 1;
  }
  let runningBalance = input.openingBalanceMinor;
  let cumulativeNet = 0;
  let totalInflowMinor = 0;
  let totalOutflowMinor = 0;
  let minimumProjectedBalanceMinor: number | null = null;
  let minimumBalanceDate: string | null = null;
  let firstDeficitDate: string | null = null;
  let firstReserveBreachDate: string | null = null;
  const timeline: CashFlowTimelineDay[] = [];
  for (let index = 0; index < dayCount; index += 1) {
    const date = shiftDate(input.startDate, index);
    const events = (byDate.get(date) ?? []).sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
    let actualNetChangeMinor = 0;
    let actualClearedCount = 0;
    let actualPendingCount = 0;
    let actualUnknownCount = 0;
    let commitmentNetChangeMinor = 0;
    let confirmedRecurringNetChangeMinor = 0;
    let recurringCandidateNetChangeMinor = 0;
    let scenarioNetChangeMinor = 0;
    let dayInflow = 0;
    let dayOutflow = 0;
    for (const event of events) {
      if (event.amountMinor > 0) dayInflow = addSafe(dayInflow, event.amountMinor, 'daily inflows');
      else dayOutflow = addSafe(dayOutflow, -event.amountMinor, 'daily outflows');
      if (event.source === 'actual_transaction') {
        actualNetChangeMinor = addSafe(actualNetChangeMinor, event.amountMinor, 'actual daily net');
        if (event.clearedStatus === 'cleared') actualClearedCount += 1;
        else if (event.clearedStatus === 'pending') actualPendingCount += 1;
        else actualUnknownCount += 1;
      }
      else if (event.source === 'manual_commitment') commitmentNetChangeMinor = addSafe(commitmentNetChangeMinor, event.amountMinor, 'commitment daily net');
      else if (event.source === 'confirmed_recurring') confirmedRecurringNetChangeMinor = addSafe(confirmedRecurringNetChangeMinor, event.amountMinor, 'confirmed recurring daily net');
      else if (event.source === 'recurring_candidate') recurringCandidateNetChangeMinor = addSafe(recurringCandidateNetChangeMinor, event.amountMinor, 'recurring candidate daily net');
      else scenarioNetChangeMinor = addSafe(scenarioNetChangeMinor, event.amountMinor, 'scenario daily net');
    }
    const netChangeMinor = addSafe(
      addSafe(addSafe(addSafe(actualNetChangeMinor, commitmentNetChangeMinor, 'daily net'), confirmedRecurringNetChangeMinor, 'daily net'), recurringCandidateNetChangeMinor, 'daily net'),
      scenarioNetChangeMinor,
      'daily net',
    );
    cumulativeNet = addSafe(cumulativeNet, netChangeMinor, 'cumulative cash flow');
    totalInflowMinor = addSafe(totalInflowMinor, dayInflow, 'total inflows');
    totalOutflowMinor = addSafe(totalOutflowMinor, dayOutflow, 'total outflows');
    if (runningBalance !== null) {
      runningBalance = addSafe(runningBalance, netChangeMinor, 'projected balance');
      if (minimumProjectedBalanceMinor === null || runningBalance < minimumProjectedBalanceMinor) { minimumProjectedBalanceMinor = runningBalance; minimumBalanceDate = date; }
      if (firstDeficitDate === null && runningBalance < 0) firstDeficitDate = date;
      if (reserveMinor !== null && firstReserveBreachDate === null && runningBalance < reserveMinor) firstReserveBreachDate = date;
    }
    timeline.push({
      date, actualNetChangeMinor, actualClearedCount, actualPendingCount, actualUnknownCount, commitmentNetChangeMinor,
      confirmedRecurringNetChangeMinor, recurringCandidateNetChangeMinor, scenarioNetChangeMinor,
      totalInflowMinor: dayInflow, totalOutflowMinor: dayOutflow, netChangeMinor,
      projectedBalanceMinor: runningBalance,
      belowReserve: runningBalance === null || reserveMinor === null ? null : runningBalance < reserveMinor,
      eventIds: events.map((event) => event.id),
    });
  }
  const warnings: string[] = [];
  if (input.openingBalanceMinor === null) warnings.push('El saldo inicial consolidado es desconocido porque al menos una cuenta del ámbito no proporciona un saldo o una conversión válida; no se calculan déficits ni saldo proyectado.');
  if (input.events.some((event) => event.source === 'scenario')) warnings.push('El escenario es hipotético y no se ha guardado ni aplicado a Actual Budget.');
  if (input.events.some((event) => event.source === 'recurring_candidate')) warnings.push('Se han incluido candidatos recurrentes como hipótesis seleccionadas por el usuario; no son obligaciones confirmadas.');
  return {
    isEstimate: true, asOfDate: input.asOfDate, startDate: input.startDate, endDate: input.endDate,
    openingBalanceMinor: input.openingBalanceMinor, endingBalanceMinor: runningBalance,
    minimumProjectedBalanceMinor, minimumBalanceDate, firstDeficitDate, reserveMinor, firstReserveBreachDate,
    totalInflowMinor, totalOutflowMinor, netChangeMinor: cumulativeNet, timeline,
    sourceTotals: sourceTotals as Readonly<Record<CashFlowSource, CashFlowSourceTotal>>,
    assumptions: [
      'El saldo inicial utiliza el saldo actual comunicado por Actual para todas las cuentas del ámbito y su conversión local fechada.',
      'Los movimientos futuros registrados en Actual se proyectan con su signo original; las transferencias entre cuentas del ámbito se compensan entre sí.',
      'Los compromisos puntuales activos y las recurrencias confirmadas se proyectan en fuentes separadas de los movimientos reales.',
      'Los candidatos recurrentes no confirmados se muestran por separado y solo se incorporan cuando el usuario los selecciona expresamente como hipótesis.',
      'No se presuponen movimientos, intereses, ingresos ni tipos de cambio futuros.',
    ],
    warnings,
  };
}
