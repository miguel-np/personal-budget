import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatCivilDate, formatMoney } from './finance-format.js';

type FindingType =
  | 'expense-change' | 'income-change' | 'budget-overspend' | 'pending-categorization'
  | 'commitment-upcoming' | 'recurring-candidate-upcoming' | 'goal-at-risk' | 'goal-progress' | 'financial-anomaly';
type ReviewItemStatus = 'pending' | 'reviewed' | 'postponed';
type ReviewStatus = 'new' | 'reviewed' | 'expected' | 'dismissed' | 'snoozed';
type NavigationTarget = '/reports' | '/movements' | '/budgets' | '/planning' | '/goals';

interface ReviewItem {
  findingId: string;
  findingType: FindingType;
  fingerprint: string;
  status: ReviewItemStatus;
  postponedUntil?: string;
}
interface ReviewRun {
  id: string;
  periodType: 'weekly' | 'monthly';
  startDate: string;
  endDate: string;
  generatedAt: string;
  currency: string;
  accountScope: { mode: 'all' | 'selected'; label: string; fingerprint: string };
  status: 'in_progress' | 'completed';
  completedAt?: string;
  items: readonly ReviewItem[];
}
interface FinancialSummary {
  currency: string;
  startDate: string;
  endDate: string;
  incomeMinor: number;
  expenseMinor: number;
  savingsMinor: number;
  savingsRatePercent: number | null;
  uncategorizedOutflowMinor: number;
  unclassifiedInflowMinor: number;
  excludedTransferCount: number;
  transactionCount: number;
  unconvertedTransactionCount: number;
  warnings: readonly string[];
}
interface Finding {
  id: string;
  fingerprint: string;
  type: FindingType;
  title: string;
  explanation: string;
  period: { startDate: string; endDate: string };
  currency: string;
  confidence: 'observed' | 'estimated' | 'candidate' | 'suggestion';
  priority: 'low' | 'medium' | 'high';
  priorityReason: string;
  impactMinor: number | null;
  metrics: Readonly<Record<string, number | string | boolean | null>>;
  evidence: readonly { label: string; value: string | number; source: string; rule: string }[];
  limitations: readonly string[];
  reviewStatus: ReviewStatus;
  snoozedUntil?: string;
  navigationTarget: NavigationTarget;
}
interface ReviewPayload {
  schemaVersion: 1;
  run: ReviewRun;
  period: {
    periodType: 'weekly' | 'monthly';
    startDate: string;
    endDate: string;
    scheduledEndDate: string;
    complete: boolean;
  };
  asOfDate: string;
  timeZone: string;
  calculatedAt: string;
  currency: string;
  accountScope: { label: string };
  summary: FinancialSummary;
  budgetAssessment: {
    available: boolean;
    reason: string | null;
    overBudgetCategoryCount: number;
    scope: string;
  };
  goalAssessment: {
    evaluatedGoalCount: number;
    onTrackCount: number;
    atRiskCount: number;
    projections: readonly {
      findingId: string;
      title: string;
      type: 'goal-progress' | 'goal-at-risk';
      projectedProgressPercent: number | null;
      targetDate: string | null;
      impactMinor: number | null;
      currency: string;
      confidence: string;
    }[];
  };
  comparison: { period: { startDate: string; endDate: string }; summary: FinancialSummary };
  findings: readonly Finding[];
  warnings: readonly string[];
  capabilities: { aiEnabled: boolean; deterministicReportAvailable: boolean };
  notes: readonly string[];
}
interface ApiPayload<T> { data?: T; error?: { code?: string; message?: string }; }
interface ReviewHistory { version: 1; reviews: readonly ReviewRun[]; }

const TYPE_LABELS: Record<FindingType, string> = {
  'expense-change': 'Variación del gasto',
  'income-change': 'Variación de ingresos',
  'budget-overspend': 'Desviación presupuestaria',
  'pending-categorization': 'Movimiento sin clasificar',
  'commitment-upcoming': 'Compromiso próximo',
  'recurring-candidate-upcoming': 'Posible pago recurrente',
  'goal-at-risk': 'Objetivo en riesgo',
  'goal-progress': 'Progreso de objetivo',
  'financial-anomaly': 'Anomalía financiera',
};
const CONFIDENCE_LABELS = {
  observed: 'Dato observado',
  estimated: 'Estimación',
  candidate: 'Candidato',
  suggestion: 'Sugerencia',
} as const;
const PRIORITY_LABELS = { high: 'Alta', medium: 'Media', low: 'Baja' } as const;

function todayLocal(): string {
  const now = new Date();
  return [String(now.getFullYear()).padStart(4, '0'), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}
function addDays(date: string, days: number): string {
  const value = new Date(date + 'T00:00:00.000Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function dateRange(startDate: string, endDate: string): string {
  return startDate === endDate
    ? formatCivilDate(startDate)
    : formatCivilDate(startDate) + ' – ' + formatCivilDate(endDate);
}
function deltaText(current: number, previous: number, currency: string): string {
  const delta = current - previous;
  const relative = previous === 0
    ? 'variación porcentual no disponible (base anterior cero)'
    : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(delta / Math.abs(previous) * 100) + ' %';
  return (delta > 0 ? '+' : '') + formatMoney(delta, currency) + ' · ' + relative;
}
function findingAmount(finding: Finding): string {
  return finding.impactMinor === null ? 'Impacto no cuantificado' : formatMoney(finding.impactMinor, finding.currency);
}

export function PeriodicReviewPanel({ onNavigate }: { onNavigate: (target: NavigationTarget) => void }) {
  const [periodType, setPeriodType] = useState<'weekly' | 'monthly'>('monthly');
  const [anchorDate, setAnchorDate] = useState(todayLocal);
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [history, setHistory] = useState<ReviewHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadHistory(signal?: AbortSignal): Promise<void> {
    setHistoryLoading(true);
    try {
      const response = await fetch('/api/v1/reviews/periodic', { ...(signal ? { signal } : {}), headers: { Accept: 'application/json' } });
      const result = await response.json() as ApiPayload<ReviewHistory>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'No se pudo recuperar el historial de revisiones.');
      if (!signal?.aborted) setHistory(result.data);
    } catch (cause) {
      if (!signal?.aborted) setActionError(cause instanceof Error ? cause.message : 'No se pudo recuperar el historial de revisiones.');
    } finally {
      if (!signal?.aborted) setHistoryLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, []);

  async function startReview(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    setLoading(true);
    setError('');
    setActionError('');
    setNotice('');
    setPayload(null);
    try {
      const response = await fetch('/api/v1/reviews/periodic', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          periodType,
          anchorDate,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      });
      const result = await response.json() as ApiPayload<ReviewPayload>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'No se pudo generar la revisión financiera.');
      setPayload(result.data);
      setNotice(result.data.run.status === 'completed'
        ? 'Revisión generada: no quedan puntos pendientes de revisar.'
        : 'Revisión generada. Los puntos pendientes se pueden revisar o aplazar.');
      await loadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo generar la revisión financiera.');
    } finally {
      setLoading(false);
    }
  }

  async function updateItem(item: ReviewItem, status: 'reviewed' | 'postponed'): Promise<void> {
    if (!payload) return;
    setActionError('');
    setNotice('');
    try {
      const response = await fetch('/api/v1/reviews/periodic/' + encodeURIComponent(payload.run.id) + '/items', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          findingId: item.findingId,
          status,
          ...(status === 'postponed' ? { postponedUntil: addDays(todayLocal(), 7) } : {}),
        }),
      });
      const result = await response.json() as ApiPayload<ReviewRun>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'No se pudo guardar el estado del punto de revisión.');
      setPayload((current) => current ? { ...current, run: result.data! } : current);
      setNotice(status === 'reviewed' ? 'Punto marcado como revisado.' : 'Punto aplazado durante siete días.');
      await loadHistory();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'No se pudo guardar el estado del punto de revisión.');
    }
  }

  const findingsById = useMemo(() => new Map((payload?.findings ?? []).map((finding) => [finding.id, finding])), [payload]);
  const activeItems = payload?.run.items ?? [];
  const pendingCount = activeItems.filter((item) => item.status === 'pending').length;
  const budgetFindings = payload?.findings.filter((finding) => finding.type === 'budget-overspend') ?? [];
  const budgetIssues = payload?.budgetAssessment.overBudgetCategoryCount ?? 0;
  const maximumBudgetUsage = budgetFindings.reduce<number | null>((maximum, finding) => {
    const value = finding.metrics.percentUsed;
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(maximum ?? 0, value) : maximum;
  }, null);
  const goalProjections = payload?.goalAssessment.projections ?? [];
  const projectedGoalProgress = goalProjections
    .map((goal) => goal.projectedProgressPercent)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const averageGoalProgress = projectedGoalProgress.length
    ? projectedGoalProgress.reduce((sum, value) => sum + value, 0) / projectedGoalProgress.length
    : null;
  const upcoming = activeItems.filter((item) => item.findingType === 'commitment-upcoming' || item.findingType === 'recurring-candidate-upcoming').length;
  const unclassified = payload?.summary.uncategorizedOutflowMinor ?? 0;

  return (
    <section className="content-section periodic-review-page" aria-labelledby="periodic-review-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">REVISIÓN GUIADA / DATOS LOCALES</p>
          <h2 id="periodic-review-heading">Revisión financiera periódica</h2>
          <p className="page-subtitle">Un recorrido semanal o mensual por los cambios, compromisos y puntos que merecen atención. No ejecuta operaciones financieras.</p>
        </div>
        {payload ? <span className="date-badge">{pendingCount} pendientes</span> : null}
      </div>

      <form className="filters-panel periodic-review-controls" onSubmit={(event) => { void startReview(event); }}>
        <label className="field-label">Frecuencia
          <select aria-label="Frecuencia de revisión" value={periodType} onChange={(event) => setPeriodType(event.currentTarget.value as 'weekly' | 'monthly')}>
            <option value="weekly">Semanal (lunes a domingo)</option>
            <option value="monthly">Mensual (mes natural)</option>
          </select>
        </label>
        <label className="field-label">Fecha de referencia
          <input aria-label="Fecha de referencia de la revisión" type="date" value={anchorDate} max={todayLocal()} onChange={(event) => setAnchorDate(event.currentTarget.value)} required />
        </label>
        <div className="button-row">
          <button className="button primary" type="submit" disabled={loading || !anchorDate}>
            {loading ? 'Generando revisión…' : payload ? 'Volver a generar' : 'Iniciar revisión'}
          </button>
        </div>
      </form>

      {notice ? <p className="form-alert success" role="status">{notice}</p> : null}
      {actionError ? <p className="form-alert error" role="alert">{actionError}</p> : null}
      {error ? <div className="notice notice-error" role="alert"><div><strong>No se ha podido generar la revisión</strong><p>{error}</p></div><button className="button secondary" type="button" onClick={() => { void startReview(); }}>Reintentar</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="spinner" aria-hidden="true" /> Calculando el resumen y los hallazgos locales…</div> : null}

      {payload ? (
        <>
          <article className="panel periodic-review-overview">
            <div className="panel-heading">
              <div><p className="eyebrow">CORTE Y CONTEXTO</p><h3>{payload.run.periodType === 'weekly' ? 'Revisión semanal' : 'Revisión mensual'} · {dateRange(payload.period.startDate, payload.period.endDate)}</h3></div>
              <span className="intelligence-review-state">{payload.run.status === 'completed' ? 'Revisión completada' : 'En curso'}</span>
            </div>
            <div className="detail-grid">
              <div className="detail-line"><span>Fecha de corte</span><strong>{formatCivilDate(payload.asOfDate)}</strong></div>
              <div className="detail-line"><span>Zona horaria</span><strong>{payload.timeZone}</strong></div>
              <div className="detail-line"><span>Divisa de análisis</span><strong>{payload.currency}</strong></div>
              <div className="detail-line"><span>Ámbito de cuentas</span><strong>{payload.accountScope.label}</strong></div>
              <div className="detail-line"><span>Generada</span><strong>{new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(payload.calculatedAt))}</strong></div>
            </div>
            {!payload.period.complete ? <p className="setting-hint">El periodo todavía no está cerrado. Los resultados son provisionales hasta {formatCivilDate(payload.period.scheduledEndDate)}.</p> : null}
          </article>

          <div className="stats-grid periodic-review-stats">
            <article className="stat-card positive"><p>Ingresos</p><strong>{formatMoney(payload.summary.incomeMinor, payload.currency)}</strong><span>Periodo comparable: {formatMoney(payload.comparison.summary.incomeMinor, payload.currency)}</span></article>
            <article className="stat-card negative"><p>Gastos</p><strong>{formatMoney(payload.summary.expenseMinor, payload.currency)}</strong><span>Variación: {deltaText(payload.summary.expenseMinor, payload.comparison.summary.expenseMinor, payload.currency)}</span></article>
            <article className={'stat-card ' + (payload.summary.savingsMinor >= 0 ? 'positive' : 'negative')}><p>Ahorro neto</p><strong>{formatMoney(payload.summary.savingsMinor, payload.currency)}</strong><span>Tasa de ahorro: {payload.summary.savingsRatePercent === null ? 'No disponible' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(payload.summary.savingsRatePercent) + ' %'}</span></article>
            <article className="stat-card"><p>Puntos pendientes</p><strong>{pendingCount}</strong><span>{activeItems.length} puntos accionables identificados</span></article>
          </div>

          <div className="two-column periodic-review-secondary">
            <article className="panel"><div className="panel-heading"><div><p className="eyebrow">PLANIFICACIÓN</p><h3>Presupuesto y objetivos</h3></div></div>
              <div className="detail-line"><span>Evaluación presupuestaria</span><strong>{payload.budgetAssessment.available ? 'Evaluable' : 'No evaluable'}</strong></div>
              {payload.budgetAssessment.available ? <>
                <div className="detail-line"><span>Categorías con desviación</span><strong>{budgetIssues}</strong></div>
                {maximumBudgetUsage !== null ? <div className="detail-line"><span>Mayor porcentaje de presupuesto consumido</span><strong>{new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(maximumBudgetUsage)} %</strong></div> : null}
                <p className="setting-hint">{budgetIssues === 0 ? 'No se han detectado excesos en categorías con asignación positiva y datos comparables.' : payload.budgetAssessment.scope}</p>
              </> : <p className="setting-hint">{payload.budgetAssessment.reason}</p>}
              <div className="detail-line"><span>Objetivos con proyección</span><strong>{payload.goalAssessment.evaluatedGoalCount}</strong></div>
              <div className="detail-line"><span>Objetivos proyectados en plazo / en riesgo</span><strong>{payload.goalAssessment.onTrackCount} / {payload.goalAssessment.atRiskCount}</strong></div>
              <div className="detail-line"><span>Avance proyectado medio</span><strong>{averageGoalProgress === null ? 'No disponible' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(averageGoalProgress) + ' %'}</strong></div>
              {goalProjections.length > 0 ? <div className="periodic-review-goals">
                {goalProjections.map((goal) => <div className="detail-line" key={goal.findingId}><span>{goal.title}<small>{goal.targetDate ? 'Fecha objetivo: ' + formatCivilDate(goal.targetDate) : 'Proyección estimada'}</small></span><strong>{goal.projectedProgressPercent === null ? 'No disponible' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(goal.projectedProgressPercent) + ' %'}</strong></div>)}
              </div> : null}
              <div className="detail-line"><span>Compromisos y recurrencias próximos</span><strong>{upcoming}</strong></div>
              <div className="detail-line"><span>Importe de salidas sin categoría</span><strong>{formatMoney(unclassified, payload.currency)}</strong></div>
              <div className="detail-line"><span>Movimientos sin conversión</span><strong>{payload.summary.unconvertedTransactionCount}</strong></div>
            </article>
            <article className="panel"><div className="panel-heading"><div><p className="eyebrow">COMPARACIÓN</p><h3>Periodo anterior equivalente</h3></div></div>
              <p className="setting-hint">{dateRange(payload.comparison.period.startDate, payload.comparison.period.endDate)}</p>
              <div className="detail-line"><span>Ingresos</span><strong>{deltaText(payload.summary.incomeMinor, payload.comparison.summary.incomeMinor, payload.currency)}</strong></div>
              <div className="detail-line"><span>Gastos</span><strong>{deltaText(payload.summary.expenseMinor, payload.comparison.summary.expenseMinor, payload.currency)}</strong></div>
              <div className="detail-line"><span>Ahorro neto</span><strong>{deltaText(payload.summary.savingsMinor, payload.comparison.summary.savingsMinor, payload.currency)}</strong></div>
            </article>
          </div>

          {payload.warnings.length > 0 ? <details className="intelligence-warnings" open><summary>Limitaciones y calidad de datos ({payload.warnings.length})</summary><ul>{payload.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}

          <div className="section-heading periodic-review-findings-heading"><div><p className="eyebrow">SIGUIENTES PASOS</p><h3>Qué conviene revisar</h3><p className="page-subtitle">Ordenados por prioridad determinista. Revisa la evidencia antes de decidir; el impacto puede ser desconocido.</p></div></div>
          {activeItems.length === 0 ? <div className="empty-state"><span className="empty-symbol" aria-hidden="true">◇</span><h3>No hay puntos pendientes para este periodo</h3><p>No se han generado hallazgos accionables o ya están revisados, aplazados, esperados o descartados.</p></div> : (
            <div className="intelligence-list">
              {activeItems.map((item) => {
                const finding = findingsById.get(item.findingId);
                if (!finding) return null;
                return (
                  <article className={'panel intelligence-card priority-' + finding.priority} key={item.findingId}>
                    <div className="intelligence-card-heading"><div><div className="intelligence-badges">
                      <span className={'intelligence-priority ' + finding.priority}>Prioridad {PRIORITY_LABELS[finding.priority]}</span>
                      <span className="intelligence-confidence">{CONFIDENCE_LABELS[finding.confidence]}</span>
                      <span className="intelligence-type">{TYPE_LABELS[finding.type]}</span>
                    </div><h3>{finding.title}</h3><p className="intelligence-card-period">{dateRange(finding.period.startDate, finding.period.endDate)} · {finding.currency}</p></div>
                    <span className="intelligence-review-state">{item.status === 'reviewed' ? 'Revisado' : item.status === 'postponed' ? 'Aplazado hasta ' + (item.postponedUntil ? formatCivilDate(item.postponedUntil) : 'fecha pendiente') : 'Pendiente'}</span></div>
                    <p className="intelligence-explanation">{finding.explanation}</p>
                    <div className="intelligence-impact"><span>Impacto asociado</span><strong>{findingAmount(finding)}</strong></div>
                    <details className="intelligence-evidence" open><summary>Evidencia y regla</summary><dl>{finding.evidence.slice(0, 5).map((evidence, index) => <div key={evidence.label + '-' + index}><dt>{evidence.label}</dt><dd>{typeof evidence.value === 'number' && /importe|gasto|ingreso|presupuesto|saldo|brecha|exceso|mediana/i.test(evidence.label) ? formatMoney(evidence.value, finding.currency) : String(evidence.value)}</dd><small>{evidence.rule} · Fuente: {evidence.source}</small></div>)}</dl>
                      <p className="intelligence-priority-reason"><strong>Por qué esta prioridad:</strong> {finding.priorityReason}</p>
                    </details>
                    {finding.limitations.length ? <details className="intelligence-limitations"><summary>Limitaciones ({finding.limitations.length})</summary><ul>{finding.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details> : null}
                    <div className="intelligence-actions">
                      <button className="button secondary" type="button" onClick={() => onNavigate(finding.navigationTarget)}>Abrir detalle</button>
                      {item.status === 'pending' ? <>
                        <button className="button secondary" type="button" onClick={() => { void updateItem(item, 'reviewed'); }}>Marcar revisado</button>
                        <button className="button secondary" type="button" onClick={() => { void updateItem(item, 'postponed'); }}>Aplazar 7 días</button>
                      </> : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          <p className="section-footnote">Los movimientos sin categoría se muestran como agregado; el detalle se abre en Movimientos. Los traspasos internos se excluyen de ingresos y gastos. La revisión se puede regenerar sin IA y no cambia datos de Actual Budget.</p>
        </>
      ) : null}

      <article className="panel periodic-review-history">
        <div className="panel-heading"><div><p className="eyebrow">HISTORIAL LOCAL</p><h3>Revisiones anteriores</h3></div></div>
        {historyLoading ? <p role="status" className="muted-copy">Cargando historial…</p> : null}
        {!historyLoading && (history?.reviews.length ?? 0) === 0 ? <p className="muted-copy">Todavía no hay revisiones guardadas.</p> : null}
        {history?.reviews.slice(0, 10).map((run) => (
          <div className="detail-line periodic-review-history-row" key={run.id}>
            <span>{run.periodType === 'weekly' ? 'Semanal' : 'Mensual'} · {dateRange(run.startDate, run.endDate)}<small>{formatCivilDate(run.generatedAt.slice(0, 10))} · {run.currency} · {run.accountScope.label}</small></span>
            <strong>{run.status === 'completed' ? 'Completada' : run.items.filter((item) => item.status === 'pending').length + ' pendientes'}</strong>
          </div>
        ))}
        <p className="section-footnote">El historial conserva únicamente metadatos de revisión e identificadores de hallazgos. No contiene transacciones ni conversaciones.</p>
      </article>
      <p className="section-footnote">La IA local es opcional y no participa en los cálculos ni en la priorización. No se realizan notificaciones en segundo plano, pagos ni cambios automáticos en el presupuesto.</p>
    </section>
  );
}
