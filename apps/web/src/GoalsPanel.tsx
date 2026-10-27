import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatMoney as sharedFormatMoney } from './finance-format.js';

type Direction = 'expense' | 'income';
type Frequency = 'once' | 'monthly' | 'quarterly' | 'yearly';
type PlanningStatus = 'active' | 'paused';
interface AccountScope { mode: 'all' | 'selected'; accountIds: readonly string[]; }
interface ScopeMetadata { label: string; accountIds: readonly string[]; accountNames?: readonly string[]; }
interface MonthlyProjectionRow {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  commitmentIncomeMinor: number;
  commitmentExpenseMinor: number;
  availableCashMinor: number;
  plannedContributionMinor: number;
  actualContributionMinor: number;
  projectedBalanceMinor: number;
}
interface GoalProjection {
  isEstimate: true;
  currency: string;
  asOfDate: string;
  targetDate: string;
  targetAmountMinor: number;
  initialAmountMinor: number;
  monthlyContributionMinor: number;
  requiredMonthlyContributionMinor: number | null;
  progressPercent: number;
  projectedBalanceMinor: number;
  projectedProgressPercent: number;
  maximumAchievableBalanceMinor: number;
  achievableUnderCashFlow: boolean;
  goalReachedInitially: boolean;
  estimatedCompletionDate: string | null;
  months: number;
  monthlyProjection: readonly MonthlyProjectionRow[];
  assumptions: readonly string[];
  warnings: readonly string[];
}
interface Goal {
  id: string;
  name: string;
  targetAmountMinor: number;
  initialAmountMinor: number;
  monthlyContributionMinor: number;
  targetDate: string;
  monthlyIncomeMinor: number | null;
  monthlyExpenseMinor: number | null;
  currency: string;
  scope: AccountScope;
  status: PlanningStatus;
  createdAt: string;
  updatedAt: string;
  scopeMatches: boolean;
  currencyMatches: boolean;
  projection: GoalProjection | null;
  planningWarnings: readonly string[];
}
interface Commitment {
  id: string;
  title: string;
  amountMinor: number;
  date: string;
  direction: Direction;
  frequency: Frequency;
  notes?: string;
  currency: string;
  scope: AccountScope;
  status: PlanningStatus;
  createdAt: string;
  updatedAt: string;
  scopeMatches: boolean;
  currencyMatches: boolean;
}
interface CalendarItem {
  id: string;
  source: 'manual_commitment' | 'actual_transaction' | 'recurring_candidate';
  title: string;
  date: string;
  amountMinor: number;
  direction: Direction;
  frequency: string;
  frequencyLabel?: string;
  currency: string;
  status: string;
  notes?: string;
}
interface PlanningData {
  asOfDate: string;
  month: string;
  currency: string;
  accountScope: ScopeMetadata;
  history: {
    startDate: string;
    endDate: string;
    monthlyIncomeMinor: number;
    monthlyExpenseMinor: number;
    emptyMonths: number;
    assumptions: readonly string[];
    warnings: readonly string[];
  };
  goals: readonly Goal[];
  commitments: readonly Commitment[];
  calendarItems: readonly CalendarItem[];
  warnings: readonly string[];
  notes: readonly string[];
}
interface ApiPayload<T> { data?: T; error?: { code?: string; message?: string }; }
interface GoalDraft {
  name: string;
  targetAmount: string;
  initialAmount: string;
  monthlyContribution: string;
  targetDate: string;
  monthlyIncome: string;
  monthlyExpense: string;
}
interface CommitmentDraft {
  title: string;
  amount: string;
  date: string;
  direction: Direction;
  frequency: Frequency;
  notes: string;
}

function localDate(date = new Date()): string {
  return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function futureDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}
function monthNow(): string { return localDate().slice(0, 7); }
function inputAmount(amountMinor: number | null | undefined): string {
  return amountMinor === null || amountMinor === undefined ? '' : (amountMinor / 100).toFixed(2);
}
function toMinor(value: string, label: string, allowNegative = false, allowZero = true): number {
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!normalized) throw new Error(label + ': introduce un importe.');
  const amount = Number(normalized);
  const minor = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(minor) || (!allowNegative && minor < 0) || (!allowZero && minor === 0)) {
    throw new Error(label + ': introduce un importe válido en unidades monetarias.');
  }
  return minor;
}
function money(amountMinor: number, currency: string): string {
  return sharedFormatMoney(amountMinor, currency);
}
function civilDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(date + 'T12:00:00.000Z'));
}
function monthTitle(month: string): string {
  return new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(month + '-01T12:00:00.000Z'));
}
function emptyGoalDraft(): GoalDraft {
  return { name: '', targetAmount: '', initialAmount: '0.00', monthlyContribution: '100.00', targetDate: futureDate(180), monthlyIncome: '', monthlyExpense: '' };
}
function emptyCommitmentDraft(): CommitmentDraft {
  return { title: '', amount: '', date: futureDate(1), direction: 'expense', frequency: 'once', notes: '' };
}
async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const payload = await response.json() as ApiPayload<T>;
  if (!response.ok || payload.data === undefined) throw new Error(payload.error?.message ?? 'La API local no pudo completar la operación.');
  return payload.data;
}

export function GoalsPanel({ currency }: { currency: string }) {
  const [data, setData] = useState<PlanningData | null>(null);
  const [month, setMonth] = useState(monthNow);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [goalDraft, setGoalDraft] = useState<GoalDraft>(emptyGoalDraft);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [commitmentDraft, setCommitmentDraft] = useState<CommitmentDraft>(emptyCommitmentDraft);
  const [editingCommitmentId, setEditingCommitmentId] = useState<string | null>(null);
  const [agendaView, setAgendaView] = useState<'list' | 'calendar'>('list');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch('/api/v1/planning?month=' + encodeURIComponent(month), {
          signal: controller.signal, headers: { Accept: 'application/json' },
        });
        const payload = await response.json() as ApiPayload<PlanningData>;
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'No se pudo consultar la planificación local.');
        setData(payload.data);
        setLoadError('');
      } catch (caught) {
        if (!controller.signal.aborted) setLoadError(caught instanceof Error ? caught.message : 'No se pudo consultar la planificación local.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [month, reloadKey]);

  const effectiveCurrency = data?.currency ?? currency;
  const days = useMemo(() => {
    const [year, monthNumber] = month.split('-').map(Number);
    const count = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
    const offset = (new Date(Date.UTC(year!, monthNumber! - 1, 1)).getUTCDay() + 6) % 7;
    return [
      ...Array.from({ length: offset }, (_item, index) => ({ date: '', day: index, empty: true })),
      ...Array.from({ length: count }, (_item, index) => ({ date: month + '-' + String(index + 1).padStart(2, '0'), day: index + 1, empty: false })),
    ];
  }, [month]);
  const sortedCommitments = useMemo(() => [...(data?.commitments ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)), [data?.commitments]);

  async function runMutation(url: string, method: string, body: unknown, success: string): Promise<boolean> {
    setBusy(true); setError(''); setNotice('');
    try {
      await apiRequest<unknown>(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      setNotice(success);
      setReloadKey((value) => value + 1);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'La operación no se pudo completar.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveGoal(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const body = {
        name: goalDraft.name.trim(),
        targetAmountMinor: toMinor(goalDraft.targetAmount, 'Objetivo', false, false),
        initialAmountMinor: toMinor(goalDraft.initialAmount, 'Ahorro inicial'),
        monthlyContributionMinor: toMinor(goalDraft.monthlyContribution, 'Aportación mensual'),
        targetDate: goalDraft.targetDate,
        monthlyIncomeMinor: goalDraft.monthlyIncome.trim() ? toMinor(goalDraft.monthlyIncome, 'Ingreso mensual supuesto', true) : null,
        monthlyExpenseMinor: goalDraft.monthlyExpense.trim() ? toMinor(goalDraft.monthlyExpense, 'Gasto mensual supuesto') : null,
      };
      const saved = await runMutation(editingGoalId ? '/api/v1/planning/goals/' + editingGoalId : '/api/v1/planning/goals',
        editingGoalId ? 'PUT' : 'POST', body, editingGoalId ? 'Objetivo actualizado y recalculado con el ámbito actual.' : 'Objetivo guardado localmente.');
      if (!saved) return;
      setGoalDraft(emptyGoalDraft());
      setEditingGoalId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Revisa los datos del objetivo.');
    }
  }

  async function saveCommitment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const body = {
        title: commitmentDraft.title.trim(),
        amountMinor: toMinor(commitmentDraft.amount, 'Importe del compromiso', false, false),
        date: commitmentDraft.date,
        direction: commitmentDraft.direction,
        frequency: commitmentDraft.frequency,
        notes: commitmentDraft.notes.trim(),
      };
      const saved = await runMutation(editingCommitmentId ? '/api/v1/planning/commitments/' + editingCommitmentId : '/api/v1/planning/commitments',
        editingCommitmentId ? 'PUT' : 'POST', body, editingCommitmentId ? 'Compromiso actualizado.' : 'Compromiso guardado como hipótesis local.');
      if (!saved) return;
      setCommitmentDraft(emptyCommitmentDraft());
      setEditingCommitmentId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Revisa los datos del compromiso.');
    }
  }

  function editGoal(goal: Goal): void {
    setEditingGoalId(goal.id);
    setGoalDraft({
      name: goal.name,
      targetAmount: inputAmount(goal.targetAmountMinor),
      initialAmount: inputAmount(goal.initialAmountMinor),
      monthlyContribution: inputAmount(goal.monthlyContributionMinor),
      targetDate: goal.targetDate,
      monthlyIncome: inputAmount(goal.monthlyIncomeMinor),
      monthlyExpense: inputAmount(goal.monthlyExpenseMinor),
    });
    setError(''); setNotice('');
    document.getElementById('goal-form-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function editCommitment(commitment: Commitment): void {
    setEditingCommitmentId(commitment.id);
    setCommitmentDraft({
      title: commitment.title,
      amount: inputAmount(commitment.amountMinor),
      date: commitment.date,
      direction: commitment.direction,
      frequency: commitment.frequency,
      notes: commitment.notes ?? '',
    });
    setError(''); setNotice('');
    document.getElementById('commitment-form-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function deleteAllPlanningData(): Promise<void> {
    const accepted = window.confirm('¿Eliminar definitivamente todos los objetivos y compromisos locales? No se modificará ningún movimiento ni presupuesto de Actual Budget.');
    if (!accepted) return;
    const deleted = await runMutation('/api/v1/planning/reset', 'POST', { confirmation: 'DELETE_PLANNING_DATA' }, 'Se han eliminado los objetivos y compromisos locales.');
    if (!deleted) return;
    setEditingGoalId(null); setGoalDraft(emptyGoalDraft());
    setEditingCommitmentId(null); setCommitmentDraft(emptyCommitmentDraft());
  }

  const itemsByDate = useMemo(() => {
    const result = new Map<string, CalendarItem[]>();
    for (const item of data?.calendarItems ?? []) {
      const rows = result.get(item.date) ?? [];
      rows.push(item); result.set(item.date, rows);
    }
    return result;
  }, [data?.calendarItems]);

  function renderCalendarItem(item: CalendarItem) {
    const sourceLabel = item.source === 'manual_commitment'
      ? 'Compromiso manual'
      : item.source === 'actual_transaction' ? 'Registrado en Actual' : 'Candidato recurrente';
    const className = item.source === 'manual_commitment'
      ? 'agenda-item agenda-manual'
      : item.source === 'actual_transaction' ? 'agenda-item agenda-actual' : 'agenda-item agenda-candidate';
    return (
      <article className={className} key={item.id}>
        <div className="agenda-item-heading"><strong>{item.title}</strong><span className="agenda-source">{sourceLabel}</span></div>
        <p>{item.direction === 'expense' ? 'Salida' : 'Entrada'} · {money(item.amountMinor, effectiveCurrency)}</p>
        <p className="agenda-item-meta">{item.frequencyLabel ?? item.frequency} · {civilDate(item.date)}</p>
        {item.notes ? <p className="agenda-item-note">{item.notes}</p> : null}
      </article>
    );
  }

  return (
    <section className="content-section goals-page" aria-labelledby="goals-heading">
      <div className="section-heading goals-page-heading">
        <div>
          <p className="eyebrow">PLANIFICACIÓN FINANCIERA · LOCAL</p>
          <h2 id="goals-heading">Objetivos de ahorro y compromisos</h2>
          <p className="section-context">Cálculos deterministas, sin conexión bancaria, pagos ni escrituras sobre Actual Budget.</p>
        </div>
        <button className="button secondary" type="button" disabled={busy} onClick={() => { void deleteAllPlanningData(); }}>Borrar planificación local</button>
      </div>

      {loadError ? <p className="form-alert error" role="alert">{loadError}</p> : null}
      {error ? <p className="form-alert error" role="alert">{error}</p> : null}
      {notice ? <p className="form-alert success" role="status">{notice}</p> : null}
      {loading && !data ? <p className="muted-copy" role="status">Cargando objetivos y compromisos locales…</p> : null}
      {data ? (
        <>
          <div className="planning-context-strip" aria-label="Contexto de la planificación">
            <span><strong>Divisa</strong> {data.currency}</span>
            <span><strong>Cuentas</strong> {data.accountScope.label}</span>
            <span><strong>Historial</strong> {civilDate(data.history.startDate)} – {civilDate(data.history.endDate)}</span>
            <span><strong>Origen</strong> Datos locales y estimaciones</span>
          </div>
          {data.warnings.length ? <ul className="warning-list goals-warning-list">{[...new Set(data.warnings)].map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}

          <article className="panel goals-form-panel" aria-labelledby="goal-form-heading">
            <div className="panel-heading"><div><p className="eyebrow">OBJETIVO PERSONAL</p><h3 id="goal-form-heading">{editingGoalId ? 'Editar objetivo de ahorro' : 'Crear objetivo de ahorro'}</h3></div></div>
            <p className="setting-hint">Define cantidad, fecha, ahorro inicial y aportación mensual. Los ingresos/gastos supuestos pueden sustituir la mediana histórica; déjalos vacíos para usar el historial local de 12 meses.</p>
            <form onSubmit={(event) => { void saveGoal(event); }}>
              <div className="form-grid goals-form-grid">
                <label className="field-label">Nombre del objetivo
                  <input value={goalDraft.name} maxLength={100} required onChange={(event) => setGoalDraft((prev) => ({ ...prev, name: event.currentTarget.value }))} placeholder="Fondo de emergencia" />
                </label>
                <label className="field-label">Cantidad objetivo ({effectiveCurrency})
                  <input value={goalDraft.targetAmount} required inputMode="decimal" autoComplete="off" onChange={(event) => setGoalDraft((prev) => ({ ...prev, targetAmount: event.currentTarget.value }))} placeholder="5000,00" />
                </label>
                <label className="field-label">Ahorro inicial ({effectiveCurrency})
                  <input value={goalDraft.initialAmount} required inputMode="decimal" autoComplete="off" onChange={(event) => setGoalDraft((prev) => ({ ...prev, initialAmount: event.currentTarget.value }))} />
                </label>
                <label className="field-label">Aportación mensual deseada ({effectiveCurrency})
                  <input value={goalDraft.monthlyContribution} required inputMode="decimal" autoComplete="off" onChange={(event) => setGoalDraft((prev) => ({ ...prev, monthlyContribution: event.currentTarget.value }))} />
                </label>
                <label className="field-label">Fecha objetivo
                  <input type="date" min={futureDate(1)} value={goalDraft.targetDate} required onChange={(event) => setGoalDraft((prev) => ({ ...prev, targetDate: event.currentTarget.value }))} />
                </label>
                <label className="field-label">Ingreso mensual supuesto ({effectiveCurrency})
                  <input value={goalDraft.monthlyIncome} inputMode="decimal" autoComplete="off" onChange={(event) => setGoalDraft((prev) => ({ ...prev, monthlyIncome: event.currentTarget.value }))} placeholder={'Historial: ' + money(data.history.monthlyIncomeMinor, effectiveCurrency)} />
                </label>
                <label className="field-label">Gasto mensual supuesto ({effectiveCurrency})
                  <input value={goalDraft.monthlyExpense} inputMode="decimal" autoComplete="off" onChange={(event) => setGoalDraft((prev) => ({ ...prev, monthlyExpense: event.currentTarget.value }))} placeholder={'Historial: ' + money(data.history.monthlyExpenseMinor, effectiveCurrency)} />
                </label>
              </div>
              <p className="section-footnote">La divisa y el ámbito de cuentas actuales quedan vinculados al objetivo al guardarlo. Si cambian después, deberás revisar y confirmar de nuevo el registro.</p>
              <div className="button-row">
                <button className="button primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : editingGoalId ? 'Guardar objetivo' : 'Crear objetivo'}</button>
                {editingGoalId ? <button className="button secondary" type="button" disabled={busy} onClick={() => { setEditingGoalId(null); setGoalDraft(emptyGoalDraft()); }}>Cancelar edición</button> : null}
              </div>
            </form>
          </article>

          <section aria-labelledby="goals-list-heading" className="goals-list-section">
            <div className="panel-heading"><div><p className="eyebrow">SEGUIMIENTO</p><h3 id="goals-list-heading">Tus objetivos ({data.goals.length})</h3></div></div>
            {data.goals.length === 0 ? <p className="muted-copy">Todavía no hay objetivos. Define uno para ver progreso y escenarios estimados.</p> : null}
            <div className="goals-cards-grid">
              {data.goals.map((goal) => {
                const projection = goal.projection;
                const progress = projection?.projectedProgressPercent ?? Math.min(100, goal.initialAmountMinor / goal.targetAmountMinor * 100);
                return (
                  <article className="panel goal-card" key={goal.id}>
                    <div className="goal-card-top">
                      <div><p className="eyebrow">{goal.status === 'active' ? 'OBJETIVO ACTIVO' : 'OBJETIVO EN PAUSA'}</p><h4>{goal.name}</h4></div>
                      <span className={'status-label ' + (goal.status === 'active' ? 'status-active' : 'status-paused')}>{goal.status === 'active' ? 'Activo' : 'En pausa'}</span>
                    </div>
                    <div className="goal-amount-row"><strong>{money(goal.targetAmountMinor, goal.currency)}</strong><span>Objetivo · {civilDate(goal.targetDate)}</span></div>
                    <div className="goal-progress-wrap">
                      <div><span>Progreso estimado</span><strong>{progress.toFixed(1)} %</strong></div>
                      <progress className="goal-progress" aria-label={'Progreso hacia ' + goal.name} max={100} value={Math.max(0, Math.min(100, progress))} />
                    </div>
                    <div className="goal-metrics">
                      <div><span>Ahorro inicial</span><strong>{money(goal.initialAmountMinor, goal.currency)}</strong></div>
                      <div><span>Aportación deseada</span><strong>{money(goal.monthlyContributionMinor, goal.currency)}/mes</strong></div>
                      <div><span>Saldo proyectado</span><strong>{projection ? money(projection.projectedBalanceMinor, goal.currency) : 'No disponible'}</strong></div>
                      <div><span>Aportación necesaria aprox.</span><strong>{projection?.requiredMonthlyContributionMinor === null || !projection ? 'No calculable' : money(projection.requiredMonthlyContributionMinor, goal.currency) + '/mes'}</strong></div>
                    </div>
                    {projection ? (
                      <>
                        <p className="goal-outcome">{projection.goalReachedInitially
                          ? 'El saldo inicial ya alcanza el objetivo.'
                          : projection.estimatedCompletionDate
                            ? 'Finalización estimada: ' + civilDate(projection.estimatedCompletionDate)
                            : projection.achievableUnderCashFlow
                              ? 'El flujo estimado podría permitir alcanzar la meta; la aportación configurada se queda corta.'
                              : 'La meta no es alcanzable con los supuestos actuales.'}</p>
                        <p className="section-footnote">Máximo estimado según el efectivo disponible: {money(projection.maximumAchievableBalanceMinor, goal.currency)}. Horizonte: {projection.months} mes(es). No es una garantía.</p>
                        {projection.warnings.length ? <ul className="warning-list">{projection.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
                        <details className="goal-projection-details">
                          <summary>Ver evolución mensual y supuestos</summary>
                          {projection.monthlyProjection.length ? (
                            <div className="goal-projection-table-wrap" role="region" tabIndex={0} aria-label={'Proyección mensual de ' + goal.name}>
                              <table className="goal-projection-table">
                                <thead><tr><th scope="col">Mes</th><th scope="col">Efectivo disponible</th><th scope="col">Compromisos</th><th scope="col">Aportación</th><th scope="col">Saldo estimado</th></tr></thead>
                                <tbody>{projection.monthlyProjection.map((row) => (
                                  <tr key={row.month}>
                                    <th scope="row">{row.month}</th>
                                    <td>{money(row.availableCashMinor, goal.currency)}</td>
                                    <td>{money(row.commitmentIncomeMinor - row.commitmentExpenseMinor, goal.currency)}</td>
                                    <td>{money(row.actualContributionMinor, goal.currency)}</td>
                                    <td>{money(row.projectedBalanceMinor, goal.currency)}</td>
                                  </tr>
                                ))}</tbody>
                              </table>
                            </div>
                          ) : <p className="muted-copy">No hay meses completos antes de la fecha objetivo.</p>}
                          <h5>Supuestos del cálculo</h5>
                          <ul className="assumption-list">{projection.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
                        </details>
                      </>
                    ) : <p className="form-alert error" role="status">No se genera una proyección: {goal.planningWarnings.join(' ') || 'el objetivo está en pausa o falta un ámbito válido.'}</p>}
                    {(!goal.scopeMatches || !goal.currencyMatches) ? <p className="form-alert error" role="alert">El contexto guardado no coincide con la configuración actual. Edita el objetivo para revisar y confirmar los importes.</p> : null}
                    <div className="button-row goal-actions">
                      <button className="button secondary" type="button" disabled={busy} onClick={() => editGoal(goal)}>Editar</button>
                      <button className="button secondary" type="button" disabled={busy} onClick={() => { void runMutation('/api/v1/planning/goals/' + goal.id + '/status', 'PATCH', { status: goal.status === 'active' ? 'paused' : 'active' }, goal.status === 'active' ? 'Objetivo pausado.' : 'Objetivo reanudado.'); }}>{goal.status === 'active' ? 'Pausar' : 'Reanudar'}</button>
                      <button className="button danger" type="button" disabled={busy} onClick={() => { if (window.confirm('¿Eliminar el objetivo «' + goal.name + '»? No se modificará Actual Budget.')) void runMutation('/api/v1/planning/goals/' + goal.id, 'DELETE', undefined, 'Objetivo eliminado.'); }}>Eliminar</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <article className="panel goals-form-panel" aria-labelledby="commitment-form-heading">
            <div className="panel-heading"><div><p className="eyebrow">PAGOS E INGRESOS FUTUROS</p><h3 id="commitment-form-heading">{editingCommitmentId ? 'Editar compromiso' : 'Añadir compromiso futuro'}</h3></div></div>
            <p className="setting-hint">Registra pagos o ingresos previstos conocidos, como seguros, tasas o una paga extra. Son hipótesis locales: no crean transacciones ni ejecutan pagos.</p>
            <form onSubmit={(event) => { void saveCommitment(event); }}>
              <div className="form-grid goals-form-grid">
                <label className="field-label">Concepto
                  <input value={commitmentDraft.title} maxLength={100} required onChange={(event) => setCommitmentDraft((prev) => ({ ...prev, title: event.currentTarget.value }))} placeholder="Seguro anual del hogar" />
                </label>
                <label className="field-label">Importe positivo ({effectiveCurrency})
                  <input value={commitmentDraft.amount} required inputMode="decimal" onChange={(event) => setCommitmentDraft((prev) => ({ ...prev, amount: event.currentTarget.value }))} placeholder="360,00" />
                </label>
                <label className="field-label">Fecha inicial
                  <input type="date" required min={commitmentDraft.frequency === 'once' ? futureDate(1) : undefined} value={commitmentDraft.date} onChange={(event) => setCommitmentDraft((prev) => ({ ...prev, date: event.currentTarget.value }))} />
                </label>
                <label className="field-label">Tipo de flujo
                  <select value={commitmentDraft.direction} onChange={(event) => setCommitmentDraft((prev) => ({ ...prev, direction: event.currentTarget.value as Direction }))}>
                    <option value="expense">Pago / salida</option>
                    <option value="income">Ingreso previsto</option>
                  </select>
                </label>
                <label className="field-label">Frecuencia
                  <select value={commitmentDraft.frequency} onChange={(event) => setCommitmentDraft((prev) => ({ ...prev, frequency: event.currentTarget.value as Frequency }))}>
                    <option value="once">Una vez</option>
                    <option value="monthly">Mensual</option>
                    <option value="quarterly">Trimestral</option>
                    <option value="yearly">Anual</option>
                  </select>
                </label>
                <label className="field-label">Notas (opcional)
                  <input value={commitmentDraft.notes} maxLength={500} onChange={(event) => setCommitmentDraft((prev) => ({ ...prev, notes: event.currentTarget.value }))} placeholder="Hipótesis introducida manualmente" />
                </label>
              </div>
              <p className="section-footnote">Los compromisos activos afectan a los meses correspondientes de los objetivos compatibles con la misma divisa y el mismo ámbito de cuentas.</p>
              <div className="button-row">
                <button className="button primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : editingCommitmentId ? 'Guardar compromiso' : 'Añadir compromiso'}</button>
                {editingCommitmentId ? <button className="button secondary" type="button" disabled={busy} onClick={() => { setEditingCommitmentId(null); setCommitmentDraft(emptyCommitmentDraft()); }}>Cancelar edición</button> : null}
              </div>
            </form>
          </article>

          <section className="goals-commitment-management" aria-labelledby="commitment-list-heading">
            <div className="panel-heading"><div><p className="eyebrow">REGISTROS LOCALES</p><h3 id="commitment-list-heading">Compromisos guardados ({sortedCommitments.length})</h3></div></div>
            {sortedCommitments.length === 0 ? <p className="muted-copy">Aún no hay compromisos guardados. Los elementos de la agenda pueden incluir también operaciones ya registradas o candidatos no confirmados.</p> : null}
            <div className="commitment-management-list">
              {sortedCommitments.map((commitment) => (
                <article className="panel commitment-card" key={commitment.id}>
                  <div className="goal-card-top">
                    <div><p className="eyebrow">{commitment.direction === 'expense' ? 'SALIDA PREVISTA' : 'ENTRADA PREVISTA'}</p><h4>{commitment.title}</h4></div>
                    <span className={'status-label ' + (commitment.status === 'active' ? 'status-active' : 'status-paused')}>{commitment.status === 'active' ? 'Activo' : 'En pausa'}</span>
                  </div>
                  <div className="goal-amount-row"><strong>{money(commitment.amountMinor, commitment.currency)}</strong><span>{commitment.frequency === 'once' ? 'Una vez' : commitment.frequency === 'monthly' ? 'Mensual' : commitment.frequency === 'quarterly' ? 'Trimestral' : 'Anual'} · Fecha ancla {civilDate(commitment.date)}</span></div>
                  {commitment.notes ? <p className="section-context">{commitment.notes}</p> : null}
                  {(!commitment.scopeMatches || !commitment.currencyMatches) ? (
                    <p className="form-alert error" role="alert">
                      {!commitment.scopeMatches ? 'El ámbito de cuentas guardado ha cambiado. ' : ''}
                      {!commitment.currencyMatches ? 'La divisa de análisis ha cambiado. ' : ''}
                      Este compromiso queda excluido de la proyección hasta editarlo y confirmar el contexto actual.
                    </p>
                  ) : null}
                  <div className="button-row">
                    <button className="button secondary" type="button" disabled={busy} onClick={() => editCommitment(commitment)}>Editar</button>
                    <button className="button secondary" type="button" disabled={busy} onClick={() => { void runMutation('/api/v1/planning/commitments/' + commitment.id + '/status', 'PATCH', { status: commitment.status === 'active' ? 'paused' : 'active' }, commitment.status === 'active' ? 'Compromiso pausado.' : 'Compromiso reanudado.'); }}>{commitment.status === 'active' ? 'Pausar' : 'Reanudar'}</button>
                    <button className="button danger" type="button" disabled={busy} onClick={() => { if (window.confirm('¿Eliminar el compromiso «' + commitment.title + '»? No se modificará Actual Budget.')) void runMutation('/api/v1/planning/commitments/' + commitment.id, 'DELETE', undefined, 'Compromiso eliminado.'); }}>Eliminar</button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel goals-agenda-panel" aria-labelledby="agenda-heading">
            <div className="panel-heading goals-agenda-heading">
              <div><p className="eyebrow">CALENDARIO FINANCIERO</p><h3 id="agenda-heading">Compromisos y próximos movimientos</h3></div>
              <label className="field-label agenda-month-picker">Mes
                <input type="month" value={month} onChange={(event) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.currentTarget.value)) setMonth(event.currentTarget.value); }} />
              </label>
            </div>
            <div className="agenda-legend" aria-label="Origen de los elementos">
              <span><i className="agenda-legend-mark agenda-manual-mark" aria-hidden="true" /> Compromiso manual</span>
              <span><i className="agenda-legend-mark agenda-actual-mark" aria-hidden="true" /> Movimiento registrado en Actual</span>
              <span><i className="agenda-legend-mark agenda-candidate-mark" aria-hidden="true" /> Candidato recurrente no confirmado</span>
            </div>
            <div className="agenda-view-controls" role="group" aria-label="Vista de agenda">
              <button type="button" className={'button ' + (agendaView === 'list' ? 'primary' : 'secondary')} aria-pressed={agendaView === 'list'} onClick={() => setAgendaView('list')}>Lista accesible</button>
              <button type="button" className={'button ' + (agendaView === 'calendar' ? 'primary' : 'secondary')} aria-pressed={agendaView === 'calendar'} onClick={() => setAgendaView('calendar')}>Calendario mensual</button>
            </div>
            <h4 className="agenda-month-title">{monthTitle(month)}</h4>
            {agendaView === 'list' ? (
              <div className="agenda-list" aria-label={'Elementos de agenda para ' + monthTitle(month)}>
                {(data.calendarItems ?? []).map((item) => renderCalendarItem(item))}
                {data.calendarItems.length === 0 ? <p className="muted-copy">No hay compromisos activos ni movimientos/candidatos futuros para este mes.</p> : null}
              </div>
            ) : (
              <div className="agenda-calendar" aria-label={'Calendario de ' + monthTitle(month)}>
                <div className="goals-calendar-weekdays" aria-hidden="true">{['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((day) => <span key={day}>{day}</span>)}</div>
                <div className="goals-calendar-grid">
                  {days.map((day, index) => day.empty ? (
                    <div className="calendar-day calendar-day-empty" aria-hidden="true" key={'empty-' + index} />
                  ) : (
                    <section className="calendar-day" aria-label={civilDate(day.date)} key={day.date}>
                      <h5>{day.day}</h5>
                      {(itemsByDate.get(day.date) ?? []).map((item) => renderCalendarItem(item))}
                    </section>
                  ))}
                </div>
                {data.calendarItems.length === 0 ? <p className="muted-copy">No hay elementos de agenda para este mes.</p> : null}
              </div>
            )}
            <p className="section-footnote">La lista y el calendario representan exactamente los mismos elementos. Un candidato recurrente es solo una estimación; un movimiento registrado ya existe en Actual y no se edita aquí.</p>
          </section>

          <details className="panel planning-data-management">
            <summary>Datos locales, ámbito y copias de seguridad</summary>
            <p>Los objetivos y compromisos se guardan en <code>planning-data.json</code> en el directorio de datos de la API, con escritura atómica y permisos restrictivos. El archivo está separado de las cuentas y los movimientos de Actual Budget.</p>
            <p>La copia cifrada existente de Actual solo incluye el directorio de datos del servidor de Actual; no incluye este archivo de planificación. Exporta o conserva este archivo por un procedimiento local seguro si necesitas respaldar estos datos. Puedes borrarlo desde esta pantalla; el borrado no afecta a movimientos ni a backups de Actual.</p>
            {data.notes.map((note) => <p key={note}>{note}</p>)}
          </details>
        </>
      ) : null}
    </section>
  );
}

interface DashboardGoalSummary {
  goals: readonly Pick<Goal, 'id' | 'name' | 'status' | 'projection' | 'scopeMatches' | 'currencyMatches'>[];
  calendarItems: readonly CalendarItem[];
  asOfDate: string;
  currency: string;
}
export function GoalsDashboardSummary({ currency, onNavigate, reloadKey = 0 }: { currency: string; onNavigate: (href: string) => void; reloadKey?: number }) {
  const [summary, setSummary] = useState<DashboardGoalSummary | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/v1/planning?month=' + encodeURIComponent(monthNow()), {
          signal: controller.signal, headers: { Accept: 'application/json' },
        });
        const payload = await response.json() as ApiPayload<DashboardGoalSummary>;
        if (response.ok && payload.data && !controller.signal.aborted) setSummary(payload.data);
      } catch {
        // Planning is optional to the dashboard and must not break core financial views.
      }
    })();
    return () => controller.abort();
  }, [reloadKey]);

  if (!summary) {
    return (
      <section className="panel goals-dashboard-panel" aria-labelledby="goals-dashboard-heading">
        <div className="panel-heading"><div><p className="eyebrow">PLANIFICACIÓN</p><h3 id="goals-dashboard-heading">Objetivos y próximos compromisos</h3></div></div>
        <p className="muted-copy">La planificación estará disponible cuando la API local pueda consultar los datos de este presupuesto.</p>
        <div className="button-row"><button className="button secondary" type="button" onClick={() => onNavigate('/goals')}>Abrir objetivos</button></div>
      </section>
    );
  }
  const activeGoals = summary.goals.filter((goal) => goal.status === 'active');
  const upcoming = [...summary.calendarItems].filter((item) => item.date > summary.asOfDate).sort((a, b) => a.date.localeCompare(b.date))[0];
  return (
    <section className="panel goals-dashboard-panel" aria-labelledby="goals-dashboard-heading">
      <div className="panel-heading"><div><p className="eyebrow">PLANIFICACIÓN</p><h3 id="goals-dashboard-heading">Objetivos y próximos compromisos</h3></div></div>
      <div className="goals-dashboard-metrics">
        <div><span>Objetivos activos</span><strong>{activeGoals.length}</strong></div>
        <div><span>Próximo elemento</span><strong>{upcoming ? civilDate(upcoming.date) : 'Sin vencimientos'}</strong></div>
      </div>
      {activeGoals.slice(0, 3).map((goal) => (
        <div className="goal-dashboard-row" key={goal.id}>
          <span>{goal.name}</span>
          <strong>{goal.projection ? money(goal.projection.projectedBalanceMinor, goal.projection.currency) + ' estimados' : 'Revisar supuestos'}</strong>
        </div>
      ))}
      {upcoming ? <p className="section-context">Próximo: {upcoming.title} · {upcoming.direction === 'expense' ? 'Salida' : 'Entrada'} {money(upcoming.amountMinor, summary.currency || currency)} · {upcoming.source === 'actual_transaction' ? 'registrado en Actual' : upcoming.source === 'recurring_candidate' ? 'candidato no confirmado' : 'compromiso manual'}.</p> : <p className="muted-copy">No se han detectado vencimientos futuros en el mes actual.</p>}
      <div className="button-row"><button className="button secondary" type="button" onClick={() => onNavigate('/goals')}>Gestionar objetivos y compromisos</button></div>
    </section>
  );
}
