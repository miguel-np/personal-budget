import { createServer } from 'node:http';

let readiness = 'configured';

let failImportPreview = false;
let commitCount = 0;
let transferPreviewCount = 0;
let transferCommitCount = 0;
let lastTransferPayload = null;
let categoryWrites = 0;
let transactionWrites = 0;
let lastTransactionUpdate = null;
let appPreferences = { theme: 'system', locale: 'es-ES' };
let lastPreviewChanges = [];
let lastCommittedChanges = [];
let budgetedMinor = 50_000;
let currencyPreferences = { displayCurrency: 'EUR', accountCurrencyOverrides: {}, exchangeRates: [] };
let accountScope = { mode: 'all', accountIds: [] };
const now = new Date();
const iso = (date) => date.toISOString().slice(0, 10);
const currentMonthStart = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
const account = { id: 'synthetic-account-1', name: 'Cuenta sintética', closed: false, offBudget: false, currentBalanceMinor: 123456, currencyCode: 'EUR', nativeCurrencyCode: 'EUR', displayBalanceMinor: 123456, displayCurrency: 'EUR', balanceConversion: { fromCurrency: 'EUR', toCurrency: 'EUR', rate: '1', effectiveDate: iso(now), source: 'synthetic-identity', inverseRate: false } };
const transferAccount = { id: 'synthetic-account-transfer-eur', name: 'Cuenta de transferencia sintética', closed: false, offBudget: false, currentBalanceMinor: 40000, currencyCode: 'EUR', nativeCurrencyCode: 'EUR', displayBalanceMinor: 40000, displayCurrency: 'EUR', balanceConversion: { fromCurrency: 'EUR', toCurrency: 'EUR', rate: '1', effectiveDate: iso(now), source: 'synthetic-identity', inverseRate: false } };
const secondaryAccount = { id: 'synthetic-account-2', name: 'Cuenta sintética secundaria', closed: false, offBudget: false, currentBalanceMinor: 65432, currencyCode: 'GBP', nativeCurrencyCode: 'GBP', displayBalanceMinor: null, displayCurrency: 'EUR', balanceConversion: { warning: 'No existe tipo de cambio sintético para GBP/EUR.' } };
const accounts = [account, transferAccount, secondaryAccount];
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

const transferSource = {
  id: 'synthetic-transfer-source', account: account.id, date: iso(now), amount: -5_000,
  transfer_id: 'synthetic-transfer-counterpart', payee_name: transferAccount.name,
  imported_payee: transferAccount.name, notes: 'Transferencia sintética', cleared: false,
};
const transferCounterpart = {
  id: 'synthetic-transfer-counterpart', account: transferAccount.id, date: iso(now), amount: 5_000,
  transfer_id: 'synthetic-transfer-source', payee_name: account.name,
  imported_payee: account.name, notes: 'Transferencia sintética', cleared: false,
};
const splitParent = {
  id: 'synthetic-split-parent', account: account.id, date: iso(now), amount: -7_000,
  is_parent: true, payee_name: 'Compra dividida sintética', imported_payee: 'Compra dividida sintética',
  notes: '', cleared: false,
  subtransactions: [
    { id: 'synthetic-split-food', account: account.id, date: iso(now), amount: -3_000, category: categories[0].id, notes: 'Parte alimentación', parent_id: 'synthetic-split-parent', is_child: true, is_parent: false, cleared: false },
    { id: 'synthetic-split-other', account: account.id, date: iso(now), amount: -4_000, category: categories[1].id, notes: 'Parte restaurantes', parent_id: 'synthetic-split-parent', is_child: true, is_parent: false, cleared: false },
  ],
};
const linkedTransactions = [transferSource, transferCounterpart, splitParent];
function allTransactions() {
  return [...transactions, ...linkedTransactions];
}
function resetLinkedTransactions() {
  Object.assign(transferSource, { date: iso(now), amount: -5_000, notes: 'Transferencia sintética', cleared: false });
  Object.assign(transferCounterpart, { date: iso(now), amount: 5_000, notes: 'Transferencia sintética', cleared: false });
  Object.assign(splitParent, {
    date: iso(now), amount: -7_000, imported_payee: 'Compra dividida sintética', notes: '', cleared: false,
    subtransactions: [
      { id: 'synthetic-split-food', account: account.id, date: iso(now), amount: -3_000, category: categories[0].id, notes: 'Parte alimentación', parent_id: 'synthetic-split-parent', is_child: true, is_parent: false, cleared: false },
      { id: 'synthetic-split-other', account: account.id, date: iso(now), amount: -4_000, category: categories[1].id, notes: 'Parte restaurantes', parent_id: 'synthetic-split-parent', is_child: true, is_parent: false, cleared: false },
    ],
  });
}
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
      readiness = 'configured'; failImportPreview = false; commitCount = 0; transferPreviewCount = 0; transferCommitCount = 0; lastTransferPayload = null; categoryWrites = 0; transactionWrites = 0; lastTransactionUpdate = null; appPreferences = { theme: 'system', locale: 'es-ES' }; lastPreviewChanges = []; lastCommittedChanges = []; budgetedMinor = 50_000; currencyPreferences = { displayCurrency: 'EUR', accountCurrencyOverrides: {}, exchangeRates: [] }; accountScope = { mode: 'all', accountIds: [] }; resetLinkedTransactions();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__test__/mode') {
      const body = await readBody(req);
      readiness = body.readiness === 'not_configured' ? 'not_configured' : 'configured';
      failImportPreview = body.failImportPreview === true;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/__test__/state') return send(res, 200, {
      commitCount, transferPreviewCount, transferCommitCount, lastTransferPayload, categoryWrites,
      transactionWrites, lastTransactionUpdate, appPreferences, lastPreviewChanges, lastCommittedChanges,
      budgetedMinor, currencyPreferences, accountScope,
      transferState: { source: { ...transferSource }, counterpart: { ...transferCounterpart } },
      splitState: { parentId: splitParent.id, parentAmount: splitParent.amount, date: splitParent.date, children: splitParent.subtransactions.map((child) => ({ ...child })) },
    });
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
    if (req.method === 'GET' && url.pathname === '/api/v1/preferences/app') return send(res, 200, { data: appPreferences });
    if (req.method === 'PUT' && url.pathname === '/api/v1/preferences/app') {
      const body = await readBody(req);
      if (!['system', 'dark', 'light'].includes(body.theme) || !['es-ES', 'en-GB'].includes(body.locale)) {
        return send(res, 400, { error: { code: 'INVALID_APP_PREFERENCES', message: 'Las preferencias sintéticas no son válidas.' } });
      }
      appPreferences = { theme: body.theme, locale: body.locale };
      return send(res, 200, { data: appPreferences });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/preferences/reset') {
      const body = await readBody(req);
      if (body.confirmation !== 'RESET_APP_PREFERENCES') return send(res, 400, { error: { code: 'CONFIRMATION_REQUIRED', message: 'Se requiere confirmación explícita.' } });
      appPreferences = { theme: 'system', locale: 'es-ES' };
      currencyPreferences = { displayCurrency: 'EUR', accountCurrencyOverrides: {}, exchangeRates: [] };
      accountScope = { mode: 'all', accountIds: [] };
      return send(res, 200, { data: { reset: true, app: appPreferences, currency: { ...currencyPreferences, budgetCurrency: 'EUR' }, accountScope } });
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
      let filtered = allTransactions().flatMap((entry) => {
        if (entry.is_parent === true && entry.subtransactions?.length) {
          return entry.subtransactions.map((child) => ({
            ...child,
            id: child.id,
            account: child.account || entry.account,
            date: child.date || entry.date,
            payee_name: child.payee_name || entry.payee_name,
            imported_payee: child.imported_payee || entry.imported_payee,
            is_child: false,
            parent_id: null,
            is_split_child: true,
            parent_transaction_id: entry.id,
            is_split_editable: Boolean(child.id),
          }));
        }
        return [entry];
      });
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
    const transactionUpdateMatch = url.pathname.match(/^\/api\/v1\/transactions\/([^/]+)$/);
    if (req.method === 'PUT' && transactionUpdateMatch) {
      const id = decodeURIComponent(transactionUpdateMatch[1]);
      const body = await readBody(req);
      const rawTransactions = allTransactions();
      const parent = rawTransactions.find((item) => item.is_parent === true && item.subtransactions?.some((child) => child.id === id && (child.account || item.account) === body.accountId));
      const child = parent?.subtransactions.find((item) => item.id === id);
      const row = rawTransactions.find((item) => item.id === id && item.account === body.accountId);
      const transaction = row || (parent && child ? { ...child, account: child.account || parent.account, date: child.date || parent.date } : null);
      if (!transaction || transaction.account !== body.accountId || transaction.date < body.startDate || transaction.date > body.endDate) {
        return send(res, 404, { error: { code: 'INVALID_TRANSACTION', message: 'No existe el movimiento sintético solicitado.' } });
      }
      const fields = body.changes || {};
      if (fields.category !== undefined && fields.category !== null && !categories.some((item) => item.id === fields.category)) {
        return send(res, 400, { error: { code: 'INVALID_CATEGORY', message: 'La categoría sintética no existe.' } });
      }
      if (transaction.transfer_id) {
        if (fields.category !== undefined || fields.imported_payee !== undefined) {
          return send(res, 409, { error: { code: 'TRANSFER_FIELDS_RESTRICTED', message: 'La transferencia está enlazada.' } });
        }
        const counterpart = rawTransactions.find((item) => item.id === transaction.transfer_id && item.transfer_id === transaction.id && item.account !== transaction.account);
        if (!counterpart || counterpart.amount !== -transaction.amount) return send(res, 409, { error: { code: 'TRANSFER_COUNTERPART_NOT_AVAILABLE', message: 'No se puede verificar la otra pata de la transferencia.' } });
        const nextAmount = fields.amount ?? transaction.amount;
        if (Math.sign(nextAmount) !== Math.sign(transaction.amount)) return send(res, 400, { error: { code: 'TRANSFER_DIRECTION_CHANGE_NOT_ALLOWED', message: 'No se puede invertir la dirección de la transferencia.' } });
        Object.assign(transaction, fields);
        let writes = 1;
        if (fields.date !== undefined) counterpart.date = fields.date;
        if (fields.amount !== undefined) counterpart.amount = -nextAmount;
        if (fields.date !== undefined || fields.amount !== undefined) writes += 1;
        transactionWrites += writes;
        lastTransactionUpdate = { transactionId: id, fields: Object.keys(fields), changes: fields, counterpartTransactionId: counterpart.id, paired: true };
        return send(res, 200, { data: { transactionId: id, counterpartTransactionId: counterpart.id, updatedFields: Object.keys(fields), persisted: true, verified: true, partial: false } });
      }
      if (parent && child) {
        const totalBefore = parent.subtransactions.reduce((sum, item) => sum + item.amount, 0);
        if (totalBefore !== parent.amount) return send(res, 409, { error: { code: 'SPLIT_TOTAL_MISMATCH', message: 'El desglose sintético no cuadra.' } });
        const nextAmount = fields.amount ?? child.amount;
        if (Math.sign(nextAmount) !== Math.sign(child.amount)) return send(res, 400, { error: { code: 'SPLIT_PART_DIRECTION_CHANGE_NOT_ALLOWED', message: 'No se puede cambiar la dirección de una parte.' } });
        const nextDate = fields.date ?? parent.date;
        parent.subtransactions = parent.subtransactions.map((item) => ({
          ...item,
          date: fields.date === undefined ? item.date : nextDate,
          ...(item.id === child.id && fields.amount !== undefined ? { amount: nextAmount } : {}),
          ...(item.id === child.id && fields.category !== undefined ? { category: fields.category } : {}),
          ...(item.id === child.id && fields.notes !== undefined ? { notes: fields.notes } : {}),
        }));
        parent.amount = parent.subtransactions.reduce((sum, item) => sum + item.amount, 0);
        if (!Number.isSafeInteger(parent.amount) || parent.amount === 0) return send(res, 400, { error: { code: 'INVALID_SPLIT_TOTAL', message: 'El total del desglose no es válido.' } });
        if (fields.date !== undefined) parent.date = fields.date;
        if (fields.imported_payee !== undefined) parent.imported_payee = fields.imported_payee;
        if (fields.cleared !== undefined) parent.cleared = fields.cleared;
        transactionWrites += 1;
        lastTransactionUpdate = { transactionId: id, fields: Object.keys(fields), changes: fields, parentTransactionId: parent.id, parentAmount: parent.amount, childIds: parent.subtransactions.map((item) => item.id) };
        return send(res, 200, { data: { transactionId: id, parentTransactionId: parent.id, updatedFields: Object.keys(fields), parentAmount: parent.amount, persisted: true, verified: true } });
      }
      if (transaction.is_parent || transaction.is_child || transaction.parent_id || transaction.subtransactions?.length) {
        return send(res, 409, { error: { code: 'UNSUPPORTED_TRANSACTION', message: 'La estructura del desglose no se puede verificar.' } });
      }
      Object.assign(transaction, fields);
      transactionWrites += 1;
      lastTransactionUpdate = { transactionId: id, fields: Object.keys(fields), changes: fields };
      return send(res, 200, { data: { transactionId: id, updatedFields: Object.keys(fields), persisted: true, verified: true } });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/transfers/preview') {
      const body = await readBody(req);
      const source = accounts.find((entry) => entry.id === body.sourceAccountId && !entry.closed);
      const destination = accounts.find((entry) => entry.id === body.destinationAccountId && !entry.closed);
      if (!source || !destination || source.id === destination.id) return send(res, 400, { error: { code: 'INVALID_TRANSFER_ACCOUNT', message: 'Selecciona dos cuentas abiertas y distintas.' } });
      if (!['all', 'selected'].includes(accountScope.mode) || (accountScope.mode === 'selected' && (!accountScope.accountIds.includes(source.id) || !accountScope.accountIds.includes(destination.id)))) return send(res, 400, { error: { code: 'ACCOUNT_OUTSIDE_SCOPE', message: 'Ambas cuentas deben pertenecer al ámbito.' } });
      if (source.currencyCode !== destination.currencyCode) return send(res, 422, { error: { code: 'TRANSFER_CURRENCY_MISMATCH', message: 'Las cuentas deben tener la misma divisa.' } });
      if (source.offBudget !== destination.offBudget) return send(res, 422, { error: { code: 'TRANSFER_BUDGET_SCOPE_MISMATCH', message: 'Las cuentas deben tener el mismo ámbito de presupuesto.' } });
      transferPreviewCount += 1;
      lastTransferPayload = body;
      return send(res, 200, { data: {
        added: 1, updated: 0, errors: 0, submitted: 1, dryRun: true,
        sourceAccountId: body.sourceAccountId, destinationAccountId: body.destinationAccountId, linkedTransfer: true,
      } });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/transfers/commit') {
      const body = await readBody(req);
      const source = accounts.find((entry) => entry.id === body.sourceAccountId && !entry.closed);
      const destination = accounts.find((entry) => entry.id === body.destinationAccountId && !entry.closed);
      if (!source || !destination || source.id === destination.id) return send(res, 400, { error: { code: 'INVALID_TRANSFER_ACCOUNT', message: 'Selecciona dos cuentas abiertas y distintas.' } });
      if (accountScope.mode === 'selected' && (!accountScope.accountIds.includes(source.id) || !accountScope.accountIds.includes(destination.id))) return send(res, 400, { error: { code: 'ACCOUNT_OUTSIDE_SCOPE', message: 'Ambas cuentas deben pertenecer al ámbito.' } });
      if (source.currencyCode !== destination.currencyCode) return send(res, 422, { error: { code: 'TRANSFER_CURRENCY_MISMATCH', message: 'Las cuentas deben tener la misma divisa.' } });
      if (source.offBudget !== destination.offBudget) return send(res, 422, { error: { code: 'TRANSFER_BUDGET_SCOPE_MISMATCH', message: 'Las cuentas deben tener el mismo ámbito de presupuesto.' } });
      transferCommitCount += 1;
      lastTransferPayload = body;
      return send(res, 200, { data: {
        added: 1, updated: 0, errors: 0, submitted: 1, dryRun: false,
        sourceAccountId: body.sourceAccountId, destinationAccountId: body.destinationAccountId, linkedTransfer: true,
      } });
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
      const requested = body.transactions?.length ?? 0;
      return send(res, 200, { data: {
        preview: body.commit !== true, requested, changes: requested,
        ...(body.commit === true ? { applied: requested, appliedTransactionIds: (body.transactions ?? []).map((item) => item.transactionId), persisted: true, partial: false } : {}),
      } });
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
