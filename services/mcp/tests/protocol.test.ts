import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface RpcResponse {
  readonly id?: string | number | null;
  readonly result?: {
    readonly protocolVersion?: string;
    readonly capabilities?: { readonly tools?: object; readonly prompts?: object };
    readonly tools?: readonly { readonly name: string; readonly description: string }[];
    readonly prompts?: readonly { readonly name: string; readonly description: string }[];
    readonly messages?: readonly { readonly content?: { readonly text?: string } }[];
    readonly structuredContent?: { readonly currency?: string; readonly incomeMinor?: number; readonly expenseMinor?: number };
    readonly isError?: boolean;
    readonly content?: readonly { readonly type: string; readonly text: string }[];
  };
  readonly error?: { readonly code?: number; readonly message?: string };
}
type FixtureHandler = (request: IncomingMessage, response: ServerResponse) => void;

interface McpFixture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly read: (timeoutMs?: number) => Promise<RpcResponse>;
  readonly write: (message: unknown) => void;
  readonly close: () => Promise<void>;
}

const fixtures: McpFixture[] = [];

async function startFixture(handler: FixtureHandler, timeoutMs = 5_000): Promise<McpFixture> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic API failed to listen.');

  const child = spawn(process.execPath, [resolve('services/mcp/server.mjs')], {
    env: {
      ...process.env,
      PERSONAL_BUDGET_API_URL: 'http://127.0.0.1:' + address.port,
      PERSONAL_BUDGET_MCP_API_TIMEOUT_MS: String(timeoutMs),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
      newline = buffer.indexOf('\n');
    }
  });
  const fixture: McpFixture = {
    child,
    read: (readTimeout = 3_000) => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(JSON.parse(queued) as RpcResponse);
      return new Promise<RpcResponse>((resolveRead, rejectRead) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onLine);
          if (index >= 0) waiters.splice(index, 1);
          rejectRead(new Error('MCP response timed out in test client.'));
        }, readTimeout);
        const onLine = (line: string) => {
          clearTimeout(timer);
          try { resolveRead(JSON.parse(line) as RpcResponse); }
          catch (error) { rejectRead(error); }
        };
        waiters.push(onLine);
      });
    },
    write: (message) => child.stdin.write(JSON.stringify(message) + '\n'),
    close: async () => {
      if (child.exitCode === null && !child.killed) child.kill();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function reply(id: number, method: string, params?: unknown) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

function syntheticApi(_request: IncomingMessage, response: ServerResponse) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    data: {
      currency: 'EUR', startDate: '2026-10-01', endDate: '2026-10-31',
      incomeMinor: 200_000, expenseMinor: 10_000, savingsMinor: 190_000,
      savingsRatePercent: 95, transactionCount: 2, excludedTransferCount: 1,
      expensesByCategory: [{ categoryName: 'Alimentación', amountMinor: 10_000, transactionCount: 1 }],
      warnings: [],
    },
  }));
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe('MCP stdio protocol and failure boundaries', () => {
  it('initializes, documents read-only tools, calculates synthetic totals, and rejects unsafe calls', async () => {
    const fixture = await startFixture(syntheticApi);
    fixture.write(reply(1, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '1' },
    }));
    expect(await fixture.read()).toMatchObject({
      id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } },
    });

    fixture.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    fixture.write(reply(2, 'tools/list'));
    const list = await fixture.read();
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'get_monthly_summary', 'get_spending_by_category', 'compare_periods', 'get_yearly_overview',
      'get_uncategorized_transactions', 'get_recurring_candidates', 'simulate_budget_change',
    ]));
    expect(list.result?.tools?.every((tool) => /read-only/i.test(tool.description))).toBe(true);

    fixture.write(reply(3, 'tools/call', { name: 'get_monthly_summary', arguments: { month: '2026-10' } }));
    expect(await fixture.read()).toMatchObject({
      id: 3, result: { isError: false, structuredContent: { currency: 'EUR', incomeMinor: 200_000, expenseMinor: 10_000 } },
    });

    fixture.write(reply(4, 'tools/call', { name: 'run_shell', arguments: { command: 'whoami' } }));
    expect((await fixture.read()).result?.isError).toBe(true);

    fixture.write(reply(5, 'tools/call', { name: 'get_monthly_summary', arguments: { month: '2026-99', extra: 'bad' } }));
    expect((await fixture.read()).result).toMatchObject({ isError: true });
  });


  it('exposes bounded read-only finance tools and sanitizes identifiers', async () => {
    const calls: Array<{ method: string; path: string; body: string }> = [];
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        calls.push({ method: request.method ?? 'GET', path: url.pathname + url.search, body });
        response.setHeader('content-type', 'application/json');
        if (url.pathname === '/api/v1/intelligence/findings') {
          response.end(JSON.stringify({ data: { period: { startDate: '2026-10-01', endDate: '2026-10-31' }, currency: 'EUR', accountScope: { label: 'Todas', accountIds: ['private-account-id'] }, findings: [{ id: 'f1', type: 'expense-change', title: 'Gasto elevado', explanation: 'La categoría aumentó.', period: { startDate: '2026-10-01', endDate: '2026-10-31' }, currency: 'EUR', confidence: 'observed', priority: 'medium', priorityReason: 'Variación observada', impactMinor: 1000, metrics: { deltaMinor: 1000 }, evidence: [], limitations: [], calculatedAt: '2026-11-01T00:00:00.000Z', reviewStatus: 'new', accountScope: { accountIds: ['private-account-id'] } }], warnings: [] } }));
        } else if (url.pathname === '/api/v1/budget-alerts') {
          response.end(JSON.stringify({ data: { month: '2026-10', currency: 'EUR', alerts: [{ categoryId: 'cat-secret', categoryName: 'Comida', metric: 'percent_used', threshold: 80, observedValue: 92, message: 'Has consumido el 92 % del presupuesto de Comida.', status: 'active' }], categories: [{ categoryId: 'cat-secret', categoryName: 'Comida', budgetedMinor: 30000, spentMinor: 27600, availableMinor: 2400, state: 'budgeted' }], warnings: [] } }));
        } else if (url.pathname === '/api/v1/budget-improvements') {
          response.end(JSON.stringify({ data: { asOfDate: '2026-11-04', currency: 'EUR', goal: 'increase_monthly_margin', baseline: { startDate: '2026-05-01', endDate: '2026-10-31', periodMonths: 6, monthlyIncomeMinor: 300000, monthlyExpenseMinor: 200000, monthlySavingsMinor: 100000, savingsRatePercent: 33.33, transactionCount: 60, unconvertedTransactionCount: 0 }, proposals: [{ categoryId: 'cat-secret', categoryName: 'Comida', suggestedReductionPercent: 10, observedMonthlyExpenseMinor: 50000, estimatedMonthlySavingsMinor: 5000, estimatedAnnualSavingsMinor: 60000, confidence: 'medium', explanation: 'Propuesta explicada.', evidence: { signal: 'recent_increase', transactionCount: 10 }, assumptions: ['Estimación'], warnings: [], priorityRank: 1, priorityReason: 'Mayor margen' }], savingsGoals: [], warnings: [] } }));
        } else if (url.pathname === '/api/v1/cash-flow/project') {
          response.end(JSON.stringify({ data: { asOfDate: '2026-11-04', endDate: '2026-12-04', currency: 'EUR', openingBalanceMinor: 500000, unknownOpeningAccounts: [], recurringCandidates: [{ id: 'rc_0123456789abcdef01234567', payee: 'Gimnasio', occurrenceCount: 4, estimatedIntervalDays: 30, estimatedFrequency: 'monthly', meanAbsoluteAmountMinor: 3000, amountDeviationPercent: 0, nextDate: '2026-11-30', upcomingEventsCount: 1, warnings: [] }], warnings: [], notes: [], projection: { isEstimate: true, openingBalanceMinor: 500000, endingBalanceMinor: 450000, minimumProjectedBalanceMinor: 450000, minimumBalanceDate: '2026-12-04', firstDeficitDate: null, reserveMinor: null, firstReserveBreachDate: null, totalInflowMinor: 100000, totalOutflowMinor: 150000, netChangeMinor: -50000, sourceTotals: {}, timeline: [{ date: '2026-11-04', netChangeMinor: -50000, totalInflowMinor: 0, totalOutflowMinor: 50000, totalTransferInflowMinor: 0, totalTransferOutflowMinor: 0, projectedBalanceMinor: 450000, belowReserve: null, eventIds: ['private-event-id'] }], assumptions: ['Estimación'], warnings: [] } } }));
        } else if (url.pathname === '/api/v1/wealth/summary') {
          response.end(JSON.stringify({ data: { asOfDate: '2026-11-04', currency: 'EUR', status: 'incomplete', netWorthMinor: null, actual: { netWorthMinor: 100000, assetsMinor: 200000, liabilitiesMinor: 100000, accountCount: 2 }, external: { netWorthMinor: null, assetsMinor: 0, liabilitiesMinor: 0, itemCount: 1 }, liquidity: { cashLikeExternalMinor: 0 }, coverage: { includedActualAccounts: 2, unclassifiedAccountIds: ['secret-account'], unconvertibleAccountIds: [], staleAssetIds: ['secret-asset'], missingValuationIds: [], excludedDuplicateOrOptOutIds: [] }, warnings: ['Faltan clasificaciones.'] } }));
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
        }
      });
    };
    const fixture = await startFixture(handler);

    fixture.write(reply(1, 'tools/list'));
    const list = await fixture.read();
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'get_financial_findings', 'get_budget_alerts', 'get_budget_improvement_context', 'project_cash_flow', 'get_net_worth_summary',
    ]));
    expect(list.result?.tools?.every((tool) => /read-only|non-persisting/i.test(tool.description))).toBe(true);

    fixture.write(reply(2, 'tools/call', { name: 'get_financial_findings', arguments: { startDate: '2026-10-01', endDate: '2026-10-31' } }));
    const findings = await fixture.read();
    expect(findings.result?.structuredContent).toMatchObject({ currency: 'EUR', findings: [{ title: 'Gasto elevado' }] });
    expect(JSON.stringify(findings)).not.toContain('private-account-id');

    fixture.write(reply(3, 'tools/call', { name: 'get_budget_alerts', arguments: { month: '2026-10' } }));
    expect((await fixture.read()).result?.structuredContent).toMatchObject({ month: '2026-10', alerts: [{ categoryName: 'Comida', observedValue: 92 }] });

    fixture.write(reply(4, 'tools/call', { name: 'get_budget_improvement_context', arguments: { periodMonths: 6 } }));
    expect((await fixture.read()).result?.structuredContent).toMatchObject({ baseline: { monthlySavingsMinor: 100000 }, proposals: [{ categoryName: 'Comida', estimatedMonthlySavingsMinor: 5000 }] });

    fixture.write(reply(5, 'tools/call', { name: 'project_cash_flow', arguments: { horizonDays: 30 } }));
    const cashFlow = await fixture.read();
    expect(cashFlow.result?.structuredContent).toMatchObject({ projection: { isEstimate: true, endingBalanceMinor: 450000 }, recurringCandidates: [{ confidence: 'candidate_only' }] });
    expect(JSON.stringify(cashFlow)).not.toContain('private-event-id');

    fixture.write(reply(6, 'tools/call', { name: 'get_net_worth_summary', arguments: {} }));
    const wealth = await fixture.read();
    expect(wealth.result?.structuredContent).toMatchObject({ status: 'incomplete', netWorthMinor: null, coverage: { unclassifiedAccountCount: 1, staleAssetCount: 1 } });
    expect(JSON.stringify(wealth)).not.toContain('secret-account');
    expect(JSON.stringify(wealth)).not.toContain('secret-asset');

    expect(calls.find((call) => call.path === '/api/v1/cash-flow/project')).toMatchObject({ method: 'POST' });
    expect(calls.every((call) => call.method === 'GET' || call.path === '/api/v1/cash-flow/project')).toBe(true);
  });

  it('publishes reusable workflow prompts with validated arguments', async () => {
    const fixture = await startFixture(syntheticApi);
    fixture.write(reply(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } }));
    expect(await fixture.read()).toMatchObject({ result: { capabilities: { tools: {}, prompts: {} } } });

    fixture.write(reply(2, 'prompts/list'));
    expect((await fixture.read()).result?.prompts?.map((prompt) => prompt.name)).toEqual([
      'monthly_financial_review', 'budget_coaching', 'cash_flow_review', 'recurring_payment_audit', 'wealth_review',
    ]);

    fixture.write(reply(3, 'prompts/get', { name: 'monthly_financial_review', arguments: { startDate: '2026-10-01', endDate: '2026-10-31', previousStartDate: '2026-09-01', previousEndDate: '2026-09-30' } }));
    const prompt = await fixture.read();
    expect(prompt.result?.messages?.[0]?.content?.text).toContain('2026-10-01 a 2026-10-31');
    fixture.write(reply(4, 'prompts/get', { name: 'monthly_financial_review', arguments: { startDate: '2026-99-01', endDate: '2026-10-31', previousStartDate: '2026-09-01', previousEndDate: '2026-09-30' } }));
    expect(await fixture.read()).toMatchObject({ error: { code: -32602 } });
  });

  it('rejects API bodies above the byte limit without echoing the body', async () => {
    const oversizedApi = (_request: IncomingMessage, response: ServerResponse) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { expenseMinor: 1, padding: 'SENSITIVE'.repeat(9_000) } }));
    };
    const fixture = await startFixture(oversizedApi);
    fixture.write(reply(1, 'tools/call', { name: 'get_monthly_summary', arguments: { month: '2026-10' } }));
    const answer = await fixture.read();
    expect(answer.result?.isError).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('SENSITIVE');
    expect(JSON.stringify(answer)).toMatch(/size limit/i);
  });

  it('times out a stalled local API request and returns a sanitized tool error', async () => {
    const stalledApi = (_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
    };
    const fixture = await startFixture(stalledApi, 100);
    fixture.write(reply(1, 'tools/call', { name: 'get_monthly_summary', arguments: { month: '2026-10' } }));
    const answer = await fixture.read(2_000);
    expect(answer.result?.isError).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('AbortError');
    expect(JSON.stringify(answer)).not.toContain('127.0.0.1');
  });

  it('refuses non-loopback API endpoints before starting the server', async () => {
    const child = spawn(process.execPath, [resolve('services/mcp/server.mjs')], {
      env: { ...process.env, PERSONAL_BUDGET_API_URL: 'https://example.com' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(code).toBe(2);
  });

  it('rejects timeout configuration outside the bounded range', async () => {
    const child = spawn(process.execPath, [resolve('services/mcp/server.mjs')], {
      env: { ...process.env, PERSONAL_BUDGET_MCP_API_TIMEOUT_MS: '999999' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(code).toBe(2);
  });
});
