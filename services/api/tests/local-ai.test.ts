import { describe, expect, it, vi } from 'vitest';
import { LocalAiClient } from '../src/local-ai.js';
import type { AssistantContext } from '../src/local-ai.js';

const config = { enabled: true, baseURL: 'http://127.0.0.1:11434', model: 'synthetic-model', timeoutMs: 1_000, maxContextChars: 2_000 };
const context: AssistantContext = {
  question: 'Explica el resultado cualitativamente.',
  summary: {
    currency: 'EUR', startDate: '2026-10-01', endDate: '2026-10-31',
    incomeMinor: 200_000, expenseMinor: 10_000, savingsMinor: 190_000,
    savingsRatePercent: 95, transactionCount: 2, excludedTransferCount: 1,
  },
  expensesByCategory: [{ categoryName: 'Alimentación', amountMinor: 10_000, transactionCount: 1 }],
};

describe('LocalAiClient', () => {
  it('does not contact a model when AI is disabled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new LocalAiClient({ ...config, enabled: false }, fetcher);
    await expect(client.status()).resolves.toEqual({ enabled: false, status: 'disabled' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('detects a missing model without exposing runtime details', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ models: [{ name: 'other-model' }] }), { status: 200 }));
    const client = new LocalAiClient(config, fetcher);
    await expect(client.status()).resolves.toMatchObject({ status: 'model_missing', model: 'synthetic-model' });
  });
  it('sends aggregate-only context and removes numeric claims from the model narrative', async () => {
    let requestBody = '';
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'synthetic-model' }] }), { status: 200 });
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ message: { content: 'Los gastos crecieron un 27% y suman 1234 euros.' } }), { status: 200 });
    });
    const client = new LocalAiClient(config, fetcher);
    const answer = await client.explain(context);
    expect(requestBody).not.toContain('transactions');
    expect(requestBody).not.toContain('payee_name');
    expect(answer).not.toMatch(/\d/);
    expect(answer).toContain('el valor mostrado en los resultados');
  });
  it('rejects a remote model endpoint', () => {
    expect(() => new LocalAiClient({ ...config, baseURL: 'https://example.com' })).toThrow();
  });
});
