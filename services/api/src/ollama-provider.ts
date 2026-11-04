import type {
  ModelProvider,
  ModelProviderAvailability,
  ModelProviderChatRequest,
  ModelProviderChatResponse,
  ModelProviderCapabilities,
} from './model-provider.js';
import { ModelProviderUnavailableError } from './model-provider.js';

interface OllamaTagsPayload {
  readonly models?: readonly { readonly name?: string; readonly model?: string }[];
}

interface OllamaChatPayload {
  readonly message?: {
    readonly content?: string;
    readonly tool_calls?: ModelProviderChatResponse['toolCalls'];
  };
}

export interface OllamaProviderConfig {
  readonly baseURL: string;
  readonly fetcher?: typeof fetch;
}

function isLoopback(value: string): boolean {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function urlWithPath(baseURL: string, path: string): string {
  return new URL(path, baseURL.endsWith('/') ? baseURL : baseURL + '/').toString();
}

/**
 * Ollama-specific adapter. Its network boundary is deliberately limited to
 * /api/tags and /api/chat on a loopback endpoint. Tool calls are returned as
 * data for the backend to validate; this adapter never executes them.
 */
export class OllamaProvider implements ModelProvider {
  public readonly id = 'ollama';
  public readonly capabilities: ModelProviderCapabilities = {
    structuredOutput: 'model-dependent',
    toolCalling: 'model-dependent',
    streaming: 'unsupported',
  };

  private readonly baseURL: string;
  private readonly fetcher: typeof fetch;

  public constructor(config: OllamaProviderConfig) {
    if (!isLoopback(config.baseURL)) {
      throw new Error('Ollama must use a loopback URL without embedded credentials.');
    }
    this.baseURL = config.baseURL.endsWith('/') ? config.baseURL : config.baseURL + '/';
    this.fetcher = config.fetcher ?? fetch;
  }

  public async probe(model: string, signal: AbortSignal): Promise<ModelProviderAvailability> {
    try {
      const response = await this.fetcher(urlWithPath(this.baseURL, 'api/tags'), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!response.ok) return 'unavailable';
      const payload = await response.json() as OllamaTagsPayload;
      const found = (payload.models ?? []).some((item) => item.name === model || item.model === model);
      return found ? 'available' : 'model_missing';
    } catch {
      return 'unavailable';
    }
  }

  public async chat(request: ModelProviderChatRequest, signal: AbortSignal): Promise<ModelProviderChatResponse> {
    let response: Response;
    try {
      response = await this.fetcher(urlWithPath(this.baseURL, 'api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        signal,
        body: JSON.stringify({
          model: request.model,
          stream: false,
          ...(request.format !== undefined ? { format: request.format } : {}),
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.options ? { options: request.options } : {}),
          messages: request.messages,
        }),
      });
    } catch {
      throw new ModelProviderUnavailableError();
    }

    if (!response.ok) throw new ModelProviderUnavailableError();
    try {
      const raw = await response.text();
      if (request.maxResponseChars !== undefined &&
        (!Number.isSafeInteger(request.maxResponseChars) || request.maxResponseChars < 1 || raw.length > request.maxResponseChars)) {
        throw new ModelProviderUnavailableError();
      }
      const payload = JSON.parse(raw) as OllamaChatPayload;
      const content = payload.message?.content ?? '';
      const toolCalls = payload.message?.tool_calls ?? [];
      if (typeof content !== 'string' || !Array.isArray(toolCalls)) {
        throw new ModelProviderUnavailableError();
      }
      return { content, toolCalls };
    } catch {
      throw new ModelProviderUnavailableError();
    }
  }
}
