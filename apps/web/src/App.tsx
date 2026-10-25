import { useEffect, useMemo, useState } from 'react';

type ConnectionState = 'checking' | 'connected' | 'unconfigured' | 'error';
type PeriodMode = 'day' | 'month' | 'year' | 'custom';
type SortKey = 'date' | 'amount' | 'description';

interface Account {
  id: string;
  name: string;
  closed: boolean;
  offBudget: boolean;
  currentBalanceMinor: number | null;
}
interface Category {
  id: string;
  name: string;
  groupId: string;
  isIncome: boolean;
}
interface Transaction {
  id: string;
  account: string;
  date: string;
  amount: number;
  category?: string | null;
  transfer_id?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  imported_payee?: string | null;
  notes?: string | null;
  cleared?: boolean;
  is_parent?: boolean;
  is_child?: boolean;
  parent_id?: string | null;
  subtransactions?: readonly Transaction[];
}
interface CategoryTotal {
  categoryId: string | null;
  categoryName: string;
  amountMinor: number;
  transactionCount: number;
}
interface Summary {
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
  expensesByCategory: CategoryTotal[];
  incomeByCategory: CategoryTotal[];
  warnings: string[];
}
interface Period {
  startDate: string;
  endDate: string;
}
interface ApiPayload<T> {
  data?: T;
  error?: { code?: string; message?: string };
  pagination?: { total: number; limit: number; offset: number; sortBy?: SortKey; order?: 'asc' | 'desc' };
}
class ApiError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}
const NAV_ITEMS = [
  { href: '/', label: 'Resumen', icon: '◫' },
  { href: '/movements', label: 'Movimientos', icon: '↕' },
  { href: '/reports', label: 'Informes', icon: '▥' },
  { href: '/assistant', label: 'Asistente', icon: '✧' },
  { href: '/settings', label: 'Configuración', icon: '⚙' },
] as const;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function currentDate(): string {
  return isoDate(new Date());
}
function periodFor(mode: PeriodMode, anchor: string, customStart: string, customEnd: string): Period {
  if (mode === 'custom') return { startDate: customStart, endDate: customEnd };
  if (mode === 'day') return { startDate: anchor, endDate: anchor };
  const parts = anchor.split('-').map(Number);
  const year = parts[0] ?? new Date().getUTCFullYear();
  const month = parts[1] ?? 1;
  if (mode === 'year') return { startDate: String(year).padStart(4, '0') + '-01-01', endDate: String(year).padStart(4, '0') + '-12-31' };
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return { startDate: isoDate(first), endDate: isoDate(last) };
}
function previousPeriod(mode: PeriodMode, period: Period): Period {
  if (mode === 'month') {
    const start = new Date(period.startDate + 'T00:00:00Z');
    const previous = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
    return periodFor('month', isoDate(previous), '', '');
  }
  if (mode === 'year') {
    const year = Number(period.startDate.slice(0, 4)) - 1;
    return { startDate: String(year).padStart(4, '0') + '-01-01', endDate: String(year).padStart(4, '0') + '-12-31' };
  }
  const startMs = Date.parse(period.startDate + 'T00:00:00Z');
  const endMs = Date.parse(period.endDate + 'T00:00:00Z');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return period;
  const days = Math.round((endMs - startMs) / 86_400_000) + 1;
  const end = new Date(startMs - 86_400_000);
  const start = new Date(startMs - days * 86_400_000);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}
async function apiResponse<T>(url: string, signal?: AbortSignal): Promise<ApiPayload<T>> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const payload = await response.json().catch(() => ({})) as ApiPayload<T> & { status?: string };
  if (!response.ok) {
    const code = payload.error?.code ?? (response.status === 503 && payload.status === 'not_configured' ? 'NOT_CONFIGURED' : undefined);
    throw new ApiError(payload.error?.message ?? 'La API local no ha podido completar la consulta.', code);
  }
  return payload;
}
async function apiData<T>(url: string, signal?: AbortSignal): Promise<T> {
  const payload = await apiResponse<T>(url, signal);
  return payload.data === undefined ? payload as T : payload.data;
}
function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amountMinor / 100);
  } catch {
    return (amountMinor / 100).toFixed(2) + ' ' + currency;
  }
}
function displayDate(value: string): string {
  const parsed = new Date(value + 'T12:00:00');
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' }).format(parsed);
}
function transactionDescription(transaction: Transaction): string {
  return transaction.payee_name?.trim() || transaction.imported_payee?.trim() || transaction.notes?.trim() || 'Movimiento sin concepto';
}
function queryFor(period: Period): string {
  return '?startDate=' + encodeURIComponent(period.startDate) + '&endDate=' + encodeURIComponent(period.endDate);
}
function ErrorNotice({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <div><strong>{title}</strong><p>{message}</p></div>
      {onRetry ? <button className="button secondary" type="button" onClick={onRetry}>Reintentar</button> : null}
    </div>
  );
}
function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><span className="empty-symbol" aria-hidden="true">◇</span><h3>{title}</h3><p>{body}</p></div>;
}
function LoadingState() {
  return <div className="loading-state" role="status"><span className="spinner" aria-hidden="true" /> Cargando datos locales…</div>;
}
function StatCard({ label, value, detail, tone = 'default' }: { label: string; value: string; detail: string; tone?: 'default' | 'positive' | 'negative' }) {
  return <article className={'stat-card ' + tone}><p>{label}</p><strong>{value}</strong><span>{detail}</span></article>;
}

export function App() {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [transactionTotal, setTransactionTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [comparison, setComparison] = useState<Summary | null>(null);
  const [bootError, setBootError] = useState('');
  const [dataError, setDataError] = useState('');
  const [bootLoaded, setBootLoaded] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [mode, setMode] = useState<PeriodMode>('month');
  const [anchor, setAnchor] = useState(currentDate);
  const [customStart, setCustomStart] = useState(currentDate().slice(0, 8) + '01');
  const [customEnd, setCustomEnd] = useState(currentDate());
  const [accountFilter, setAccountFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [uncategorizedOnly, setUncategorizedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortAscending, setSortAscending] = useState(false);

  const route = window.location.pathname.replace(/\/+$/, '') || '/';
  const pageTitle = NAV_ITEMS.find((item) => item.href === route)?.label ?? 'Resumen';
  const period = useMemo(() => periodFor(mode, anchor, customStart, customEnd), [mode, anchor, customStart, customEnd]);
  const previous = useMemo(() => previousPeriod(mode, period), [mode, period]);
  const invalidPeriod = period.startDate > period.endDate;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await apiData<{ status: string }>('/ready', controller.signal);
        const [accountsResult, categoriesResult] = await Promise.all([
          apiData<Account[]>('/api/v1/accounts', controller.signal),
          apiData<Category[]>('/api/v1/categories', controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setAccounts(accountsResult);
        setCategories(categoriesResult);
        setConnection('connected');
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && (error.code === 'NOT_CONFIGURED' || error.code === 'CLOSED')) {
          setConnection('unconfigured');
          setBootError('Configura ACTUAL_BUDGET_ID en el archivo .env y comprueba que Actual Budget está iniciado.');
        } else {
          setConnection('error');
          setBootError(error instanceof Error ? error.message : 'No se han podido cargar los datos locales.');
        }
      } finally {
        if (!controller.signal.aborted) setBootLoaded(true);
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!bootLoaded || connection !== 'connected' || invalidPeriod) return;
    const controller = new AbortController();
    let active = true;
    setDataLoading(true);
    setDataError('');
    const transactionQuery = new URLSearchParams({
      startDate: period.startDate,
      endDate: period.endDate,
      limit: '20',
      offset: String((page - 1) * 20),
      sortBy: sortKey,
      order: sortAscending ? 'asc' : 'desc',
    });
    if (accountFilter !== 'all') transactionQuery.set('accountId', accountFilter);
    if (categoryFilter !== 'all') transactionQuery.set('categoryId', categoryFilter);
    if (uncategorizedOnly) transactionQuery.set('uncategorized', 'true');
    if (searchText.trim()) transactionQuery.set('search', searchText.trim());
    const transactionRequest = route === '/movements'
      ? apiResponse<Transaction[]>('/api/v1/transactions?' + transactionQuery.toString(), controller.signal)
      : Promise.resolve({ data: [] as Transaction[], pagination: { total: 0, limit: 20, offset: 0 } });
    Promise.all([
      apiData<Summary>('/api/v1/reports/summary' + queryFor(period), controller.signal),
      transactionRequest,
      route === '/reports'
        ? apiData<Summary>('/api/v1/reports/summary' + queryFor(previous), controller.signal)
        : Promise.resolve(null),
    ])
      .then(([summaryResult, transactionResult, previousResult]) => {
        if (!active) return;
        setSummary(summaryResult);
        setTransactions(transactionResult.data ?? []);
        setTransactionTotal(transactionResult.pagination?.total ?? transactionResult.data?.length ?? 0);
        setComparison(previousResult);
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setDataError(error instanceof Error ? error.message : 'No se han podido cargar los datos del periodo.');
      })
      .finally(() => { if (active) setDataLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [accountFilter, accounts, bootLoaded, categoryFilter, connection, invalidPeriod, page, period, previous, route, searchText, sortAscending, sortKey, uncategorizedOnly]);

  const categoriesById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  const accountsById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const filteredTransactions = transactions;
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(transactionTotal / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleTransactions = filteredTransactions;

  function retryBoot() {
    window.location.reload();
  }
  function changeSort(key: SortKey) {
    if (key === sortKey) setSortAscending((ascending) => !ascending);
    else {
      setSortKey(key);
      setSortAscending(key !== 'date');
    }
    setPage(1);
  }
  function updateMode(nextMode: PeriodMode) {
    setMode(nextMode);
    setPage(1);
  }
  const currency = summary?.currency ?? 'EUR';

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navegación principal">
        <a className="brand" href="/" aria-label="personal-budget, ir al resumen">
          <span className="brand-mark" aria-hidden="true">pb</span>
          <span><strong>personal-budget</strong><small>FINANZAS LOCALES</small></span>
        </a>
        <nav className="nav-list" aria-label="Secciones de la aplicación">
          {NAV_ITEMS.map((item) => (
            <a className={'nav-item' + (item.href === route ? ' active' : '')} href={item.href}
              aria-current={item.href === route ? 'page' : undefined} key={item.href}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={'connection-indicator ' + connection} aria-hidden="true" />
          <span><strong>{connection === 'connected' ? 'Conexión local' : connection === 'checking' ? 'Comprobando' : connection === 'unconfigured' ? 'Sin presupuesto' : 'Sin conexión'}</strong>
            <small>Los datos permanecen en tu equipo</small></span>
        </div>
      </aside>

      <main className="main-content">
        <header className="page-header">
          <div>
            <p className="eyebrow">ÁREA PERSONAL / {pageTitle.toLocaleUpperCase('es')}</p>
            <h1>{route === '/' ? 'Resumen financiero' : route === '/movements' ? 'Movimientos' : route === '/reports' ? 'Informes' : route === '/assistant' ? 'Asistente' : route === '/settings' ? 'Configuración' : pageTitle}</h1>
            <p className="page-subtitle">Tus finanzas, con cálculos verificables y sin enviar datos a terceros.</p>
          </div>
          <div className="header-status" role="status"><span className={'status-dot ' + connection} />
            {connection === 'connected' ? 'Actual Budget' : connection === 'checking' ? 'Conectando…' : connection === 'unconfigured' ? 'Configura tu presupuesto' : 'API no disponible'}
          </div>
        </header>

        {connection === 'checking' ? <LoadingState /> : null}
        {connection === 'unconfigured' ? <ErrorNotice title="Actual Budget aún no está conectado" message={bootError || 'Configura la conexión local con Actual Budget para consultar tus datos.'} /> : null}
        {connection === 'error' ? <ErrorNotice title="No se puede cargar la aplicación" message={bootError || 'Comprueba el backend local y vuelve a intentarlo.'} onRetry={retryBoot} /> : null}

        {connection === 'connected' && bootLoaded ? (
          <>
            {(route === '/' || route === '/reports' || route === '/movements') && (
              <section className="period-panel" aria-label="Periodo de consulta">
                <div className="period-modes" role="group" aria-label="Tipo de periodo">
                  {(['day', 'month', 'year', 'custom'] as const).map((value) => (
                    <button key={value} type="button" className={'mode-button' + (mode === value ? ' selected' : '')} aria-pressed={mode === value}
                      onClick={() => updateMode(value)}>{value === 'day' ? 'Día' : value === 'month' ? 'Mes' : value === 'year' ? 'Año' : 'Personalizado'}</button>
                  ))}
                </div>
                <div className="period-fields">
                  {mode !== 'custom' ? <label className="field-label">{mode === 'year' ? 'Selecciona una fecha del año' : mode === 'month' ? 'Selecciona un mes' : 'Selecciona un día'}
                    <input type={mode === 'year' ? 'number' : mode === 'month' ? 'month' : 'date'}
                      min={mode === 'year' ? '1900' : undefined} max={mode === 'year' ? '9999' : undefined}
                      value={mode === 'year' ? anchor.slice(0, 4) : mode === 'month' ? anchor.slice(0, 7) : anchor}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (mode === 'year' && /^\d{4}$/.test(value)) setAnchor(value + '-01-01');
                        else if (mode === 'month' && /^\d{4}-\d{2}$/.test(value)) setAnchor(value + '-01');
                        else if (mode === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(value)) setAnchor(value);
                      }} />
                  </label> : (
                    <>
                      <label className="field-label">Desde<input type="date" value={customStart} onChange={(event) => { setCustomStart(event.currentTarget.value); setPage(1); }} /></label>
                      <label className="field-label">Hasta<input type="date" value={customEnd} onChange={(event) => { setCustomEnd(event.currentTarget.value); setPage(1); }} /></label>
                    </>
                  )}
                  <p className="period-caption">{displayDate(period.startDate)} — {displayDate(period.endDate)}</p>
                </div>
              </section>
            )}

            {invalidPeriod ? <ErrorNotice title="Periodo no válido" message="La fecha inicial debe ser anterior o igual a la fecha final." /> : null}
            {dataError ? <ErrorNotice title="No se han podido actualizar los datos" message={dataError} onRetry={() => window.location.reload()} /> : null}
            {dataLoading ? <LoadingState /> : null}

            {!dataLoading && !dataError && !invalidPeriod && route === '/' && (
              <section className="content-section" aria-labelledby="overview-heading">
                <div className="section-heading"><div><p className="eyebrow">DATOS DE ACTUAL BUDGET</p><h2 id="overview-heading">Balance del periodo</h2></div><span className="date-badge">{period.startDate} — {period.endDate}</span></div>
                {summary ? (
                  <>
                    <div className="stats-grid">
                      <StatCard label="Ingresos" value={formatMoney(summary.incomeMinor, currency)} detail="Ingresos clasificados en el periodo" tone="positive" />
                      <StatCard label="Gastos" value={formatMoney(summary.expenseMinor, currency)} detail="Traspasos internos excluidos" tone="negative" />
                      <StatCard label="Ahorro neto" value={formatMoney(summary.savingsMinor, currency)} detail="Ingresos menos gastos" tone={summary.savingsMinor >= 0 ? 'positive' : 'negative'} />
                      <StatCard label="Tasa de ahorro" value={summary.savingsRatePercent === null ? 'No aplicable' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(summary.savingsRatePercent) + ' %'} detail={summary.incomeMinor > 0 ? 'Ahorro neto / ingresos' : 'No hay ingresos positivos clasificados'} />
                    </div>
                    <div className="two-column">
                      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">DISTRIBUCIÓN</p><h3>Gastos por categoría</h3></div><span className="muted-label">{summary.expensesByCategory.length} categorías</span></div>
                        <CategoryBars totals={summary.expensesByCategory.slice(0, 6)} currency={currency} />
                      </article>
                      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">SEÑALES</p><h3>Aspectos a revisar</h3></div></div>
                        {summary.warnings.length ? <ul className="warning-list">{summary.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <EmptyState title="Sin alertas de clasificación" body="No hay avisos que requieran revisión en este periodo." />}
                        <div className="detail-line"><span>Movimientos incluidos</span><strong>{summary.transactionCount}</strong></div>
                        <div className="detail-line"><span>Traspasos excluidos del consolidado</span><strong>{summary.excludedTransferCount}</strong></div>
                      </article>
                    </div>
                    <div className="section-footnote">Importes calculados con reglas deterministas en el backend. Los movimientos divididos se normalizan antes de agregarse; no se suman divisas distintas.</div>
                  </>
                ) : <EmptyState title="No hay resumen disponible" body="Selecciona un periodo válido o comprueba la conexión con Actual Budget." />}
              </section>
            )}

            {!dataLoading && !dataError && !invalidPeriod && route === '/movements' && (
              <section className="content-section" aria-labelledby="movements-heading">
                <div className="section-heading"><div><p className="eyebrow">LIBRO DE MOVIMIENTOS</p><h2 id="movements-heading">Transacciones</h2></div><span className="date-badge">{transactionTotal} resultados</span></div>
                {accounts.filter((item) => !item.closed).length === 0 ? <EmptyState title="No hay cuentas disponibles" body="Crea o abre una cuenta en Actual Budget y vuelve a cargar los datos." /> : (
                  <>
                    <div className="filters-panel">
                      <label className="field-label search-field">Buscar<input type="search" placeholder="Concepto, cuenta o categoría" value={searchText} onChange={(event) => { setSearchText(event.currentTarget.value); setPage(1); }} /></label>
                      <label className="field-label">Cuenta<select value={accountFilter} onChange={(event) => { setAccountFilter(event.currentTarget.value); setPage(1); }}><option value="all">Todas las cuentas</option>{accounts.filter((item) => !item.closed).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
                      <label className="field-label">Categoría<select value={categoryFilter} onChange={(event) => { setCategoryFilter(event.currentTarget.value); setUncategorizedOnly(false); setPage(1); }}><option value="all">Todas las categorías</option>{categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
                      <label className="check-field"><input type="checkbox" checked={uncategorizedOnly} onChange={(event) => { setUncategorizedOnly(event.currentTarget.checked); setCategoryFilter('all'); setPage(1); }} /> Sin categoría</label>
                    </div>
                    {visibleTransactions.length === 0 ? <EmptyState title="No se han encontrado movimientos" body="Cambia el periodo o los filtros. Esta vista no inventa datos cuando Actual no devuelve resultados." /> : (
                      <div className="table-wrap">
                        <table className="transactions-table">
                          <thead><tr>
                            <th scope="col"><button type="button" className="sort-button" onClick={() => changeSort('date')}>Fecha{sortKey === 'date' ? (sortAscending ? ' ↑' : ' ↓') : ''}</button></th>
                            <th scope="col"><button type="button" className="sort-button" onClick={() => changeSort('description')}>Descripción{sortKey === 'description' ? (sortAscending ? ' ↑' : ' ↓') : ''}</button></th>
                            <th scope="col">Cuenta</th><th scope="col">Categoría</th>
                            <th scope="col"><button type="button" className="sort-button" onClick={() => changeSort('amount')}>Importe{sortKey === 'amount' ? (sortAscending ? ' ↑' : ' ↓') : ''}</button></th><th scope="col">Estado</th>
                          </tr></thead>
                          <tbody>{visibleTransactions.map((transaction) => {
                            const category = categoriesById.get(transaction.category ?? '');
                            return <tr key={transaction.id}>
                              <td>{displayDate(transaction.date)}</td>
                              <td><strong className="transaction-name">{transactionDescription(transaction)}</strong>{transaction.notes ? <small className="transaction-note">{transaction.notes}</small> : null}</td>
                              <td>{accountsById.get(transaction.account)?.name ?? 'Cuenta desconocida'}</td>
                              <td>{category?.name ?? <span className="uncategorized">Sin categoría</span>}</td>
                              <td className={'amount-cell ' + (transaction.amount < 0 ? 'expense' : 'income')}>{formatMoney(transaction.amount, currency)}</td>
                              <td><span className={'cleared-badge ' + (transaction.cleared ? 'cleared' : '')}>{transaction.cleared ? 'Conciliado' : 'Pendiente'}</span></td>
                            </tr>;
                          })}</tbody>
                        </table>
                      </div>
                    )}
                    <div className="table-footer"><span>Página {currentPage} de {pageCount} · {transactionTotal} movimientos</span><div className="pagination"><button className="button secondary" type="button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</button><button className="button secondary" type="button" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Siguiente</button></div></div>
                    <p className="section-footnote">La API limita los periodos de consulta a cinco años. Los importes conservan el signo de Actual; los traspasos se muestran en el registro, pero se excluyen de los totales consolidados.</p>
                  </>
                )}
              </section>
            )}

            {!dataLoading && !dataError && !invalidPeriod && route === '/reports' && (
              <section className="content-section" aria-labelledby="reports-heading">
                <div className="section-heading"><div><p className="eyebrow">ANÁLISIS COMPARATIVO</p><h2 id="reports-heading">Informes del periodo</h2></div></div>
                {summary && comparison ? (
                  <>
                    <div className="stats-grid">
                      <StatCard label="Ingresos" value={formatMoney(summary.incomeMinor, currency)} detail={'Anterior: ' + formatMoney(comparison.incomeMinor, currency)} tone="positive" />
                      <StatCard label="Gastos" value={formatMoney(summary.expenseMinor, currency)} detail={'Anterior: ' + formatMoney(comparison.expenseMinor, currency)} tone="negative" />
                      <StatCard label="Ahorro neto" value={formatMoney(summary.savingsMinor, currency)} detail={'Anterior: ' + formatMoney(comparison.savingsMinor, currency)} tone={summary.savingsMinor >= 0 ? 'positive' : 'negative'} />
                      <StatCard label="Variación del gasto" value={comparison.expenseMinor === 0 ? 'No aplicable' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(((summary.expenseMinor - comparison.expenseMinor) / Math.abs(comparison.expenseMinor)) * 100) + ' %'} detail={'Periodo previo: ' + previous.startDate + ' — ' + previous.endDate} />
                    </div>
                    <div className="two-column">
                      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">DETALLE</p><h3>Gasto por categoría</h3></div></div><CategoryBars totals={summary.expensesByCategory} currency={currency} /></article>
                      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">COMPARATIVA</p><h3>Periodo actual y anterior</h3></div></div>
                        <div className="comparison-rows"><ComparisonRow label="Ingresos" current={summary.incomeMinor} previous={comparison.incomeMinor} currency={currency} />
                          <ComparisonRow label="Gastos" current={summary.expenseMinor} previous={comparison.expenseMinor} currency={currency} />
                          <ComparisonRow label="Ahorro neto" current={summary.savingsMinor} previous={comparison.savingsMinor} currency={currency} /></div>
                        {summary.warnings.length ? <ul className="warning-list">{summary.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
                      </article>
                    </div>
                    <div className="section-footnote">La comparación utiliza el mismo tipo de periodo y cálculos de finance-core. No se consideran transferencias internas como ingresos o gastos consolidados.</div>
                  </>
                ) : <EmptyState title="No hay datos suficientes" body="El informe necesita un presupuesto configurado y datos devueltos por Actual Budget." />}
              </section>
            )}

            {route === '/assistant' && (
              <section className="content-section">
                <div className="section-heading"><div><p className="eyebrow">IA OPCIONAL · FASE FUTURA</p><h2>Asistente local</h2></div></div>
                <div className="panel assistant-panel"><span className="assistant-symbol" aria-hidden="true">✧</span><h3>El asistente aún no está conectado</h3><p>Esta sección no envía movimientos ni consultas a un modelo. La integración de IA local se abordará como una fase independiente, con herramientas de solo lectura y permisos explícitos.</p><span className="status-chip">No conectado</span></div>
              </section>
            )}

            {route === '/settings' && (
              <section className="content-section">
                <div className="section-heading"><div><p className="eyebrow">ESTADO DEL SERVICIO</p><h2>Configuración local</h2></div></div>
                <div className="settings-grid">
                  <article className="panel settings-panel"><p className="eyebrow">CONEXIÓN</p><h3>Actual Budget</h3><div className="detail-line"><span>Estado de API</span><strong>{connection === 'connected' ? 'Disponible' : connection}</strong></div><div className="detail-line"><span>Cuentas visibles</span><strong>{accounts.length}</strong></div><div className="detail-line"><span>Categorías cargadas</span><strong>{categories.length}</strong></div><div className="detail-line"><span>Divisa del presupuesto</span><strong>{currency}</strong></div></article>
                  <article className="panel settings-panel"><p className="eyebrow">PRIVACIDAD</p><h3>Diseño local-first</h3><ul className="privacy-list"><li>No se solicitan credenciales bancarias.</li><li>El navegador llama únicamente a la API local de la aplicación.</li><li>No hay telemetría ni analítica de terceros.</li><li>Los errores de API se saneanean antes de mostrarse.</li></ul><p className="setting-hint">Configura servidor y presupuesto en el archivo .env. Esta pantalla no muestra contraseñas ni identificadores privados de configuración.</p></article>
                </div>
                <div className="panel account-list-panel"><div className="panel-heading"><div><p className="eyebrow">CUENTAS</p><h3>Cuentas disponibles</h3></div></div>{accounts.length ? accounts.map((account) => <div className="detail-line" key={account.id}><span>{account.name}{account.closed ? ' · Cerrada' : ''}{account.offBudget ? ' · Fuera de presupuesto' : ''}</span><strong>{account.currentBalanceMinor === null ? 'Saldo desconocido' : formatMoney(account.currentBalanceMinor, currency)}</strong></div>) : <p className="muted-copy">No hay cuentas para mostrar.</p>}</div>
              </section>
            )}

            {!['/', '/movements', '/reports', '/assistant', '/settings'].includes(route) && (
              <section className="content-section"><EmptyState title="Sección no encontrada" body="Utiliza la navegación principal para abrir una sección disponible." /><a className="button primary" href="/">Volver al resumen</a></section>
            )}
          </>
        ) : null}
        <footer className="app-footer"><span>personal-budget</span><span>Local-first · Sin analítica de terceros</span></footer>
      </main>
    </div>
  );
}

function CategoryBars({ totals, currency }: { totals: readonly CategoryTotal[]; currency: string }) {
  if (!totals.length) return <EmptyState title="Sin movimientos por categoría" body="No hay importes clasificados para mostrar en este periodo." />;
  const maxValue = Math.max(1, ...totals.map((item) => Math.abs(item.amountMinor)));
  return <div className="category-bars">{totals.map((item) => (
    <div className="category-bar-row" key={item.categoryId ?? 'uncategorized'}>
      <div className="category-bar-label"><span>{item.categoryName}</span><strong>{formatMoney(item.amountMinor, currency)}</strong></div>
      <div className="bar-track" role="img" aria-label={item.categoryName + ': ' + formatMoney(item.amountMinor, currency)}><span style={{ width: Math.max(2, Math.abs(item.amountMinor) / maxValue * 100) + '%' }} /></div>
    </div>
  ))}</div>;
}
function ComparisonRow({ label, current, previous, currency }: { label: string; current: number; previous: number; currency: string }) {
  const delta = current - previous;
  return <div className="comparison-row"><div><span>{label}</span><strong>{formatMoney(current, currency)}</strong></div><div className="comparison-meta"><span>Anterior: {formatMoney(previous, currency)}</span><strong className={delta > 0 ? 'up' : delta < 0 ? 'down' : ''}>{delta > 0 ? '+' : ''}{formatMoney(delta, currency)}</strong></div></div>;
}
