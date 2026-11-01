import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from './finance-format.js';

type Classification = 'unclassified' | 'essential' | 'protected' | 'flexible' | 'reviewable';
type Goal = 'increase_monthly_margin' | 'reduce_variable_spending' | 'reach_savings_goal' | 'free_cash_flow';
interface CategoryChoice { categoryId: string; categoryName: string; classification: Classification; }
interface Proposal {
  id: string; categoryId: string; categoryName: string; suggestedReductionPercent: number;
  observedMonthlyExpenseMinor: number; estimatedMonthlySavingsMinor: number; estimatedAnnualSavingsMinor: number;
  confidence: 'medium' | 'high'; explanation: string;
  evidence: {
    signal: 'budget_overrun' | 'recent_increase'; periodMonths: number; transactionCount: number;
    observedExpenseMinor: number; budgetedMinor: number | null; budgetSpentMinor: number | null;
    latestMonthExpenseMinor: number | null; priorMonthsAverageExpenseMinor: number | null; rule: string;
  };
  assumptions: readonly string[]; warnings: readonly string[];
}
interface Baseline {
  currency: string; startDate: string; endDate: string; periodMonths: number;
  monthlyIncomeMinor: number; monthlyExpenseMinor: number; monthlySavingsMinor: number;
  savingsRatePercent: number | null; transactionCount: number; unconvertedTransactionCount: number;
}
interface Scenario {
  id: string; name: string; currency: string; startDate: string; endDate: string;
  reductions: readonly { categoryId: string; reductionPercent: number }[];
  estimatedMonthlySavingsMinor: number; estimatedAnnualSavingsMinor: number; createdAt: string;
}
interface Decision { proposalId: string; status: 'accepted' | 'rejected' | 'postponed'; updatedAt: string; }
interface Analysis {
  asOfDate: string; currency: string; baseline: Baseline; proposals: readonly Proposal[];
  categoryChoices: readonly CategoryChoice[]; goal: Goal; decisions: readonly Decision[];
  scenarios: readonly Scenario[]; warnings: readonly string[];
}
interface Simulation {
  estimatedMonthlySavingsMinor: number; estimatedAnnualSavingsMinor: number;
  projectedMonthlySavingsMinor: number; projectedAnnualSavingsMinor: number;
  selectedCategories: readonly { categoryId: string; categoryName: string; reductionPercent: number; monthlySavingsMinor: number }[];
  assumptions: readonly string[]; warnings: readonly string[];
}
interface ApiPayload<T> { data?: T; error?: { message?: string } }
const classificationLabels: Record<Classification, string> = {
  unclassified: 'Sin clasificar', essential: 'Esencial', protected: 'Protegida', flexible: 'Flexible', reviewable: 'Revisable',
};
const goalLabels: Record<Goal, string> = {
  increase_monthly_margin: 'Aumentar margen mensual', reduce_variable_spending: 'Reducir gasto variable',
  reach_savings_goal: 'Alcanzar un objetivo de ahorro', free_cash_flow: 'Liberar flujo de caja',
};
export function BudgetImprovementPanel({ currency }: { currency: string }) {
  const [periodMonths, setPeriodMonths] = useState<3 | 6 | 12>(6);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [categoryChoices, setCategoryChoices] = useState<readonly CategoryChoice[]>([]);
  const [goal, setGoal] = useState<Goal>('increase_monthly_margin');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [percentages, setPercentages] = useState<Record<string, number>>({});
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [scenarioName, setScenarioName] = useState('Escenario de mejora');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load(): Promise<void> {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/budget-improvements?periodMonths=' + periodMonths, { headers: { Accept: 'application/json' } });
      const payload = await response.json() as ApiPayload<Analysis>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'No se pudo cargar el diagnóstico presupuestario.');
      setAnalysis(payload.data);
      setCategoryChoices(payload.data.categoryChoices);
      setGoal(payload.data.goal);
      setSelected(Object.fromEntries(payload.data.proposals.map((proposal) => [proposal.id, true])));
      setPercentages(Object.fromEntries(payload.data.proposals.map((proposal) => [proposal.id, proposal.suggestedReductionPercent])));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo cargar el análisis.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [periodMonths]);

  async function savePreferences(): Promise<void> {
    if (!analysis || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/v1/budget-improvements/preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ goal, categories: categoryChoices.map(({ categoryId, classification }) => ({ categoryId, classification })) }),
      });
      const payload = await response.json() as ApiPayload<unknown>;
      if (!response.ok) throw new Error(payload.error?.message ?? 'No se pudieron guardar las prioridades.');
      setNotice('Preferencias guardadas localmente. Las categorías esenciales y protegidas quedan excluidas de los recortes.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudieron guardar las preferencias.'); }
    finally { setBusy(false); }
  }

  const reductions = useMemo(() => analysis?.proposals
    .filter((proposal) => selected[proposal.id])
    .map((proposal) => ({ categoryId: proposal.categoryId, reductionPercent: percentages[proposal.id] ?? proposal.suggestedReductionPercent })) ?? [],
  [analysis, selected, percentages]);

  async function simulate(): Promise<void> {
    if (!analysis || reductions.length === 0 || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/v1/budget-improvements/simulate', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ periodMonths, reductions }),
      });
      const payload = await response.json() as ApiPayload<{ simulation: Simulation }>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'No se pudo simular la combinación.');
      setSimulation(payload.data.simulation);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo simular la combinación.'); }
    finally { setBusy(false); }
  }

  async function saveScenario(): Promise<void> {
    if (!analysis || !reductions.length || !scenarioName.trim() || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/v1/budget-improvements/scenarios', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ periodMonths, reductions, name: scenarioName.trim() }),
      });
      const payload = await response.json() as ApiPayload<Scenario>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'No se pudo guardar el escenario.');
      setNotice('Escenario guardado como metadatos locales. Actual Budget y los movimientos no se han modificado.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo guardar el escenario.'); }
    finally { setBusy(false); }
  }

  async function decide(proposalId: string, status: Decision['status']): Promise<void> {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/v1/budget-improvements/decisions', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ proposalId, status }),
      });
      const payload = await response.json() as ApiPayload<unknown>;
      if (!response.ok) throw new Error(payload.error?.message ?? 'No se pudo guardar la decisión.');
      setNotice('Decisión registrada localmente; no aplica cambios en Actual Budget.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo guardar la decisión.'); }
    finally { setBusy(false); }
  }

  async function deleteScenario(id: string): Promise<void> {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/budget-improvements/scenarios/' + encodeURIComponent(id), { method: 'DELETE', headers: { Accept: 'application/json' } });
      const payload = await response.json() as ApiPayload<{ deleted: boolean }>;
      if (!response.ok) throw new Error(payload.error?.message ?? 'No se pudo eliminar el escenario.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo eliminar el escenario.'); }
    finally { setBusy(false); }
  }

  const decisions = new Map((analysis?.decisions ?? []).map((item) => [item.proposalId, item.status]));
  return (
    <article className="panel planning-panel">
      <div className="panel-heading"><div><p className="eyebrow">MEJORA PRESUPUESTARIA · #83</p><h3>Propuestas personalizadas y simulaciones</h3></div></div>
      <p className="section-footnote">Diagnóstico local sobre periodos completos. Las propuestas de reducción solo aparecen para categorías que marques explícitamente como flexibles o revisables; nunca se infiere que un gasto esencial sea prescindible.</p>
      <div className="form-grid">
        <label className="field-label">Historial de referencia
          <select value={periodMonths} onChange={(event) => { setPeriodMonths(Number(event.currentTarget.value) as 3 | 6 | 12); setSimulation(null); }}>
            <option value={3}>3 meses completos</option><option value={6}>6 meses completos</option><option value={12}>12 meses completos</option>
          </select>
        </label>
        <label className="field-label">Prioridad principal
          <select value={goal} onChange={(event) => setGoal(event.currentTarget.value as Goal)}>
            {Object.entries(goalLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      {analysis ? (
        <>
          <div className="stats-grid">
            <article className="stat-card"><p>Ingresos mensuales observados</p><strong>{formatMoney(analysis.baseline.monthlyIncomeMinor, currency)}</strong></article>
            <article className="stat-card"><p>Gastos mensuales observados</p><strong>{formatMoney(analysis.baseline.monthlyExpenseMinor, currency)}</strong></article>
            <article className={'stat-card ' + (analysis.baseline.monthlySavingsMinor < 0 ? 'negative' : 'positive')}><p>Ahorro neto mensual observado</p><strong>{formatMoney(analysis.baseline.monthlySavingsMinor, currency)}</strong></article>
          </div>
          <p className="section-footnote">Periodo {analysis.baseline.startDate} — {analysis.baseline.endDate} · {analysis.baseline.transactionCount} movimientos · tasa de ahorro {analysis.baseline.savingsRatePercent === null ? 'no calculable' : analysis.baseline.savingsRatePercent.toFixed(1) + ' %'} · {analysis.baseline.unconvertedTransactionCount} movimientos sin conversión válida.</p>
          <div className="suggestion-block">
            <h4>Clasificación de prioridades</h4>
            <p className="section-footnote">La clasificación es una decisión tuya. Solo Flexible y Revisable pueden generar propuestas de reducción.</p>
            {categoryChoices.map((category) => (
              <label className="field-label" key={category.categoryId}>
                {category.categoryName}
                <select value={category.classification} disabled={busy} onChange={(event) => {
                  const classification = event.currentTarget.value as Classification;
                  setCategoryChoices((current) => current.map((item) => item.categoryId === category.categoryId ? { ...item, classification } : item));
                }}>
                  {Object.entries(classificationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            ))}
            <button className="button secondary" type="button" disabled={busy} onClick={() => void savePreferences()}>{busy ? 'Guardando…' : 'Guardar prioridades'}</button>
          </div>
          <div className="suggestion-block">
            <h4>Propuestas basadas en evidencia ({analysis.proposals.length})</h4>
            {analysis.proposals.length === 0 ? <p className="muted-copy">No hay propuestas fiables todavía. Clasifica alguna categoría flexible o revisable y asegúrate de que exista historial suficiente.</p> : null}
            {analysis.proposals.map((proposal) => (
              <div className="comparison-row" key={proposal.id}>
                <div><strong>{proposal.categoryName}</strong><span>Gasto observado medio: {formatMoney(proposal.observedMonthlyExpenseMinor, currency)} / mes</span></div>
                <div className="comparison-meta">
                  <p>{proposal.explanation}</p>
                  <span>Señal: {proposal.evidence.signal === 'budget_overrun' ? 'exceso frente al presupuesto del último mes completo' : 'aumento frente a la media histórica'}.</span>
                  <span>{proposal.evidence.transactionCount} movimientos en {proposal.evidence.periodMonths} meses · confianza {proposal.confidence === 'high' ? 'alta' : 'media'}</span>
                  <span>Ahorro hipotético sugerido al {proposal.suggestedReductionPercent} %: {formatMoney(proposal.estimatedMonthlySavingsMinor, currency)} / mes · {formatMoney(proposal.estimatedAnnualSavingsMinor, currency)} / año.</span>
                  <span>{proposal.evidence.rule}</span>
                  <label className="field-label compact-label"><input type="checkbox" checked={Boolean(selected[proposal.id])} onChange={(event) => setSelected((current) => ({ ...current, [proposal.id]: event.currentTarget.checked }))} /> Incluir en el escenario</label>
                  <label className="field-label compact-label">Reducción hipotética (%)
                    <input type="number" min={1} max={100} step={1} value={percentages[proposal.id] ?? proposal.suggestedReductionPercent} onChange={(event) => setPercentages((current) => ({ ...current, [proposal.id]: Number(event.currentTarget.value) }))} />
                  </label>
                  {proposal.warnings.map((warning) => <span className="warning-text" key={warning}>{warning}</span>)}
                  <div className="button-row">
                    <button className="button small" type="button" disabled={busy} onClick={() => void decide(proposal.id, 'accepted')}>Aceptar propuesta</button>
                    <button className="button small" type="button" disabled={busy} onClick={() => void decide(proposal.id, 'postponed')}>Posponer</button>
                    <button className="button small" type="button" disabled={busy} onClick={() => void decide(proposal.id, 'rejected')}>Descartar</button>
                    {decisions.get(proposal.id) ? <span className="muted-label">Decisión: {decisions.get(proposal.id)}</span> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="panel confirmation-panel">
            <h4>Comparar una combinación</h4>
            <p className="section-footnote">Una categoría aparece como máximo una vez en cada combinación. Las cifras son simulaciones deterministas, no ahorro garantizado.</p>
            <button className="button primary" type="button" disabled={busy || reductions.length === 0} onClick={() => void simulate()}>{busy ? 'Calculando…' : 'Simular selección'}</button>
            {simulation ? (
              <div className="forecast-result">
                <div className="stats-grid">
                  <article className="stat-card"><p>Ahorro adicional estimado / mes</p><strong>{formatMoney(simulation.estimatedMonthlySavingsMinor, currency)}</strong></article>
                  <article className="stat-card"><p>Ahorro adicional estimado / año</p><strong>{formatMoney(simulation.estimatedAnnualSavingsMinor, currency)}</strong></article>
                  <article className="stat-card"><p>Nuevo ahorro mensual estimado</p><strong>{formatMoney(simulation.projectedMonthlySavingsMinor, currency)}</strong></article>
                </div>
                {simulation.assumptions.map((assumption) => <p className="section-footnote" key={assumption}>{assumption}</p>)}
                <label className="field-label">Nombre del escenario<input value={scenarioName} onChange={(event) => setScenarioName(event.currentTarget.value)} maxLength={80} /></label>
                <button className="button secondary" type="button" disabled={busy} onClick={() => void saveScenario()}>Guardar escenario local</button>
              </div>
            ) : null}
          </div>
          {analysis.scenarios.length ? (
            <div className="suggestion-block">
              <h4>Escenarios guardados ({analysis.scenarios.length})</h4>
              {analysis.scenarios.map((scenario) => (
                <div className="comparison-row" key={scenario.id}>
                  <div><strong>{scenario.name}</strong><span>{scenario.startDate} — {scenario.endDate}</span></div>
                  <div className="comparison-meta">
                    <span>{formatMoney(scenario.estimatedMonthlySavingsMinor, currency)} / mes · {formatMoney(scenario.estimatedAnnualSavingsMinor, currency)} / año</span>
                    <button className="button small" type="button" disabled={busy} onClick={() => void deleteScenario(scenario.id)}>Eliminar escenario</button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {analysis.warnings.map((warning) => <p className="form-alert warning" role="note" key={warning}>{warning}</p>)}
        </>
      ) : null}
      {error ? <p className="form-alert error" role="alert">{error}</p> : null}
      {notice ? <p className="form-alert" role="status">{notice}</p> : null}
    </article>
  );
}
