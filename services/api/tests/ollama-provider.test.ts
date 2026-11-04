import { describe, expect, it, vi } from 'vitest';
import { ModelProviderUnavailableError } from '../src/model-provider.js';
import type { ModelProviderChatRequest } from '../src/model-provider.js';
import { OllamaProvider } from '../src/ollama-provider.js';

describe('OllamaProvider contract', () => {
  it('accepts only loopback endpoints without embedded credentials', () => {
    expect(() => new OllamaProvider({ baseURL: 'https://api.example.com' })).toThrow();
    expect(() => new OllamaProvider({ baseURL: 'http://user:secret@127.0.0.1:11434' })).toThrow();
    expect(() => new OllamaProvider({ baseURL: 'http://127.0.0.1:11434' })).not.toThrow();
  });

  it('probes model availability using both Ollama model name fields', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      models: [{ name: 'primary:latest' }, { model: 'alternate:latest' }],
    }), { status: 200 }));
    const provider = new OllamaProvider({ baseURL: 'http://127.0.0.1:11434', fetcher });

    await expect(provider.probe('primary:latest', AbortSignal.timeout(1_000))).resolves.toBe('available');
    await expect(provider.probe('alternate:latest', AbortSignal.timeout(1_000))).resolves.toBe('available');
    await expect(provider.probe('missing:latest', AbortSignal.timeout(1_000))).resolves.toBe('model_missing');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/tags');
  });

  it('returns unavailable for probe HTTP, network and malformed JSON failures', async () => {
    const httpFailure = new OllamaProvider({
      baseURL: 'http://127.0.0.1:11434',
      fetcher: vi.fn<typeof fetch>(async () => new Response('{}', { status: 503 })),
    });
    const networkFailure = new OllamaProvider({
      baseURL: 'http://127.0.0.1:11434',
      fetcher: vi.fn<typeof fetch>(async () => { throw new Error('private endpoint detail'); }),
    });
    const malformed = new OllamaProvider({
      baseURL: 'http://127.0.0.1:11434',
      fetcher: vi.fn<typeof fetch>(async () => new Response('{', { status: 200 })),
    });

    await expect(httpFailure.probe('model', AbortSignal.timeout(1_000))).resolves.toBe('unavailable');
    await expect(networkFailure.probe('model', AbortSignal.timeout(1_000))).resolves.toBe('unavailable');
    await expect(malformed.probe('model', AbortSignal.timeout(1_000))).resolves.toBe('unavailable');
  });

  it('maps normalized requests to Ollama chat and returns tool calls as data', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestSignal: AbortSignal | null = null;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestSignal = init?.signal as AbortSignal;
      return new Response(JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'web_search', arguments: { query: 'consulta exacta' } } }],
        },
      }), { status: 200 });
    });
    const provider = new OllamaProvider({ baseURL: 'http://127.0.0.1:11434', fetcher });
    const request: ModelProviderChatRequest = {
      model: 'synthetic-model',
      contextWindowTokens: 2_048,
      maxOutputTokens: 384,
      temperature: 0,
      tools: [{
        name: 'web_search',
        description: 'Búsqueda externa acotada.',
        parameters: { type: 'object' },
      }],
      messages: [
        { role: 'system', content: 'No ejecutar herramientas.' },
        { role: 'user', content: 'Consulta aprobada.' },
        { role: 'assistant', content: '', toolCalls: [{ name: 'web_search', arguments: { query: 'consulta exacta' } }] },
        { role: 'tool', toolName: 'web_search', content: 'Resultado sintético.' },
      ],
    };
    const signal = AbortSignal.timeout(1_000);
    const response = await provider.chat(request, signal);

    expect(requestBody).toEqual({
      model: 'synthetic-model',
      stream: false,
      options: { num_ctx: 2_048, num_predict: 384, temperature: 0 },
      tools: [{
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Búsqueda externa acotada.',
          parameters: { type: 'object' },
        },
      }],
      messages: [
        { role: 'system', content: 'No ejecutar herramientas.' },
        { role: 'user', content: 'Consulta aprobada.' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'consulta exacta' } } }] },
        { role: 'tool', tool_name: 'web_search', content: 'Resultado sintético.' },
      ],
    });
    expect(requestSignal).toBe(signal);
    expect(response).toEqual({
      content: '',
      toolCalls: [{ name: 'web_search', arguments: { query: 'consulta exacta' } }],
    });
    // The provider only returns tool-call data; it has no execution callback.
    expect(Object.keys(response)).toEqual(['content', 'toolCalls']);
  });

  it('preserves structured output formats without changing their schema', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const schema = {
      type: 'object',
      properties: { categoryId: { type: ['string', 'null'] } },
      required: ['categoryId'],
      additionalProperties: false,
    };
    const provider = new OllamaProvider({
      baseURL: 'http://127.0.0.1:11434',
      fetcher: vi.fn<typeof fetch>(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ message: { content: '{"categoryId":null}' } }), { status: 200 });
      }),
    });

    await expect(provider.chat({
      model: 'synthetic-model',
      format: schema,
      messages: [{ role: 'user', content: 'Clasifica o abstente.' }],
    }, AbortSignal.timeout(1_000))).resolves.toEqual({ content: '{"categoryId":null}', toolCalls: [] });
    expect(requestBody?.format).toEqual(schema);
  });

  it('enforces an explicit response-body limit before parsing JSON', async () => {
    const provider = new OllamaProvider({
      baseURL: 'http://127.0.0.1:11434',
      fetcher: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        message: { content: 'x'.repeat(101) },
      }), { status: 200 })),
    });
    await expect(provider.chat({
      model: 'synthetic-model',
      maxResponseChars: 100,
      messages: [{ role: 'user', content: 'Pregunta sintética.' }],
    }, AbortSignal.timeout(1_000))).rejects.toBeInstanceOf(ModelProviderUnavailableError);
  });

  it('rejects malformed model tool calls instead of normalizing incomplete instructions', async () => {
    const provider = new OllamaProvider({
      baseURL: 'http://127.0.0.1:11434',
      fetcher: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        message: {
          content: '',
          tool_calls: [{ function: { arguments: { query: 'consulta alterada' } } }],
        },
      }), { status: 200 })),
    });

    await expect(provider.chat({
      model: 'synthetic-model',
      messages: [{ role: 'user', content: 'Consulta aprobada.' }],
    }, AbortSignal.timeout(1_000))).rejects.toBeInstanceOf(ModelProviderUnavailableError);
  });

  it('sanitizes HTTP, network and malformed chat responses into one provider error', async () => {
    const providers = [
      new OllamaProvider({
        baseURL: 'http://127.0.0.1:11434',
        fetcher: vi.fn<typeof fetch>(async () => new Response('private error body', { status: 502 })),
      }),
      new OllamaProvider({
        baseURL: 'http://127.0.0.1:11434',
        fetcher: vi.fn<typeof fetch>(async () => { throw new Error('private network detail'); }),
      }),
      new OllamaProvider({
        baseURL: 'http://127.0.0.1:11434',
        fetcher: vi.fn<typeof fetch>(async () => new Response('{', { status: 200 })),
      }),
    ];

    for (const provider of providers) {
      await expect(provider.chat({
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'Pregunta sintética.' }],
      }, AbortSignal.timeout(1_000))).rejects.toBeInstanceOf(ModelProviderUnavailableError);
    }
  });
});
