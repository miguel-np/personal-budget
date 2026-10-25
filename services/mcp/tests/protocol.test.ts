import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface RpcResponse {
  readonly id?: string | number | null;
  readonly result?: {
    readonly protocolVersion?: string;
    readonly capabilities?: { readonly tools?: object };
    readonly tools?: readonly { readonly name: string; readonly description: string }[];
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
    let newline = buffer.indexOf('\\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
      newline = buffer.indexOf('\\n');
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
    write: (message) => child.stdin.write(JSON.stringify(message) + '\\n'),
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
    expect(JSON.stringify(await fixture.read().catch(() => null))).toBe('null');
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
