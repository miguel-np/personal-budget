import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { MovementTools } from './MovementTools.js';
import { BudgetPanel } from './BudgetPanel.js';
import { AssistantPanel } from './AssistantPanel.js';
import { PlanningPanel } from './PlanningPanel.js';
import { MovementManager } from './MovementManager.js';
import { ReportExportPanel } from './ReportExportPanel.js';
import { SettingsCenter, type AppPreferences } from './SettingsCenter.js';
import { AccountsPanel } from './AccountsPanel.js';
import { DashboardSignals } from './DashboardSignals.js';
import { formatAccountBalance, formatCivilDate, formatMoney as sharedFormatMoney, setFinanceLocale } from './finance-format.js';

type ConnectionState = 'checking' | 'connected' | 'unconfigured' | 'error';
type PeriodMode = 'day' | 'month' | 'year' | 'custom';
type SortKey = 'date' | 'amount' | 'description';

interface Account {
  id: string;
  name: string;
  closed: boolean;
  offBudget: boolean;
  currentBalanceMinor: number | null;
  currencyCode?: string | null;
  nativeCurrencyCode?: string | null;
  displayBalanceMinor?: number | null;
  displayCurrency?: string;
  balanceConversion?: { warning?: string };
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
  currencyCode?: string | null;
  displayCurrency?: string;
  displayAmountMinor?: number | null;
  conversion?: { warning?: string; rate?: string | null; effectiveDate?: string | null; source?: string | null };
  category?: string | null;
  transfer_id?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  imported_payee?: string | null;
  notes?: string | null;
  cleared?: boolean;
  is_parent?: boolean;
  is_child?: boolean;
  is_split_child?: boolean;
  parent_id?: string | null;
  subtransactions?: readonly Transaction[];
}
interface CategoryTotal {
  categoryId: string | null;
  categoryName: string;
  amountMinor: number;
  transactionCount: number;
}
interface AccountScopePreference {
  mode: 'all' | 'selected';
  accountIds: string[];
  label?: string;
  activeAccountIds?: string[];
  accountNames?: string[];
  warning?: string;
}
interface AccountScopeDraft {
  mode: 'all' | 'selected';
  accountIds: string[];
}
interface Summary {
  currency: string;
  accountScope?: { mode: 'all' | 'selected'; accountIds: readonly string[]; accountNames: readonly string[]; label: string };
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
  exchangeRatesUsed: readonly { fromCurrency: string; toCurrency: string; rate: string; effectiveDate: string; source: string; inverseRate: boolean; transactionCount: number }[];
  expensesByCategory: CategoryTotal[];
  incomeByCategory: CategoryTotal[];
  warnings: string[];
}
interface CurrencyRate {
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveDate: string;
  source: string;
}
interface CurrencyPreferences {
  displayCurrency: string;
  accountCurrencyOverrides: Record<string, string>;
  exchangeRates: CurrencyRate[];
  budgetCurrency?: string;
}
interface Period {
  startDate: string;
  endDate: string;
}
interface TrendWindow extends Period {
  month: string;
}
interface TrendPoint extends TrendWindow {
  summary: Summary;
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
  { href: '/accounts', label: 'Cuentas', icon: '€' }, 
  { href: '/reports', label: 'Informes', icon: '▥' },
  { href: '/budgets', label: 'Presupuestos', icon: '◷' },
  { href: '/planning', label: 'Planificación', icon: '◎' },
  { href: '/assistant', label: 'Asistente', icon: '✧' },
  { href: '/settings', label: 'Configuración', icon: '⚙' },
] as const;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function currentDate(): string {
  const now = new Date();
  return [String(now.getFullYear()).padStart(4, '0'), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
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
function monthPeriod(month: string): Period {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  return {
    startDate: month + '-01',
    endDate: isoDate(new Date(Date.UTC(year, monthNumber, 0))),
  };
}
function monthlyTrendWindows(mode: PeriodMode, period: Period, anchor: string): TrendWindow[] {
  const lastMonth = (mode === 'year' ? period.endDate : mode === 'custom' ? period.endDate : anchor).slice(0, 7);
  const count = mode === 'year' ? 12 : 6;
  const [yearText, monthText] = lastMonth.split('-');
  const endYear = Number(yearText);
  const endMonth = Number(monthText);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(endYear, endMonth - count + index, 1));
    const month = isoDate(date).slice(0, 7);
    return { month, ...monthPeriod(month) };
  });
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
  const response = await fetch(url, { ...(signal ? { signal } : {}), headers: { Accept: 'application/json' } });
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
function formatMoney(amountMinor: number, currency: string): string { return sharedFormatMoney(amountMinor, currency); }
function displayDate(value: string): string { return formatCivilDate(value); }
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [trendPoints, setTrendPoints] = useState<TrendPoint[]>([]);
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendError, setTrendError] = useState('');
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
  const [currencyPreferences, setCurrencyPreferences] = useState<CurrencyPreferences>({
    displayCurrency: 'EUR', accountCurrencyOverrides: {}, exchangeRates: [],
  });
  const [currencySaving, setCurrencySaving] = useState(false);
  const [currencySaveError, setCurrencySaveError] = useState('');
  const [currencySaveNotice, setCurrencySaveNotice] = useState('');
  const [movementNotice, setMovementNotice] = useState('');
  const [appPreferences, setAppPreferences] = useState<AppPreferences>({ theme: 'system', locale: 'es-ES' });
  const [, setFormattingRevision] = useState(0);
  const [appPreferencesSaving, setAppPreferencesSaving] = useState(false);
  const [appPreferencesError, setAppPreferencesError] = useState('');
  const [appPreferencesNotice, setAppPreferencesNotice] = useState('');
  const [preferencesResetting, setPreferencesResetting] = useState(false);
  const [preferencesResetError, setPreferencesResetError] = useState('');
  const [preferencesResetNotice, setPreferencesResetNotice] = useState('');
  const [accountScope, setAccountScope] = useState<AccountScopePreference | null>(null);
  const [accountScopeDraft, setAccountScopeDraft] = useState<AccountScopeDraft>({ mode: 'all', accountIds: [] });
  const [accountScopeSaving, setAccountScopeSaving] = useState(false);
  const [accountScopeSaveError, setAccountScopeSaveError] = useState('');
  const [accountScopeSaveNotice, setAccountScopeSaveNotice] = useState('');
  const [manualQuickRequest, setManualQuickRequest] = useState<{ key: number; kind: 'income' | 'expense' | 'transfer' } | null>(null);
  const [movementOperationNotice, setMovementOperationNotice] = useState('');

  const [route, setRoute] = useState(() => window.location.pathname.replace(/\/+$/, '') || '/');
  const previousRoute = useRef(route);

  useEffect(() => {
    setFinanceLocale(appPreferences.locale);
    setFormattingRevision((value) => value + 1);
    const root = document.documentElement;
    root.lang = appPreferences.locale;
    const preference = appPreferences.theme;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      root.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    };
    applyTheme();
    if (preference === 'system') {
      media.addEventListener('change', applyTheme);
      return () => media.removeEventListener('change', applyTheme);
    }
    return undefined;
  }, [appPreferences]);

  useEffect(() => {
    const syncRoute = () => setRoute(window.location.pathname.replace(/\/+$/, '') || '/');
    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  }, []);

  useEffect(() => {
    if (previousRoute.current === route) return;
    previousRoute.current = route;
    document.querySelector<HTMLHeadingElement>('.page-header h1')?.focus({ preventScroll: true });
  }, [route]);

  function navigate(event: MouseEvent<HTMLAnchorElement>, href: string): void {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.currentTarget.origin !== window.location.origin) return;
    event.preventDefault();
    navigateTo(href);
  }
  function navigateTo(href: string): void {
    if (window.location.pathname !== href) setMovementOperationNotice('');
    if (window.location.pathname !== href) window.history.pushState(null, '', href);
    setRoute(href);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function quickRegister(kind: 'income' | 'expense' | 'transfer'): void {
    setManualQuickRequest((previous) => ({ key: (previous?.key ?? 0) + 1, kind }));
    setAccountFilter('all');
    setPage(1);
    navigateTo('/movements');
  }
  function openAccountMovements(accountId: string): void {
    setAccountFilter(accountId);
    setPage(1);
    navigateTo('/movements');
  }
  const pageTitle = NAV_ITEMS.find((item) => item.href === route)?.label ?? 'Resumen';
  const period = useMemo(() => periodFor(mode, anchor, customStart, customEnd), [mode, anchor, customStart, customEnd]);
  const previous = useMemo(() => previousPeriod(mode, period), [mode, period]);
  const trendWindows = useMemo(() => monthlyTrendWindows(mode, period, anchor), [mode, period, anchor]);
  const invalidPeriod = period.startDate > period.endDate;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await apiData<{ status: string }>('/ready', controller.signal);
        const [accountsResult, categoriesResult, currencyResult, accountScopeResult, appPreferencesResult] = await Promise.all([
          apiData<Account[]>('/api/v1/accounts', controller.signal),
          apiData<Category[]>('/api/v1/categories', controller.signal),
          apiData<CurrencyPreferences>('/api/v1/preferences/currency', controller.signal),
          apiData<AccountScopePreference>('/api/v1/preferences/accounts', controller.signal),
          apiData<AppPreferences>('/api/v1/preferences/app', controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setAccounts(accountsResult);
        setCategories(categoriesResult);
        setCurrencyPreferences({
          displayCurrency: currencyResult.displayCurrency,
          accountCurrencyOverrides: currencyResult.accountCurrencyOverrides ?? {},
          exchangeRates: currencyResult.exchangeRates ?? [],
          budgetCurrency: currencyResult.budgetCurrency ?? 'EUR',
        });
        setAccountScope(accountScopeResult);
        setAccountScopeDraft({ mode: accountScopeResult.mode, accountIds: [...(accountScopeResult.accountIds ?? [])] });
        setAppPreferences(appPreferencesResult);
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
      route === '/' || route === '/reports'
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
  }, [accountFilter, accounts, bootLoaded, categoryFilter, connection, invalidPeriod, page, period, previous, refreshKey, route, searchText, sortAscending, sortKey, uncategorizedOnly]);

  useEffect(() => {
    if (!bootLoaded || connection !== 'connected' || route !== '/') {
      setTrendPoints([]);
      setTrendError('');
      setTrendLoading(false);
      return;
    }
    const controller = new AbortController();
    setTrendLoading(true);
    setTrendError('');
    void Promise.all(trendWindows.map(async (window) => ({
      ...window,
      summary: await apiData<Summary>('/api/v1/reports/summary' + queryFor(window), controller.signal),
    })))
      .then((results) => { if (!controller.signal.aborted) setTrendPoints(results); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setTrendError(error instanceof Error ? error.message : 'No se ha podido cargar la tendencia mensual.');
          setTrendPoints([]);
        }
      })
      .finally(() => { if (!controller.signal.aborted) setTrendLoading(false); });
    return () => controller.abort();
  }, [bootLoaded, connection, refreshKey, route, trendWindows]);

  const movementAccounts = useMemo(() => accounts.filter((account) => !account.closed &&
    (accountScope?.mode !== 'selected' || accountScope.accountIds.includes(account.id))), [accounts, accountScope]);
  const filteredTransactions = transactions;
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(transactionTotal / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleTransactions = filteredTransactions;


  async function saveAccountScope(): Promise<void> {
    if (accountScopeSaving) return;
    setAccountScopeSaving(true);
    setAccountScopeSaveError('');
    setAccountScopeSaveNotice('');
    try {
      const payload: AccountScopeDraft = accountScopeDraft.mode === 'all'
        ? { mode: 'all', accountIds: [] }
        : { mode: 'selected', accountIds: [...new Set(accountScopeDraft.accountIds)] };
      const response = await fetch('/api/v1/preferences/accounts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as ApiPayload<AccountScopePreference>;
      if (!response.ok || !result.data) {
        throw new Error(result.error?.message ?? 'No se pudo guardar el ámbito de cuentas.');
      }
      setAccountScope(result.data);
      setAccountScopeDraft({ mode: result.data.mode, accountIds: [...result.data.accountIds] });
      setAccountFilter('all');
      setPage(1);
      setRefreshKey((value) => value + 1);
      setAccountScopeSaveNotice('Ámbito de análisis guardado localmente.');
    } catch (error) {
      setAccountScopeSaveError(error instanceof Error ? error.message : 'No se pudo guardar el ámbito de cuentas.');
    } finally {
      setAccountScopeSaving(false);
    }
  }

  async function saveAppPreferences(): Promise<void> {
    if (appPreferencesSaving) return;
    setAppPreferencesSaving(true); setAppPreferencesError(''); setAppPreferencesNotice('');
    try {
      const response = await fetch('/api/v1/preferences/app', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(appPreferences),
      });
      const result = await response.json() as ApiPayload<AppPreferences>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'No se pudieron guardar las preferencias de interfaz.');
      setAppPreferences(result.data);
      setAppPreferencesNotice('Preferencias de interfaz guardadas localmente.');
    } catch (error) {
      setAppPreferencesError(error instanceof Error ? error.message : 'No se pudieron guardar las preferencias de interfaz.');
    } finally { setAppPreferencesSaving(false); }
  }

  async function resetApplicationPreferences(): Promise<void> {
    if (preferencesResetting) return;
    const confirmed = window.confirm('Se restablecerán solo el tema, el formato regional, la divisa de análisis y el ámbito de cuentas. No se borrará ni modificará ningún movimiento, categoría, presupuesto, backup o archivo descargado. ¿Continuar?');
    if (!confirmed) return;
    setPreferencesResetting(true); setPreferencesResetError(''); setPreferencesResetNotice(''); setAppPreferencesError(''); setAppPreferencesNotice('');
    try {
      const response = await fetch('/api/v1/preferences/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ confirmation: 'RESET_APP_PREFERENCES' }),
      });
      const result = await response.json() as ApiPayload<{
        reset: boolean; app: AppPreferences; currency: CurrencyPreferences;
        accountScope: AccountScopePreference;
      }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'No se pudieron restablecer las preferencias locales.');
      setAppPreferences(result.data.app);
      setCurrencyPreferences({
        displayCurrency: result.data.currency.displayCurrency,
        accountCurrencyOverrides: result.data.currency.accountCurrencyOverrides ?? {},
        exchangeRates: result.data.currency.exchangeRates ?? [],
        budgetCurrency: result.data.currency.budgetCurrency ?? 'EUR',
      });
      const openAccounts = accounts.filter((account) => !account.closed);
      setAccountScope({
        ...result.data.accountScope,
        label: 'Todas las cuentas abiertas',
        activeAccountIds: openAccounts.map((account) => account.id),
        accountNames: openAccounts.map((account) => account.name),
      });
      setAccountScopeDraft({ mode: 'all', accountIds: [] });
      setAccountFilter('all'); setCategoryFilter('all'); setUncategorizedOnly(false); setSearchText(''); setPage(1);
      setRefreshKey((value) => value + 1);
      setPreferencesResetNotice('Preferencias locales restablecidas. El presupuesto y sus movimientos no se han modificado.');
    } catch (error) {
      setPreferencesResetError(error instanceof Error ? error.message : 'No se pudieron restablecer las preferencias locales.');
    } finally { setPreferencesResetting(false); }
  }

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
  const currency = summary?.currency ?? currencyPreferences.displayCurrency ?? 'EUR';
  function updateExchangeRate(index: number, field: keyof CurrencyRate, value: string): void {
    setCurrencyPreferences((previous) => ({
      ...previous,
      exchangeRates: previous.exchangeRates.map((item, i) => i === index ? { ...item, [field]: value } : item),
    }));
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Saltar al contenido principal</a>
      <aside className="sidebar" aria-label="Navegación principal">
        <a className="brand" href="/" onClick={(event) => navigate(event, '/')} aria-label="personal-budget, ir al resumen">
          <span className="brand-mark" aria-hidden="true">pb</span>
          <span><strong>personal-budget</strong><small>FINANZAS LOCALES</small></span>
        </a>
        <nav className="nav-list" aria-label="Secciones de la aplicación">
          {NAV_ITEMS.map((item) => (
            <a className={'nav-item' + (item.href === route ? ' active' : '')} href={item.href} onClick={(event) => navigate(event, item.href)}
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

      <main id="main-content" className="main-content" tabIndex={-1}>
        <header className="page-header">
          <div>
            <p className="eyebrow">ÁREA PERSONAL / {pageTitle.toLocaleUpperCase('es')}</p>
            <h1 tabIndex={-1}>{route === '/' ? 'Resumen financiero' : route === '/movements' ? 'Movimientos' : route === '/reports' ? 'Informes' : route === '/assistant' ? 'Asistente' : route === '/settings' ? 'Configuración' : pageTitle}</h1>
            <p className="page-subtitle">Tus finanzas, con cálculos verificables y sin enviar datos a terceros.</p>
          </div>
          <div className="header-status" role="status"><span className={'status-dot ' + connection} />
            {connection === 'connected' ? 'Actual Budget' : connection === 'checking' ? 'Conectando…' : connection === 'unconfigured' ? 'Configura tu presupuesto' : 'API no disponible'}
          </div>
        </header>

        {route === '/movements' && movementNotice ? <p className="form-alert success movement-operation-notice" role="status">{movementNotice}</p> : null}
        {connection === 'checking' ? <LoadingState /> : null}
        {connection === 'unconfigured' ? <ErrorNotice title="Actual Budget aún no está conectado" message={bootError || 'Configura la conexión local con Actual Budget para consultar tus datos.'} /> : null}
        {connection === 'error' ? <ErrorNotice title="No se puede cargar la aplicación" message={bootError || 'Comprueba el backend local y vuelve a intentarlo.'} onRetry={retryBoot} /> : null}

        {connection === 'connected' && bootLoaded ? (
          <>

            <section className="panel account-scope-panel" aria-labelledby="account-scope-heading">
              <div className="section-heading">
                <div><p className="eyebrow">ÁMBITO GLOBAL DE ANÁLISIS</p><h2 id="account-scope-heading">Cuentas incluidas</h2></div>
                <span className="date-badge">{accountScope?.label ?? 'Cargando ámbito…'}</span>
              </div>
              <p className="setting-hint">El ámbito se aplica a resumen, tendencias, informes, asistente y planificación. El filtro de Movimientos solo puede estrechar esta selección. Los presupuestos por categoría siguen siendo los del presupuesto completo de Actual.</p>
              {accountScope?.warning ? <p className="form-alert error" role="alert">{accountScope.warning} Selecciona «Todas las cuentas abiertas» o guarda una selección válida para volver a habilitar los análisis.</p> : null}
              <div className="account-scope-mode" role="radiogroup" aria-label="Modo del ámbito de cuentas">
                <label className="check-field">
                  <input type="radio" name="account-scope-mode" checked={accountScopeDraft.mode === 'all'}
                    onChange={() => setAccountScopeDraft({ mode: 'all', accountIds: [] })} />
                  Todas las cuentas abiertas
                </label>
                <label className="check-field">
                  <input type="radio" name="account-scope-mode" aria-label="Seleccionar cuentas" checked={accountScopeDraft.mode === 'selected'}
                    onChange={() => setAccountScopeDraft((previous) => ({ mode: 'selected', accountIds: previous.mode === 'selected' ? previous.accountIds : [] }))} />
                  Seleccionar cuentas
                </label>
              </div>
              {accountScopeDraft.mode === 'selected' ? (
                <div className="account-scope-options" role="group" aria-label="Cuentas seleccionadas para análisis">
                  {accounts.filter((account) => !account.closed).length === 0
                    ? <p className="muted-copy">No hay cuentas abiertas disponibles.</p>
                    : accounts.filter((account) => !account.closed).map((account) => (
                      <label className="check-field" key={account.id}>
                        <input type="checkbox" checked={accountScopeDraft.accountIds.includes(account.id)}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            const openIds = accounts.filter((candidate) => !candidate.closed).map((candidate) => candidate.id);
                            setAccountScopeDraft((previous) => {
                              const validIds = previous.accountIds.filter((id) => openIds.includes(id));
                              const ids = checked
                                ? [...validIds.filter((id) => id !== account.id), account.id]
                                : validIds.filter((id) => id !== account.id);
                              return { mode: 'selected', accountIds: ids };
                            });
                          }} />
                        {account.name}
                      </label>
                    ))}
                  {accountScopeDraft.accountIds.length === 0 ? <p className="setting-hint">No hay cuentas seleccionadas; los totales serán cero hasta seleccionar alguna.</p> : null}
                </div>
              ) : null}
              <div className="button-row">
                <button className="button primary" type="button" disabled={accountScopeSaving}
                  onClick={() => { void saveAccountScope(); }}>
                  {accountScopeSaving ? 'Guardando…' : 'Guardar ámbito'}
                </button>
                <button className="button secondary" type="button" disabled={accountScopeSaving}
                  onClick={() => setAccountScopeDraft({ mode: 'all', accountIds: [] })}>
                  Restablecer todas las cuentas
                </button>
              </div>
              {accountScopeSaveError ? <p role="alert" className="form-alert error">{accountScopeSaveError}</p> : null}
              {accountScopeSaveNotice ? <p role="status" className="form-alert success">{accountScopeSaveNotice}</p> : null}
            </section>
            {route === '/movements' && movementOperationNotice ? <p className="form-alert success" role="status">{movementOperationNotice}</p> : null}
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
                      <StatCard label="Tasa de ahorro" value={summary.savingsRatePercent === null ? 'No aplicable' : new Intl.NumberFormat(appPreferences.locale, { maximumFractionDigits: 1 }).format(summary.savingsRatePercent) + ' %'} detail={summary.incomeMinor > 0 ? 'Ahorro neto / ingresos' : 'No hay ingresos positivos clasificados'} />
                    </div>
                    <div className="two-column">
                      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">DISTRIBUCIÓN</p><h3>Gastos por categoría</h3></div><span className="muted-label">{summary.expensesByCategory.length} categorías</span></div>
                        <CategoryBars totals={summary.expensesByCategory.slice(0, 6)} currency={currency} />
                      </article>
                      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">SEÑALES</p><h3>Aspectos a revisar</h3></div></div>
                        {summary.warnings.length ? <ul className="warning-list">{summary.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <EmptyState title="Sin alertas de clasificación" body="No hay avisos que requieran revisión en este periodo." />}
                        <div className="detail-line"><span>Movimientos consolidados</span><strong>{summary.transactionCount - summary.unconvertedTransactionCount}</strong></div>
                        {summary.unconvertedTransactionCount > 0 ? <div className="detail-line"><span>Movimientos sin conversión</span><strong>{summary.unconvertedTransactionCount}</strong></div> : null}
                        <div className="detail-line"><span>Traspasos excluidos del consolidado</span><strong>{summary.excludedTransferCount}</strong></div>
                      </article>
                    </div>
                    <DashboardSignals
                      accounts={accounts}
                      activeAccountIds={accountScope?.activeAccountIds ?? accounts.filter((account) => !account.closed).map((account) => account.id)}
                      accountScopeLabel={accountScope?.label ?? 'Ámbito pendiente'}
                      currency={currency}
                      summary={summary}
                      comparison={comparison}
                      reloadKey={refreshKey}
                      onNavigate={navigateTo}
                      onQuickRegister={quickRegister}
                    />
                    {summary.exchangeRatesUsed.length > 0 ? <details className="panel exchange-rate-details">
                      <summary>Tipos de cambio utilizados ({summary.exchangeRatesUsed.length})</summary>
                      <div className="comparison-rows">{summary.exchangeRatesUsed.map((rate) => (
                        <div className="comparison-row" key={[rate.fromCurrency, rate.toCurrency, rate.rate, rate.effectiveDate, rate.source, rate.inverseRate].join('|')}>
                          <div><span>{rate.fromCurrency} → {rate.toCurrency}</span><strong>{rate.rate}{rate.inverseRate ? ' (tasa inversa)' : ''}</strong></div>
                          <div className="comparison-meta"><span>Aplicable desde {rate.effectiveDate} · fuente: {rate.source}</span><span>{rate.transactionCount} movimientos</span></div>
                        </div>
                      ))}</div>
                    </details> : null}
                    <MonthlyTrendPanel points={trendPoints} currency={currency} loading={trendLoading} error={trendError} />
                    <div className="section-footnote">Importes calculados con reglas deterministas en el backend. Los movimientos divididos se normalizan antes de agregarse; no se suman divisas distintas.</div>
                  </>
                ) : <EmptyState title="No hay resumen disponible" body="Selecciona un periodo válido o comprueba la conexión con Actual Budget." />}
              </section>
            )}

            {!dataLoading && !dataError && !invalidPeriod && route === '/accounts' && (
              <AccountsPanel
                accounts={accounts}
                currency={currency}
                activeAccountIds={accountScope?.activeAccountIds ?? accounts.filter((account) => !account.closed).map((account) => account.id)}
                onOpenMovements={openAccountMovements}
              />
            )}

            {!dataLoading && !dataError && !invalidPeriod && route === '/movements' && (
              <section className="content-section" aria-labelledby="movements-heading">
                <div className="section-heading"><div><p className="eyebrow">LIBRO DE MOVIMIENTOS</p><h2 id="movements-heading">Transacciones</h2></div><span className="date-badge">{transactionTotal} resultados</span></div>
                <MovementTools
                  accounts={movementAccounts}
                  categories={categories}
                  currency={currency}
                  quickRequest={manualQuickRequest}

                  onImported={(notice) => { if (notice) { setMovementOperationNotice(notice); setMovementNotice(notice); } setPage(1); setRefreshKey((value) => value + 1); }}
                />
                {accounts.filter((item) => !item.closed).length === 0 ? <EmptyState title="No hay cuentas disponibles" body="Crea o abre una cuenta en Actual Budget y vuelve a cargar los datos." /> : (
                  <>
                    <div className="filters-panel">
                      <label className="field-label search-field">Buscar<input type="search" placeholder="Concepto, cuenta o categoría" value={searchText} onChange={(event) => { setSearchText(event.currentTarget.value); setPage(1); }} /></label>
                      <label className="field-label">Cuenta<select value={accountFilter} onChange={(event) => { setAccountFilter(event.currentTarget.value); setPage(1); }}><option value="all">Todas las cuentas del ámbito</option>{movementAccounts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
                      <label className="field-label">Categoría<select value={categoryFilter} onChange={(event) => { setCategoryFilter(event.currentTarget.value); setUncategorizedOnly(false); setPage(1); }}><option value="all">Todas las categorías</option>{categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
                      <label className="check-field"><input type="checkbox" checked={uncategorizedOnly} onChange={(event) => { setUncategorizedOnly(event.currentTarget.checked); setCategoryFilter('all'); setPage(1); }} /> Sin categoría</label>
                    </div>
                    <MovementManager
                      transactions={visibleTransactions}
                      total={transactionTotal}
                      accounts={accounts}
                      categories={categories}
                      currency={currency}
                      locale={appPreferences.locale}
                      startDate={period.startDate}
                      endDate={period.endDate}
                      accountFilter={accountFilter}
                      categoryFilter={categoryFilter}
                      searchText={searchText}
                      uncategorizedOnly={uncategorizedOnly}
                      sortKey={sortKey}
                      sortAscending={sortAscending}
                      filterKey={[period.startDate, period.endDate, accountFilter, categoryFilter, searchText, uncategorizedOnly, page, sortKey, sortAscending].join('|')}
                      accountScopeLabel={accountScope?.label ?? (accountScope?.mode === 'selected' ? 'Cuentas seleccionadas' : 'Todas las cuentas abiertas')}
                      onSort={changeSort}
                      onUpdated={(notice, refresh = true) => { setMovementNotice(notice); if (refresh) setRefreshKey((value) => value + 1); }}
                    />
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
                    <ReportExportPanel current={summary} previous={comparison} period={period} comparisonPeriod={previous} />
                  </>
                ) : <EmptyState title="No hay datos suficientes" body="El informe necesita un presupuesto configurado y datos devueltos por Actual Budget." />}
              </section>
            )}

            {route === '/budgets' && (
              <>
                <p className="setting-hint">Los presupuestos y asignaciones de Actual pertenecen al presupuesto completo; el ámbito de cuentas limita el análisis de movimientos, no convierte un presupuesto global en presupuestos por cuenta.</p>
                <BudgetPanel currency={currencyPreferences.budgetCurrency ?? 'EUR'} onBudgetUpdated={() => { setRefreshKey((value) => value + 1); }} />
              </>
            )}

            {route === '/assistant' && <AssistantPanel currency={currency} />}
            {route === '/planning' && <PlanningPanel currency={currency} />}

            {route === '/settings' && (
              <section className="content-section">
                <SettingsCenter
                  preferences={appPreferences}
                  onChange={setAppPreferences}
                  onSave={() => { void saveAppPreferences(); }}
                  onReset={() => { void resetApplicationPreferences(); }}
                  saving={appPreferencesSaving}
                  saveError={appPreferencesError}
                  saveNotice={appPreferencesNotice}
                  resetting={preferencesResetting}
                  resetError={preferencesResetError}
                  resetNotice={preferencesResetNotice}
                  currency={currencyPreferences.displayCurrency}
                  budgetCurrency={currencyPreferences.budgetCurrency ?? 'EUR'}
                  accountCount={accounts.length}
                  categoryCount={categories.length}
                />
                <article className="panel settings-panel currency-settings">
                  <p className="eyebrow">PRESENTACIÓN FINANCIERA</p>
                  <h3>Divisa de análisis y conversiones</h3>
                  <p className="setting-hint">La divisa de análisis solo cambia la presentación y los agregados locales; nunca reescribe movimientos en Actual Budget. Si se desconoce la divisa de origen o falta una tasa, el importe no se consolida.</p>
                  <label className="field-label">Divisa de análisis (código ISO de 3 letras)
                    <input value={currencyPreferences.displayCurrency} maxLength={3} pattern="[A-Za-z]{3}" onChange={(event) => {
                      const displayCurrency = event.currentTarget.value.toUpperCase();
                      setCurrencyPreferences((previous) => ({ ...previous, displayCurrency }));
                    }} />
                  </label>
                  <h4>Divisa nativa por cuenta</h4>
                  {accounts.filter((account) => !account.closed).map((account) => (
                    <div className="detail-line currency-account-row" key={account.id}>
                      <span>{account.name}<small>{account.nativeCurrencyCode ? 'Divisa nativa informada por Actual' : 'Se requiere indicar la divisa si se conoce'}</small></span>
                      <label className="field-label currency-code-field">
                        <span className="visually-hidden">Divisa nativa de {account.name}</span>
                        <input value={account.nativeCurrencyCode ?? currencyPreferences.accountCurrencyOverrides[account.id] ?? ''} disabled={Boolean(account.nativeCurrencyCode)} placeholder="Desconocida" maxLength={3} pattern="[A-Za-z]{3}" onChange={(event) => {
                          const value = event.currentTarget.value.toUpperCase();
                          setCurrencyPreferences((previous) => {
                            const next = { ...previous.accountCurrencyOverrides };
                            if (value.trim() === '') delete next[account.id];
                            else next[account.id] = value;
                            return { ...previous, accountCurrencyOverrides: next };
                          });
                        }} />
                      </label>
                    </div>
                  ))}
                  <h4>Tipos de cambio manuales</h4>
                  <p className="setting-hint">La tasa se interpreta como unidades de la divisa destino por 1 unidad de origen y se aplica desde la fecha indicada. Añade tasas históricas para informes reproducibles.</p>
                  {currencyPreferences.exchangeRates.map((rate, index) => (
                    <div className="currency-rate-row" key={rate.fromCurrency + '-' + rate.toCurrency + '-' + index}>
                      <label className="field-label">Origen<input maxLength={3} value={rate.fromCurrency} onChange={(event) => updateExchangeRate(index, 'fromCurrency', event.currentTarget.value.toUpperCase())} /></label>
                      <label className="field-label">Destino<input maxLength={3} value={rate.toCurrency} onChange={(event) => updateExchangeRate(index, 'toCurrency', event.currentTarget.value.toUpperCase())} /></label>
                      <label className="field-label">Tasa<input inputMode="decimal" value={rate.rate} onChange={(event) => updateExchangeRate(index, 'rate', event.currentTarget.value)} /></label>
                      <label className="field-label">Aplicable desde<input type="date" value={rate.effectiveDate} onChange={(event) => updateExchangeRate(index, 'effectiveDate', event.currentTarget.value)} /></label>
                      <label className="field-label">Fuente<input maxLength={100} value={rate.source} onChange={(event) => updateExchangeRate(index, 'source', event.currentTarget.value)} /></label>
                      <button className="button small" type="button" onClick={() => setCurrencyPreferences((previous) => ({ ...previous, exchangeRates: previous.exchangeRates.filter((_item, i) => i !== index) }))}>Eliminar tasa</button>
                    </div>
                  ))}
                  <div className="button-row">
                    <button className="button secondary" type="button" onClick={() => setCurrencyPreferences((previous) => ({ ...previous, exchangeRates: [...previous.exchangeRates, { fromCurrency: 'USD', toCurrency: 'EUR', rate: '', effectiveDate: currentDate(), source: 'manual' }] }))}>Añadir tasa</button>
                    <button className="button primary" type="button" disabled={currencySaving} onClick={() => {
                      void (async () => {
                        setCurrencySaving(true); setCurrencySaveError(''); setCurrencySaveNotice('');
                        try {
                          const payload = {
                            displayCurrency: currencyPreferences.displayCurrency.trim().toUpperCase(),
                            accountCurrencyOverrides: currencyPreferences.accountCurrencyOverrides,
                            exchangeRates: currencyPreferences.exchangeRates.filter((rate) => rate.rate.trim() !== ''),
                          };
                          const response = await fetch('/api/v1/preferences/currency', {
                            method: 'PUT', headers: { 'content-type': 'application/json', Accept: 'application/json' },
                            body: JSON.stringify(payload),
                          });
                          const result = await response.json() as ApiPayload<CurrencyPreferences>;
                          if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'No se pudieron guardar las preferencias monetarias.');
                          setCurrencyPreferences(result.data);
                          setAccounts(await apiData<Account[]>('/api/v1/accounts'));
                          setCurrencySaveNotice('Preferencias monetarias guardadas localmente.');
                          setRefreshKey((previous) => previous + 1);
                        } catch (error) {
                          setCurrencySaveError(error instanceof Error ? error.message : 'No se pudieron guardar las preferencias monetarias.');
                        } finally { setCurrencySaving(false); }
                      })();
                    }}>{currencySaving ? 'Guardando…' : 'Guardar preferencias'}</button>
                  </div>
                  {currencySaveError ? <p role="alert" className="form-alert error">{currencySaveError}</p> : null}
                  {currencySaveNotice ? <p role="status" className="form-alert success">{currencySaveNotice}</p> : null}
                </article>
                <div className="panel account-list-panel"><div className="panel-heading"><div><p className="eyebrow">CUENTAS</p><h3>Saldo original y saldo convertido</h3></div></div>{accounts.length ? accounts.map((account) => <div className="detail-line" key={account.id}><span>{account.name}{account.closed ? ' · Cerrada' : ''}{account.offBudget ? ' · Fuera de presupuesto' : ''}<small>{account.balanceConversion?.warning ? account.balanceConversion.warning : 'El saldo convertido usa la tasa más reciente aplicable.'}</small></span><strong>{formatAccountBalance(account.currentBalanceMinor, account.displayBalanceMinor, account.displayCurrency ?? currency, account.currencyCode)}</strong></div>) : <p className="muted-copy">No hay cuentas para mostrar.</p>}</div>
              </section>
            )}

            {!['/', '/movements', '/accounts', '/reports', '/budgets', '/planning', '/assistant', '/settings'].includes(route) && (
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
function MonthlyTrendPanel({ points, currency, loading, error }: { points: readonly TrendPoint[]; currency: string; loading: boolean; error: string }) {
  const maxValue = Math.max(1, ...points.flatMap((point) => [
    Math.max(0, point.summary.incomeMinor),
    Math.max(0, point.summary.expenseMinor),
  ]));
  return (
    <article className="panel monthly-trend-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">HISTÓRICO</p><h3>Tendencia mensual de ingresos, gastos y ahorro</h3></div>
        <span className="muted-label">{points.length ? points.length + ' meses' : 'Sin datos'}</span>
      </div>
      {loading && points.length === 0 ? <LoadingState /> : null}
      {error ? <p className="form-alert error" role="alert">{error}</p> : null}
      {!loading && !error && points.length === 0 ? <EmptyState title="Tendencia no disponible" body="No hay meses para comparar en este momento." /> : null}
      {points.length ? (
        <div className="trend-table-wrap" role="region" aria-label="Tabla de tendencia mensual; desplázate horizontalmente para ver todas las columnas" tabIndex={0}>
          <table className="trend-table">
            <thead><tr><th scope="col">Mes</th><th scope="col">Comparación visual</th><th scope="col">Ingresos</th><th scope="col">Gastos</th><th scope="col">Ahorro neto</th></tr></thead>
            <tbody>{points.map((point) => {
              const label = new Intl.DateTimeFormat('es-ES', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(point.month + '-01T00:00:00.000Z'));
              const income = Math.max(0, point.summary.incomeMinor);
              const expense = Math.max(0, point.summary.expenseMinor);
              return (
                <tr key={point.month}>
                  <td>{label}</td>
                  <td><div className="trend-bars" role="img" aria-label={point.month + ': ingresos ' + formatMoney(income, currency) + ', gastos ' + formatMoney(expense, currency) + ', ahorro ' + formatMoney(point.summary.savingsMinor, currency)}>
                    <span className="trend-label">I</span><div className="trend-track"><span className="income" style={{ width: income / maxValue * 100 + '%' }} /></div>
                    <span className="trend-label">G</span><div className="trend-track"><span className="expense" style={{ width: expense / maxValue * 100 + '%' }} /></div>
                    <span className="trend-label">A</span><div className="trend-track"><span className={point.summary.savingsMinor < 0 ? 'expense' : 'income'} style={{ width: Math.min(100, Math.abs(point.summary.savingsMinor) / maxValue * 100) + '%' }} /></div>
                  </div></td>
                  <td className="trend-number income-text">{formatMoney(point.summary.incomeMinor, currency)}</td>
                  <td className="trend-number expense-text">{formatMoney(point.summary.expenseMinor, currency)}</td>
                  <td className={'trend-number ' + (point.summary.savingsMinor < 0 ? 'expense-text' : 'income-text')}>{formatMoney(point.summary.savingsMinor, currency)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : null}
      <p className="section-footnote">Cada barra tiene su valor exacto en la tabla. Los traspasos internos se excluyen del resumen; no se mezclan importes de divisas distintas.</p>
    </article>
  );
}

function ComparisonRow({ label, current, previous, currency }: { label: string; current: number; previous: number; currency: string }) {
  const delta = current - previous;
  return <div className="comparison-row"><div><span>{label}</span><strong>{formatMoney(current, currency)}</strong></div><div className="comparison-meta"><span>Anterior: {formatMoney(previous, currency)}</span><strong className={delta > 0 ? 'up' : delta < 0 ? 'down' : ''}>{delta > 0 ? '+' : ''}{formatMoney(delta, currency)}</strong></div></div>;
}
