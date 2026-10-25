import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

interface SdkFixture {
  readonly client: Client;
  readonly server: ReturnType<typeof createServer>;
  readonly close: () => Promise<void>;
}

const fixtures: SdkFixture[] = [];

async function startSdkFixture(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<SdkFixture> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic API failed to listen.');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('services/mcp/server.mjs')],
    env: {
      ...process.env,
      PERSONAL_BUDGET_API_URL: 'http://127.0.0.1:' + address.port,
      PERSONAL_BUDGET_MCP_API_TIMEOUT_MS: '5000',
    },
  });
  const client = new Client({ name: 'sdk-interop-client', version: '1.0.0' });
  await client.connect(transport);
  const fixture: SdkFixture = {
    client,
    server,
    close: async () => {
      await client.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

function syntheticApi(_request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    data: {
      currency: 'EUR', startDate: '2026-10-01', endDate: '2026-10-31',
      incomeMinor: 300_000, expenseMinor: 5_734, savingsMinor: 294_266,
      savingsRatePercent: 98.09, transactionCount: 4, excludedTransferCount: 0,
      expensesByCategory: [
        { categoryName: 'Comida', amountMinor: 4_500, transactionCount: 1 },
        { categoryName: 'Sin categoría', amountMinor: 1_234, transactionCount: 1 },
      ],
      warnings: [],
    },
  }));
}

describe('MCP interop through the official MCP SDK client', () => {
  it('handshakes, lists the reviewed tools and returns structured results', async () => {
    const { client } = await startSdkFixture(syntheticApi);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'get_monthly_summary', 'get_spending_by_category', 'compare_periods', 'get_yearly_overview',
      'get_uncategorized_transactions', 'get_recurring_candidates', 'simulate_budget_change',
    ]));
    expect(tools.tools.every((tool) => /read-only/i.test(tool.description ?? ''))).toBe(true);
    expect(tools.tools.length).toBe(7);

    const summary = await client.callTool({ name: 'get_monthly_summary', arguments: { month: '2026-10' } });
    const summaryContent = summary.content as Array<{ type: string; text?: string }>;
    expect(summary.isError).toBe(false);
    expect(summary.structuredContent).toMatchObject({ currency: 'EUR', incomeMinor: 300_000, expenseMinor: 5_734 });
    expect(summaryContent.some((item) => item.type === 'text' && item.text?.includes('300000'))).toBe(true);

    const spending = await client.callTool({ name: 'get_spending_by_category', arguments: { startDate: '2026-10-01', endDate: '2026-10-31' } });
    expect(spending.structuredContent).toMatchObject({
      currency: 'EUR',
      expensesByCategory: expect.arrayContaining([
        expect.objectContaining({ categoryName: 'Comida', amountMinor: 4_500 }),
      ]),
    });
  });

  it('fails closed for unknown tools and invalid arguments', async () => {
    const { client } = await startSdkFixture(syntheticApi);

    const unknown = await client.callTool({ name: 'run_shell', arguments: { command: 'whoami' } });
    expect(unknown.isError).toBe(true);
    expect((unknown as CallToolResult).content.some((item) => item.type === 'text' && /unknown tool/i.test(item.text ?? ''))).toBe(true);

    const invalid = await client.callTool({ name: 'get_monthly_summary', arguments: { month: '2026-99', extra: 'bad' } });
    expect(invalid.isError).toBe(true);
  });

  it('reports hypothetical simulations without persisting anything', async () => {
    const { client } = await startSdkFixture(syntheticApi);
    const simulation = await client.callTool({
      name: 'simulate_budget_change',
      arguments: { startDate: '2026-10-01', endDate: '2026-10-31', categoryName: 'Comida', reductionPercent: 10 },
    });
    expect(simulation.isError).toBe(false);
    expect(simulation.structuredContent).toMatchObject({ persisted: false, isEstimate: true, estimatedReductionMinor: 450 });
  });
});
