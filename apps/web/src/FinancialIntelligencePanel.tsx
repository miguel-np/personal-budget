import { useEffect, useMemo, useState } from 'react';
import { formatCivilDate, formatMoney as sharedFormatMoney } from './finance-format.js';

type FindingType =
  | 'expense-change' | 'income-change' | 'budget-overspend' | 'pending-categorization'
  | 'commitment-upcoming' | 'recurring-candidate-upcoming' | 'goal-at-risk' | 'goal-progress' | 'financial-anomaly';
type AnomalyKind = 'transaction-outlier' | 'total-expense-change' | 'category-change' | 'payee-change' | 'possible-duplicate' | 'income-change' | 'refund-change' | 'frequency-change';
type ReviewStatus = 'new' | 'reviewed' | 'dismissed' | 'snoozed';
type Confidence = 'observed' | 'estimated' | 'candidate' | 'suggestion';
type NavigationTarget = '/reports' | '/movements' | '/budgets' | '/planning' | '/goals';

interface Finding {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  type: FindingType;
  title: string;
  explanation: string;
  period: { startDate: string; endDate: string };
  accountScope: { mode: 'all' | 'selected'; accountIds: readonly string[]; label: string };
  currency: string;
  confidence: Confidence;
  priority: 'low' | 'medium' | 'high';
  priorityReason: string;
  impactMinor: number | null;
  metrics: Readonly<Record<string, number | string | boolean | null>>;
  evidence: readonly { label: string; value: string | number; source: string; rule: string }[];
  limitations: readonly string[];
  calculatedAt: string;
  reviewStatus: ReviewStatus;
  snoozedUntil?: string;
  navigationTarget: NavigationTarget;
}
interface FindingsPayload {
  schemaVersion: 1;
  findings: readonly Finding[];
  warnings: readonly string[];
  period: { startDate: string; endDate: string };
  accountScope: { label: string };
  currency: string;
  calculatedAt: string;
  aiEnabled: boolean;
  qualityMetrics: {
    feedbackCount: number;
    usefulCount: number;
    dismissedCount: number;
    dismissalRatePercent: number | null;
    note: string;
  };
}
interface ApiPayload<T> { data?: T; error?: { code?: string; message?: string }; }

const TYPE_LABELS: Record<FindingType, string> = {
  'expense-change': 'Variación del gasto',
  'income-change': 'Variación de ingresos',
  'budget-overspend': 'Presupuesto superado',
  'pending-categorization': 'Pendiente de clasificar',
  'commitment-upcoming': 'Compromiso próximo',
  'recurring-candidate-upcoming': 'Posible recurrencia',
  'goal-at-risk': 'Objetivo en riesgo',
  'goal-progress': 'Progreso de objetivo',
  'financial-anomaly': 'Anomalía financiera',
};
const ANOMALY_KIND_LABELS: Record<AnomalyKind, string> = {
  'transaction-outlier': 'Importe individual inusual', 'total-expense-change': 'Cambio en gasto total',
  'category-change': 'Cambio por categoría', 'payee-change': 'Cambio por beneficiario',
  'possible-duplicate': 'Posibles duplicados', 'income-change': 'Cambio en ingresos',
  'refund-change': 'Cambio en reembolsos', 'frequency-change': 'Cambio en frecuencia',
};
const ANOMALY_KIND_DEFAULTS = Object.keys(ANOMALY_KIND_LABELS) as AnomalyKind[];
const CONFIDENCE_LABELS: Record<Confidence, string> = {
  observed: 'Hecho observado',
  estimated: 'Estimación',
  candidate: 'Candidato estadístico',
  suggestion: 'Sugerencia',
};
const PRIORITY_LABELS = { high: 'Alta', medium: 'Media', low: 'Baja' } as const;
const REVIEW_LABELS: Record<ReviewStatus, string> = {
  new: 'Pendiente', reviewed: 'Útil confirmado', dismissed: 'Descartado', snoozed: 'Aplazado',
};
const MONEY_KEYS = new Set([
  'currentMinor', 'previousMinor', 'deltaMinor', 'budgetedMinor', 'spentMinor', 'overByMinor',
  'uncategorizedOutflowMinor', 'unclassifiedInflowMinor', 'amountMinor', 'meanAbsoluteAmountMinor',
  'targetAmountMinor', 'projectedBalanceMinor', 'gapMinor', 'baselineMedianMinor', 'observedMinor',
  'minimumAbsoluteChangeMinor', 'triggerThresholdMinor', 'medianAbsoluteDeviationMinor', 'potentiallyRepeatedAmountMinor',
]);

function money(value: number, currency: string): string {
  return sharedFormatMoney(value, currency);
}
function valueText(key: string, value: number | string | boolean | null, currency: string): string {
  if (value === null) return 'No disponible';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') {
    if (MONEY_KEYS.has(key) || key === 'impactMinor') return money(value, currency);
    if (key.toLowerCase().includes('percent') || key === 'percentageChange' || key === 'percentUsed') {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) + ' %';
    }
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
  return value;
}
function formatEvidence(value: string | number, label: string, currency: string): string {
  if (typeof value === 'string') {
    if (label.toLocaleLowerCase('es').includes('serie histórica')) {
      try {
        const series: unknown = JSON.parse(value);
        if (Array.isArray(series)) return series.flatMap((point: unknown) => {
          if (!point || typeof point !== 'object') return [];
          const item = point as { date?: unknown; amountMinor?: unknown };
          return typeof item.date === 'string' && typeof item.amountMinor === 'number' && Number.isFinite(item.amountMinor)
            ? [item.date + ': ' + money(item.amountMinor, currency)] : [];
        }).join(' · ');
      } catch { return value; }
    }
    return value;
  }
  const key = /valor del periodo|variación absoluta|umbral de activación|importe|gasto|ingreso|presupuesto|saldo|exceso|brecha estimada|mediana de importes|mediana de referencia/i.test(label) ? 'impactMinor' : label.toLowerCase().includes('%') ? 'percentageChange' : 'count';
  return valueText(key, value, currency);
}
function dateRange(period: { startDate: string; endDate: string }): string {
  return period.startDate === period.endDate
    ? formatCivilDate(period.startDate)
    : formatCivilDate(period.startDate) + ' – ' + formatCivilDate(period.endDate);
}
function snoozeDate(days: number): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function FinancialIntelligencePanel({
  startDate, endDate, refreshKey, onNavigate,
}: {
  startDate: string;
  endDate: string;
  refreshKey: number;
  onNavigate: (target: NavigationTarget) => void;
}) {
  const [payload, setPayload] = useState<FindingsPayload | null>(null);
  const [rangeStart, setRangeStart] = useState(startDate);
  const [rangeEnd, setRangeEnd] = useState(endDate);
  const [referenceWindows, setReferenceWindows] = useState(6);
  const [minimumAbsoluteChangeMinor, setMinimumAbsoluteChangeMinor] = useState(5_000);
  const [minimumRelativeChangePercent, setMinimumRelativeChangePercent] = useState(30);
  const [enabledAnomalyKinds, setEnabledAnomalyKinds] = useState<AnomalyKind[]>(ANOMALY_KIND_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | FindingType>('all');
  const [statusFilter, setStatusFilter] = useState<'new' | 'all' | 'reviewed' | 'dismissed' | 'snoozed'>('new');
  const [busyFinding, setBusyFinding] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [explanationBusy, setExplanationBusy] = useState('');
  const [explanationErrors, setExplanationErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) {
      setPayload(null);
      setError('El intervalo no es válido: la fecha inicial debe ser igual o anterior a la fecha final.');
      setLoading(false);
      return () => controller.abort();
    }
    const query = new URLSearchParams({ startDate: rangeStart, endDate: rangeEnd, referenceWindows: String(referenceWindows), minimumAbsoluteChangeMinor: String(minimumAbsoluteChangeMinor), minimumRelativeChangePercent: String(minimumRelativeChangePercent) });
    enabledAnomalyKinds.forEach((kind) => query.append('enabledAnomalyKinds', kind));
    void fetch('/api/v1/intelligence/findings?' + query.toString(), {
      signal: controller.signal, headers: { Accept: 'application/json' },
    }).then(async (response) => {
      const result = await response.json() as ApiPayload<FindingsPayload>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'No se pudieron calcular los hallazgos financieros.');
      return result.data;
    }).then((result) => {
      if (!controller.signal.aborted) setPayload(result);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'No se pudo cargar el centro de inteligencia financiera.');
        setPayload(null);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [rangeStart, rangeEnd, refreshKey, reloadKey, referenceWindows, minimumAbsoluteChangeMinor, minimumRelativeChangePercent, enabledAnomalyKinds]);

  const findings = useMemo(() => (payload?.findings ?? []).filter((finding) => {
    if (typeFilter !== 'all' && finding.type !== typeFilter) return false;
    if (statusFilter !== 'all' && finding.reviewStatus !== statusFilter) return false;
    return true;
  }), [payload, typeFilter, statusFilter]);
  const pendingCount = (payload?.findings ?? []).filter((finding) => finding.reviewStatus === 'new').length;

  async function updateReview(finding: Finding, status: 'reviewed' | 'dismissed' | 'snoozed'): Promise<void> {
    setBusyFinding(finding.id);
    setActionError('');
    setNotice('');
    try {
      const request = await fetch('/api/v1/intelligence/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          findingId: finding.id, startDate: rangeStart, endDate: rangeEnd, status,
          referenceWindows, minimumAbsoluteChangeMinor, minimumRelativeChangePercent, enabledAnomalyKinds,
          ...(status === 'snoozed' ? { snoozedUntil: snoozeDate(7) } : {}),
        }),
      });
      const result = await request.json() as ApiPayload<{ findingId: string; status: ReviewStatus }>;
      if (!request.ok || !result.data) throw new Error(result.error?.message ?? 'No se pudo guardar el estado de revisión.');
      setNotice(status === 'reviewed' ? 'Hallazgo marcado como útil.' : status === 'dismissed' ? 'Hallazgo descartado.' : 'Hallazgo aplazado durante 7 días.');
      setReloadKey((value) => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'No se pudo guardar el estado de revisión.');
    } finally {
      setBusyFinding('');
    }
  }

  async function explainLocally(finding: Finding): Promise<void> {
    setExplanationBusy(finding.id);
    setExplanationErrors((previous) => ({ ...previous, [finding.id]: '' }));
    try {
      const response = await fetch('/api/v1/intelligence/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ findingId: finding.id, startDate: rangeStart, endDate: rangeEnd, referenceWindows, minimumAbsoluteChangeMinor, minimumRelativeChangePercent, enabledAnomalyKinds }),
      });
      const result = await response.json() as ApiPayload<{ explanation: string }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'La explicación local no está disponible; el hallazgo calculado no cambia.');
      setExplanations((previous) => ({ ...previous, [finding.id]: result.data!.explanation }));
    } catch (cause) {
      setExplanationErrors((previous) => ({
        ...previous, [finding.id]: cause instanceof Error ? cause.message : 'La explicación local no está disponible.',
      }));
    } finally {
      setExplanationBusy('');
    }
  }

  return (
    <section className="content-section intelligence-page" aria-labelledby="intelligence-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">EVIDENCIA LOCAL / REGLAS EXPLÍCITAS</p>
          <h2 id="intelligence-heading">Centro de inteligencia financiera</h2>
          <p className="page-subtitle">Qué ha cambiado, por qué importa y qué conviene revisar. Los hallazgos no modifican Actual Budget.</p>
        </div>
        <span className="date-badge">{pendingCount} pendientes</span>
      </div>

      {payload ? (
        <div className="intelligence-quality" aria-label="Métricas locales de utilidad">
          <div><span>Feedback explícito</span><strong>{payload.qualityMetrics.feedbackCount}</strong></div>
          <div><span>Marcados útiles</span><strong>{payload.qualityMetrics.usefulCount}</strong></div>
          <div><span>Descartados</span><strong>{payload.qualityMetrics.dismissedCount}</strong></div>
          <div><span>Tasa de descarte</span><strong>{payload.qualityMetrics.dismissalRatePercent === null ? 'Sin datos' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(payload.qualityMetrics.dismissalRatePercent) + ' %'}</strong></div>
          <p>{payload.qualityMetrics.note} La precisión y la tasa de falsos positivos solo se calculan con casos etiquetados de forma independiente; las pruebas del proyecto usan fixtures sintéticos, sin telemetría externa.</p>
        </div>
      ) : null}

      <div className="intelligence-method-note">
        <strong>Cómo se calculan las prioridades</strong>
        <p>Las variaciones entre periodos requieren al menos 5.000 unidades menores y un 20 % respecto a una ventana equivalente. Las anomalías usan medianas, desviación absoluta mediana y umbrales configurables. La prioridad no es una medida de certeza.</p>
      </div>

      <div className="filters-panel intelligence-filters">
        <label className="field-label">Desde
          <input type="date" aria-label="Desde" value={rangeStart} onChange={(event) => setRangeStart(event.currentTarget.value)} />
        </label>
        <label className="field-label">Hasta
          <input type="date" aria-label="Hasta" value={rangeEnd} onChange={(event) => setRangeEnd(event.currentTarget.value)} />
        </label>
        <label className="field-label">Tipo de hallazgo
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.currentTarget.value as 'all' | FindingType)}>
            <option value="all">Todos los tipos</option>
            {Object.entries(TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="field-label">Estado de revisión
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as typeof statusFilter)}>
            <option value="new">Pendientes</option>
            <option value="all">Todos los estados</option>
            <option value="reviewed">Útiles confirmados</option>
            <option value="dismissed">Descartados</option>
            <option value="snoozed">Aplazados</option>
          </select>
        </label>
        <div className="intelligence-period">
          <span>Periodo de análisis</span>
          <strong>{dateRange({ startDate: rangeStart, endDate: rangeEnd })}</strong>
          <small>{payload?.accountScope.label ?? 'Cargando ámbito de cuentas'}</small>
        </div>
      </div>

      <div className="filters-panel intelligence-anomaly-settings" aria-label="Configuración de detección de anomalías">
        <div className="intelligence-period"><strong>Detección de anomalías</strong><small>Los ajustes solo cambian las reglas de detección; no modifican movimientos ni contabilidad.</small></div>
        <label className="field-label">Ventanas de referencia
          <select aria-label="Ventanas históricas de referencia" value={referenceWindows} onChange={(event) => setReferenceWindows(Number(event.currentTarget.value))}>
            <option value={3}>3 ventanas</option><option value={6}>6 ventanas</option><option value={12}>12 ventanas</option><option value={24}>24 ventanas (hasta 2 años)</option>
          </select>
        </label>
        <label className="field-label">Cambio absoluto mínimo
          <select aria-label="Cambio absoluto mínimo" value={minimumAbsoluteChangeMinor} onChange={(event) => setMinimumAbsoluteChangeMinor(Number(event.currentTarget.value))}>
            {[2_500, 5_000, 10_000, 25_000].map((value) => <option key={value} value={value}>{payload?.currency ? money(value, payload.currency) : value.toLocaleString('es-ES') + ' unidades menores'}</option>)}
          </select>
        </label>
        <label className="field-label">Cambio relativo mínimo
          <select aria-label="Cambio relativo mínimo" value={minimumRelativeChangePercent} onChange={(event) => setMinimumRelativeChangePercent(Number(event.currentTarget.value))}>
            {[20, 30, 50, 75].map((value) => <option key={value} value={value}>{value} %</option>)}
          </select>
        </label>
        <div className="intelligence-anomaly-types" role="group" aria-label="Tipos de anomalía activados"><strong>Tipos de alerta</strong>
          {Object.entries(ANOMALY_KIND_LABELS).map(([kind, label]) => <label key={kind} className="field-label">
            <input type="checkbox" checked={enabledAnomalyKinds.includes(kind as AnomalyKind)} onChange={(event) => {
              const checked = event.currentTarget.checked;
              setEnabledAnomalyKinds((current) => checked
                ? current.includes(kind as AnomalyKind) ? current : [...current, kind as AnomalyKind]
                : current.length > 1 ? current.filter((item) => item !== kind) : current);
            }} />{label}
          </label>)}
        </div>
      </div>

      {notice ? <p className="form-alert success" role="status">{notice}</p> : null}
      {actionError ? <p className="form-alert error" role="alert">{actionError}</p> : null}
      {loading ? <div className="loading-state" role="status"><span className="spinner" aria-hidden="true" /> Calculando hallazgos locales…</div> : null}
      {!loading && error ? (
        <div className="notice notice-error" role="alert">
          <div><strong>No se ha podido cargar la inteligencia financiera</strong><p>{error}</p></div>
          <button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)}>Reintentar</button>
        </div>
      ) : null}
      {!loading && !error && findings.length === 0 ? (
        <div className="empty-state">
          <span className="empty-symbol" aria-hidden="true">◇</span>
          <h3>{(payload?.findings.length ?? 0) === 0 ? 'Sin hallazgos para este periodo' : 'No hay hallazgos con estos filtros'}</h3>
          <p>{(payload?.warnings.length ?? 0) > 0
            ? 'No se ha detectado evidencia suficiente para generar hallazgos activos. Consulta las limitaciones del análisis.'
            : 'No se han activado las reglas deterministas disponibles. Esto no significa que no exista ningún riesgo financiero.'}</p>
        </div>
      ) : null}

      {payload?.warnings.length ? (
        <details className="intelligence-warnings">
          <summary>Limitaciones del análisis ({payload.warnings.length})</summary>
          <ul>{payload.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </details>
      ) : null}

      <div className="intelligence-list">
        {!loading && !error ? findings.map((finding) => (
          <article className={'panel intelligence-card priority-' + finding.priority} key={finding.id}>
            <div className="intelligence-card-heading">
              <div>
                <div className="intelligence-badges">
                  <span className={'intelligence-priority ' + finding.priority}>Prioridad {PRIORITY_LABELS[finding.priority]}</span>
                  <span className="intelligence-confidence">{CONFIDENCE_LABELS[finding.confidence]}</span>
                  <span className="intelligence-type">{TYPE_LABELS[finding.type]}</span>
                </div>
                <h3>{finding.title}</h3>
                <p className="intelligence-card-period">{dateRange(finding.period)} · {finding.accountScope.label} · {finding.currency}</p>
              </div>
              <span className="intelligence-review-state">{REVIEW_LABELS[finding.reviewStatus]}</span>
            </div>
            <p className="intelligence-explanation">{finding.explanation}</p>
            {finding.impactMinor !== null ? <div className="intelligence-impact"><span>Impacto asociado</span><strong>{money(finding.impactMinor, finding.currency)}</strong></div> : null}
            <details className="intelligence-evidence" open>
              <summary>Evidencia y regla que lo activa</summary>
              <dl>
                {finding.evidence.map((item, index) => (
                  <div key={item.label + '-' + index}>
                    <dt>{item.label}</dt><dd>{formatEvidence(item.value, item.label, finding.currency)}</dd>
                    <small>{item.rule} · Fuente: {item.source}</small>
                  </div>
                ))}
              </dl>
              <p className="intelligence-priority-reason"><strong>Por qué esta prioridad:</strong> {finding.priorityReason}</p>
            </details>
            {finding.limitations.length ? (
              <details className="intelligence-limitations">
                <summary>Limitaciones ({finding.limitations.length})</summary>
                <ul>{finding.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
              </details>
            ) : null}
            {explanations[finding.id] ? <div className="intelligence-ai-note"><strong>Explicación cualitativa de IA local</strong><p>{explanations[finding.id]}</p><small>El cálculo determinista es la fuente de verdad; la explicación no añade evidencias.</small></div> : null}
            {explanationErrors[finding.id] ? <p className="form-alert error" role="alert">{explanationErrors[finding.id]}</p> : null}
            <div className="intelligence-actions">
              <button className="button secondary" type="button" onClick={() => onNavigate(finding.navigationTarget)}>Abrir detalle</button>
              {payload?.aiEnabled ? <button className="button secondary" type="button" disabled={Boolean(explanationBusy)} onClick={() => { void explainLocally(finding); }}>{explanationBusy === finding.id ? 'Generando explicación…' : 'Explicar con IA local'}</button> : null}
              {finding.reviewStatus === 'new' ? (
                <>
                  <button className="button secondary" type="button" disabled={Boolean(busyFinding)} onClick={() => { void updateReview(finding, 'reviewed'); }}>Marcar útil</button>
                  <button className="button secondary" type="button" disabled={Boolean(busyFinding)} onClick={() => { void updateReview(finding, 'snoozed'); }}>Aplazar 7 días</button>
                  <button className="button text-button" type="button" disabled={Boolean(busyFinding)} onClick={() => { void updateReview(finding, 'dismissed'); }}>Descartar</button>
                </>
              ) : null}
              {busyFinding === finding.id ? <span role="status" className="muted-label">Guardando…</span> : null}
            </div>
          </article>
        )) : null}
      </div>
      {!payload?.aiEnabled && !loading && !error ? <p className="section-footnote">La explicación con IA local no está activada. Los cálculos, reglas, evidencias y revisiones siguen funcionando sin Ollama.</p> : null}
      {payload?.calculatedAt ? <p className="section-footnote">Calculado el {formatCivilDate(payload.calculatedAt.slice(0, 10))}. Sin telemetría ni notificaciones externas.</p> : null}
    </section>
  );
}
