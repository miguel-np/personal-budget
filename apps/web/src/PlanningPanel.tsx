import { useEffect, useMemo, useState, type FormEvent } from 'react';

interface Account { id: string; name: string; closed: boolean; }
interface Category { id: string; name: string; groupId: string; isIncome: boolean; }
interface RecurringCandidate {
  payee: string;
  payeeVariants: readonly string[];
  occurrenceCount: number;
  refundsExcluded: number;
  firstDate: string;
  lastDate: string;
  dates: readonly string[];
  meanAbsoluteAmountMinor: number;
  minAbsoluteAmountMinor: number;
  maxAbsoluteAmountMinor: number;
  amountDeviationPercent: number;
  estimatedIntervalDays: number | null;
  estimatedFrequency: string | null;
  confidence: string;
  signals: readonly string[];
  warnings: readonly string[];
}
interface CategorySuggestion {
  transactionId: string;
  date: string;
  payeeLabel: string;
  amountMinor: number;
  suggestedCategoryId: string;
  suggestedCategoryName: string;
  evidenceCount: number;
  lastEvidenceDate: string;
  confidence: string;
}
interface ForecastMonthlyRow { month: string; incomeMinor: number; expenseMinor: number; savingsMinor: number; }
interface ForecastResult {
  isEstimate: boolean;
  currency: string;
  horizonMonths: number;
  history: { startDate: string; endDate: string; monthsWithData: number; transactionCount: number };
  baselineMonthlyIncomeMinor: number;
  recurringExpenseMonthlyMinor: number;
  extraordinaryExpenseMonthlyMinor: number;
  projectedMonthlyIncomeMinor: number;
  projectedMonthlyExpenseMinor: number;
  projectedMonthlySavingsMinor: number;
  projectedSavingsMinor: number;
  monthlyProjection: readonly ForecastMonthlyRow[];
  assumptions: readonly string[];
  warnings: readonly string[];
}
interface ApiPayload<T> { data?: T; notes?: readonly string[]; error?: { code?: string; message?: string } }

function money(value: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(value / 100);
}
function isoDate(date: Date): string { return date.toISOString().slice(0, 10); }
function monthOffset(months: number): { startDate: string; endDate: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}
async function jsonResponse<T>(response: Response): Promise<ApiPayload<T>> {
  const payload = await response.json() as ApiPayload<T>;
  if (!response.ok) throw new Error(payload.error?.message ?? 'La API local no ha podido completar la consulta.');
  return payload;
}

export function PlanningPanel({ currency }: { currency: string }) {
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [candidates, setCandidates] = useState<readonly RecurringCandidate[]>([]);
  const [suggestions, setSuggestions] = useState<readonly CategorySuggestion[]>([]);
  const [discarded, setDiscarded] = useState<readonly string[]>([]);
  const [chosenCategory, setChosenCategory] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');

  const suggestionPeriod = useMemo(() => monthOffset(0), []);
  const detectionPeriod = useMemo(() => monthOffset(5), []);
  const visibleSuggestions = useMemo(() =>
    suggestions.filter((suggestion) => !discarded.includes(suggestion.transactionId)), [suggestions, discarded]);
  const expenseCategories = useMemo(() => categories.filter((category) => !category.isIncome), [categories]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch('/api/v1/accounts', { signal: controller.signal, headers: { Accept: 'application/json' } }).then((response) => response.json()),
      fetch('/api/v1/categories', { signal: controller.signal, headers: { Accept: 'application/json' } }).then((response) => response.json()),
      fetch('/api/v1/insights/recurring?startDate=' + detectionPeriod.startDate + '&endDate=' + detectionPeriod.endDate, { signal: controller.signal, headers: { Accept: 'application/json' } }).then((response) => response.json()),
      fetch('/api/v1/insights/category-suggestions?startDate=' + suggestionPeriod.startDate + '&endDate=' + suggestionPeriod.endDate, { signal: controller.signal, headers: { Accept: 'application/json' } }).then((response) => response.json()),
    ]).then(([accountsPayload, categoriesPayload, recurringPayload, suggestionsPayload]) => {
      setAccounts(accountsPayload.data ?? []);
      setCategories(categoriesPayload.data ?? []);
      setCandidates(recurringPayload.data ?? []);
      setSuggestions(suggestionsPayload.data ?? []);
      setLoadError(recurringPayload.error || suggestionsPayload.error ? 'No se pudieron cargar las sugerencias locales.' : '');
    }).catch(() => {
      if (!controller.signal.aborted) setLoadError('La API local no ha podido completar la consulta.');
    });
    return () => controller.abort();
  }, [detectionPeriod.endDate, detectionPeriod.startDate, suggestionPeriod.endDate, suggestionPeriod.startDate]);

  function discard(transactionId: string): void {
    setDiscarded((previous) => [...previous, transactionId]);
  }

  async function apply(transactionIds: readonly string[]): Promise<void> {
    if (transactionIds.length === 0 || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const body = {
        startDate: suggestionPeriod.startDate,
        endDate: suggestionPeriod.endDate,
        commit: true,
        transactions: transactionIds.map((transactionId) => ({
          transactionId,
          categoryId: chosenCategory[transactionId] ?? suggestions.find((suggestion) => suggestion.transactionId === transactionId)?.suggestedCategoryId,
        })),
      };
      const response = await fetch('/api/v1/insights/categorize', {
        method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await jsonResponse<{ preview: boolean; changes: number }>(response);
      setNotice('Se actualizaron ' + payload.data?.changes + ' movimiento(s) en Actual Budget tras tu confirmación.');
      setDiscarded((previous) => [...previous, ...transactionIds]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo aplicar la sugerencia.');
    } finally { setBusy(false); }
  }

  return (
    <section className="content-section" aria-labelledby="planning-heading">
      <div className="section-heading">
        <div><p className="eyebrow">P3 · ESTIMACIONES Y SUGERENCIAS</p><h2 id="planning-heading">Planificación</h2></div>
        <span className="date-badge">Todo el procesamiento permanece local</span>
      </div>
      {loadError ? <p className="form-alert error" role="alert">{loadError}</p> : null}

      <article className="panel planning-panel">
        <div className="panel-heading"><div><p className="eyebrow">SUGERENCIAS</p><h3>Pagos recurrentes y categorías para revisar</h3></div></div>
        {candidates.length === 0 && visibleSuggestions.length === 0
          ? <p className="muted-copy">No hay candidatos recurrentes ni movimientos sin categoría con evidencia histórica en el periodo analizado.</p> : null}
        {candidates.length > 0 ? (
          <div className="suggestion-block">
            <h4>Pagos recurrentes detectados ({candidates.length})</h4>
            <p className="section-footnote">Señales deterministas: beneficiario, frecuencia, importe y fechas. Son candidatos, no garantías de que el gasto se repita.</p>
            {candidates.map((candidate) => (
              <div className="comparison-row" key={candidate.payee}>
                <div><span>{candidate.payeeVariants[0] ?? candidate.payee}</span><strong>{money(candidate.meanAbsoluteAmountMinor, currency)}</strong></div>
                <div className="comparison-meta">
                  <span>{candidate.occurrenceCount} cargos · {candidate.estimatedFrequency ?? 'cadencia irregular'} · {candidate.firstDate} — {candidate.lastDate}</span>
                  {candidate.warnings.map((warning) => <span key={warning} className="warning-text">{warning}</span>)}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {visibleSuggestions.length > 0 ? (
          <div className="suggestion-block">
            <h4>Sugerencias de categoría ({visibleSuggestions.length})</h4>
            <p className="section-footnote">Reglas deterministas sobre el historial local. Nada se modifica sin tu confirmación; descartar o aplicar son acciones explícitas.</p>
            {visibleSuggestions.map((suggestion) => (
              <div className="comparison-row" key={suggestion.transactionId}>
                <div><span>{suggestion.payeeLabel} · {suggestion.date}</span><strong>{money(suggestion.amountMinor, currency)}</strong></div>
                <div className="comparison-meta">
                  <span>Evidencia: {suggestion.evidenceCount} movimiento(s) en {suggestion.suggestedCategoryName} (último {suggestion.lastEvidenceDate})</span>
                  <label className="field-label compact-label">
                    Categoría
                    <select
                      value={chosenCategory[suggestion.transactionId] ?? suggestion.suggestedCategoryId}
                      onChange={(event) => setChosenCategory((previous) => ({ ...previous, [suggestion.transactionId]: event.currentTarget.value }))}
                    >
                      {expenseCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                  </label>
                  <div className="button-row">
                    <button className="button primary small" type="button" disabled={busy} onClick={() => { void apply([suggestion.transactionId]); }}>Aplicar</button>
                    <button className="button small" type="button" disabled={busy} onClick={() => discard(suggestion.transactionId)}>Descartar</button>
                  </div>
                </div>
              </div>
            ))}
            <div className="button-row">
              <button className="button primary" type="button" disabled={busy || visibleSuggestions.length === 0} onClick={() => { void apply(visibleSuggestions.map((suggestion) => suggestion.transactionId)); }}>
                {busy ? 'Aplicando…' : 'Aplicar todas las sugerencias visibles'}
              </button>
            </div>
          </div>
        ) : null}
        {error ? <p className="form-alert error" role="alert">{error}</p> : null}
        {notice ? <p className="form-alert success" role="status">{notice}</p> : null}
      </article>

      <ForecastPanel categories={categories} accounts={accounts} />
    </section>
  );
}

function ForecastPanel({ categories, accounts }: { categories: readonly Category[]; accounts: readonly Account[] }) {
  const [scenarioType, setScenarioType] = useState<'income_change' | 'category_reduction'>('category_reduction');
  const [categoryId, setCategoryId] = useState('');
  const [percent, setPercent] = useState(10);
  const [horizonMonths, setHorizonMonths] = useState(6);
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const expenseCategories = categories.filter((category) => !category.isIncome);
  const effectiveCategory = categoryId || expenseCategories[0]?.id || '';

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const period = monthOffset(5);
      const scenario = scenarioType === 'category_reduction'
        ? { type: 'category_reduction' as const, categoryId: effectiveCategory, percent }
        : { type: 'income_change' as const, percent };
      const response = await fetch('/api/v1/forecasts/simulate', {
        method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ startDate: period.startDate, endDate: period.endDate, horizonMonths, scenario }),
      });
      const payload = await jsonResponse<ForecastResult>(response);
      if (!payload.data) throw new Error('La API no devolvió una previsión calculada.');
      setResult(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo calcular la previsión.');
    } finally { setBusy(false); }
  }

  return (
    <article className="panel planning-panel">
      <div className="panel-heading"><div><p className="eyebrow">PREVISIÓN</p><h3>Simulación presupuestaria explicable</h3></div></div>
      <p className="section-footnote">Escenarios hipotéticos calculados por finance-core a partir de tu historial local. No crea ni edita movimientos reales y no es una garantía.</p>
      <form onSubmit={(event) => { void submit(event); }}>
        <div className="form-grid">
          <label className="field-label">
            Tipo de escenario
            <select value={scenarioType} onChange={(event) => setScenarioType(event.currentTarget.value as 'income_change' | 'category_reduction')}>
              <option value="category_reduction">Reducción porcentual por categoría</option>
              <option value="income_change">Cambio de ingreso mensual</option>
            </select>
          </label>
          {scenarioType === 'category_reduction' ? (
            <label className="field-label">
              Categoría
              <select value={effectiveCategory} onChange={(event) => setCategoryId(event.currentTarget.value)}>
                {expenseCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
          ) : null}
          <label className="field-label">
            Porcentaje ({scenarioType === 'category_reduction' ? 'reducción' : 'cambio de ingreso'})
            <input type="number" min={scenarioType === 'category_reduction' ? 0 : -100} max={scenarioType === 'category_reduction' ? 100 : 1000} step="1" value={percent} onChange={(event) => setPercent(Number(event.currentTarget.value))} required />
          </label>
          <label className="field-label">
            Horizonte (meses)
            <input type="number" min={1} max={60} step="1" value={horizonMonths} onChange={(event) => setHorizonMonths(Number(event.currentTarget.value))} required />
          </label>
        </div>
        <button className="button primary" type="submit" disabled={busy || accounts.length === 0}>{busy ? 'Calculando…' : 'Simular escenario'}</button>
      </form>
      {error ? <p className="form-alert error" role="alert">{error}</p> : null}
      {result ? (
        <div className="forecast-result">
          <p className="eyebrow">ESTIMACIÓN · NO ES UNA GARANTÍA</p>
          <div className="stats-grid">
            <article className="panel"><p className="eyebrow">INGRESO MENSUAL ESTIMADO</p><strong>{money(result.projectedMonthlyIncomeMinor, result.currency)}</strong><p className="section-footnote">Base: {money(result.baselineMonthlyIncomeMinor, result.currency)}</p></article>
            <article className="panel"><p className="eyebrow">GASTO MENSUAL ESTIMADO</p><strong>{money(result.projectedMonthlyExpenseMinor, result.currency)}</strong><p className="section-footnote">Recurrente: {money(result.recurringExpenseMonthlyMinor, result.currency)} · Extraordinario/variable: {money(result.extraordinaryExpenseMonthlyMinor, result.currency)}</p></article>
            <article className="panel"><p className="eyebrow">AHORRO PROYECTADO · {result.horizonMonths} MESES</p><strong>{money(result.projectedSavingsMinor, result.currency)}</strong><p className="section-footnote">{money(result.projectedMonthlySavingsMinor, result.currency)} por mes</p></article>
          </div>
          {result.warnings.map((warning) => <p key={warning} className="form-alert warning" role="note">{warning}</p>)}
          <div className="trend-table-wrap">
            <table className="trend-table">
              <thead><tr><th scope="col">Mes</th><th scope="col">Ingresos</th><th scope="col">Gastos</th><th scope="col">Ahorro</th></tr></thead>
              <tbody>{result.monthlyProjection.map((row) => (
                <tr key={row.month}>
                  <td>{row.month}</td>
                  <td className="trend-number income-text">{money(row.incomeMinor, result.currency)}</td>
                  <td className="trend-number expense-text">{money(row.expenseMinor, result.currency)}</td>
                  <td className={'trend-number ' + (row.savingsMinor < 0 ? 'expense-text' : 'income-text')}>{money(row.savingsMinor, result.currency)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="section-footnote">Historial usado: {result.history.startDate} — {result.history.endDate} ({result.history.monthsWithData} meses con datos, {result.history.transactionCount} movimientos). {result.assumptions.join(' ')}</p>
        </div>
      ) : null}
    </article>
  );
}
