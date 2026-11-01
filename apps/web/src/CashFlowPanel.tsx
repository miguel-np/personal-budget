import { useState, type FormEvent } from 'react';
import { formatMoney } from './finance-format.js';

interface CashFlowEvent { id: string; date: string; amountMinor: number; source: 'actual_transaction' | 'manual_commitment' | 'scenario'; label: string; }
interface CashFlowDay {
  date: string; actualNetChangeMinor: number; commitmentNetChangeMinor: number; scenarioNetChangeMinor: number;
  totalInflowMinor: number; totalOutflowMinor: number; netChangeMinor: number; projectedBalanceMinor: number | null;
  belowReserve: boolean | null; eventIds: readonly string[];
}
interface CashFlowResult {
  isEstimate: true; asOfDate: string; startDate: string; endDate: string; openingBalanceMinor: number | null;
  endingBalanceMinor: number | null; minimumProjectedBalanceMinor: number | null; minimumBalanceDate: string | null;
  firstDeficitDate: string | null; reserveMinor: number | null; firstReserveBreachDate: string | null;
  totalInflowMinor: number; totalOutflowMinor: number; netChangeMinor: number;
  timeline: readonly CashFlowDay[];
  sourceTotals: Record<string, { inflowMinor: number; outflowMinor: number; netChangeMinor: number; eventCount: number }>;
  assumptions: readonly string[]; warnings: readonly string[];
}
interface CashFlowResponse {
  asOfDate: string; endDate: string; currency: string; openingBalanceMinor: number | null;
  unknownOpeningAccounts: readonly { id: string; name: string }[];
  actualEvents: readonly CashFlowEvent[]; manualEvents: readonly CashFlowEvent[];
  scenarioEvents: readonly CashFlowEvent[];
  duplicateCommitmentIds: readonly string[]; possibleDuplicateCommitments: readonly string[];
  projection: CashFlowResult; notes: readonly string[];
}
interface ApiPayload<T> { data?: T; error?: { message?: string } }
function minorFactor(currency: string): number {
  const digits = new Intl.NumberFormat('es-ES', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  return 10 ** digits;
}
function parseMajor(value: string, currency: string): number | null {
  if (!value.trim()) return null;
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const result = Math.round(Number(normalized) * minorFactor(currency));
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}
function amount(value: number | null, currency: string): string {
  return value === null ? 'Desconocido' : formatMoney(value, currency);
}
export function CashFlowPanel({ currency }: { currency: string }) {
  const [horizonDays, setHorizonDays] = useState<7 | 30 | 90>(30);
  const [reserve, setReserve] = useState('');
  const [scenarioDate, setScenarioDate] = useState('');
  const [scenarioAmount, setScenarioAmount] = useState('');
  const [scenarioDirection, setScenarioDirection] = useState<'expense' | 'income'>('expense');
  const [scenarioLabel, setScenarioLabel] = useState('Pago hipotético');
  const [result, setResult] = useState<CashFlowResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function calculate(event?: FormEvent<HTMLFormElement>, includeScenario = false): Promise<void> {
    event?.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const reserveMinor = reserve.trim() ? parseMajor(reserve, currency) : undefined;
      if (reserve.trim() && reserveMinor === null) throw new Error('Introduce una reserva válida en la divisa de análisis.');
      const scenarioMinor = includeScenario ? parseMajor(scenarioAmount, currency) : null;
      if (includeScenario && (!scenarioDate || scenarioMinor === null || scenarioMinor <= 0 || !scenarioLabel.trim())) {
        throw new Error('Completa fecha, importe y descripción del escenario.');
      }
      const body = {
        horizonDays,
        ...(reserveMinor === undefined ? {} : { reserveMinor }),
        ...(includeScenario ? { scenario: { date: scenarioDate, amountMinor: scenarioMinor, direction: scenarioDirection, label: scenarioLabel.trim() } } : {}),
      };
      const response = await fetch('/api/v1/cash-flow/project', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await response.json() as ApiPayload<CashFlowResponse>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'No se pudo calcular el flujo de caja.');
      setResult(payload.data);
      setNotice(includeScenario ? 'Escenario calculado en memoria. No se ha guardado ni modificado Actual Budget.' : 'Proyección actualizada con los datos locales disponibles.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo calcular el flujo de caja.');
    } finally { setBusy(false); }
  }

  const projection = result?.projection;
  return (
    <article className="panel planning-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">LIQUIDEZ · #73</p><h3>Saldo estimado y flujo de caja</h3></div>
        <span className="date-badge">Proyección determinista</span>
      </div>
      <p className="section-footnote">Combina saldos conocidos, movimientos futuros registrados y compromisos manuales compatibles. No equivale al saldo bancario disponible ni es una garantía.</p>
      <form onSubmit={(event) => { void calculate(event); }}>
        <div className="form-grid">
          <label className="field-label">Horizonte
            <select value={horizonDays} onChange={(event) => setHorizonDays(Number(event.currentTarget.value) as 7 | 30 | 90)}>
              <option value={7}>7 días</option><option value={30}>30 días</option><option value={90}>90 días</option>
            </select>
          </label>
          <label className="field-label">Reserva mínima opcional ({currency})
            <input type="number" min="0" step="0.01" value={reserve} onChange={(event) => setReserve(event.currentTarget.value)} placeholder="Sin reserva" />
          </label>
        </div>
        <button className="button primary" type="submit" disabled={busy}>{busy ? 'Calculando…' : 'Calcular flujo de caja'}</button>
      </form>
      {error ? <p className="form-alert error" role="alert">{error}</p> : null}
      {notice ? <p className="form-alert" role="status">{notice}</p> : null}
      {projection ? (
        <div className="forecast-result">
          <p className="eyebrow">CORTE {result?.asOfDate} · {result?.currency} · {result?.endDate}</p>
          <div className="stats-grid">
            <article className="stat-card"><p>Saldo inicial estimado</p><strong>{amount(projection.openingBalanceMinor, currency)}</strong><span>Saldo actual de Actual convertido al corte</span></article>
            <article className="stat-card"><p>Saldo final proyectado</p><strong>{amount(projection.endingBalanceMinor, currency)}</strong><span>Entradas menos salidas conocidas</span></article>
            <article className={'stat-card ' + (projection.minimumProjectedBalanceMinor !== null && projection.minimumProjectedBalanceMinor < 0 ? 'negative' : '')}><p>Mínimo proyectado</p><strong>{amount(projection.minimumProjectedBalanceMinor, currency)}</strong><span>{projection.minimumBalanceDate ?? 'No calculable'}</span></article>
          </div>
          <div className="stats-grid">
            <article className="panel"><p className="eyebrow">Entradas</p><strong>{amount(projection.totalInflowMinor, currency)}</strong></article>
            <article className="panel"><p className="eyebrow">Salidas</p><strong>{amount(projection.totalOutflowMinor, currency)}</strong></article>
            <article className="panel"><p className="eyebrow">Variación neta</p><strong>{amount(projection.netChangeMinor, currency)}</strong></article>
          </div>
          {projection.firstDeficitDate ? <p className="form-alert error" role="alert">El saldo proyectado sería negativo por primera vez el {projection.firstDeficitDate}.</p> : null}
          {projection.firstReserveBreachDate ? <p className="form-alert warning" role="note">El saldo caería por debajo de la reserva el {projection.firstReserveBreachDate}.</p> : null}
          {projection.warnings.map((warning) => <p key={warning} className="form-alert warning" role="note">{warning}</p>)}
          {result?.possibleDuplicateCommitments.length ? <p className="form-alert warning" role="note">Posibles duplicados conservados en el cálculo: {result.possibleDuplicateCommitments.join(', ')}. Revisa estos elementos antes de interpretar el saldo.</p> : null}
          {result?.duplicateCommitmentIds.length ? <p className="section-footnote">{result.duplicateCommitmentIds.length} compromiso(s) con coincidencia exacta se han contado una sola vez, usando el movimiento real de Actual.</p> : null}
          <div className="trend-table-wrap">
            <table className="trend-table">
              <thead><tr><th>Fecha</th><th>Actual</th><th>Compromisos</th><th>Escenario</th><th>Saldo estimado</th></tr></thead>
              <tbody>{projection.timeline.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td><td>{amount(day.actualNetChangeMinor, currency)}</td>
                  <td>{amount(day.commitmentNetChangeMinor, currency)}</td><td>{amount(day.scenarioNetChangeMinor, currency)}</td>
                  <td>{amount(day.projectedBalanceMinor, currency)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="panel">
            <h4>Probar un pago o ingreso hipotético</h4>
            <p className="section-footnote">El escenario se añade solo a esta simulación; no crea un movimiento ni un compromiso.</p>
            <div className="form-grid">
              <label className="field-label">Fecha<input type="date" value={scenarioDate} onChange={(event) => setScenarioDate(event.currentTarget.value)} min={result?.asOfDate} max={result?.endDate} /></label>
              <label className="field-label">Tipo<select value={scenarioDirection} onChange={(event) => setScenarioDirection(event.currentTarget.value as 'expense' | 'income')}><option value="expense">Gasto</option><option value="income">Ingreso</option></select></label>
              <label className="field-label">Importe ({currency})<input type="number" min="0.01" step="0.01" value={scenarioAmount} onChange={(event) => setScenarioAmount(event.currentTarget.value)} /></label>
              <label className="field-label">Descripción<input value={scenarioLabel} onChange={(event) => setScenarioLabel(event.currentTarget.value)} maxLength={100} /></label>
            </div>
            <button className="button secondary" type="button" disabled={busy} onClick={() => { void calculate(undefined, true); }}>Simular sin guardar</button>
          </div>
          <p className="section-footnote">{projection.assumptions.join(' ')}</p>
          {result?.notes.map((note) => <p key={note} className="section-footnote">{note}</p>)}
        </div>
      ) : null}
    </article>
  );
}
