import { useEffect, useMemo, useState } from 'react';
import { comparePeriodValues, getBudgetAlerts, type BudgetSignalCategory } from './financial-signals.js';
import { formatMoney as sharedFormatMoney } from './finance-format.js';

interface Account {
  readonly id: string;
  readonly name: string;
  readonly closed: boolean;
  readonly offBudget: boolean;
  readonly currentBalanceMinor: number | null;
  readonly displayBalanceMinor?: number | null;
  readonly displayCurrency?: string;
}

interface Summary {
  readonly currency: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly savingsMinor: number;
  readonly accountScope?: { readonly label: string };
}

interface BudgetData {
  readonly month: string;
  readonly categories: readonly BudgetSignalCategory[];
}

interface ApiPayload<T> {
  readonly data?: T;
  readonly error?: { readonly message?: string };
}

type QuickRegisterKind = 'income' | 'expense' | 'transfer';

interface DashboardSignalsProps {
  readonly accounts: readonly Account[];
  readonly activeAccountIds: readonly string[];
  readonly accountScopeLabel: string;
  readonly currency: string;
  readonly summary: Summary;
  readonly comparison: Summary | null;
  readonly reloadKey: number;
  readonly onNavigate: (href: string) => void;
  readonly onQuickRegister: (kind: QuickRegisterKind) => void;
}

function localMonth(): string {
  const now = new Date();
  return String(now.getFullYear()).padStart(4, '0') + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

function money(amountMinor: number, currency: string): string {
  return sharedFormatMoney(amountMinor, currency);
}

function signedMoney(amountMinor: number, currency: string): string {
  return (amountMinor > 0 ? '+' : '') + money(amountMinor, currency);
}

function percentage(value: number): string {
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1, signDisplay: 'always' }).format(value) + ' %';
}

function changeDescription(current: number, previous: number, currency: string): string {
  const change = comparePeriodValues(current, previous);
  return 'Cambio absoluto: ' + signedMoney(change.absoluteMinor, currency) + '. ' +
    (change.percentageChange === null
      ? 'Variación porcentual no aplicable: el valor del periodo anterior no es positivo.'
      : 'Variación porcentual: ' + percentage(change.percentageChange) + '.');
}

export function DashboardSignals({
  accounts, activeAccountIds, accountScopeLabel, currency, summary, comparison, reloadKey, onNavigate, onQuickRegister,
}: DashboardSignalsProps) {
  const [budget, setBudget] = useState<BudgetData | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(true);
  const [budgetError, setBudgetError] = useState('');
  const budgetMonth = useMemo(localMonth, [reloadKey]);
  const activeIds = useMemo(() => new Set(activeAccountIds), [activeAccountIds]);
  const scopedOpenAccounts = accounts.filter((account) => !account.closed && activeIds.has(account.id));
  const knownBalances = scopedOpenAccounts.filter((account) => account.currentBalanceMinor !== null);
  const offBudgetAccounts = scopedOpenAccounts.filter((account) => account.offBudget);

  useEffect(() => {
    const controller = new AbortController();
    setBudgetLoading(true);
    setBudgetError('');
    void fetch('/api/v1/budgets/' + encodeURIComponent(budgetMonth), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as ApiPayload<BudgetData>;
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? 'No se ha podido comprobar el presupuesto del mes.');
      }
      if (!controller.signal.aborted) setBudget(payload.data);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setBudget(null);
        setBudgetError(error instanceof Error ? error.message : 'No se ha podido comprobar el presupuesto del mes.');
      }
    }).finally(() => {
      if (!controller.signal.aborted) setBudgetLoading(false);
    });
    return () => controller.abort();
  }, [budgetMonth, reloadKey]);

  const alerts = useMemo(() => getBudgetAlerts(budget?.categories ?? []), [budget]);
  const evaluableCategoryCount = (budget?.categories ?? []).filter((category) =>
    !category.isIncome && !category.hidden && category.budgetedMinor !== null &&
    category.budgetedMinor > 0 && category.spentMinor !== null && category.availableMinor !== null).length;

  return (
    <section className="content-section dashboard-signals" aria-labelledby="dashboard-signals-heading">
      <div className="section-heading">
        <div><p className="eyebrow">CONTEXTO Y SIGUIENTES PASOS</p><h2 id="dashboard-signals-heading">Señales accionables</h2></div>
        <span className="date-badge">{summary.startDate} — {summary.endDate} · {currency}</span>
      </div>
      <p className="section-context">Ámbito activo: {summary.accountScope?.label ?? accountScopeLabel}. Las comparativas usan el mismo ámbito y la misma divisa de análisis.</p>

      {comparison ? (
        <article className="panel period-comparison-panel" aria-labelledby="period-comparison-heading">
          <div className="panel-heading">
            <div><p className="eyebrow">PERIODO ANTERIOR</p><h3 id="period-comparison-heading">Cambio frente al periodo previo</h3></div>
            <span className="muted-label">{comparison.startDate} — {comparison.endDate}</span>
          </div>
          <div className="comparison-rows">
            <div className="comparison-row">
              <div><span>Ingresos</span><strong>{money(summary.incomeMinor, currency)}</strong></div>
              <div className="comparison-meta"><span>Anterior: {money(comparison.incomeMinor, currency)}</span><span>{changeDescription(summary.incomeMinor, comparison.incomeMinor, currency)}</span></div>
            </div>
            <div className="comparison-row">
              <div><span>Gastos</span><strong>{money(summary.expenseMinor, currency)}</strong></div>
              <div className="comparison-meta"><span>Anterior: {money(comparison.expenseMinor, currency)}</span><span>{changeDescription(summary.expenseMinor, comparison.expenseMinor, currency)}</span></div>
            </div>
            <div className="comparison-row">
              <div><span>Ahorro neto</span><strong>{money(summary.savingsMinor, currency)}</strong></div>
              <div className="comparison-meta"><span>Anterior: {money(comparison.savingsMinor, currency)}</span><span>{changeDescription(summary.savingsMinor, comparison.savingsMinor, currency)}</span></div>
            </div>
          </div>
          <p className="section-footnote">El cambio absoluto se expresa en {currency}. El porcentaje solo aparece si la base del periodo anterior es positiva; un cero o un valor negativo no se presenta como una variación porcentual normal.</p>
        </article>
      ) : (
        <article className="panel"><div className="empty-state"><h3>Comparación no disponible</h3><p>No se ha podido obtener el periodo anterior con el mismo ámbito. Los importes actuales se mantienen separados, sin estimar una variación.</p></div></article>
      )}

      <div className="two-column">
        <article className="panel" aria-labelledby="account-signal-heading">
          <div className="panel-heading"><div><p className="eyebrow">SALDOS ACTUALES</p><h3 id="account-signal-heading">Cobertura de cuentas</h3></div><span className="muted-label">{scopedOpenAccounts.length} en el ámbito</span></div>
          <div className="signal-metrics">
            <div><span>Saldos conocidos</span><strong>{knownBalances.length} / {scopedOpenAccounts.length}</strong></div>
            <div><span>Fuera de presupuesto</span><strong>{offBudgetAccounts.length}</strong></div>
          </div>
          <p className="signal-note">Estos son saldos actuales, no efectivo disponible. Patrimonio neto: no disponible porque falta clasificación fiable de activo/pasivo; no se deduce por el signo del saldo.</p>
          <div className="button-row"><button className="button secondary" type="button" onClick={() => onNavigate('/accounts')}>Ver cuentas y saldos</button></div>
        </article>

        <article className="panel" aria-labelledby="budget-alert-heading">
          <div className="panel-heading"><div><p className="eyebrow">PRESUPUESTO DE ACTUAL</p><h3 id="budget-alert-heading">Límites que requieren atención</h3></div><span className="muted-label">{budget?.month ?? budgetMonth}</span></div>
          {budgetLoading ? <div className="loading-state" role="status">Comprobando límites del presupuesto…</div> : null}
          {budgetError ? <div className="notice notice-error" role="alert"><div><strong>Alertas no disponibles</strong><p>{budgetError} No se interpretan datos ausentes como cero.</p></div></div> : null}
          {!budgetLoading && !budgetError && alerts.length > 0 ? (
            <ul className="signal-alert-list">
              {alerts.map((alert) => (
                <li key={alert.categoryId} className={alert.kind === 'over-budget' ? 'signal-alert over' : 'signal-alert near'}>
                  <div><strong>{alert.categoryName}</strong><span>{alert.kind === 'over-budget' ? 'Presupuesto superado' : 'Alcanza o supera el 80 % del límite'}</span></div>
                  <div className="signal-alert-values"><strong>{money(alert.spentMinor, currency)}</strong><span>{new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(alert.percentUsed)} % usado</span></div>
                  {alert.kind === 'over-budget'
                    ? <p>Exceso calculado por Actual: {money(alert.overByMinor, currency)} sobre el importe asignado.</p>
                    : <p>Restante según Actual: {money(alert.availableMinor, currency)}. Se muestra para anticipar un posible exceso, no como gasto confirmado futuro.</p>}
                </li>
              ))}
            </ul>
          ) : null}
          {!budgetLoading && !budgetError && alerts.length === 0 ? (
            <div className="empty-state">
              <h3>{evaluableCategoryCount === 0 ? 'Datos insuficientes para evaluar límites' : 'Sin alertas de límite'}</h3>
              <p>{evaluableCategoryCount === 0
                ? 'No hay categorías con presupuesto, gasto y disponible conocidos para determinar una alerta. No se rellenan los desconocidos con cero.'
                : 'No hay categorías evaluables que superen el límite o alcancen el umbral del 80 % en este mes.'}</p>
            </div>
          ) : null}
          <p className="signal-note">Mes {budget?.month ?? budgetMonth}. Estas asignaciones pertenecen al presupuesto completo de Actual, no a una cuenta seleccionada. Las alertas se ordenan primero por exceso y después por porcentaje de consumo.</p>
        </article>
      </div>

      <article className="panel quick-actions-panel" aria-labelledby="quick-actions-heading">
        <div className="panel-heading"><div><p className="eyebrow">TAREAS FRECUENTES</p><h3 id="quick-actions-heading">Acciones rápidas</h3></div></div>
        <div className="quick-actions">
          <button className="button primary" type="button" onClick={() => onQuickRegister('income')}>Registrar ingreso</button>
          <button className="button secondary" type="button" onClick={() => onQuickRegister('expense')}>Registrar gasto</button>
          <button className="button secondary" type="button" onClick={() => onNavigate('/movements')}>Buscar y revisar movimientos</button>
          <button className="button secondary" type="button" disabled={scopedOpenAccounts.length < 2} onClick={() => onQuickRegister('transfer')} aria-describedby="transfer-shortcut-note">Registrar transferencia</button>
        </div>
        <p className="signal-note" id="transfer-shortcut-note">La transferencia requiere dos cuentas abiertas dentro del ámbito global, de la misma divisa y ambas dentro o ambas fuera de presupuesto. Se utiliza el beneficiario de transferencia verificado de Actual y se exige previsualización y confirmación; no se inventan tipos de cambio ni se crean dos movimientos ordinarios.</p>
      </article>

      <article className="panel planning-status-panel" aria-labelledby="planning-status-heading">
        <div className="panel-heading"><div><p className="eyebrow">PLANIFICACIÓN</p><h3 id="planning-status-heading">Estimaciones, objetivos y compromisos</h3></div></div>
        <p>Las previsiones actuales son escenarios estimados y los candidatos recurrentes son patrones detectados, no pagos confirmados. Los objetivos definidos por el usuario y el registro de compromisos futuros aún no están implementados; no se mostrarán como si existieran datos.</p>
        <div className="button-row"><button className="button secondary" type="button" onClick={() => onNavigate('/planning')}>Abrir planificación</button></div>
      </article>
    </section>
  );
}
