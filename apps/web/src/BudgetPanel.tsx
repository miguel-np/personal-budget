import { useEffect, useMemo, useState } from 'react';

interface BudgetCategory {
  categoryId: string;
  categoryName: string;
  groupId: string;
  groupName: string;
  isIncome: boolean;
  hidden: boolean;
  budgetedMinor: number | null;
  spentMinor: number | null;
  availableMinor: number | null;
  percentUsed: number | null;
  carryover: boolean | null;
  state: 'budgeted' | 'zero' | 'unbudgeted' | 'unknown';
}
interface BudgetTotals {
  totalBudgetedMinor: number | null;
  totalSpentMinor: number | null;
  totalBalanceMinor: number | null;
  totalIncomeMinor: number | null;
  incomeAvailableMinor: number | null;
  toBudgetMinor: number | null;
}
interface BudgetData {
  month: string;
  totals: BudgetTotals;
  categories: BudgetCategory[];
  notes: string[];
}
interface ApiResponse<T> {
  data?: T;
  error?: { code?: string; message?: string };
}
function localMonth(): string {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}
function money(amountMinor: number | null, currency: string): string {
  if (amountMinor === null || !Number.isFinite(amountMinor)) return 'Desconocido';
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amountMinor / 100);
  } catch {
    return (amountMinor / 100).toFixed(2) + ' ' + currency;
  }
}
function parseAllocation(raw: string): number | null {
  let value = raw.trim().replace(/[\s€$£]/g, '');
  if (!value) return null;
  if (value.includes(',') && value.includes('.')) {
    if (value.lastIndexOf(',') > value.lastIndexOf('.')) value = value.replace(/\./g, '').replace(',', '.');
    else value = value.replace(/,/g, '');
  } else if (value.includes(',')) value = value.replace(',', '.');
  if (!/^\+?\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000_000_000) return null;
  const minor = Math.round(parsed * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}
async function getBudget(month: string, signal?: AbortSignal): Promise<BudgetData> {
  const response = await fetch('/api/v1/budgets/' + encodeURIComponent(month), {
    headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}),
  });
  const payload = await response.json().catch(() => ({})) as ApiResponse<BudgetData>;
  if (!response.ok) throw new Error(payload.error?.message ?? 'No se ha podido consultar el presupuesto de Actual Budget.');
  if (!payload.data) throw new Error('La API no devolvió un presupuesto válido.');
  return payload.data;
}
export function BudgetPanel({ currency, onBudgetUpdated }: { currency: string; onBudgetUpdated: () => void }) {
  const [month, setMonth] = useState(localMonth);
  const [budget, setBudget] = useState<BudgetData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState('');
  const [allocation, setAllocation] = useState('');
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setNotice('');
    void getBudget(month, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setBudget(result); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'No se ha podido cargar el presupuesto.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [month, reloadKey]);

  const expenseCategories = useMemo(() =>
    (budget?.categories ?? [])
      .filter((category) => !category.isIncome && !category.hidden)
      .sort((left, right) => left.groupName.localeCompare(right.groupName, 'es') || left.categoryName.localeCompare(right.categoryName, 'es')),
  [budget]);
  const currencyTotalBudgeted = budget?.totals.totalBudgetedMinor ?? null;
  const currencyTotalSpent = budget?.totals.totalSpentMinor ?? null;
  const variance = currencyTotalBudgeted !== null && currencyTotalSpent !== null
    ? currencyTotalBudgeted - currencyTotalSpent : null;

  async function saveAllocation(category: BudgetCategory) {
    const amountMinor = parseAllocation(allocation);
    if (amountMinor === null) {
      setError('Introduce una asignación igual o superior a cero, con un máximo de dos decimales.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/v1/budgets/' + encodeURIComponent(month) + '/' + encodeURIComponent(category.categoryId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ amountMinor }),
      });
      const payload = await response.json().catch(() => ({})) as ApiResponse<{ updated: boolean }>;
      if (!response.ok) throw new Error(payload.error?.message ?? 'Actual Budget no ha aceptado el cambio.');
      setEditingId('');
      setNotice('Asignación actualizada en Actual Budget. Los importes se han vuelto a consultar desde la fuente de verdad.');
      setReloadKey((value) => value + 1);
      onBudgetUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se ha podido actualizar la asignación.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content-section" aria-labelledby="budget-heading">
      <div className="section-heading">
        <div><p className="eyebrow">PLANIFICACIÓN Y DESVIACIONES</p><h2 id="budget-heading">Presupuestos por categoría</h2></div>
        <label className="field-label month-picker">Mes del presupuesto<input type="month" value={month} onChange={(event) => { setMonth(event.currentTarget.value); setEditingId(''); }} /></label>
      </div>
      {loading ? <div className="loading-state" role="status">Consultando el presupuesto de Actual Budget…</div> : null}
      {error ? <div className="notice notice-error" role="alert"><div><strong>No se ha podido operar con el presupuesto</strong><p>{error}</p></div><button className="button secondary" type="button" onClick={() => setReloadKey((value) => value + 1)}>Reintentar</button></div> : null}
      {notice ? <p className="form-alert" role="status">{notice}</p> : null}
      {budget && !loading && !error ? (
        <>
          <div className="stats-grid">
            <article className="stat-card"><p>Importe presupuestado</p><strong>{money(budget.totals.totalBudgetedMinor, currency)}</strong><span>Dato comunicado por Actual</span></article>
            <article className="stat-card negative"><p>Gasto del mes</p><strong>{money(budget.totals.totalSpentMinor, currency)}</strong><span>El signo se normaliza para comparar consumo</span></article>
            <article className={'stat-card ' + (variance !== null && variance < 0 ? 'negative' : 'positive')}><p>Desviación global</p><strong>{variance === null ? 'Desconocido' : money(variance, currency)}</strong><span>{variance === null ? 'Datos incompletos' : variance < 0 ? 'Gasto superior al presupuesto' : 'Presupuesto restante'}</span></article>
            <article className="stat-card"><p>Disponible para asignar</p><strong>{money(budget.totals.toBudgetMinor, currency)}</strong><span>Importe indicado por Actual</span></article>
          </div>
          <div className="panel budget-panel">
            <div className="panel-heading"><div><p className="eyebrow">DETALLE POR CATEGORÍA</p><h3>Asignado, gastado y desviación</h3></div><span className="muted-label">{expenseCategories.length} categorías de gasto</span></div>
            {expenseCategories.length === 0 ? <div className="empty-state"><h3>No hay categorías presupuestables en este mes</h3><p>Comprueba que el mes existe en el presupuesto de Actual Budget y que contiene categorías visibles de gasto.</p></div> : (
              <div className="budget-table-wrap">
                <table className="budget-table">
                  <thead><tr><th scope="col">Categoría</th><th scope="col">Asignado</th><th scope="col">Gastado</th><th scope="col">Disponible</th><th scope="col">Consumo</th><th scope="col">Estado</th><th scope="col">Acción</th></tr></thead>
                  <tbody>{expenseCategories.map((category) => {
                    const deviation = category.budgetedMinor !== null && category.spentMinor !== null
                      ? category.budgetedMinor - category.spentMinor : null;
                    const stateLabel = category.state === 'budgeted' ? 'Asignado'
                      : category.state === 'zero' ? 'Presupuestado 0'
                        : category.state === 'unbudgeted' ? 'Sin asignación explícita' : 'Desconocido';
                    const used = category.percentUsed;
                    return (
                      <tr key={category.categoryId}>
                        <td><strong>{category.categoryName}</strong><small>{category.groupName}</small>{deviation !== null ? <span className={'budget-deviation' + (deviation < 0 ? ' over' : '')}>{deviation < 0 ? 'Exceso: ' : 'Restante: '}{money(Math.abs(deviation), currency)}</span> : null}</td>
                        <td>{editingId === category.categoryId ? <label className="allocation-input"><span className="sr-only">Nueva asignación para {category.categoryName}</span><input type="text" inputMode="decimal" value={allocation} onChange={(event) => setAllocation(event.currentTarget.value)} autoComplete="off" /></label> : money(category.budgetedMinor, currency)}</td>
                        <td>{money(category.spentMinor, currency)}</td>
                        <td className={category.availableMinor !== null && category.availableMinor < 0 ? 'budget-over' : ''}>{money(category.availableMinor, currency)}</td>
                        <td><div className="budget-usage">{used === null ? <span>—</span> : <><div className="bar-track" role="img" aria-label={'Consumo de ' + category.categoryName + ': ' + Math.round(used) + '%'}><span className={used > 100 ? 'over' : ''} style={{ width: Math.min(100, Math.max(0, used)) + '%' }} /></div><small>{new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(used)} %</small></>}</div></td>
                        <td><span className={'budget-state state-' + category.state}>{stateLabel}</span></td>
                        <td>{editingId === category.categoryId ? <div className="allocation-actions"><button className="button primary" type="button" disabled={saving} onClick={() => void saveAllocation(category)}>{saving ? 'Guardando…' : 'Guardar'}</button><button className="button secondary" type="button" disabled={saving} onClick={() => setEditingId('')}>Cancelar</button></div> : <button className="button secondary" type="button" onClick={() => { setEditingId(category.categoryId); setAllocation(category.budgetedMinor === null ? '' : (category.budgetedMinor / 100).toFixed(2).replace('.', ',')); setError(''); }}>Editar asignación</button>}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
          </div>
          <div className="panel budget-explainer">
            <p className="eyebrow">CÓMO LEER LOS ESTADOS</p>
            <p>Los cambios confirmados se guardan en Actual Budget mediante su API oficial; esta aplicación no mantiene un segundo presupuesto. El consumo se calcula sobre el importe presupuestado y el gasto que devuelve Actual; los excesos aparecen en negativo.</p>
            <p>Limitación del origen: la API de Actual puede devolver un cero cuando la asignación está vacía. Si el propio origen no distingue entre una asignación omitida y una asignación explícita de cero, la interfaz no puede deducir esa diferencia y lo indica en lugar de inventar un importe.</p>
            {budget.notes.map((note) => <p key={note}>{note}</p>)}
          </div>
        </>
      ) : null}
    </section>
  );
}
