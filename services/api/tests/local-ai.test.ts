import { describe, expect, it, vi } from 'vitest';
import { LocalAiClient, LocalAiUnavailableError } from '../src/local-ai.js';
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

  it('reports an unconfigured model without contacting Ollama', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { model: _configuredModel, ...unconfiguredConfig } = config;
    const client = new LocalAiClient(unconfiguredConfig, fetcher);
    await expect(client.status()).resolves.toEqual({ enabled: true, status: 'not_configured' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.explain(context)).rejects.toBeInstanceOf(LocalAiUnavailableError);
  });

  it('detects a missing model without exposing runtime details', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ models: [{ name: 'other-model' }] }), { status: 200 }));
    const client = new LocalAiClient(config, fetcher);
    await expect(client.status()).resolves.toMatchObject({ status: 'model_missing', model: 'synthetic-model' });
  });

  it('recognizes the alternate model field and treats an empty model list as missing', async () => {
    const byModelField = new LocalAiClient(config, vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ models: [{ model: 'synthetic-model' }] }), { status: 200 })));
    await expect(byModelField.status()).resolves.toMatchObject({ status: 'available' });

    const empty = new LocalAiClient(config, vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({}), { status: 200 })));
    await expect(empty.status()).resolves.toMatchObject({ status: 'model_missing' });
  });

  it('returns unavailable for HTTP, network and malformed status responses', async () => {
    const httpFailure = new LocalAiClient(config, vi.fn<typeof fetch>(async () => new Response('{}', { status: 503 })));
    await expect(httpFailure.status()).resolves.toMatchObject({ status: 'unavailable' });

    const networkFailure = new LocalAiClient(config, vi.fn<typeof fetch>(async () => { throw new Error('private runtime detail'); }));
    await expect(networkFailure.status()).resolves.toMatchObject({ status: 'unavailable' });

    const malformed = new LocalAiClient(config, vi.fn<typeof fetch>(async () => new Response('{', { status: 200 })));
    await expect(malformed.status()).resolves.toMatchObject({ status: 'unavailable' });
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

  it('fails closed when chat requests fail or Ollama returns a non-success status', async () => {
    const rejected = new LocalAiClient(config, vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'synthetic-model' }] }), { status: 200 });
      throw new Error('private network details');
    }));
    await expect(rejected.explain(context)).rejects.toBeInstanceOf(LocalAiUnavailableError);

    const httpFailure = new LocalAiClient(config, vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'synthetic-model' }] }), { status: 200 });
      return new Response('{}', { status: 502 });
    }));
    await expect(httpFailure.explain(context)).rejects.toBeInstanceOf(LocalAiUnavailableError);
  });

  it('sanitizes links and control characters and supplies a fallback for an empty narrative', async () => {
    const linked = new LocalAiClient(config, vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'synthetic-model' }] }), { status: 200 });
      return new Response(JSON.stringify({ message: { content: 'Tendencia estable. Más datos: https://private.example/path\u0001' } }), { status: 200 });
    }));
    const answer = await linked.explain(context);
    expect(answer).toContain('Tendencia estable.');
    expect(answer).not.toContain('https://');
    expect(answer).not.toContain('\u0001');

    const empty = new LocalAiClient(config, vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'synthetic-model' }] }), { status: 200 });
      return new Response(JSON.stringify({ message: { content: '   ' } }), { status: 200 });
    }));
    await expect(empty.explain(context)).resolves.toContain('El modelo no devolvió una explicación útil.');
  });

  it('rejects a remote model endpoint', () => {
    expect(() => new LocalAiClient({ ...config, baseURL: 'https://example.com' })).toThrow();
  });
});
