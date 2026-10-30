import { useState, type FormEvent } from 'react';
import { formatMoney } from './finance-format.js';

interface Projection {
  readonly currency: string;
  readonly targetAmountMinor: number;
  readonly monthlyContributionMinor: number;
  readonly requiredMonthlyContributionMinor: number | null;
  readonly projectedBalanceMinor: number;
  readonly maximumAchievableBalanceMinor: number;
  readonly projectedProgressPercent: number;
  readonly achievableUnderCashFlow: boolean;
  readonly estimatedCompletionDate: string | null;
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
}
interface ReadyResult {
  readonly status: 'ready';
  readonly saved: false;
  readonly goal: {
    readonly id: string | null;
    readonly name: string;
    readonly targetAmountMinor: number;
    readonly initialAmountMinor: number;
    readonly targetDate: string;
    readonly currency: string;
  };
  readonly scenarios: readonly {
    readonly label: string;
    readonly monthlyContributionMinor: number;
    readonly projection: Projection;
  }[];
  readonly sources: {
    readonly historyStartDate: string;
    readonly historyEndDate: string;
    readonly monthsWithData: number;
    readonly transactionCount: number;
    readonly monthlyIncomeSource: string;
    readonly monthlyExpenseSource: string;
    readonly accountScope: { readonly label: string };
    readonly currency: string;
    readonly commitmentsConsidered: number;
    readonly unconfirmedRecurringCandidatesExcluded: number;
  };
  readonly hypotheticalExpense: { readonly amountMinor: number; readonly date: string; readonly currency: string } | null;
  readonly manualCommitments: readonly {
    readonly title: string;
    readonly amountMinor: number;
    readonly date: string;
    readonly direction: 'expense' | 'income';
    readonly frequency: string;
    readonly currency: string;
  }[];
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
}
interface ClarificationResult {
  readonly status: 'clarification_required';
  readonly question: string;
  readonly saved: false;
}
interface ApiPayload {
  readonly data?: ReadyResult | ClarificationResult;
  readonly error?: { readonly code?: string; readonly message?: string };
}

function money(value: number, currency: string): string {
  return formatMoney(value, currency);
}

export function PlanningConversationPanel({ currency }: { currency: string }) {
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<ReadyResult | ClarificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !message.trim()) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/v1/planning/conversation/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? 'No se pudo interpretar la petición de planificación.');
      }
      setResult(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo completar la simulación local.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel planning-panel" aria-labelledby="conversational-planning-heading">
      <div className="panel-heading">
        <div><p className="eyebrow">PLANIFICADOR CONVERSACIONAL · IA LOCAL</p><h3 id="conversational-planning-heading">Planifica tu ahorro en lenguaje natural</h3></div>
        <span className="muted-label">Solo simulaciones</span>
      </div>
      <p className="section-footnote">
        Describe un objetivo, compara aportaciones o comprueba el impacto de un gasto extraordinario. La IA local solo extrae los parámetros; el backend valida el contexto y finance-core calcula las cifras.
        Requiere activar la IA local en la configuración. Los formularios habituales siguen disponibles sin IA.
      </p>
      <form onSubmit={(event) => { void submit(event); }}>
        <label className="field-label" htmlFor="planning-conversation-message">¿Qué quieres planificar?</label>
        <textarea
          id="planning-conversation-message"
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
          maxLength={1_600}
          rows={3}
          placeholder="Ej.: Quiero ahorrar 5.000 € para junio de 2027. ¿Qué aportación mensual necesitaría?"
          required
        />
        <div className="form-actions">
          <button className="button primary" type="submit" disabled={busy || !message.trim()}>
            {busy ? 'Interpretando y simulando…' : 'Simular plan'}
          </button>
          <span className="muted-label">{message.length}/1.600 caracteres</span>
        </div>
      </form>
      {error ? <p className="form-alert error" role="alert">{error}</p> : null}
      {result?.status === 'clarification_required' ? (
        <div className="form-alert warning" role="status">
          <strong>Necesito una aclaración</strong>
          <p>{result.question}</p>
          <p>No se ha ejecutado ni guardado ninguna modificación. Añade la información que falta y vuelve a simular.</p>
        </div>
      ) : null}
      {result?.status === 'ready' ? (
        <div className="forecast-result" aria-live="polite">
          <p className="eyebrow">ESTIMACIÓN · NO ES UNA GARANTÍA · NO GUARDADA</p>
          <h4>{result.goal.name}</h4>
          <p className="section-footnote">
            Objetivo: {money(result.goal.targetAmountMinor, result.goal.currency)} · Fecha: {result.goal.targetDate} · Ahorro inicial: {money(result.goal.initialAmountMinor, result.goal.currency)}
          </p>
          <div className="stats-grid">
            {result.scenarios.map((scenario) => (
              <article className="panel" key={scenario.label}>
                <p className="eyebrow">{scenario.label}</p>
                <strong>{money(scenario.projection.projectedBalanceMinor, result.goal.currency)}</strong>
                <p className="section-footnote">Saldo estimado al vencimiento · Aportación: {money(scenario.monthlyContributionMinor, result.goal.currency)}/mes</p>
                <div className="detail-line"><span>Progreso estimado</span><strong>{scenario.projection.projectedProgressPercent.toFixed(1)}%</strong></div>
                <div className="detail-line"><span>Aportación mensual necesaria</span><strong>{scenario.projection.requiredMonthlyContributionMinor === null ? 'No calculable' : money(scenario.projection.requiredMonthlyContributionMinor, result.goal.currency)}</strong></div>
                <div className="detail-line"><span>Viabilidad con flujo estimado</span><strong>{scenario.projection.achievableUnderCashFlow ? 'Posible bajo estos supuestos' : 'No alcanzable con el flujo estimado'}</strong></div>
                {scenario.projection.estimatedCompletionDate ? <p className="section-footnote">Fecha estimada de alcance: {scenario.projection.estimatedCompletionDate}</p> : null}
                {scenario.projection.warnings.map((warning) => <p key={warning} className="form-alert warning" role="note">{warning}</p>)}
              </article>
            ))}
          </div>
          {result.warnings.map((warning) => <p key={warning} className="form-alert warning" role="note">{warning}</p>)}
          {result.hypotheticalExpense ? (
            <p className="form-alert warning" role="note">
              Gasto hipotético incluido solo en este escenario: {money(result.hypotheticalExpense.amountMinor, result.hypotheticalExpense.currency)} el {result.hypotheticalExpense.date}. No se ha guardado como compromiso.
            </p>
          ) : null}
          <p className="section-footnote">
            Fuente observada: historial local {result.sources.historyStartDate} — {result.sources.historyEndDate}, {result.sources.monthsWithData} meses con datos y {result.sources.transactionCount} movimientos; ámbito: {result.sources.accountScope.label}.
            Compromisos manuales considerados: {result.sources.commitmentsConsidered}. Candidatos recurrentes no confirmados excluidos: {result.sources.unconfirmedRecurringCandidatesExcluded}.
            Ingresos y gastos: {result.sources.monthlyIncomeSource === 'observed_median' ? 'mediana observada' : 'supuesto explícito'} / {result.sources.monthlyExpenseSource === 'observed_median' ? 'mediana observada' : 'supuesto explícito'}.
          </p>
          {result.manualCommitments.length > 0 ? (
            <details>
              <summary>Ver compromisos manuales incorporados</summary>
              <ul>{result.manualCommitments.map((item) => (
                <li key={item.title + ':' + item.date}>
                  {item.title}: {money(item.amountMinor, item.currency)} · {item.direction === 'expense' ? 'gasto' : 'ingreso'} · {item.date} · {item.frequency}
                </li>
              ))}</ul>
            </details>
          ) : null}
          <details>
            <summary>Ver supuestos del cálculo</summary>
            <ul>{result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
          </details>
          <p className="form-alert warning" role="note">
            Esta conversación no crea ni modifica objetivos, compromisos, presupuestos o movimientos de Actual Budget. Para guardar un objetivo, utiliza la acción separada de Objetivos y revisa su resumen antes de confirmar.
          </p>
        </div>
      ) : null}
    </article>
  );
}
