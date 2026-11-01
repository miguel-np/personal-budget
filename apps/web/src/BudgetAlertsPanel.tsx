import { useEffect, useState } from 'react';
import { formatMoney } from './finance-format.js';

type Metric = 'percent_used' | 'remaining_minor' | 'overspend_minor' | 'overspend_percent';
interface Rule { id: string; categoryId: string; metric: Metric; threshold: number; enabled: boolean; }
interface Category { categoryId: string; categoryName: string; budgetedMinor: number | null; spentMinor: number | null; availableMinor: number | null; state: 'budgeted' | 'zero' | 'unbudgeted' | 'unknown'; hidden?: boolean; }
interface Alert { eventId: string; ruleId: string; categoryId: string; categoryName: string; metric: Metric; threshold: number; observedValue: number; month: string; message: string; status: 'active'; currency: string; }
interface AlertsData { month: string; evaluatedAt: string; currency: string; rules: readonly Rule[]; alerts: readonly Alert[]; categories: readonly Category[]; warnings: readonly string[]; }
interface ApiPayload<T> { data?: T; error?: { message?: string } }
const metricLabels: Record<Metric, string> = {
  percent_used: 'Porcentaje consumido',
  remaining_minor: 'Importe restante (por debajo del umbral)',
  overspend_minor: 'Exceso absoluto sobre presupuesto',
  overspend_percent: 'Exceso relativo sobre presupuesto',
};
function factor(currency: string): number {
  const digits = new Intl.NumberFormat('es-ES', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return 10 ** digits;
}
function thresholdLabel(rule: Rule, currency: string): string {
  return rule.metric === 'percent_used' || rule.metric === 'overspend_percent' ? rule.threshold + ' %' : formatMoney(rule.threshold, currency);
}
function displayObserved(alert: Alert): string {
  return alert.metric === 'percent_used' || alert.metric === 'overspend_percent' ? alert.observedValue + ' %' : formatMoney(alert.observedValue, alert.currency);
}
function dateAfter(days: number): string {
  const date = new Date(); date.setDate(date.getDate() + days);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
export function BudgetAlertsPanel({ month, currency }: { month: string; currency: string }) {
  const [data, setData] = useState<AlertsData | null>(null);
  const [rules, setRules] = useState<readonly Rule[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [metric, setMetric] = useState<Metric>('percent_used');
  const [threshold, setThreshold] = useState('80');
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load(): Promise<void> {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/budget-alerts?month=' + encodeURIComponent(month), { headers: { Accept: 'application/json' } });
      const payload = await response.json() as ApiPayload<AlertsData>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'No se pudieron evaluar las alertas presupuestarias.');
      setData(payload.data); setRules(payload.data.rules);
      if (!categoryId) setCategoryId(payload.data.categories.find((item) => !item.hidden)?.categoryId ?? '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudieron cargar las alertas.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [month]);

  function addRule(): void {
    if (!categoryId) { setError('Selecciona una categoría de gasto.'); return; }
    const raw = Number(threshold);
    if (!Number.isFinite(raw) || raw < 0) { setError('Introduce un umbral válido.'); return; }
    const activeCurrency = data?.currency ?? currency;
    const percentageMetric = metric === 'percent_used' || metric === 'overspend_percent';
    const thresholdValue = percentageMetric ? Math.round(raw) : Math.round(raw * factor(activeCurrency));
    if (percentageMetric && (thresholdValue < 1 || thresholdValue > 500)) { setError('El porcentaje debe estar entre 1 % y 500 %.'); return; }
    if (metric === 'overspend_minor' && thresholdValue < 1) { setError('El umbral de exceso debe ser mayor que cero.'); return; }
    if (!Number.isSafeInteger(thresholdValue)) { setError('El umbral supera el rango permitido.'); return; }
    if (rules.some((rule) => rule.id !== editingRuleId && rule.categoryId === categoryId && rule.metric === metric)) {
      setError('Ya existe una regla para esa categoría y métrica.'); return;
    }
    if (editingRuleId) {
      setRules((current) => current.map((rule) => rule.id === editingRuleId
        ? { ...rule, id: crypto.randomUUID(), categoryId, metric, threshold: thresholdValue }
        : rule));
      setEditingRuleId(null);
    } else {
      setRules((current) => [...current, { id: crypto.randomUUID(), categoryId, metric, threshold: thresholdValue, enabled: true }]);
    }
    setError('');
  }

  async function saveRules(): Promise<void> {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/v1/budget-alerts/rules', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ rules }),
      });
      const payload = await response.json() as ApiPayload<readonly Rule[]>;
      if (!response.ok) throw new Error(payload.error?.message ?? 'No se pudieron guardar las reglas.');
      setNotice('Reglas guardadas en el almacenamiento local. Se evaluarán al consultar este periodo.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudieron guardar las reglas.'); }
    finally { setBusy(false); }
  }

  async function decide(alert: Alert, status: 'dismissed' | 'snoozed'): Promise<void> {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/v1/budget-alerts/events/' + encodeURIComponent(alert.eventId), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          ruleId: alert.ruleId, categoryId: alert.categoryId, month: alert.month, status,
          ...(status === 'snoozed' ? { snoozedUntil: dateAfter(7) } : {}),
        }),
      });
      const payload = await response.json() as ApiPayload<unknown>;
      if (!response.ok) throw new Error(payload.error?.message ?? 'No se pudo actualizar la alerta.');
      setNotice(status === 'snoozed' ? 'Aviso pospuesto siete días.' : 'Aviso silenciado para este periodo.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo actualizar la alerta.'); }
    finally { setBusy(false); }
  }

  return (
    <article className="panel planning-panel">
      <div className="panel-heading"><div><p className="eyebrow">SEGUIMIENTO · #74</p><h3>Alertas presupuestarias locales</h3></div><span className="date-badge">{month}</span></div>
      <p className="section-footnote">Avisos informativos dentro de la aplicación. No modifican asignaciones ni generan notificaciones externas o procesos residentes.</p>
      <p className="section-footnote">El presupuesto de Actual está agregado por categoría y no se desglosa por cuenta; las alertas siguen el mismo ámbito global de la pantalla de Presupuestos.</p>
      {data ? <p className="section-footnote">Última evaluación: {new Date(data.evaluatedAt).toLocaleString('es-ES')} · periodo {data.month} · divisa {data.currency}.</p> : null}
      {data ? (
        <>
          <div className="suggestion-block">
            <h4>Reglas configuradas ({rules.length})</h4>
            {rules.map((rule) => {
              const category = data.categories.find((item) => item.categoryId === rule.categoryId);
              return (
                <div className="comparison-row" key={rule.id}>
                  <div><strong>{category?.categoryName ?? rule.categoryId}</strong><span>{metricLabels[rule.metric]} · {thresholdLabel(rule, data.currency)}</span></div>
                  <div className="comparison-meta">
                    <label className="field-label compact-label"><input type="checkbox" checked={rule.enabled} onChange={(event) => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled: event.currentTarget.checked } : item))} /> Regla activa</label>
                    <button className="button small" type="button" disabled={busy} onClick={() => {
                      setEditingRuleId(rule.id); setCategoryId(rule.categoryId); setMetric(rule.metric);
                      setThreshold(rule.metric === 'percent_used' || rule.metric === 'overspend_percent' ? String(rule.threshold) : String(rule.threshold / factor(data.currency)));
                      setError('');
                    }}>Editar</button>
                    <button className="button small" type="button" disabled={busy} onClick={() => {
                      setRules((current) => current.filter((item) => item.id !== rule.id));
                      if (editingRuleId === rule.id) setEditingRuleId(null);
                    }}>Eliminar</button>
                  </div>
                </div>
              );
            })}
            <div className="form-grid">
              <label className="field-label">Categoría
                <select value={categoryId} onChange={(event) => setCategoryId(event.currentTarget.value)}>
                  <option value="">Seleccionar…</option>
                  {data.categories.map((category) => <option value={category.categoryId} key={category.categoryId}>{category.categoryName}</option>)}
                </select>
              </label>
              <label className="field-label">Qué medir
                <select value={metric} onChange={(event) => setMetric(event.currentTarget.value as Metric)}>
                  {Object.entries(metricLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <label className="field-label">Umbral {metric === 'percent_used' || metric === 'overspend_percent' ? '(%)' : '(' + (data.currency ?? currency) + ')'}
                <input type="number" min="0" step={metric === 'percent_used' || metric === 'overspend_percent' ? '1' : '0.01'} value={threshold} onChange={(event) => setThreshold(event.currentTarget.value)} />
              </label>
            </div>
            <div className="button-row">
              <button className="button secondary" type="button" disabled={busy} onClick={addRule}>{editingRuleId ? 'Actualizar regla' : 'Añadir regla'}</button>
              {editingRuleId ? <button className="button small" type="button" disabled={busy} onClick={() => setEditingRuleId(null)}>Cancelar edición</button> : null}
              <button className="button primary" type="button" disabled={busy} onClick={() => void saveRules()}>{busy ? 'Guardando…' : 'Guardar reglas'}</button>
            </div>
          </div>
          <div className="suggestion-block">
            <h4>Avisos del periodo ({data.alerts.length})</h4>
            {data.alerts.length === 0 ? <p className="muted-copy">No hay umbrales cruzados en este periodo o todos los avisos ya están revisados/pospuestos.</p> : null}
            {data.alerts.map((alert) => {
              const category = data.categories.find((item) => item.categoryId === alert.categoryId);
              const displayBudgetValue = (value: number | null | undefined) => value === null || value === undefined ? 'Desconocido' : formatMoney(value, data.currency);
              return (
              <div className="comparison-row" key={alert.eventId}>
                <div><strong>{alert.categoryName}</strong><span>{alert.message}</span>
                  <span>Asignado: {displayBudgetValue(category?.budgetedMinor)} · Gastado: {displayBudgetValue(category?.spentMinor)} · Disponible: {displayBudgetValue(category?.availableMinor)}</span>
                  <a href={'#budget-category-' + encodeURIComponent(alert.categoryId)}>Ver detalle en Presupuestos</a>
                </div>
                <div className="comparison-meta">
                  <span>Observado: {displayObserved(alert)} · Umbral: {thresholdLabel({ id: alert.ruleId, categoryId: alert.categoryId, metric: alert.metric, threshold: alert.threshold, enabled: true }, alert.currency)}</span>
                  <div className="button-row">
                    <button className="button small" type="button" disabled={busy} onClick={() => void decide(alert, 'snoozed')}>Posponer 7 días</button>
                    <button className="button small" type="button" disabled={busy} onClick={() => void decide(alert, 'dismissed')}>Silenciar periodo</button>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
          {data.warnings.map((warning) => <p className="form-alert warning" role="note" key={warning}>{warning}</p>)}
        </>
      ) : null}
      {error ? <p className="form-alert error" role="alert">{error}</p> : null}
      {notice ? <p className="form-alert" role="status">{notice}</p> : null}
    </article>
  );
}
