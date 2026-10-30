import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatMoney as sharedFormatMoney } from './finance-format.js';
import { PlanningConversationPanel } from './PlanningConversationPanel.js';

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
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  evidenceCount: number;
  lastEvidenceDate: string | null;
  confidence: string;
  source: 'rule_based' | 'local_ai' | 'none';
  uncertainty: 'low' | 'medium' | 'high' | 'not_assessed';
  rationale: string | null;
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

function money(value: number, currency: string): string { return sharedFormatMoney(value, currency); }
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
  const [pendingChanges, setPendingChanges] = useState<readonly { transactionId: string; categoryId: string; expectedCategoryId: string | null }[]>([]);
  const [chosenCategory, setChosenCategory] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');

  const suggestionPeriod = useMemo(() => monthOffset(0), []);
  const detectionPeriod = useMemo(() => monthOffset(5), []);
  const visibleSuggestions = useMemo(() =>
    suggestions.filter((suggestion) => !discarded.includes(suggestion.transactionId)), [suggestions, discarded]);
  const canPreviewAll = visibleSuggestions.length > 0 && visibleSuggestions.every((suggestion) =>
    Boolean(chosenCategory[suggestion.transactionId] ?? suggestion.suggestedCategoryId));
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

  async function previewApply(transactionIds: readonly string[]): Promise<void> {
    if (transactionIds.length === 0 || busy || pendingChanges.length > 0) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const changes = transactionIds.map((transactionId) => ({
        transactionId,
        categoryId: chosenCategory[transactionId] ?? suggestions.find((suggestion) => suggestion.transactionId === transactionId)?.suggestedCategoryId ?? '',
      }));
      if (changes.some((change) => !change.categoryId)) throw new Error('Una o más sugerencias ya no tienen una categoría válida.');
      const response = await fetch('/api/v1/insights/categorize', {
        method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          startDate: suggestionPeriod.startDate,
          endDate: suggestionPeriod.endDate,
          commit: false,
          transactions: changes,
        }),
      });
      const payload = await jsonResponse<{
        preview: boolean;
        requested?: number;
        changes: number;
        baseline?: readonly { transactionId: string; expectedCategoryId: string | null }[];
      }>(response);
      if (!payload.data?.preview || payload.data.changes !== changes.length) {
        throw new Error('La API no confirmó una previsualización de solo lectura para todos los cambios.');
      }
      const baseline = payload.data.baseline;
      if (!baseline || baseline.length !== changes.length ||
          changes.some((change) => !baseline.some((entry) => entry.transactionId === change.transactionId))) {
        throw new Error('La API no devolvió una categoría de referencia verificable para cada movimiento.');
      }
      setPendingChanges(changes.map((change) => ({
        ...change,
        expectedCategoryId: baseline.find((entry) => entry.transactionId === change.transactionId)!.expectedCategoryId,
      })));
      setNotice('Previsualización: ' + changes.length + ' cambio(s) propuesto(s). No se ha escrito ningún cambio.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo previsualizar la sugerencia.');
    } finally { setBusy(false); }
  }

  async function commitPreview(): Promise<void> {
    if (pendingChanges.length === 0 || busy) return;
    const changes = [...pendingChanges];
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/v1/insights/categorize', {
        method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          startDate: suggestionPeriod.startDate,
          endDate: suggestionPeriod.endDate,
          commit: true,
          transactions: changes,
        }),
      });
      const payload = await response.json() as ApiPayload<{
        preview: boolean;
        requested?: number;
        changes: number;
        applied?: number;
        appliedTransactionIds?: readonly string[];
        pendingTransactionIds?: readonly string[];
        failedTransactionId?: string;
        partial?: boolean;
        persisted?: boolean;
        message?: string;
      }>;
      if (!response.ok || !payload.data) {
        const message = payload.error?.message ?? 'La API no confirmó la categorización.';
        // A stale or uncertain commit invalidates the preview; do not allow a blind retry.
        setPendingChanges([]);
        throw new Error(response.status === 409
          ? message + ' Vuelve a previsualizar antes de confirmar.'
          : message);
      }
      const outcome = payload.data;
      const appliedIds = new Set(outcome.appliedTransactionIds ?? []);
      const applied = outcome.applied ?? outcome.changes;
      const complete = !outcome.partial && applied === changes.length &&
        outcome.persisted !== false && appliedIds.size === changes.length;
      if (!complete) {
        const pendingIds = outcome.pendingTransactionIds ??
          changes.map((change) => change.transactionId).filter((transactionId) => !appliedIds.has(transactionId));
        setDiscarded((previous) => [...previous, ...appliedIds]);
        setPendingChanges([]);
        setNotice(
          'Resultado parcial: ' + applied + ' de ' + changes.length + ' movimientos confirmados. ' +
          (appliedIds.size > 0 ? 'Confirmados: ' + [...appliedIds].join(', ') + '. ' : '') +
          (pendingIds.length > 0
            ? 'Pendientes de nueva previsualización: ' + pendingIds.join(', ') + '. Los confirmados se han retirado de la lista; “Previsualizar todas las sugerencias visibles” actuará solo sobre los pendientes. '
            : '') +
          (outcome.failedTransactionId ? 'Movimiento donde se detuvo el lote: ' + outcome.failedTransactionId + '. ' : '') +
          (outcome.message ?? 'Comprueba los movimientos pendientes en Actual Budget y previsualízalos otra vez antes de reintentar.')
        );
        return;
      }
      setNotice('Se actualizaron ' + applied + ' movimiento(s) en Actual Budget tras la confirmación explícita.');
      setDiscarded((previous) => [...previous, ...appliedIds]);
      setPendingChanges([]);
    } catch (caught) {
      // Keep the selected categories as a draft, but force a new preview after any uncertain write.
      setPendingChanges([]);
      setError(caught instanceof Error ? caught.message : 'No se pudo aplicar la sugerencia. Comprueba el estado en Actual Budget antes de reintentar.');
    } finally { setBusy(false); }
  }
  function cancelPreview(): void {
    setPendingChanges([]);
    setNotice('Previsualización cancelada. No se ha escrito ningún cambio.');
    setError('');
  }

  return (
    <section className="content-section" aria-labelledby="planning-heading">
      <div className="section-heading">
        <div><p className="eyebrow">P3 · ESTIMACIONES Y SUGERENCIAS</p><h2 id="planning-heading">Planificación</h2></div>
        <span className="date-badge">Todo el procesamiento permanece local</span>
      </div>
      {loadError ? <p className="form-alert error" role="alert">{loadError}</p> : null}
      <PlanningConversationPanel currency={currency} />

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
            <p className="section-footnote">La fuente se identifica por movimiento: reglas deterministas, IA local o ausencia de sugerencia. La incertidumbre de IA es cualitativa, no una probabilidad. En los casos sin sugerencia, selecciona una categoría manualmente. Nada se modifica sin previsualización y confirmación explícita.</p>
            {visibleSuggestions.map((suggestion) => (
              <div className="comparison-row" key={suggestion.transactionId}>
                <div><span>{suggestion.payeeLabel} · {suggestion.date}</span><strong>{money(suggestion.amountMinor, currency)}</strong></div>
                <div className="comparison-meta">
                  {suggestion.source === 'rule_based'
                    ? <span>Reglas deterministas: {suggestion.evidenceCount} evidencia(s) en {suggestion.suggestedCategoryName} (última {suggestion.lastEvidenceDate}).</span>
                    : suggestion.source === 'local_ai'
                      ? <span>IA local · incertidumbre cualitativa baja (no es una probabilidad). {suggestion.rationale}</span>
                      : <span>Sin sugerencia automática. {suggestion.rationale ?? 'Elige una categoría manualmente.'}</span>}
                  <label className="field-label compact-label">
                    Categoría
                    <select
                      disabled={busy || pendingChanges.length > 0}
                      value={chosenCategory[suggestion.transactionId] ?? suggestion.suggestedCategoryId ?? ''}
                      onChange={(event) => {
                      const categoryId = event.currentTarget.value;
                      setChosenCategory((previous) => ({ ...previous, [suggestion.transactionId]: categoryId }));
                    }}
                    >
                      <option value="">Selecciona una categoría…</option>
                      {expenseCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                  </label>
                  <div className="button-row">
                    <button className="button primary small" type="button" disabled={busy || pendingChanges.length > 0 || !(chosenCategory[suggestion.transactionId] ?? suggestion.suggestedCategoryId)} onClick={() => { void previewApply([suggestion.transactionId]); }}>Previsualizar</button>
                    <button className="button small" type="button" disabled={busy || pendingChanges.length > 0} onClick={() => discard(suggestion.transactionId)}>Descartar</button>
                  </div>
                </div>
              </div>
            ))}
            <div className="button-row">
              <button className="button primary" type="button" disabled={busy || pendingChanges.length > 0 || !canPreviewAll} onClick={() => { void previewApply(visibleSuggestions.map((suggestion) => suggestion.transactionId)); }}>
                {busy ? 'Preparando…' : 'Previsualizar todas las sugerencias visibles'}
              </button>
            </div>
          </div>
        ) : null}
        {pendingChanges.length > 0 ? (
          <div className="panel confirmation-panel" role="group" aria-label="Confirmación de categorización">
            <h4>Revisar cambios antes de guardar</h4>
            <p>{pendingChanges.length} movimiento(s) se modificarán en Actual Budget. La previsualización no ha escrito nada; confirma para aplicar exactamente las categorías revisadas.</p>
            <div className="button-row">
              <button className="button primary" type="button" disabled={busy} onClick={() => { void commitPreview(); }}>{busy ? 'Guardando…' : 'Confirmar aplicación'}</button>
              <button className="button secondary" type="button" disabled={busy} onClick={cancelPreview}>Cancelar</button>
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
