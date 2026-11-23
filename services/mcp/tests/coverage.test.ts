import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpHandler, startMcpStdio } from '../server.mjs';

const summary = { currency: 'EUR', startDate: '2026-10-01', endDate: '2026-10-31', incomeMinor: 300000, expenseMinor: 5734, savingsMinor: 294266, savingsRatePercent: 98.09, transactionCount: 4, excludedTransferCount: 0, expensesByCategory: [{ categoryName: 'Comida', amountMinor: 4500, transactionCount: 1 }], warnings: [] };
const transactions = [
 { id: 'synthetic-1', date: '2026-08-01', amount: -1000, account: 'Cuenta sintética', category: null, payee_name: 'Internet' },
 { id: 'synthetic-2', date: '2026-09-01', amount: -1050, account: 'Cuenta sintética', category: null, payee_name: 'Internet' },
 { id: 'synthetic-3', date: '2026-10-01', amount: -1020, account: 'Cuenta sintética', category: null, payee_name: 'Internet' }
];

function response(data, status = 200, headers = {}) {
 return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fixtureFetch() {
 return vi.fn(async (request) => {
  const url = new URL(String(request));
  if (url.pathname.endsWith('/reports/summary')) return response(summary);
  if (url.pathname.endsWith('/transactions')) return response(transactions);
  if (url.pathname.endsWith('/intelligence/findings')) return response({ period: {}, currency: 'EUR', accountScope: { label: 'Todas las cuentas' }, findings: [{ id: 'finding-1', type: 'spending', title: 'Hallazgo sintético', explanation: 'Explicación sintética', period: {}, currency: 'EUR', confidence: 0.9, priority: 'low', priorityReason: 'test', impactMinor: 100, metrics: {}, evidence: [], limitations: [], calculatedAt: '2026-10-31', reviewStatus: 'reviewed' }], warnings: [] });
  if (url.pathname.endsWith('/budget-alerts')) return response({ month: '2026-10', currency: 'EUR', alerts: [{ categoryName: 'Comida', metric: 'expense', threshold: 80, observedValue: 90, message: 'Alerta sintética', status: 'active' }], categories: [{ categoryName: 'Comida', budgetedMinor: 10000, spentMinor: 9000, availableMinor: 1000, state: 'warning' }], warnings: [] });
  if (url.pathname.endsWith('/budget-improvements')) return response({ asOfDate: '2026-10-31', currency: 'EUR', goal: null, baseline: { startDate: '2026-08-01', endDate: '2026-10-31', periodMonths: 3, monthlyIncomeMinor: 300000, monthlyExpenseMinor: 5734, monthlySavingsMinor: 294266, savingsRatePercent: 98.09, transactionCount: 4, unconvertedTransactionCount: 0 }, proposals: [{ categoryName: 'Comida', kind: 'reduce', suggestedReductionPercent: 10, observedMonthlyExpenseMinor: 4500, estimatedMonthlySavingsMinor: 450, estimatedAnnualSavingsMinor: 5400, confidence: 0.8, explanation: 'Estimación', evidence: [], assumptions: [], warnings: [], priorityRank: 1, priorityReason: 'synthetic', goalImpact: { goalName: 'Reserva', monthlyContributionGapMinor: 1000, estimatedGapCoveredMinor: 450, estimatedGapRemainingMinor: 550 } }], savingsGoals: [{ name: 'Reserva', targetDate: '2027-10-01', targetAmountMinor: 100000, initialAmountMinor: 0, monthlyContributionMinor: 10000, currency: 'EUR', status: 'active', projection: { projectedBalanceMinor: 10000, projectedProgressPercent: 10, requiredMonthlyContributionMinor: 9000, estimatedCompletionDate: '2027-09-01', achievableUnderCashFlow: true }, warnings: [] }], warnings: [] });
  if (url.pathname.endsWith('/cash-flow/project')) return response({ asOfDate: '2026-10-31', endDate: '2026-11-30', currency: 'EUR', openingBalanceMinor: 100000, unknownOpeningAccounts: [], projection: { openingBalanceMinor: 100000, endingBalanceMinor: 110000, minimumProjectedBalanceMinor: 90000, minimumBalanceDate: '2026-11-02', firstDeficitDate: null, reserveMinor: 20000, firstReserveBreachDate: null, totalInflowMinor: 20000, totalOutflowMinor: 10000, netChangeMinor: 10000, sourceTotals: {}, timeline: [{ date: '2026-11-01', netChangeMinor: 1000, totalInflowMinor: 2000, totalOutflowMinor: 1000, totalTransferInflowMinor: 0, totalTransferOutflowMinor: 0, projectedBalanceMinor: 101000, belowReserve: false }], assumptions: [], warnings: [] }, recurringCandidates: [{ id: 'rc_0123456789abcdef01234567', payee: 'Internet', occurrenceCount: 3, estimatedIntervalDays: 30, estimatedFrequency: 'monthly', meanAbsoluteAmountMinor: 1020, amountDeviationPercent: 2, nextDate: '2026-11-01', upcomingEventsCount: 1, warnings: [] }], warnings: [], notes: [] });
  if (url.pathname.endsWith('/wealth/summary')) return response({ asOfDate: '2026-10-31', currency: 'EUR', status: 'complete', netWorthMinor: 200000, actual: { assetsMinor: 250000, liabilitiesMinor: 50000 }, external: { assetsMinor: 0, liabilitiesMinor: 0 }, liquidity: { amountMinor: 100000 }, coverage: { includedActualAccounts: 2, unclassifiedAccountIds: [], unconvertibleAccountIds: [], staleAssetIds: [], missingValuationIds: [], excludedDuplicateOrOptOutIds: [] }, warnings: [] });
  return response({}, 404);
 });
}

function request(method, params = {}, id = 1) {
 return { jsonrpc: '2.0', id, method, params };
}

async function callTool(session, name, args = {}) {
 return session(request('tools/call', { name, arguments: args }));
}

let handler;
let fetchMock;
beforeEach(() => {
 handler = createMcpHandler();
 fetchMock = fixtureFetch();
 vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('MCP protocol logic coverage', () => {
 it('validates JSON-RPC requests and exposes discovery methods', async () => {
  expect(await handler(null)).toMatchObject({ error: { code: -32600 } });
  expect(await handler({ jsonrpc: '1.0', method: 'ping' })).toMatchObject({ error: { code: -32600 } });
  expect(await handler(request('initialize'))).toMatchObject({ result: { protocolVersion: '2024-11-05' } });
  expect(await handler(request('ping'))).toMatchObject({ result: {} });
  expect(await handler(request('notifications/initialized'))).toBeNull();
  expect((await handler(request('tools/list'))).result.tools).toHaveLength(12);
  expect((await handler(request('prompts/list'))).result.prompts).toHaveLength(5);
  expect(await handler(request('unknown/method'))).toMatchObject({ error: { code: -32601 } });
 });

 it('builds all prompts and validates prompt arguments', async () => {
  const prompts = [
   ['monthly_financial_review', { startDate: '2026-10-01', endDate: '2026-10-31', previousStartDate: '2026-09-01', previousEndDate: '2026-09-30' }],
   ['budget_coaching', {}], ['cash_flow_review', {}],
   ['recurring_payment_audit', { startDate: '2026-08-01', endDate: '2026-10-31' }], ['wealth_review', {}]
  ];
  for (const [name, args] of prompts) {
   const result = await handler(request('prompts/get', { name, arguments: args }));
   expect(result.result.messages[0].content.text.length).toBeGreaterThan(0);
  }
  expect(await handler(request('prompts/get', { name: 'unknown' }))).toMatchObject({ error: { code: -32602 } });
  expect(await handler(request('prompts/get', { name: 'monthly_financial_review', arguments: { startDate: '2026-99-01' } }))).toMatchObject({ error: { code: -32602 } });
 });

 it('executes every tool using synthetic API responses', async () => {
  const cases = [
   ['get_monthly_summary', { month: '2026-10' }],
   ['get_spending_by_category', { startDate: '2026-10-01', endDate: '2026-10-31' }],
   ['compare_periods', { currentStartDate: '2026-10-01', currentEndDate: '2026-10-31', previousStartDate: '2026-09-01', previousEndDate: '2026-09-30' }],
   ['get_yearly_overview', { year: 2026 }],
   ['get_uncategorized_transactions', { startDate: '2026-08-01', endDate: '2026-10-31' }],
   ['get_recurring_candidates', { startDate: '2026-08-01', endDate: '2026-10-31' }],
   ['simulate_budget_change', { startDate: '2026-10-01', endDate: '2026-10-31', categoryName: 'Comida', reductionPercent: 10 }],
   ['get_financial_findings', { startDate: '2026-10-01', endDate: '2026-10-31' }],
   ['get_budget_alerts', {}], ['get_budget_improvement_context', {}],
   ['project_cash_flow', {}], ['get_net_worth_summary', {}]
  ];
  const results = [];
  for (const [name, args] of cases) results.push(await callTool(handler, name, args));
  expect(results.every((result) => result.result.isError === false)).toBe(true);
  expect(results[5].result.structuredContent.candidates).toHaveLength(1);
  expect(results[6].result.structuredContent.persisted).toBe(false);
  expect(results[10].result.structuredContent.projection.timeline).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalled();
 });

 it('rejects invalid arguments and fails closed for unknown tools', async () => {
  const invalid = await callTool(handler, 'get_spending_by_category', { startDate: '2026-99-01', endDate: '2026-10-31' });
  expect(invalid.result.isError).toBe(true);
  expect(invalid.result.content[0].text).toMatch(/date/i);
  const extra = await callTool(handler, 'get_monthly_summary', { month: '2026-10', extra: true });
  expect(extra.result.isError).toBe(true);
  const unknown = await callTool(handler, 'run_shell', { command: 'whoami' });
  expect(unknown.result.content[0].text).toMatch(/unknown tool/i);
 });

 it('sanitizes API failures and enforces response byte limits', async () => {
  const scenarios = [
   () => new Response('unavailable', { status: 503 }),
   () => new Response('not-json'),
   () => new Response('x'.repeat(70000), { headers: { 'content-length': '70000' } }),
   () => new Response('x'.repeat(70000))
  ];
  for (const makeResponse of scenarios) {
   vi.stubGlobal('fetch', vi.fn(async () => makeResponse()));
   const result = await callTool(handler, 'get_monthly_summary', { month: '2026-10' });
   expect(result.result.isError).toBe(true);
   expect(JSON.stringify(result)).not.toContain('unavailable');
  }
 });

 it('enforces the per-session tool-call limit', async () => {
  let result;
  for (let index = 0; index < 25; index += 1) result = await callTool(handler, 'not-allowed');
  expect(result.result.content[0].text).toMatch(/limit/i);
 });

 it('serves stdio requests and rejects malformed and oversized lines', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createInterface({ input: output, crlfDelay: Infinity });
  const server = startMcpStdio({ inputStream: input, outputStream: output });
  const malformed = once(reader, 'line');
  input.write('not-json\n');
  expect(JSON.parse((await malformed)[0])).toMatchObject({ error: { code: -32700 } });
  const ping = once(reader, 'line');
  input.write(JSON.stringify(request('ping')) + '\n');
  expect(JSON.parse((await ping)[0])).toMatchObject({ result: {} });
  const oversized = once(reader, 'line');
  input.write('x'.repeat(8193) + '\n');
  expect(JSON.parse((await oversized)[0])).toMatchObject({ error: { code: -32600 } });
  server?.close();
  reader.close();
  input.destroy();
  output.destroy();
 });
});
