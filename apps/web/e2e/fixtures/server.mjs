import { createServer } from 'node:http';

let readiness = 'configured';
let failImportPreview = false;
let commitCount = 0;
let categoryWrites = 0;
let lastPreviewChanges = [];
let lastCommittedChanges = [];
let budgetedMinor = 50_000;
let currencyPreferences = { displayCurrency: 'EUR', accountCurrencyOverrides: {}, exchangeRates: [] };
let accountScope = { mode: 'all', accountIds: [] };
const now = new Date();
const iso = (date) => date.toISOString().slice(0, 10);
const currentMonthStart = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
const account = { id: 'synthetic-account-1', name: 'Cuenta sintética', closed: false, offBudget: false, currentBalanceMinor: 123456, currencyCode: 'EUR', nativeCurrencyCode: 'EUR', displayBalanceMinor: 123456, displayCurrency: 'EUR', balanceConversion: { fromCurrency: 'EUR', toCurrency: 'EUR', rate: '1', effectiveDate: iso(now), source: 'synthetic-identity', inverseRate: false } };
const secondaryAccount = { id: 'synthetic-account-2', name: 'Cuenta sintética secundaria', closed: false, offBudget: false, currentBalanceMinor: 65432, currencyCode: 'GBP', nativeCurrencyCode: 'GBP', displayBalanceMinor: null, displayCurrency: 'EUR', balanceConversion: { warning: 'No existe tipo de cambio sintético para GBP/EUR.' } };
const accounts = [account, secondaryAccount];
const categories = [
  { id: 'synthetic-food', name: 'Alimentación sintética', groupId: 'synthetic-group', isIncome: false },
  { id: 'synthetic-restaurants', name: 'Restaurantes sintéticos', groupId: 'synthetic-group', isIncome: false },
  { id: 'synthetic-income', name: 'Ingresos sintéticos', groupId: 'synthetic-income-group', isIncome: true },
];
const transactions = Array.from({ length: 22 }, (_, index) => {
  const date = new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - index));
  return {
    id: 'synthetic-tx-' + (index + 1),
    account: index % 2 === 1 ? secondaryAccount.id : account.id,
    date: iso(date),
    amount: index === 1 ? 425000 : -(2_500 + index * 100),
    category: index === 2 ? null : categories[0].id,
    payee_name: index === 0 ? 'Supermercado sintético' : index === 1 ? 'Ingreso sintético' : index === 2 ? 'Cafetería sin categoría sintética' : 'Compra sintética ' + index,
    imported_payee: '',
    notes: '',
    cleared: index % 2 === 0,
  };
});
const summary = (startDate, endDate) => {
  const inScope = accountScope.mode === 'selected' ? transactions.filter((tx) => accountScope.accountIds.includes(tx.account)) : transactions;
  if (accountScope.mode === 'all') return {
    currency: currencyPreferences.displayCurrency,
    startDate: startDate || currentMonthStart,
    endDate: endDate || iso(now),
    incomeMinor: 425000,
    expenseMinor: 48500,
    savingsMinor: 376500,
    savingsRatePercent: 88.6,
    uncategorizedOutflowMinor: 2700,
    unclassifiedInflowMinor: 0,
    excludedTransferCount: 1,
    transactionCount: transactions.length,
    expensesByCategory: [{ categoryId: categories[0].id, categoryName: categories[0].name, amountMinor: 48500, transactionCount: transactions.length - 1 }],
    incomeByCategory: [{ categoryId: categories[1].id, categoryName: categories[1].name, amountMinor: 425000, transactionCount: 1 }],
    warnings: ['Dato sintético de pruebas; no corresponde a un presupuesto real.'],
    unconvertedTransactionCount: 0,
    exchangeRatesUsed: [],
  };
  const incomeMinor = inScope.filter((tx) => tx.amount > 0).reduce((sum, tx) => sum + tx.amount, 0);
  const expenseMinor = inScope.filter((tx) => tx.amount < 0).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
  const uncategorizedOutflowMinor = inScope.filter((tx) => tx.amount < 0 && !tx.category).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
  const expensesByCategory = categories.filter((category) => !category.isIncome).map((category) => {
    const rows = inScope.filter((tx) => tx.amount < 0 && tx.category === category.id);
    return { categoryId: category.id, categoryName: category.name, amountMinor: rows.reduce((sum, tx) => sum + Math.abs(tx.amount), 0), transactionCount: rows.length };
  }).filter((item) => item.transactionCount > 0);
  const incomeByCategory = categories.filter((category) => category.isIncome).map((category) => {
    const rows = inScope.filter((tx) => tx.amount > 0 && tx.category === category.id);
    return { categoryId: category.id, categoryName: category.name, amountMinor: rows.reduce((sum, tx) => sum + tx.amount, 0), transactionCount: rows.length };
  }).filter((item) => item.transactionCount > 0);
  return {
    currency: currencyPreferences.displayCurrency,
    startDate: startDate || currentMonthStart,
    endDate: endDate || iso(now),
    incomeMinor,
    expenseMinor,
    savingsMinor: incomeMinor - expenseMinor,
    savingsRatePercent: incomeMinor > 0 ? (incomeMinor - expenseMinor) / incomeMinor * 100 : null,
    uncategorizedOutflowMinor,
    unclassifiedInflowMinor: 0,
    excludedTransferCount: 0,
    transactionCount: inScope.length,
    expensesByCategory,
    incomeByCategory,
    warnings: ['Dato sintético filtrado por ámbito de cuentas; no corresponde a un presupuesto real.'],
    unconvertedTransactionCount: 0,
    exchangeRatesUsed: [],
  };
};
const recurring = [{
  payee: 'Suscripción sintética', payeeVariants: ['Suscripción sintética'], occurrenceCount: 3, refundsExcluded: 0,
  firstDate: currentMonthStart, lastDate: iso(now), dates: [currentMonthStart, iso(now)],
  meanAbsoluteAmountMinor: 999, minAbsoluteAmountMinor: 999, maxAbsoluteAmountMinor: 999,
  amountDeviationPercent: 0, estimatedIntervalDays: 30, estimatedFrequency: 'mensual', confidence: 'alta',
  signals: ['beneficiario constante', 'importe estable'], warnings: ['Fixture sintético'],
}];
const suggestions = [{
  transactionId: 'synthetic-tx-3', date: transactions[2].date, payeeLabel: 'Cafetería sin categoría sintética',
  amountMinor: transactions[2].amount, suggestedCategoryId: categories[0].id, suggestedCategoryName: categories[0].name,
  evidenceCount: 4, lastEvidenceDate: iso(now), confidence: 'high',
}];

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('fixture body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1:3000');
  try {
    if (req.method === 'POST' && url.pathname === '/__test__/reset') {
      readiness = 'configured'; failImportPreview = false; commitCount = 0; categoryWrites = 0; lastPreviewChanges = []; lastCommittedChanges = []; budgetedMinor = 50_000; currencyPreferences = { displayCurrency: 'EUR', accountCurrencyOverrides: {}, exchangeRates: [] }; accountScope = { mode: 'all', accountIds: [] };
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__test__/mode') {
      const body = await readBody(req);
      readiness = body.readiness === 'not_configured' ? 'not_configured' : 'configured';
      failImportPreview = body.failImportPreview === true;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/__test__/state') return send(res, 200, { commitCount, categoryWrites, lastPreviewChanges, lastCommittedChanges, budgetedMinor, currencyPreferences, accountScope });
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', service: 'synthetic-fixture-api' });
    if (req.method === 'GET' && url.pathname === '/ready') {
      if (readiness !== 'configured') return send(res, 503, { status: 'not_configured', error: { code: 'NOT_CONFIGURED', message: 'El presupuesto sintético no está configurado.' } });
      return send(res, 200, { status: 'configured' });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/accounts') return send(res, 200, { data: accounts });
    if (req.method === 'GET' && url.pathname === '/api/v1/preferences/accounts') {
      const active = accountScope.mode === 'all' ? accounts.filter((entry) => !entry.closed) : accounts.filter((entry) => !entry.closed && accountScope.accountIds.includes(entry.id));
      return send(res, 200, { data: { ...accountScope, label: accountScope.mode === 'all' ? 'Todas las cuentas abiertas (' + active.length + ')' : active.length ? 'Cuentas seleccionadas: ' + active.map((entry) => entry.name).join(', ') : 'Ninguna cuenta seleccionada', activeAccountIds: active.map((entry) => entry.id), accountNames: active.map((entry) => entry.name) } });
    }
    if (req.method === 'PUT' && url.pathname === '/api/v1/preferences/accounts') {
      const body = await readBody(req);
      if (!body || !['all', 'selected'].includes(body.mode) || !Array.isArray(body.accountIds) || new Set(body.accountIds).size !== body.accountIds.length || (body.mode === 'all' && body.accountIds.length > 0) || body.accountIds.some((id) => !accounts.some((entry) => entry.id === id && !entry.closed))) {
        return send(res, 400, { error: { code: 'INVALID_ACCOUNT_SCOPE', message: 'El ámbito sintético de cuentas no es válido.' } });
      }
      accountScope = { mode: body.mode, accountIds: body.accountIds };
      const active = accountScope.mode === 'all' ? accounts.filter((entry) => !entry.closed) : accounts.filter((entry) => !entry.closed && accountScope.accountIds.includes(entry.id));
      return send(res, 200, { data: { ...accountScope, label: accountScope.mode === 'all' ? 'Todas las cuentas abiertas (' + active.length + ')' : active.length ? 'Cuentas seleccionadas: ' + active.map((entry) => entry.name).join(', ') : 'Ninguna cuenta seleccionada', activeAccountIds: active.map((entry) => entry.id), accountNames: active.map((entry) => entry.name) } });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/preferences/currency') {
      return send(res, 200, { data: { ...currencyPreferences, budgetCurrency: 'EUR' } });
    }
    if (req.method === 'PUT' && url.pathname === '/api/v1/preferences/currency') {
      const body = await readBody(req);
      if (typeof body.displayCurrency !== 'string' || !/^[A-Za-z]{3}$/.test(body.displayCurrency)) {
        return send(res, 400, { error: { code: 'INVALID_CURRENCY', message: 'La divisa sintética debe ser un código ISO de tres letras.' } });
      }
      currencyPreferences = {
        displayCurrency: body.displayCurrency.toUpperCase(),
        accountCurrencyOverrides: body.accountCurrencyOverrides ?? {},
        exchangeRates: body.exchangeRates ?? [],
      };
      return send(res, 200, { data: { ...currencyPreferences, budgetCurrency: 'EUR' } });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/categories') return send(res, 200, { data: categories });
    if (req.method === 'GET' && url.pathname === '/api/v1/reports/summary') return send(res, 200, { data: summary(url.searchParams.get('startDate'), url.searchParams.get('endDate')) });
    if (req.method === 'GET' && url.pathname === '/api/v1/transactions') {
      let filtered = [...transactions];
      if (accountScope.mode === 'selected') filtered = filtered.filter((tx) => accountScope.accountIds.includes(tx.account));
      const q = url.searchParams.get('search')?.toLocaleLowerCase('es') || '';
      if (q) filtered = filtered.filter((tx) => (tx.payee_name + ' ' + (accounts.find((entry) => entry.id === tx.account)?.name ?? '')).toLocaleLowerCase('es').includes(q));
      const accountId = url.searchParams.get('accountId');
      if (accountId) filtered = filtered.filter((tx) => tx.account === accountId);
      const categoryId = url.searchParams.get('categoryId');
      if (categoryId) filtered = filtered.filter((tx) => tx.category === categoryId);
      if (url.searchParams.get('uncategorized') === 'true') filtered = filtered.filter((tx) => !tx.category);
      const sortBy = url.searchParams.get('sortBy') || 'date';
      const order = url.searchParams.get('order') || 'desc';
      filtered.sort((a, b) => {
        const left = sortBy === 'amount' ? a.amount : sortBy === 'description' ? a.payee_name : a.date;
        const right = sortBy === 'amount' ? b.amount : sortBy === 'description' ? b.payee_name : b.date;
        return (left < right ? -1 : left > right ? 1 : 0) * (order === 'asc' ? 1 : -1);
      });
      const limit = Number(url.searchParams.get('limit') || 20);
      const offset = Number(url.searchParams.get('offset') || 0);
      return send(res, 200, { data: filtered.slice(offset, offset + limit), pagination: { total: filtered.length, limit, offset, sortBy, order } });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/import/preview') {
      const body = await readBody(req);
      if (failImportPreview) return send(res, 502, { error: { code: 'UPSTREAM_FAILURE', message: 'La previsualización sintética ha fallado; no se han escrito movimientos.' } });
      return send(res, 200, { data: { added: body.records?.length ?? 0, updated: 0, errors: 0, submitted: body.records?.length ?? 0, dryRun: true } });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/import/commit') {
      const body = await readBody(req);
      commitCount += body.records?.length ?? 0;
      return send(res, 200, { data: { added: body.records?.length ?? 0, updated: 0, errors: 0, submitted: body.records?.length ?? 0, dryRun: false } });
    }
    const monthMatch = url.pathname.match(/^\/api\/v1\/budgets\/(\d{4}-\d{2})$/);
    if (req.method === 'GET' && monthMatch) {
      const month = monthMatch[1];
      return send(res, 200, { data: {
        month,
        totals: { totalBudgetedMinor: budgetedMinor, totalSpentMinor: 25000, totalBalanceMinor: budgetedMinor - 25000, totalIncomeMinor: 425000, incomeAvailableMinor: 425000, toBudgetMinor: 10000 },
        categories: [{ categoryId: categories[0].id, categoryName: categories[0].name, groupId: 'synthetic-group', groupName: 'Gastos sintéticos', isIncome: false, hidden: false, budgetedMinor, spentMinor: 25000, availableMinor: budgetedMinor - 25000, percentUsed: budgetedMinor > 0 ? 50 : null, carryover: false, state: 'budgeted' }],
        notes: ['Fixtures sintéticos de aceptación de navegador.'],
      } });
    }
    const allocationMatch = url.pathname.match(/^\/api\/v1\/budgets\/\d{4}-\d{2}\/([^/]+)$/);
    if (req.method === 'PUT' && allocationMatch) {
      const body = await readBody(req); budgetedMinor = body.amountMinor;
      return send(res, 200, { data: { updated: true } });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/insights/recurring') return send(res, 200, { data: recurring });
    if (req.method === 'GET' && url.pathname === '/api/v1/insights/category-suggestions') return send(res, 200, { data: suggestions });
    if (req.method === 'POST' && url.pathname === '/api/v1/insights/categorize') {
      const body = await readBody(req);
      if (body.commit === true) {
        categoryWrites += body.transactions?.length ?? 0;
        lastCommittedChanges = body.transactions ?? [];
      } else {
        lastPreviewChanges = body.transactions ?? [];
      }
      return send(res, 200, { data: { preview: body.commit !== true, requested: body.transactions?.length ?? 0, changes: body.transactions?.length ?? 0 } });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/assistant/status') return send(res, 200, { enabled: false, status: 'disabled' });
    if (req.method === 'POST' && url.pathname === '/api/v1/assistant/chat') return send(res, 503, { error: { code: 'AI_DISABLED', message: 'El asistente local está desactivado.' } });
    if (req.method === 'POST' && url.pathname === '/api/v1/forecasts/simulate') {
      const body = await readBody(req);
      const horizon = body.horizonMonths || 6;
      const monthlyProjection = Array.from({ length: horizon }, (_, index) => {
        const date = new Date(now.getFullYear(), now.getMonth() + index + 1, 1);
        return { month: date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0'), incomeMinor: 425000, expenseMinor: 48500, savingsMinor: 376500 };
      });
      return send(res, 200, { data: { isEstimate: true, currency: 'EUR', horizonMonths: horizon, history: { startDate: currentMonthStart, endDate: iso(now), monthsWithData: 1, transactionCount: transactions.length }, baselineMonthlyIncomeMinor: 425000, recurringExpenseMonthlyMinor: 999, extraordinaryExpenseMonthlyMinor: 47501, projectedMonthlyIncomeMinor: 425000, projectedMonthlyExpenseMinor: 48500, projectedMonthlySavingsMinor: 376500, projectedSavingsMinor: 376500 * horizon, monthlyProjection, assumptions: ['Fixture sintético.'], warnings: ['Resultado ficticio para E2E.'] } });
    }
    return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Ruta sintética no disponible.' } });
  } catch {
    return send(res, 400, { error: { code: 'INVALID_FIXTURE_REQUEST', message: 'La API sintética no pudo procesar la petición.' } });
  }
});
server.listen(3000, '127.0.0.1', () => console.log('Synthetic fixture API listening on 127.0.0.1:3000'));
process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
