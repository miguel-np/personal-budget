import { useEffect, useState } from 'react';

interface Summary {
  currency: string; startDate: string; endDate: string; incomeMinor: number; expenseMinor: number;
  savingsMinor: number; savingsRatePercent: number | null; transactionCount: number; excludedTransferCount: number;
  expensesByCategory: readonly { categoryName: string; amountMinor: number; transactionCount: number }[];
}
interface Comparison { startDate: string; endDate: string; incomeMinor: number; expenseMinor: number; savingsMinor: number; }
interface AssistantResponse { data?: { summary: Summary; comparison?: Comparison; answer: string }; error?: { code?: string; message?: string }; }
interface AssistantStatus { enabled: boolean; status: string; model?: string; }
function currentMonth(): string {
  const date = new Date();
  return String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0');
}
function periodForMonth(month: string) {
  const parts = month.split('-');
  const year = Number(parts[0]); const monthNumber = Number(parts[1]);
  const endDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { startDate: month + '-01', endDate: month + '-' + String(endDay).padStart(2, '0') };
}
function previousMonth(month: string): string {
  const parts = month.split('-');
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 2, 1));
  return String(date.getUTCFullYear()).padStart(4, '0') + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
}
function money(value: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(value / 100);
}
async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || 'El asistente local no está disponible.');
  return payload;
}
export function AssistantPanel({ currency }: { currency: string }) {
  const [month, setMonth] = useState(currentMonth);
  const [question, setQuestion] = useState('Resume los gastos principales y compara el mes con el anterior.');
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [answer, setAnswer] = useState<AssistantResponse['data'] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/assistant/status', { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(jsonResponse<AssistantStatus>).then(setStatus)
      .catch(() => { if (!controller.signal.aborted) setStatus({ enabled: false, status: 'unavailable' }); });
    return () => controller.abort();
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || question.trim().length === 0) return;
    setBusy(true); setError(''); setAnswer(null);
    const current = periodForMonth(month); const previous = periodForMonth(previousMonth(month));
    try {
      const response = await fetch('/api/v1/assistant/chat', {
        method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ question: question.trim(), startDate: current.startDate, endDate: current.endDate, previousStartDate: previous.startDate, previousEndDate: previous.endDate }),
      });
      const payload = await jsonResponse<AssistantResponse>(response);
      if (!payload.data) throw new Error('La API no devolvió un resultado calculado.');
      setAnswer(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo completar la consulta local.');
    } finally { setBusy(false); }
  }
  const isReady = status?.status === 'available';
  return (
    <section className="content-section" aria-labelledby="assistant-heading">
      <div className="section-heading"><div><p className="eyebrow">IA OPCIONAL · PROCESAMIENTO LOCAL</p><h2 id="assistant-heading">Asistente financiero</h2></div><span className="date-badge">{isReady ? 'Modelo disponible' : status?.status === 'disabled' ? 'Desactivado' : 'No disponible'}</span></div>
      <article className="panel assistant-panel">
        {!isReady ? <><h3>El asistente no está disponible</h3><p>Activa AI_ENABLED, configura OLLAMA_MODEL con un modelo descargado y arranca Ollama en el mismo entorno local. La aplicación financiera funciona sin IA.</p><p className="section-footnote">Estado: {status?.status ?? 'comprobando'}. El endpoint Ollama se limita a loopback.</p></> :
          <form onSubmit={submit}>
            <label className="field-label">Mes a analizar<input type="month" value={month} onChange={(event) => setMonth(event.currentTarget.value)} required /></label>
            <label className="field-label">Pregunta<textarea value={question} onChange={(event) => setQuestion(event.currentTarget.value)} maxLength={2_000} rows={3} required /></label>
            <button className="button primary" type="submit" disabled={busy || question.trim().length === 0}>{busy ? 'Consultando modelo local…' : 'Consultar'}</button>
          </form>}
        {error ? <p className="form-alert error" role="alert">{error}</p> : null}
      </article>
      {answer ? <>
        <div className="stats-grid">
          <article className="panel"><p className="eyebrow">INGRESOS · CALCULADO</p><strong>{money(answer.summary.incomeMinor, answer.summary.currency || currency)}</strong><p className="section-footnote">{answer.summary.startDate} — {answer.summary.endDate}</p></article>
          <article className="panel"><p className="eyebrow">GASTOS · CALCULADO</p><strong>{money(answer.summary.expenseMinor, answer.summary.currency || currency)}</strong><p className="section-footnote">{answer.summary.transactionCount} movimientos; traspasos excluidos: {answer.summary.excludedTransferCount}</p></article>
          <article className="panel"><p className="eyebrow">AHORRO NETO · CALCULADO</p><strong>{money(answer.summary.savingsMinor, answer.summary.currency || currency)}</strong><p className="section-footnote">{answer.summary.savingsRatePercent === null ? 'Tasa no aplicable' : answer.summary.savingsRatePercent.toFixed(1) + ' %'}</p></article>
        </div>
        {answer.comparison ? <article className="panel"><h3>Comparación con el periodo anterior</h3><p>Gasto anterior: {money(answer.comparison.expenseMinor, answer.summary.currency || currency)} · Periodo {answer.comparison.startDate} — {answer.comparison.endDate}</p><p>La comparación usa los mismos cálculos deterministas y la misma divisa.</p></article> : null}
        <article className="panel"><h3>Explicación local</h3><p>{answer.answer}</p><p className="section-footnote">Las cifras proceden de finance-core. La explicación del modelo es cualitativa y se muestra separada de los importes calculados.</p></article>
        <article className="panel"><h3>Gastos por categoría</h3>{answer.summary.expensesByCategory.length ? <div className="comparison-rows">{answer.summary.expensesByCategory.slice(0, 10).map((item) => <div className="comparison-row" key={item.categoryName}><div><span>{item.categoryName}</span><strong>{money(item.amountMinor, answer.summary.currency || currency)}</strong></div><div className="comparison-meta"><span>{item.transactionCount} movimientos</span></div></div>)}</div> : <p>No hay gastos categorizados para el periodo.</p>}</article>
      </> : null}
    </section>
  );
}
